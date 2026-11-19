import { useState } from 'react';
import { LogIn } from 'lucide-react';
import { useAuth } from '../store/auth.jsx';
import { Button, Field, Input } from '../components/ui.jsx';
export default function Login(){
  const {login}=useAuth();
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const submit=async e=>{e.preventDefault();setBusy(true);setError('');try{await login(email.trim(),password);}catch(e){setError(e.message);}finally{setBusy(false);}};
  return <main className="muse-login flex min-h-full items-center justify-center px-4 py-14"><section className="muse-login-card w-full max-w-[420px]">
    <header className="mb-6 flex items-center gap-3"><img src="/brand/musecanvas-cat.png" alt="" width="52" height="52" className="muse-logo"/><div><h1 className="muse-wordmark text-2xl">musecanvas</h1><p className="mt-1 text-xs text-mist-300">登录你的独立工作区</p></div></header>
    <form className="space-y-4" onSubmit={submit}><Field label="工作区账号"><Input aria-label="工作区账号" type="email" required autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} placeholder="管理员分配的账号邮箱"/></Field><Field label="密码"><Input aria-label="登录密码" type="password" required autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/></Field>{error&&<p role="alert" className="text-sm text-red-400">{error}</p>}<Button type="submit" disabled={busy} className="w-full"><LogIn size={16}/>{busy?'登录中…':'登录工作区'}</Button></form>
    <p className="mt-5 text-xs leading-5 text-mist-300">请使用分配给你的工作区地址和账号。登录后在设置中绑定自己的 Muse 账号或 API 密钥。其它成员使用各自的独立入口。</p>
  </section></main>;
}
