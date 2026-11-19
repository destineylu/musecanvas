import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Pencil, Trash2, CheckCircle, Loader2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { Modal, useToast } from './ui.jsx';
import BridgeTestBench from './BridgeTestBench.jsx';

const initial = { name: '', baseUrl: '', fileBaseUrl: '', fileFetchUrl: '', token: '', maxConcurrency: 1, enabled: true };
const labels = { idle:'空闲', busy:'生成中', partial:'生成中', unhealthy:'无法连接', cooldown:'冷却中', disabled:'已停用', 'no-token':'缺少密钥' };
const settingLabels = {
  requestTimeoutSec:'单次生成超时（秒）', queueTimeoutSec:'排队超时（秒）', retryDelaySec:'重试等待（秒）',
  maxRetries:'重试次数', healthIntervalSec:'健康检查间隔（秒）', failThreshold:'连续失败阈值', cooldownSec:'冷却时间（秒）',
};
const fieldClass = 'w-full rounded-lg border border-ink-600 bg-ink-750 px-3 py-2 text-sm text-ink-950 outline-none focus:border-brand-400';
const buttonClass = 'inline-flex items-center justify-center gap-1.5 rounded-lg border border-ink-600 bg-ink-800 px-2.5 py-1.5 text-xs text-ink-950 disabled:opacity-50 hover:border-brand-400';
export default function BridgeManager({ canManage }) {
  const [tab,setTab] = useState('nodes');
  const toast = useToast();
  const [state,setState] = useState(null);
  const [error,setError] = useState('');
  const [editing,setEditing] = useState(null);
  const [form,setForm] = useState(initial);
  const [busy,setBusy] = useState(false);
  const [testing,setTesting] = useState('');
  const [result,setResult] = useState(null);
  const [models,setModels] = useState(null);
  const [settings,setSettings] = useState(null);
  const refresh = useCallback(async () => {
    try { setState(await api.bridges());setError(''); }
    catch(e){setError(e.message);}
  },[]);
  useEffect(()=>{
    refresh();
    const timer=setInterval(()=>{if(!document.hidden)refresh();},5000);
    return ()=>clearInterval(timer);
  },[refresh]);
  const update=(key,value)=>setForm(current=>({...current,[key]:value}));
  const save=async event=>{
    event.preventDefault();setBusy(true);
    try { setState(await api.saveBridge(editing.id,form));setEditing(null);toast('Bridge 已保存','ok'); }
    catch(e){toast(e.message,'error');}
    finally{setBusy(false);}
  };
  const test=async bridge=>{
    setTesting(bridge.id);setResult(null);
    try {setResult({name:bridge.name,...await api.testBridge(bridge.id)});await refresh();}
    catch(e){toast(e.message,'error');}
    finally{setTesting('');}
  };
  const remove=async bridge=>{
    if(!confirm('删除 Bridge「'+bridge.name+'」？'))return;
    try{setState(await api.deleteBridge(bridge.id));}catch(e){toast(e.message,'error');}
  };
  const saveModels=async event=>{
    event.preventDefault();setBusy(true);
    try{setState(await api.saveBridgeModels(models));setModels(null);toast('模型映射已保存','ok');}
    catch(e){toast(e.message,'error');}finally{setBusy(false);}
  };
  const saveSettings=async event=>{
    event.preventDefault();setBusy(true);
    try{setState(await api.saveBridgeSettings(settings));setSettings(null);toast('调度设置已保存','ok');}
    catch(e){toast(e.message,'error');}finally{setBusy(false);}
  };
  return <section className="mt-3 space-y-3" aria-label="内置 MuseFlow">
    <nav aria-label="MuseFlow 设置与测试" className="flex flex-wrap gap-1 border-b border-ink-600 pb-2">
      {[['nodes','Bridge 节点'],['models','模型映射'],['settings','调度设置'],['bench','测试台'],['logs','请求记录']].map(([id,label])=>(
        <button key={id} type="button" aria-current={tab===id?'page':undefined}
          onClick={()=>setTab(id)} className={'rounded-lg px-3 py-1.5 text-xs '+(tab===id?'bg-brand-500/10 text-brand-500':'text-mist-300 hover:bg-ink-700')}>{label}</button>
      ))}
    </nav>
    {!canManage&&<p className="rounded-lg border border-ink-600 px-3 py-2 text-xs text-mist-300">当前账号可查看配置和运行测试。修改节点、密钥和调度设置请使用管理员账号登录。</p>}
    {tab==='nodes'&&<>
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-sm font-semibold">Bridge 节点</h2><p className="mt-1 text-xs text-mist-300">每个节点独立排队，密钥保存在本机。</p></div>
      <div className="flex gap-2">
        <button type="button" className={buttonClass} onClick={async()=>{try{setState(await api.checkBridges());}catch(e){toast(e.message,'error');}}}><RefreshCw size={14}/>检查健康</button>
        {canManage&&<button type="button" className={buttonClass} onClick={()=>{setForm(initial);setEditing({});}}><Plus size={14}/>添加 Bridge</button>}
      </div>
    </header>
    </>}
    {error&&<p role="alert" className="text-sm text-rose-500">{error}</p>}
    {!state&&!error&&<p className="text-sm text-mist-400">正在读取节点…</p>}
    {state&&<>
      {tab==='nodes'&&<>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {state.bridges.map(bridge=>{
          const rt=state.pool.bridges[bridge.id];
          return <article key={bridge.id} className="rounded-xl border border-ink-600 bg-ink-800 p-3">
            <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">{bridge.name}</h3><span className="text-xs text-mist-300">{labels[rt?.state]||'等待检查'}</span></div>
            <p className="mt-1.5 break-all font-mono text-xs text-mist-300">{bridge.baseUrl}</p>
            <p className="mt-1.5 text-xs text-mist-400">并发 {rt?.busy||0}/{bridge.maxConcurrency} · 成功 {rt?.ok||0} · 失败 {rt?.fail||0}{rt?.cooldownLeftSec>0?' · 冷却 '+rt.cooldownLeftSec+' 秒':''}</p>
            {rt?.lastError&&<p className="mt-2 text-xs text-rose-400">{rt.lastError}</p>}
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <button className={buttonClass} disabled={!!testing} onClick={()=>test(bridge)}>{testing===bridge.id?<Loader2 size={13} className="animate-spin"/>:<CheckCircle size={13}/>}测试</button>
              <button className={buttonClass} disabled={!canManage||rt?.busy>0} title={!canManage?'需要管理员权限':undefined} onClick={()=>{setEditing(bridge);setForm({...initial,...bridge,token:''});}}><Pencil size={13}/>编辑</button>
              <button className={buttonClass} disabled={!canManage||rt?.busy>0} title={!canManage?'需要管理员权限':undefined} onClick={()=>remove(bridge)}><Trash2 size={13}/>删除</button>
            </div>
          </article>;
        })}
      </div>
      {!state.bridges.length&&<p className="rounded-xl border border-dashed border-ink-600 p-6 text-sm text-mist-300">添加第一台 Bridge 后，即可从画布生成图片和视频。</p>}
      <p className="text-xs text-mist-300">当前排队 {state.pool.queued} 个请求</p>
      {result&&<div className="rounded-xl border border-ink-600 p-4"><h3 className="mb-2 text-sm">{result.name} 连通性</h3>{[['health','健康检查'],['models','模型鉴权'],['files','文件服务']].map(([key,label])=><p key={key} className="text-xs leading-6">{result[key].ok?'✓':'×'} {label} · {result[key].status||result[key].error||''} · {result[key].ms} ms</p>)}</div>}
      </>}
      {tab==='models'&&<div className="rounded-xl border border-ink-600 bg-ink-800 p-3">
        <div className="mb-3 flex items-center justify-between"><h2 className="font-medium">模型映射</h2><button className={buttonClass} disabled={!canManage} onClick={()=>setModels(structuredClone(state.models))}>编辑模型</button></div>
        {state.models.map(m=><div key={m.id} className="flex flex-wrap justify-between gap-2 border-t border-ink-600 py-2 text-xs"><span>{m.label} · {m.id}</span><span className="text-mist-300">{m.upstreamModel} · {m.bridges.length?m.bridges.map(id=>state.bridges.find(b=>b.id===id)?.name||id).join('、'):'所有节点'}{!m.enabled?' · 已停用':''}</span></div>)}
      </div>}
      {tab==='settings'&&<div className="rounded-xl border border-ink-600 bg-ink-800 p-3">
        <div className="flex items-center justify-between"><h2 className="font-medium">调度设置</h2><button className={buttonClass} disabled={!canManage} onClick={()=>setSettings({...state.settings})}>编辑设置</button></div>
        <dl className="mt-3 grid gap-2 sm:grid-cols-2">{Object.entries(settingLabels).map(([key,label])=><div key={key} className="flex items-center justify-between gap-3 rounded-lg bg-ink-750 px-3 py-2 text-xs"><dt className="text-mist-300">{label}</dt><dd>{state.settings[key]}</dd></div>)}</dl>
      </div>}
      <div hidden={tab!=='bench'}><BridgeTestBench models={state.models}/></div>
      {tab==='logs'&&<div className="rounded-xl border border-ink-600 bg-ink-800 p-3">
        <h2 className="mb-3 font-medium">最近请求</h2>
        {!state.logs.length&&<p className="text-xs text-mist-400">暂无请求</p>}
        <div className="max-h-64 overflow-auto">{state.logs.map((entry,index)=><div key={index} className="flex flex-wrap justify-between gap-2 border-t border-ink-600 py-2 text-xs"><span>{entry.model} · {state.bridges.find(b=>b.id===entry.bridge)?.name||entry.bridge}</span><span className="text-mist-300">{entry.state} · {entry.attempts} 次 · {Math.round((entry.ms||Date.now()-entry.startedAt)/1000)} 秒{entry.error?' · '+entry.error:''}</span></div>)}</div>
      </div>}
    </>}
    <Modal open={!!editing} onClose={()=>{if(!busy)setEditing(null);}} title={editing?.id?'编辑 Bridge':'添加 Bridge'}>
      <form className="space-y-3" onSubmit={save}>
        {[['name','名称'],['baseUrl','API 地址（含 /v1）'],['fileBaseUrl','文件服务地址'],['fileFetchUrl','文件下载地址（可选）'],['token',editing?.tokenSet?'密钥（留空保留）':'密钥']].map(([key,label])=><label key={key} className="block text-xs text-mist-300">{label}<input required={['name','baseUrl'].includes(key)||key==='token'&&!editing?.tokenSet} type={key==='token'?'password':'text'} autoComplete={key==='token'?'new-password':'off'} className={fieldClass+' mt-1'} value={form[key]} onChange={e=>update(key,e.target.value)}/></label>)}
        <label className="block text-xs text-mist-300">最大并发<input required type="number" min="1" max="16" className={fieldClass+' mt-1'} value={form.maxConcurrency} onChange={e=>update('maxConcurrency',Number(e.target.value))}/></label>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={e=>update('enabled',e.target.checked)}/>启用</label>
        <button disabled={busy} className={buttonClass} type="submit">{busy?'保存中…':'保存'}</button>
      </form>
    </Modal>
    <Modal open={!!models} onClose={()=>{if(!busy)setModels(null);}} title="模型映射" width="max-w-3xl">
      <form className="space-y-4" onSubmit={saveModels}>
        {models?.map((m,index)=><fieldset key={index} className="space-y-2 rounded-lg border border-ink-600 p-3">
          <div className="grid grid-cols-2 gap-2">{[['id','模型 ID'],['label','显示名'],['upstreamModel','上游模型']].map(([key,label])=><label key={key} className="text-xs">{label}<input required className={fieldClass+' mt-1'} value={m[key]} onChange={e=>setModels(list=>list.map((item,i)=>i===index?{...item,[key]:e.target.value}:item))}/></label>)}
          <label className="text-xs">类型<select className={fieldClass+' mt-1'} value={m.type} onChange={e=>setModels(list=>list.map((item,i)=>i===index?{...item,type:e.target.value}:item))}>{['chat','image','video'].map(type=><option key={type}>{type}</option>)}</select></label></div>
          <div className="flex flex-wrap gap-3 text-xs"><label><input type="checkbox" checked={m.enabled} onChange={e=>setModels(list=>list.map((item,i)=>i===index?{...item,enabled:e.target.checked}:item))}/> 启用</label>
          {state?.bridges.map(b=><label key={b.id}><input type="checkbox" checked={m.bridges.includes(b.id)} onChange={e=>setModels(list=>list.map((item,i)=>i===index?{...item,bridges:e.target.checked?[...item.bridges,b.id]:item.bridges.filter(id=>id!==b.id)}:item))}/> {b.name}</label>)}</div>
          <p className="text-xs text-mist-400">不限定节点时使用所有可用节点。</p>
          <button type="button" className={buttonClass} onClick={()=>setModels(list=>list.filter((_,i)=>i!==index))}>移除此模型</button>
        </fieldset>)}
        <div className="flex gap-2"><button type="button" className={buttonClass} onClick={()=>setModels(list=>[...list,{id:'',label:'',type:'chat',upstreamModel:'muse',enabled:true,bridges:[]}])}>添加模型</button><button type="submit" disabled={busy} className={buttonClass}>保存模型</button></div>
      </form>
    </Modal>
    <Modal open={!!settings} onClose={()=>{if(!busy)setSettings(null);}} title="调度设置">
      <form className="space-y-3" onSubmit={saveSettings}>{settings&&Object.entries(settingLabels).map(([key,label])=><label key={key} className="block text-xs">{label}<input required type="number" className={fieldClass+' mt-1'} value={settings[key]} onChange={e=>setSettings(current=>({...current,[key]:Number(e.target.value)}))}/></label>)}<button type="submit" disabled={busy} className={buttonClass}>保存设置</button></form>
    </Modal>
  </section>;
}
