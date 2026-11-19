import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowRight, Gift } from 'lucide-react';
import { clsx } from 'clsx';
import { useAuth } from '../store/auth.jsx';
import { Button, Field, Input, useToast } from '../components/ui.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';

export default function Login() {
  const { login, register } = useAuth();
  const toast = useToast();
  const [params] = useSearchParams();
  const ref = params.get('ref') || '';
  const [mode, setMode] = useState(ref ? 'register' : 'login');
  const [form, setForm] = useState({ email: '', password: '', name: '' });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      if (mode === 'login') {
        await login(form.email.trim(), form.password);
        toast('欢迎回来', 'ok');
      } else {
        await register(form.email.trim(), form.password, form.name.trim() || undefined, ref || undefined);
        toast(ref ? '注册成功，受邀奖励已到账' : '注册成功，已赠送积分', 'ok');
      }
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="muse-login flex min-h-full items-center justify-center px-4 py-14">
      <div className="absolute right-5 top-5 z-10"><ThemeToggle drop="down" /></div>
      <div className="muse-login-card w-full max-w-[420px]">
        <header className="mb-7 flex items-center gap-3.5">
          <img src="/brand/musecanvas-cat.png" alt="" width="58" height="58" draggable="false" className="muse-logo" />
          <div>
            <h1 className="muse-wordmark text-[29px]">musecanvas</h1>
            <p className="mt-1 text-[12px] text-mist-300">图片与视频创作画布</p>
          </div>
        </header>
            <div className="capsule-bar mb-5 w-full">
              {[
                ['login', '登录'],
                ['register', '注册'],
              ].map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => { setMode(k); setErr(''); }}
                  className={clsx(
                    'flex-1',
                    mode === k && 'on'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            <form onSubmit={submit} className="space-y-3.5">
              {ref && (
                <div className="flex items-center gap-2 rounded-lg border border-brand-400/20 bg-[#f3efff] px-3 py-2 text-[11.5px] text-brand-600">
                  <Gift size={13} /> 你被邀请注册，完成后双方各得 50 积分
                </div>
              )}

              {mode === 'register' && (
                <Field label="昵称">
                  <Input value={form.name} onChange={set('name')} placeholder="随便起个名字" />
                </Field>
              )}

              <Field label="邮箱">
                <Input
                  type="email"
                  required
                  value={form.email}
                  onChange={set('email')}
                  placeholder="you@example.com"
                  autoComplete="username"
                />
              </Field>

              <Field label="密码" hint={mode === 'register' ? '至少 6 位' : undefined}>
                <Input
                  type="password"
                  required
                  value={form.password}
                  onChange={set('password')}
                  placeholder={mode === 'register' ? '至少 6 位' : '输入密码'}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                />
              </Field>

              {err && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-600">
                  {err}
                </div>
              )}

              <Button type="submit" size="lg" loading={loading} className="w-full">
                {mode === 'login' ? '进入工作台' : '注册并开始'}
                {!loading && <ArrowRight size={16} />}
              </Button>
            </form>

      </div>
    </div>
  );
}
