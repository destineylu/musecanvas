import { useEffect, useRef, useState } from 'react';
import { Upload, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { suggestComfy, COMFY_SOURCES } from '../../../shared/comfy-workflow.js';

const labels={prompt:'画布正向提示词',negative:'负面提示词',image:'参考图片',width:'宽度',height:'高度',seed:'随机种子',duration:'时长（秒）',frames:'帧数',fps:'帧率',ratio:'画幅比例字符串'};
export const freshComfy=(kind='image')=>({workflow:{},bindings:[],outputNode:'',width:kind==='video'?384:512,height:kind==='video'?384:512,fps:16,frameStep:4,frameOffset:1,maxFrames:kind==='video'?81:241,seed:-1,negative:'',requiresImage:true,ratioOptions:[]});
export default function ComfyWorkflowSettings({value,kind,onChange,onName}){
  const config=value||freshComfy(kind),file=useRef(null);
  const [library,setLibrary]=useState([]),[chosen,setChosen]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  useEffect(()=>{let active=true;api.comfyLibrary().then(d=>{if(active)setLibrary(d.workflows);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
  const patch=x=>onChange({...config,...x});
  const importWorkflow=(data,name)=>{
    let workflow=data.workflow||data.prompt||data;
    if(!workflow||typeof workflow!=='object'||Array.isArray(workflow)||Array.isArray(workflow.nodes)||!Object.values(workflow).every(n=>n?.class_type&&n?.inputs))throw Error('请选择 ComfyUI 导出的 API 格式 JSON，普通界面工作流不能直接运行');
    const suggested=suggestComfy(workflow);
    // Prefer explicit public parameter definitions from the local saved library.
    for(const p of data.parameters||[]){
      if(p.name==='prompt_2'&&!/CLIPTextEncode/.test(workflow[p.nodeId]?.class_type||''))continue;
      const source=({prompt:'prompt',prompt_2:'negative',aspect_ratio:'ratio',image:'image',seed:'seed',width:'width',height:'height',fps:'fps',duration:'duration',frames:'frames'})[p.name];
      if(!source||!workflow[p.nodeId]?.inputs||!(p.inputKey in workflow[p.nodeId].inputs))continue;
      const key=String(p.nodeId)+':'+p.inputKey;
      suggested.bindings=suggested.bindings.filter(b=>b.nodeId+':'+b.input!==key);
      suggested.bindings.push({source,nodeId:String(p.nodeId),input:p.inputKey});
    }
    const ratioOptions=(data.parameters||[]).find(p=>p.name==='aspect_ratio')?.options||[];
    onChange({...freshComfy(kind),workflow,...suggested,ratioOptions});onName?.(name);setError('');
  };
  const load=async()=>{setLoading(true);try{const d=await api.comfyWorkflow(chosen);importWorkflow(d,d.name);}catch(e){setError(e.message);}finally{setLoading(false);}};
  const nodes=Object.entries(config.workflow),fields=n=>Object.entries(config.workflow[n]?.inputs||{}).filter(([,v])=>!Array.isArray(v)&&['string','number','boolean'].includes(typeof v));
  const binding=(index,update)=>patch({bindings:config.bindings.map((b,i)=>i===index?{...b,...update}:b)});
  const selectClass='rounded-lg border border-ink-600 bg-ink-800 p-2 text-xs min-w-0';
  return <div className="mt-4 space-y-3 rounded-xl border border-brand-500/30 p-3" aria-label="ComfyUI 工作流配置">
    <div className="flex flex-wrap items-center gap-2"><h4 className="mr-auto text-sm font-semibold">本地 ComfyUI 工作流</h4><button type="button" className="flex items-center gap-1 text-xs text-brand-500" onClick={()=>file.current.click()}><Upload size={13}/>导入 API JSON</button><input ref={file} type="file" accept=".json,application/json" hidden onChange={async e=>{const f=e.target.files[0];if(!f)return;try{if(f.size>4*1024*1024)throw Error('工作流文件不能超过 4 MB');importWorkflow(JSON.parse(await f.text()),f.name.replace(/\.json$/i,''));}catch(err){setError(err.message);}e.target.value='';}}/></div>
    <div className="flex flex-wrap gap-2"><select className={selectClass+' flex-1'} aria-label="本机保存的 ComfyUI 工作流" value={chosen} onChange={e=>setChosen(e.target.value)}><option value="">选择本机已保存的工作流…</option>{library.map(w=><option key={w.id} value={w.id}>{w.name} · {w.nodes} 节点</option>)}</select><button type="button" disabled={!chosen||loading} className="text-xs text-brand-500 disabled:opacity-40" onClick={load}>{loading?'导入中…':'导入所选工作流'}</button></div>
    <p className="text-xs leading-5 text-mist-300">在 ComfyUI 中启用开发者模式，导出 API 格式 JSON。工作流引用的模型和自定义节点必须已安装。导入不会执行，也不会自动设为默认；请核对下面的绑定，尤其正向 / 负向提示词。相同服务地址的图片、视频任务串行提交。</p>
    {error&&<p role="alert" className="text-xs text-red-400">{error}</p>}
    {!!nodes.length&&<>
      <p className="text-xs text-brand-500">已载入 {nodes.length} 个节点</p>
      <label className="grid gap-1 text-xs text-mist-300">保存结果的输出节点<select aria-label="ComfyUI 输出节点" className={selectClass} value={config.outputNode} onChange={e=>patch({outputNode:e.target.value})}><option value="">选择 SaveImage / SaveVideo / VideoCombine 等输出</option>{nodes.map(([id,n])=><option key={id} value={id}>{id} · {n._meta?.title||n.class_type}</option>)}</select></label>
      <div className="space-y-2">{config.bindings.map((b,i)=><div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2"><select aria-label={'绑定来源 '+(i+1)} className={selectClass} value={b.source} onChange={e=>binding(i,{source:e.target.value})}>{COMFY_SOURCES.map(s=><option key={s} value={s}>{labels[s]}</option>)}</select><select aria-label={'绑定节点 '+(i+1)} className={selectClass} value={b.nodeId} onChange={e=>binding(i,{nodeId:e.target.value,input:fields(e.target.value)[0]?.[0]||''})}><option value="">节点</option>{nodes.filter(([id])=>fields(id).length).map(([id,n])=><option key={id} value={id}>{id} · {n._meta?.title||n.class_type}</option>)}</select><select aria-label={'绑定输入 '+(i+1)} className={selectClass} value={b.input} onChange={e=>binding(i,{input:e.target.value})}><option value="">输入字段</option>{fields(b.nodeId).map(([key])=><option key={key} value={key}>{key}</option>)}</select><button type="button" aria-label={'删除绑定 '+(i+1)} onClick={()=>patch({bindings:config.bindings.filter((_,n)=>n!==i)})}><Trash2 size={14}/></button></div>)}</div>
      <button type="button" className="flex items-center gap-1 text-xs text-brand-500" onClick={()=>patch({bindings:[...config.bindings,{source:'prompt',nodeId:'',input:''}]})}><Plus size={13}/>添加参数绑定</button>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[['width','基础宽度'],['height','基础高度'],['seed','种子（-1 随机）'],['fps','帧率'],['frameStep','帧数步长'],['frameOffset','帧数余数'],['maxFrames','最大帧数']].map(([key,label])=><label className="grid gap-1 text-xs text-mist-300" key={key}>{label}<input type="number" aria-label={'ComfyUI '+label} className={selectClass} value={config[key]} onChange={e=>patch({[key]:Number(e.target.value)})}/></label>)}</div>
      <label className="grid gap-1 text-xs text-mist-300">负面提示词<textarea aria-label="ComfyUI 负面提示词" rows={2} className={selectClass} value={config.negative} onChange={e=>patch({negative:e.target.value})}/></label>
      {config.bindings.some(b=>b.source==='image')&&<label className="flex items-center gap-2 text-xs text-mist-300"><input type="checkbox" checked={config.requiresImage} onChange={e=>patch({requiresImage:e.target.checked})}/>必须连接参考图（推荐；取消后无图时沿用工作流原图）</label>}
      <p className="text-xs leading-5 text-mist-300">绑定宽高后按画布比例、基础像素面积计算，取 16 的倍数；未绑定的参数沿用工作流。视频帧数取时长 × 帧率附近满足「步长 × N + 余数」的值，受最大帧数限制。图生视频需绑定参考图片；提示词需绑定实际文本输入，不要选节点连接。</p>
    </>}
  </div>;
}
