import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, FlaskConical, X } from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from './ui.jsx';
import ComfyWorkflowSettings, { freshComfy } from './ComfyWorkflowSettings.jsx';
const types=[['chat','语言模型'],['image','图片模型'],['video','视频模型']];
const fresh=kind=>({kind,name:'',baseUrl:'',apiKey:'',model:'',protocol:kind==='chat'?'chat':kind==='image'?'images':'video-openai',maxConcurrency:1,maxReferences:kind==='chat'?0:1,extra:'{}',sizes:'{}',durations:kind==='video'?'[4,8,12]':'[5,6,8,10]',createPath:'',pollPath:'/videos/{id}',contentPath:'/videos/{id}/content',editPath:'/images/edits'});
export default function ModelSettings(){
  const [config,setConfig]=useState(null),[edit,setEdit]=useState(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const toast=useToast();
  const sync=data=>{setConfig(data);window.dispatchEvent(new Event('muse-models-changed'));};
  useEffect(()=>{api.modelConfig().then(setConfig).catch(e=>toast(e.message,'error'));},[]);
  const act=async work=>{setBusy(true);setMessage('');try{await work();}catch(e){setMessage(e.message);toast(e.message,'error');}finally{setBusy(false);}};
  if(!config)return <p className="p-4 text-sm text-mist-300">正在读取模型配置…</p>;
  const field=(key,label,placeholder='',type='text')=><label className="grid gap-1 text-xs text-mist-300">{label}<input aria-label={label} type={type} className="rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-sm text-ink-950" value={edit[key]} placeholder={placeholder} autoComplete="off" onChange={e=>setEdit({...edit,[key]:e.target.value})}/></label>;
  return <section aria-label="模型配置" className="space-y-3">
    <p className="text-xs leading-5 text-mist-300">分别选择对话与 AI 搭建、图片和视频使用的模型，自动保存并用于新任务。图片 / 视频可选择「本地 ComfyUI 工作流」协议。Muse 继续使用「接入方式」中的选择。密钥仅保存在本机服务端。</p>
    <div className="grid gap-3 lg:grid-cols-3">{types.map(([kind,title])=><div key={kind} className="rounded-xl border border-ink-600 bg-ink-800 p-3">
      <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">{title}</h2><button disabled={busy} className="flex items-center gap-1 text-xs text-brand-500" onClick={()=>{setEdit(fresh(kind));setMessage('');}}><Plus size={14}/>添加{title}</button></div>
      <label className="grid gap-1 text-xs text-mist-300">默认{title}<select aria-label={'默认'+title} className="rounded-lg border border-ink-600 bg-ink-800 px-2 py-2 text-sm text-ink-950" disabled={busy} value={config.defaults[kind]} onChange={e=>act(async()=>sync(await api.modelDefaults({[kind]:e.target.value})))}><option value="muse">Muse（当前接入方式）</option>{config.providers.filter(p=>p.kind===kind).map(p=><option value={p.id} key={p.id}>{p.name} · {p.model}</option>)}</select></label>
      <div className="mt-2 space-y-2">{config.providers.filter(p=>p.kind===kind).map(p=><div key={p.id} className="rounded-lg border border-ink-600 p-2"><p className="truncate text-sm">{p.name}</p><p className="mb-2 truncate text-xs text-mist-300">{p.model} · 并发 {p.maxConcurrency}</p><div className="flex gap-3 text-xs text-brand-500">
        <button disabled={busy} className="flex items-center gap-1" onClick={()=>{setEdit({...p,apiKey:'',extra:JSON.stringify(p.extra,null,2),sizes:JSON.stringify(p.sizes,null,2),durations:JSON.stringify(p.durations)});setMessage('');}}><Pencil size={12}/>编辑</button>
        <button disabled={busy} className="flex items-center gap-1" onClick={()=>act(async()=>setMessage((await api.testModel(p.id)).message))}><FlaskConical size={12}/>测试连接</button>
        <button disabled={busy||config.defaults[kind]===p.id} className="flex items-center gap-1 disabled:opacity-40" onClick={()=>act(async()=>sync(await api.deleteModel(p.id)))}><Trash2 size={12}/>删除</button>
      </div></div>)}</div>
    </div>)}</div>
    {message&&<p role="status" className="rounded-lg border border-ink-600 p-3 text-xs">{message}</p>}
    {edit&&<form className="rounded-xl border border-brand-500/40 bg-ink-800 p-4" onSubmit={e=>{e.preventDefault();act(async()=>{const extra=JSON.parse(edit.extra),sizes=JSON.parse(edit.sizes),durations=JSON.parse(edit.durations);sync(await api.saveModel(edit.id,{...edit,extra,sizes,durations}));setEdit(null);toast('模型已保存，请在上方选择为默认模型');});}}>
      <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold">{edit.id?'编辑':'添加'}{types.find(t=>t[0]===edit.kind)[1]}</h3><button type="button" aria-label="关闭模型编辑" onClick={()=>setEdit(null)}><X size={16}/></button></div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{field('name','显示名称','例如：我的图片服务')}{field('baseUrl','Base URL',edit.protocol==='comfyui'?'http://127.0.0.1:8188':'https://服务地址/v1')}{field('model',edit.protocol==='comfyui'?'工作流名称':'模型 ID',edit.protocol==='comfyui'?'例如：本地图片工作流':'供应商提供的模型名称')}{field('apiKey','API Key',edit.keySet?'已保存，留空保留':'按供应商要求填写','password')}
      <label className="grid gap-1 text-xs text-mist-300">接口协议<select aria-label="接口协议" className="rounded-lg border border-ink-600 bg-ink-800 p-2 text-sm" value={edit.protocol} onChange={e=>{const protocol=e.target.value;setEdit({...edit,protocol,maxReferences:Math.min(1,edit.maxReferences),maxConcurrency:protocol==='comfyui'?1:edit.maxConcurrency,baseUrl:protocol==='comfyui'?'http://127.0.0.1:8188':edit.baseUrl,comfy:edit.comfy||freshComfy(edit.kind),durations:protocol==='video-openai'?'[4,8,12]':'[5,6,8,10]'});}}>{edit.kind==='chat'?<option value="chat">Chat Completions</option>:edit.kind==='image'?<><option value="images">Images（generations / edits）</option><option value="comfyui">本地 ComfyUI 工作流</option></>:<><option value="video-openai">OpenAI Videos（multipart）</option><option value="video-json">兼容视频任务（JSON）</option><option value="comfyui">本地 ComfyUI 工作流</option></>}</select></label>
      {edit.kind==='video'&&field('durations','可选时长 JSON 数组','[4,8,12]')}{edit.protocol!=='comfyui'&&field('maxConcurrency','并发上限（1–4）','1','number')}{edit.kind!=='chat'&&edit.protocol!=='comfyui'&&field('maxReferences','最多参考图（0–3，OpenAI 视频限 1）','1','number')}
      </div>
      {edit.protocol==='comfyui'&&<ComfyWorkflowSettings kind={edit.kind} value={edit.comfy} onChange={comfy=>setEdit(current=>({...current,comfy}))} onName={name=>setEdit(current=>({...current,model:current.model||name,name:current.name||name}))}/>}
      {edit.protocol!=='comfyui'&&<details className="mt-3 text-xs"><summary className="cursor-pointer text-brand-500">接口路径与高级参数</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">{field('createPath','生成接口路径',edit.kind==='chat'?'/chat/completions':edit.kind==='image'?'/images/generations':'/videos')}{edit.kind==='image'&&field('editPath','参考图接口路径')}{edit.kind==='video'&&<>{field('pollPath','查询任务路径（用 {id} 代表任务 ID）')}{field('contentPath','视频内容路径（OpenAI 协议）')}</>}{[['extra','附加参数 JSON','例如 {"quality":"medium"}'],['sizes','比例到尺寸映射 JSON','例如 {"16:9":"1536x1024","9:16":"1024x1536"}']].map(([key,label,hint])=><label key={key} className="grid gap-1 text-mist-300">{label}<textarea aria-label={label} className="rounded-lg border border-ink-600 bg-ink-800 p-2 font-mono text-xs text-ink-950" rows={3} value={edit[key]} onChange={e=>setEdit({...edit,[key]:e.target.value})}/><span>{hint}</span></label>)}</div></details>}
      {edit.protocol!=='comfyui'&&<p className="my-3 text-xs leading-5 text-mist-300">Base URL 包含版本前缀（如 /v1）。连接测试只检查 /models，不生成媒体。比例会按映射转换为像素尺寸；请按供应商要求填写映射、时长等参数。视频 JSON 协议需返回任务 ID，并通过查询接口返回状态与媒体 URL；其它协议需要单独适配。</p>}
      <button disabled={busy} className="rounded-lg bg-brand-500 px-4 py-2 text-sm text-white disabled:opacity-50">{busy?'保存中…':'保存模型'}</button>
    </form>}
  </section>;
}
