import { db, uid, getJob } from './db.js';
import { createQueuedJob } from './worker.js';
import { selectedModel } from './model-config.js';
import { upstreamMode, usesMuse2api } from './config.js';
import { referenceImage } from './mediaRefs.js';
import { snapshot } from './workbench.js';

db.exec(`CREATE TABLE IF NOT EXISTS workflow_runs (
 id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, user_id TEXT NOT NULL,
 status TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_one_active ON workflow_runs(canvas_id) WHERE status IN ('running','paused');`);
const bad = message => Object.assign(new Error(message), {status:400});
const active = s => ['running','paused'].includes(s);
function parse(row) { return row ? {id:row.id,canvasId:row.canvas_id,status:row.status,...JSON.parse(row.data)} : null; }
export function getRun(canvasId,userId) {
  return parse(db.prepare('SELECT * FROM workflow_runs WHERE canvas_id=? AND user_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1').get(canvasId,userId));
}
function write(id, status, data) { db.prepare('UPDATE workflow_runs SET status=?,data=?,updated_at=? WHERE id=?').run(status,JSON.stringify(data),Date.now(),id); }
export function startRun(canvasId,userId,limit=2) {
  const canvas = db.prepare('SELECT * FROM canvases WHERE id=? AND user_id=?').get(canvasId,userId);
  if(!canvas) throw bad('画布不存在');
  if(active(getRun(canvasId,userId)?.status)) throw bad('当前画布已有流程，不能重复启动');
  const document = JSON.parse(canvas.document_json);
  const nodes = document.nodes || [], links = document.links || [];
  if(nodes.some(n=>n.status==='running') || db.prepare("SELECT 1 FROM jobs WHERE canvas_id=? AND status IN ('queued','processing')").get(canvasId)) throw bad('请等当前单独生成的任务完成后再启动一键生成');
  if(new Set(nodes.map(n=>n.id)).size!==nodes.length)throw bad('节点 ID 重复，请重新搭建');
  if(links.some(l=>!nodes.some(n=>n.id===l.from)||!nodes.some(n=>n.id===l.to)))throw bad('画布中存在失效连线，请先修正');
  const targets=nodes.filter(n=>['image','video'].includes(n.type)&&n.intent!=='asset'&&!n.mediaUrl);
  if(!targets.length) throw bad('没有待生成的图片或视频节点；已完成的素材会保留');
  if(targets.length>60) throw bad('一次最多执行 60 个生成节点，请拆分画布');
  const bindings={};
  for(const kind of ['image','video']) {const p=selectedModel(kind);bindings[kind]=p?{providerId:p.id,revision:p.revision,maxReferences:p.maxReferences,durations:p.durations}:{mode:upstreamMode,maxReferences:usesMuse2api?3:1,durations:[5,6,8,10]};}
  const ids=new Set(targets.map(n=>n.id));
  const steps=targets.map(n=>{
    const input=links.filter(l=>l.to===n.id).map(l=>nodes.find(x=>x.id===l.from)).filter(Boolean);
    if(input.some(x=>x.type==='video'||x.type==='director'||x.type==='comfy'))throw bad('「'+(n.label||n.id)+'」包含不支持的输入，请使用文本或图片连入');
    const text=(n.text||'').trim();
    const prompt=[text,...input.filter(x=>x.type==='text'&&x.text?.trim()&&x.text.trim()!==text).map(x=>x.text.trim())].filter(Boolean).join('\n');
    if(prompt.length<2||prompt.length>100000)throw bad('「'+(n.label||n.id)+'」提示词须为 2–100000 字');
    const refs=n.refImage?[{url:n.refImage}]:input.filter(x=>x.type==='image').map(x=>({nodeId:x.id,url:x.mediaUrl||null}));
    if(refs.length>bindings[n.type].maxReferences)throw bad('「'+(n.label||n.id)+'」参考图数量超出所选模型上限');
    for(const ref of refs)if(ref.url)referenceImage(userId,ref.url,false);else if(!ids.has(ref.nodeId))throw bad('存在没有素材、也不能生成的参考节点');
    const durations=bindings[n.type].durations;
    return {nodeId:n.id,type:n.type,label:n.label||n.id,prompt,size:n.size||(n.type==='video'?'16:9':'1:1'),duration:durations.includes(Number(n.duration))?Number(n.duration):durations[0],refs,deps:refs.filter(x=>!x.url).map(x=>x.nodeId),state:'waiting',jobId:null};
  });
  const visited=new Set(),visiting=new Set(),map=new Map(steps.map(s=>[s.nodeId,s]));
  const visit=id=>{if(visiting.has(id))throw bad('生成依赖存在循环，请先修正连线');if(visited.has(id))return;visiting.add(id);for(const dep of map.get(id).deps)visit(dep);visiting.delete(id);visited.add(id);};
  steps.forEach(s=>visit(s.nodeId));
  const data={limit:Math.max(1,Math.min(3,Math.floor(Number(limit)||2))),bindings,steps,startedAt:Date.now()};
  snapshot(canvasId,userId,document,'一键生成前',true);
  const id=uid('flow_');
  db.prepare('INSERT INTO workflow_runs VALUES(?,?,?,?,?,?)').run(id,canvasId,userId,'running',JSON.stringify(data),Date.now());
  tickWorkflows();return getRun(canvasId,userId);
}
export function controlRun(canvasId,userId,action) {
  const run=getRun(canvasId,userId);if(!run||!active(run.status))throw bad('没有可控制的流程');
  const {id,status,canvasId:_,...data}=run;
  if(!['pause','resume','stop'].includes(action))throw bad('操作无效');
  if(action==='stop')for(const step of data.steps)if(step.state==='waiting')step.state='cancelled';
  write(id,action==='pause'?'paused':action==='stop'?'stopped':'running',data);
  tickWorkflows();return getRun(canvasId,userId);
}
function tick(row) {
  const run=parse(row), {id,status,canvasId,...data}=run;
  const canvas=db.prepare('SELECT * FROM canvases WHERE id=? AND user_id=?').get(canvasId,row.user_id);
  if(!canvas){write(id,'stopped',data);return;}
  const doc=JSON.parse(canvas.document_json), byId=new Map(data.steps.map(s=>[s.nodeId,s]));
  let changed=false;
  for(const s of data.steps) {
    if(s.jobId&&s.state==='running') {
      const j=getJob(s.jobId);
      if(!j||j.status==='failed'){s.state='failed';s.error=j?.error||'任务不存在';changed=true;}
      else if(j.status==='completed'){s.state='done';s.mediaUrl=j.mediaUrl;changed=true;}
    }
    if(s.state==='waiting'&&s.deps.some(d=>['failed','blocked','cancelled'].includes(byId.get(d)?.state))){s.state='blocked';s.error='上游依赖未完成';changed=true;}
  }
  let slots=data.limit-data.steps.filter(s=>s.state==='running').length;
  if(status==='running')for(const s of data.steps) {
    if(slots<=0)break;
    if(s.state!=='waiting'||!s.deps.every(d=>byId.get(d)?.state==='done'))continue;
    if(!doc.nodes.some(n=>n.id===s.nodeId)){s.state='cancelled';changed=true;continue;}
    try {
      const images=s.refs.map(r=>r.url||byId.get(r.nodeId)?.mediaUrl);
      images.forEach(url=>referenceImage(row.user_id,url,false));
      const job=createQueuedJob(row.user_id,s.type,s.prompt,{size:s.size,duration:s.duration,images,sourceNodeId:s.nodeId,workflowRunId:id},{projectId:canvas.project_id,canvasId,binding:data.bindings[s.type]});
      s.jobId=job.id;s.state='running';slots--;
    }catch(e){s.state='failed';s.error=e.message;}
    changed=true;
  }
  // Merge only execution fields into the latest canvas, preserving edits and deletions.
  if(changed) {
    doc.nodes=doc.nodes.map(n=>{
      const s=byId.get(n.id);if(!s||s.state==='waiting'||s.state==='cancelled')return n;
      const j=s.jobId?getJob(s.jobId):null;
      return {...n,intent:'generate',jobId:s.jobId,status:s.state==='done'?'done':s.state==='running'?'running':'failed',progress:j?.progress||0,phase:j?.phase,error:s.error||null,...(s.mediaUrl?{mediaUrl:s.mediaUrl}: {})};
    });
    db.prepare('UPDATE canvases SET document_json=?,updated_at=? WHERE id=?').run(JSON.stringify(doc),Date.now(),canvasId);
  }
  const finished=data.steps.every(s=>!['waiting','running'].includes(s.state));
  write(id,finished?(data.steps.some(s=>['failed','blocked'].includes(s.state))?'failed':status==='stopped'?'stopped':'completed'):status,data);
}
export function tickWorkflows() {
  for(const row of db.prepare("SELECT * FROM workflow_runs WHERE status IN ('running','paused','stopped')").all()) {
    if(row.status==='stopped'&&!JSON.parse(row.data).steps.some(s=>s.state==='running'))continue;
    db.exec('BEGIN IMMEDIATE');
    try {tick(row);db.exec('COMMIT');} catch(e) {db.exec('ROLLBACK');console.error('[workflow]',e.message);}
  }
}
export function startWorkflowRunner() {tickWorkflows();setInterval(tickWorkflows,1500).unref();}
