import { useEffect, useRef, useState } from 'react';
import { Play, Square, Loader2 } from 'lucide-react';
import { getToken } from '../lib/api.js';

const field = 'w-full rounded-lg border border-ink-600 bg-ink-750 px-3 py-2 text-sm text-ink-950';
export default function BridgeTestBench({ models }) {
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [ratio, setRatio] = useState('16:9');
  const [duration, setDuration] = useState(5);
  const [image, setImage] = useState('');
  const [imageName, setImageName] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [phase, setPhase] = useState('');
  const active = useRef(null);
  useEffect(() => () => active.current?.abort(), []);
  const available = models.filter(m => m.enabled);
  const selected = available.find(m => m.id === model) || available[0];
  const links = [...new Set(reply.match(/https?:\/\/[^\s<>"'\x60)\]]+\.(?:webp|png|jpe?g|gif|avif|mp4|webm|mov)(?:\?[^\s<>"'\x60)\]]*)?/gi) || [])]
    .filter(value => { try { const url = new URL(value); return url.origin === location.origin && url.pathname.startsWith('/bridge-media/'); } catch { return false; } });

  const attach = async event => {
    const file = event.target.files?.[0];
    if (!file) { setImage('');setImageName('');return; }
    if (file.size > 2 * 1024 * 1024 || !['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)) {
      setError('参考图请使用小于 2 MB 的 PNG、JPG、WebP 或 GIF');event.target.value='';return;
    }
    try {
      const data = await new Promise((resolve,reject) => {
        const reader = new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);
      });
      setImage(data);setImageName(file.name);setError('');
    } catch { setError('参考图读取失败'); }
  };
  const run = async event => {
    event.preventDefault();
    if (!selected || !prompt.trim() || busy) return;
    const controller = new AbortController();active.current=controller;
    setBusy(true);setError('');setReply('');setElapsed(0);setPhase('等待调度');
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now()-start)/1000)),1000);
    let reader;
    try {
      const response = await fetch('/api/bridges/test-run', {
        method:'POST',headers:{Authorization:'Bearer '+getToken(),'Content-Type':'application/json'},
        body:JSON.stringify({model:selected.id,prompt,ratio,duration,image:image||undefined}),signal:controller.signal,
      });
      if (!response.ok) {
        const data=await response.json();throw Error(data.error?.message || data.error || 'HTTP '+response.status);
      }
      reader=response.body.getReader();
      const decoder=new TextDecoder();
      let buffer='',content='',done=false;
      while(!done){
        const chunk=await reader.read();
        if(chunk.done)break;
        buffer+=decoder.decode(chunk.value,{stream:true});
        let newline;
        while((newline=buffer.indexOf('\n'))!==-1){
          const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);
          if(line.startsWith(':')){setPhase('排队或生成中，连接正常');continue;}
          if(!line.startsWith('data:'))continue;
          const data=line.slice(5).trim();
          if(data==='[DONE]'){done=true;break;}
          if(!data)continue;
          const item=JSON.parse(data);
          if(item.error)throw Error(item.error.message||'生成失败');
          content+=item.choices?.[0]?.delta?.content||'';
          setReply(content);
        }
      }
      if(!done)throw Error('响应中断，未收到完成标记');
      setPhase('完成');
    } catch (failure) {
      setError(controller.signal.aborted?'已停止等待，上游生成可能仍在继续。可在请求记录查看状态。':failure.message);setPhase('');
    } finally {
      clearInterval(timer);await reader?.cancel().catch(()=>{});reader?.releaseLock();
      if(active.current===controller)active.current=null;
      setBusy(false);setElapsed(Math.floor((Date.now()-start)/1000));
    }
  };
  return <section aria-label="Bridge 测试台" className="space-y-4">
    <div><h2 className="text-lg font-semibold">测试台</h2><p className="mt-1 text-xs text-mist-300">直接测试内置 Bridge 的对话、图片和视频。生成使用远端额度。</p></div>
    <form onSubmit={run} className="space-y-4 rounded-xl border border-ink-600 bg-ink-800 p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs">模型<select className={field+' mt-1'} value={selected?.id||''} onChange={e=>setModel(e.target.value)} disabled={busy||!available.length}>
          {!available.length&&<option value="">暂无已启用模型</option>}
          {available.map(m=><option key={m.id} value={m.id}>{m.label} · {m.id}</option>)}
        </select></label>
        {selected?.type!=='chat'&&<label className="text-xs">比例<select disabled={busy} className={field+' mt-1'} value={ratio} onChange={e=>setRatio(e.target.value)}>{['16:9','9:16','1:1','4:3','3:4'].map(r=><option key={r}>{r}</option>)}</select></label>}
        {selected?.type==='video'&&<label className="text-xs">时长<select disabled={busy} className={field+' mt-1'} value={duration} onChange={e=>setDuration(Number(e.target.value))}>{[5,6,8,10].map(d=><option key={d} value={d}>{d} 秒</option>)}</select></label>}
      </div>
      <label className="block text-xs">提示词<textarea required disabled={busy} value={prompt} onChange={e=>setPrompt(e.target.value)} rows={4} maxLength={100000} className={field+' mt-1 resize-y'} placeholder="填写测试内容"/></label>
      <label className="block text-xs">参考图（可选）<input disabled={busy} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={attach} className={field+' mt-1'}/></label>
      {imageName&&<p className="text-xs text-mist-300">{imageName}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <button disabled={busy||!selected||!prompt.trim()} className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm text-ink-900 disabled:opacity-50">
          {busy?<Loader2 size={15} className="animate-spin"/>:<Play size={15}/>}开始测试
        </button>
        {busy&&<button type="button" onClick={()=>active.current?.abort()} className="inline-flex items-center gap-2 text-sm text-mist-300"><Square size={13}/>停止等待</button>}
        <span role="status" className="text-xs text-mist-300">{phase}{elapsed>0?' · '+elapsed+' 秒':''}</span>
      </div>
    </form>
    {error&&<p role="alert" className="rounded-lg border border-rose-500/30 p-3 text-sm text-rose-500">{error}</p>}
    {reply&&<pre className="whitespace-pre-wrap break-words rounded-xl border border-ink-600 bg-ink-800 p-4 text-sm">{reply}</pre>}
    {links.map(url=><div key={url} className="rounded-xl border border-ink-600 bg-ink-800 p-3">
      {/\.(mp4|webm|mov)(?:\?|$)/i.test(url)?<video controls src={url} className="max-h-96 w-full rounded-lg"/>:<img alt="测试生成图片" src={url} className="max-h-96 w-full rounded-lg object-contain"/>}
      <a href={url} download className="mt-2 inline-block text-sm text-brand-500">下载素材</a>
    </div>)}
  </section>;
}
