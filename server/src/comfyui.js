import { randomInt } from 'node:crypto';
import { requestBuffer, saveExternalResult } from './external-models.js';
import { buildComfyPrompt } from '../../shared/comfy-workflow.js';

const error=message=>Object.assign(new Error(message),{status:502});
const headers=p=>p.apiKey?{Authorization:'Bearer '+p.apiKey}:{};
export const comfyOrigin=p=>new URL(p.baseUrl).origin;
export async function request(p,route,{body,form,timeout=15000}={}) {
  let payload,head=headers(p);
  if(form){const req=new Request('http://local.invalid',{method:'POST',body:form});head['Content-Type']=req.headers.get('content-type');payload=Buffer.from(await req.arrayBuffer());}
  else if(body!==undefined){head['Content-Type']='application/json';payload=JSON.stringify(body);}
  let res;
  try{res=await requestBuffer(p.baseUrl+route,{method:payload===undefined?'GET':'POST',headers:head,body:payload,timeout});}
  catch(e){throw error('无法连接 ComfyUI，请检查服务地址与运行状态');}
  let data;const text=res.buffer.toString('utf8');
  if(!text.trim()&&res.status>=200&&res.status<300)return {};
  try{data=JSON.parse(text);}catch{throw error('ComfyUI 返回非 JSON，请检查地址（无需 /v1）');}
  if(res.status<200||res.status>=300||data.error){
    const detail=Object.entries(data.node_errors||{}).map(([id,n])=>id+': '+(n.errors||[]).map(e=>e.message||e.type).join(', ')).join('; ');
    throw error('ComfyUI 拒绝工作流（HTTP '+res.status+'）'+(detail?'：'+detail.slice(0,500):''));
  }
  return data;
}
export async function checkComfy(p) {
  const stats=await request(p,'/system_stats');
  if(!stats.system||!Array.isArray(stats.devices))throw error('此地址不是兼容的 ComfyUI 服务');
  const classes=[...new Set(Object.values(p.comfy.workflow).map(n=>n.class_type))];
  for(const name of classes){
    const info=await request(p,'/object_info/'+encodeURIComponent(name));
    if(!info[name])throw error('ComfyUI 缺少节点：'+name);
    for(const [id,node] of Object.entries(p.comfy.workflow).filter(([,n])=>n.class_type===name)){
      const inputs={...info[name].input?.required,...info[name].input?.optional};
      for(const [key,value] of Object.entries(node.inputs)){
        if(Array.isArray(value)||p.comfy.bindings.some(b=>b.nodeId===id&&b.input===key))continue;
        const spec=inputs[key];
        const options=Array.isArray(spec?.[0])?spec[0]:spec?.[1]?.options;
        if(Array.isArray(options)&&options.length&&!options.includes(value))throw error('工作流节点 '+id+' 的 '+key+' 不在本机可用选项中，请检查模型文件：'+String(value).slice(0,120));
      }
    }
  }
  return {ok:true,message:'ComfyUI 已连接，工作流节点均存在。未提交生成；模型文件与显存须在实际执行时验证。'};
}
export async function submitComfy(p,job,refs) {
  let filename;
  if(refs.length){
    const m=/^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(refs[0]);
    if(!m)throw error('ComfyUI 参考图格式无效');
    const form=new FormData();
    form.append('image',new Blob([Buffer.from(m[2],'base64')],{type:m[1]}),job.id+'.'+m[1].split('/')[1]);
    form.append('type','input');form.append('overwrite','false');
    const uploaded=await request(p,'/upload/image',{form,timeout:60000});
    if(typeof uploaded.name!=='string'||uploaded.type&&uploaded.type!=='input')throw error('ComfyUI 未返回有效上传文件名');
    filename=[uploaded.subfolder,uploaded.name].filter(Boolean).join('/');
  }
  const seed=randomInt(0,281474976710655);
  const prompt=buildComfyPrompt(p.comfy,job,filename,seed);
  const result=await request(p,'/prompt',{body:{prompt,client_id:'musecanvas-'+job.id,extra_data:{musecanvas_job_id:job.id}},timeout:60000});
  if(typeof result.prompt_id!=='string'||!result.prompt_id)throw error('ComfyUI 未返回 prompt_id，请到队列核对，勿重复提交');
  return {taskId:result.prompt_id,seed:p.comfy.seed>=0?p.comfy.seed:seed};
}
function fileResult(item,kind) {
  if(!item||typeof item.filename!=='string'||!['output','temp'].includes(item.type||'output'))return false;
  return (kind==='video'?/\.(mp4|webm)$/i:/\.(png|jpe?g|webp|gif)$/i).test(item.filename);
}
export async function pollComfy(p,taskId,kind) {
  const all=await request(p,'/history/'+encodeURIComponent(taskId));
  const entry=all[taskId];
  if(!entry){
    const queue=await request(p,'/queue');
    const exists=[...(queue.queue_running||[]),...(queue.queue_pending||[])].some(row=>row[1]===taskId);
    return {state:exists?'running':'missing'};
  }
  if(entry.status?.status_str==='error'||entry.status?.messages?.some(m=>['execution_error','execution_interrupted'].includes(m[0]))){
    const detail=entry.status.messages?.find(m=>m[0]==='execution_error')?.[1];
    throw error('ComfyUI 执行失败'+(detail?.node_type?'（'+detail.node_type+'）':'')+'，请检查节点、模型文件及显存');
  }
  if(!entry.status?.completed)return {state:'running'};
  const output=entry.outputs?.[p.comfy.outputNode];
  const files=[...(output?.images||[]),...(output?.gifs||[]),...(output?.videos||[])];
  const file=files.find(f=>fileResult(f,kind));
  if(!file)throw error('所选输出节点没有保存'+(kind==='video'?'MP4/WebM 视频':'图片')+'，请检查输出节点与保存开关');
  const query=new URLSearchParams({filename:file.filename,subfolder:file.subfolder||'',type:file.type||'output'});
  return {state:'done',url:p.baseUrl+'/view?'+query};
}
export const saveComfyResult=(p,job,url)=>saveExternalResult(p,job,{url});
