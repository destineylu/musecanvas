import { useState } from 'react';
import { useAuth } from '../store/auth.jsx';
import { api } from '../lib/api.js';
export default function AccountSettings(){
  const {user}=useAuth();
  const [oldPassword,setOldPassword]=useState(''),[password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const submit=async e=>{e.preventDefault();if(password!==confirm){setMessage('两次新密码不一致');return;}setBusy(true);setMessage('');try{await api.updateMe({oldPassword,password});setMessage('密码已修改');setOldPassword('');setPassword('');setConfirm('');}catch(e){setMessage(e.message);}finally{setBusy(false);}};
  return <section className="rounded-xl border border-ink-600 bg-ink-800 p-4"><h2 className="text-sm font-semibold">我的工作区账号</h2><p className="my-2 text-xs text-mist-300">{user?.email} · 仅用于此独立工作区；Muse 账号在接入方式中另外绑定。</p><form onSubmit={submit} className="grid max-w-lg gap-3">{[['原密码',oldPassword,setOldPassword],['新密码（至少 12 位）',password,setPassword],['确认新密码',confirm,setConfirm]].map(([label,value,set])=><label className="grid gap-1 text-xs" key={label}>{label}<input aria-label={label} required type="password" minLength={label==='原密码'?1:12} maxLength={1024} autoComplete={label==='原密码'?'current-password':'new-password'} value={value} onChange={e=>set(e.target.value)} className="rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-sm"/></label>)}<button disabled={busy} className="w-fit rounded-lg bg-brand-500 px-4 py-2 text-sm text-white">{busy?'修改中…':'修改密码'}</button>{message&&<p role="status" className="text-xs">{message}</p>}</form></section>;
}
