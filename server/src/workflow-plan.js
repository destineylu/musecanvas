import { jsonrepair } from 'jsonrepair';
import { validateWorkflow } from '../../shared/canvas-workflow.js';

// Extract complete top-level objects, respecting braces inside quoted strings.
// Do not let a repair library invent a closing half of a truncated plan.
function objects(text) {
  const result=[];let start=-1,depth=0,quote='',escaped=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(start<0){if(c==='{'){start=i;depth=1;}continue;}
    if(quote){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c===quote)quote='';continue;}
    if(c==='"'||c==="'")quote=c;
    else if(c==='{')depth++;
    else if(c==='}'&&--depth===0){result.push(text.slice(start,i+1));start=-1;}
  }
  return result;
}

export function parseWorkflowPlan(reply) {
  if(typeof reply!=='string'||reply.length>200_000)throw Error('方案回复为空或过长');
  const fenced=[...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m=>m[1]);
  const candidates=[...fenced.flatMap(objects),...objects(reply)];
  if(!candidates.length)throw Error('AI 方案未完整返回，请重新生成');
  let lastError;
  // Prefer a final corrected object when the assistant includes more than one.
  for(const value of [...new Set(candidates)].reverse()){
    try{
      let data;
      try{data=JSON.parse(value);}catch{data=JSON.parse(jsonrepair(value));}
      const plan=validateWorkflow(data);
      if(plan.nodes.some(n=>!n.text))throw Error('部分节点缺少提示词');
      const imageIds=new Set(plan.nodes.filter(n=>n.type==='image').map(n=>n.id));
      if(plan.nodes.some(n=>n.type==='video'&&plan.links.filter(l=>l.to===n.id&&imageIds.has(l.from)).length>1))throw Error('视频节点的图片参考超过一张');
      return plan;
    }catch(error){lastError=error;}
  }
  throw Error('AI 方案结构不完整：'+(lastError?.message||'请重新生成'));
}
