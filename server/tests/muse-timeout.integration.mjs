import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'muse-timeout-'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async fn=>{for(let i=0;i<80;i++){const v=await fn();if(v)return v;await wait(150);}throw Error('timeout waiting for fixture');};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9kAAAAASUVORK5CYII=','base64');
const submissions=[],tasks=new Map();let child,sql,token,seq=0;
const upstream=http.createServer(async(req,res)=>{
 let raw='';for await(const c of req)raw+=c;
 const json=x=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(x));};
 if(req.url==='/healthz')return json({ok:true});
 if(req.url==='/admin/scheduler')return json({max_concurrency:1});
 if(req.method==='POST'){
  const body=JSON.parse(raw),id='fixture-'+(++seq);submissions.push(body);tasks.set(id,{status:'queued',polls:0,kind:req.url.includes('videos')?'video':'image'});return json({id,status:'queued'});
 }
 if(req.url.startsWith('/v1/media/')){res.setHeader('Content-Type','application/octet-stream');return res.end(png);}
 const id=req.url.split('/').pop(),task=tasks.get(id);
 if(task){task.polls++;return json({id,status:task.status,progress:10,...(task.status==='completed'?{url:'/v1/media/'+id+'.png'}:{})});}
 res.statusCode=404;json({error:'unknown fixture'});
});
try{
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const reserve=http.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 child=spawn(process.execPath,['src/index.js'],{env:{...process.env,DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',ACCESS_MODE:'local',JWT_SECRET:'fixture-secret-'.repeat(4),ADMIN_EMAIL:'owner@example.test',ADMIN_PASSWORD:'fixture-password-12345',MUSECANVAS_UPSTREAM_OVERRIDE:'muse2api',MUSE_BASE:'http://127.0.0.1:'+upstream.address().port,MUSE_KEY:'fixture-only'},windowsHide:true,stdio:'ignore'});
 const base='http://127.0.0.1:'+port;
 await until(async()=>{try{return (await fetch(base+'/api/health')).ok;}catch{return false;}});
 const call=async(route,body,method=body?'POST':'GET')=>{const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();assert.equal(r.ok,true,JSON.stringify(d));return d;};
 token=(await call('/api/auth/local-session',{})).token;
 sql=new DatabaseSync(path.join(dir,'studio.db'));
 const project=(await call('/api/projects/scratch')).project,canvasId=project.canvases[0].id;
 const owner=sql.prepare('SELECT user_id FROM canvases WHERE id=?').get(canvasId).user_id;
 for(const [kind,minutes,seconds] of [['image',9,1800],['video',16,1800]]){
  const body={prompt:'timeout fixture',size:'16:9',canvasId,sourceNodeId:kind+'-node'};
  const job=(await call(kind==='image'?'/api/images':'/api/videos',body)).job;
  const retry=await call(kind==='image'?'/api/images':'/api/videos',body);
  assert.equal(retry.reused,true);assert.equal(retry.job.id,job.id,'double-click must reuse the existing task');
  let current=await until(async()=>{const j=(await call('/api/jobs/'+job.id)).job;return j.upstreamId?.startsWith('muse2api:id:')?j:null;});
  const task=tasks.get(current.upstreamId.slice('muse2api:id:'.length));
  assert.equal(submissions.at(-1).timeout,seconds);
  sql.prepare('UPDATE jobs SET result=? WHERE id=?').run(JSON.stringify({submittedAt:Date.now()-minutes*60000}),job.id);
  await until(async()=>task.polls>=2);
  current=(await call('/api/jobs/'+job.id)).job;assert.equal(current.status,'processing',kind+' must survive queue wait');
  task.status='completed';
  sql.prepare('UPDATE jobs SET result=? WHERE id=?').run(JSON.stringify({submittedAt:Date.now()-3*3600000,pollTimeoutMs:1}),job.id);
  current=await until(async()=>{const j=(await call('/api/jobs/'+job.id)).job;return j.status==='completed'?j:null;});
  assert.ok(current.mediaUrl,'completed upstream results must be retrieved even after a polling deadline');
  const node={id:kind+'-node',type:kind,jobId:job.id,status:'done',mediaUrl:current.mediaUrl,text:'manual retry'};
  const document={nodes:[node],links:[],view:{x:0,y:0,z:1}};
  sql.prepare('UPDATE canvases SET document_json=? WHERE id=?').run(JSON.stringify(document),canvasId);
  sql.prepare('INSERT INTO workflow_runs VALUES(?,?,?,?,?,?)').run('old-'+kind,canvasId,owner,'failed',JSON.stringify({steps:[{nodeId:node.id,jobId:'old-job',state:'failed',error:'old timeout'}]}),Date.now());
  await call('/api/projects/canvases/'+canvasId,{document:{...document,nodes:[{...node,jobId:'old-job',status:'failed',mediaUrl:null,error:'old timeout'}]}},'PATCH');
  const saved=(await call('/api/projects/canvases/'+canvasId)).canvas.document.nodes[0];
  assert.equal(saved.jobId,job.id);assert.equal(saved.status,'done');assert.equal(saved.mediaUrl,current.mediaUrl,'old flow autosave must not erase a new result');
 }
 assert.equal(submissions.length,2,'polling must never resubmit generation');
 console.log('PASS: 30-minute budgets, queue waits, late completed results, retry deduplication and stale-flow autosave protection');
}finally{
 sql?.close();
 if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}
 upstream.closeAllConnections();await new Promise(r=>upstream.close(r));
 assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'muse-timeout-'));
 fs.rmSync(dir,{recursive:true,force:true});
}
