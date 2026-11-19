const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const plain = x => x && typeof x === 'object' && !Array.isArray(x);
const safeKey = key => typeof key === 'string' && !['__proto__','prototype','constructor'].includes(key);
export const COMFY_SOURCES = ['prompt','negative','image','width','height','seed','duration','frames','fps','ratio'];

export function validateComfy(config, kind) {
  if (!plain(config) || !plain(config.workflow)) fail('请导入 ComfyUI API 格式工作流');
  const workflow = config.workflow;
  if (Array.isArray(workflow.nodes) || !Object.keys(workflow).length) fail('这是界面工作流，请从 ComfyUI 导出 API 格式 JSON');
  if (Object.keys(workflow).length > 500 || JSON.stringify(workflow).length > 4 * 1024 * 1024) fail('工作流超过 500 个节点或 4 MB');
  for (const [id,node] of Object.entries(workflow)) {
    if (!safeKey(id) || !plain(node) || typeof node.class_type !== 'string' || !plain(node.inputs)) fail('工作流节点格式无效');
    for (const [key,value] of Object.entries(node.inputs)) {
      if (!safeKey(key)) fail('工作流输入字段无效');
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1]) && !Object.hasOwn(workflow,value[0])) fail('工作流引用了不存在的节点：'+value[0]);
    }
  }
  if (!Array.isArray(config.bindings) || !config.bindings.length || config.bindings.length > 80) fail('请绑定画布提示词到工作流节点');
  const seen = new Set();
  const bindings = config.bindings.map(b => {
    const nodeId=String(b.nodeId),input=String(b.input);
    if (!COMFY_SOURCES.includes(b.source) || !safeKey(nodeId) || !safeKey(input) || !Object.hasOwn(workflow,nodeId) || !Object.hasOwn(workflow[nodeId].inputs,input)) fail('参数绑定引用了不存在的节点或输入');
    if (Array.isArray(workflow[nodeId].inputs[input])) fail('不能覆盖节点连接，请选择实际参数字段');
    const key=nodeId+':'+input;if(seen.has(key))fail('同一输入不能重复绑定');seen.add(key);
    return {source:b.source,nodeId,input};
  });
  if (!bindings.some(b=>b.source==='prompt')) fail('必须绑定至少一个正向提示词');
  const outputNode=String(config.outputNode||'');
  if (!Object.hasOwn(workflow,outputNode)) fail('请选择保存图片或视频的输出节点');
  const number=(key,fallback,min,max)=>{const n=Number(config[key]??fallback);if(!Number.isFinite(n)||n<min||n>max)fail('工作流参数 '+key+' 超出范围');return n;};
  const width=number('width',kind==='video'?384:512,64,4096),height=number('height',kind==='video'?384:512,64,4096),fps=number('fps',16,1,120);
  const frameStep=number('frameStep',4,1,64),frameOffset=number('frameOffset',1,0,63);
  const maxFrames=number('maxFrames',kind==='video'?81:241,1,2000);
  const seed=number('seed',-1,-1,Number.MAX_SAFE_INTEGER);
  if (![width,height,frameStep,frameOffset,maxFrames,seed].every(Number.isInteger) || frameOffset>=frameStep) fail('尺寸、种子、帧数规则必须是有效整数');
  const negative=String(config.negative||'').slice(0,10000);
  const requiresImage=bindings.some(b=>b.source==='image') && config.requiresImage!==false;
  const ratioOptions=Array.isArray(config.ratioOptions)?config.ratioOptions.filter(x=>typeof x==='string'&&x.length<100).slice(0,30):[];
  return {workflow,bindings,outputNode,width,height,fps,frameStep,frameOffset,maxFrames,seed,negative,requiresImage,kind,ratioOptions};
}

export function suggestComfy(workflow) {
  const bindings=[];
  for (const [id,n] of Object.entries(workflow||{})) {
    if (!n?.inputs || !n.class_type) continue;
    const title=String(n._meta?.title||'');
    for (const [input,value] of Object.entries(n.inputs)) {
      if (Array.isArray(value)) continue;
      let source;
      if (/CLIPTextEncode|TextEncode/.test(n.class_type)&&input==='text') {
        const isNegative=/negative|负/i.test(title)||Object.values(workflow).some(other=>other?.inputs?.negative?.[0]===id);
        source=isNegative?'negative':(!bindings.some(b=>b.source==='prompt')?'prompt':undefined);
      }
      else if(n.class_type==='LoadImage'&&input==='image'&&!bindings.some(b=>b.source==='image'))source='image';
      else if(input==='seed'||input==='noise_seed')source='seed';
      else if(/Empty.*Latent|Wan.*ToVideo|ImageToVideo/.test(n.class_type)&&['width','height'].includes(input))source=input;
      else if(/Video/.test(n.class_type)&&['length','num_frames','frames'].includes(input))source='frames';
      else if(/Video/.test(n.class_type)&&['fps','frame_rate'].includes(input))source='fps';
      if(source)bindings.push({source,nodeId:id,input});
    }
  }
  const output=Object.entries(workflow||{}).find(([,n])=>/SaveVideo|VideoCombine|SaveImage/.test(n?.class_type));
  return {bindings,outputNode:output?.[0]||''};
}

export function comfyDimensions(config, ratio) {
  const m=/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio||'');
  if(!m)return {width:config.width,height:config.height};
  const r=Number(m[1])/Number(m[2]),area=config.width*config.height;
  if(!Number.isFinite(r)||r<=0)fail('画幅比例无效');
  const round=n=>Math.max(64,Math.min(4096,Math.round(n/16)*16));
  return {width:round(Math.sqrt(area*r)),height:round(Math.sqrt(area/r))};
}
export function buildComfyPrompt(config,job,imageName,seed) {
  const workflow=structuredClone(config.workflow),size=comfyDimensions(config,job.params.size);
  if(config.requiresImage&&!imageName)fail('此 ComfyUI 工作流需要参考图，请连接图片节点');
  const seconds=Number(job.params.duration)||5;
  const frames=Math.max(config.frameOffset||config.frameStep,Math.round((seconds*config.fps-config.frameOffset)/config.frameStep)*config.frameStep+config.frameOffset);
  if(config.bindings.some(b=>b.source==='frames')&&frames>config.maxFrames)fail('视频超过工作流最大帧数，请缩短时长或调整帧率');
  const values={prompt:[job.prompt,job.params.extra].filter(Boolean).join('\n'),negative:config.negative,image:imageName,...size,seed:config.seed>=0?config.seed:seed,duration:seconds,frames,fps:config.fps,ratio:job.params.size};
  for(const b of config.bindings){
    if(b.source==='image'&&!imageName)continue;
    let value=values[b.source];
    // ResolutionSelector options can include a descriptive suffix.
    if(b.source==='ratio'){
      const current=workflow[b.nodeId].inputs[b.input];
      const option=config.ratioOptions?.find(x=>x.startsWith(value+' '));value=option||value;
      if(typeof current!=='string')fail('比例绑定必须指向字符串输入');
    }
    workflow[b.nodeId].inputs[b.input]=value;
  }
  return workflow;
}
