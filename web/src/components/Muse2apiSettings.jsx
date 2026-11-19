import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { request } from '../lib/api.js';

const field = 'mt-1 w-full rounded-lg border border-ink-600 bg-ink-750 px-3 py-2 text-sm text-ink-950';
const button = 'rounded-lg border border-ink-600 px-3 py-1.5 text-xs disabled:opacity-50';
export default function Muse2apiSettings({ canManage }) {
  const [config, setConfig] = useState(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { request('/api/muse2api').then(setConfig).catch(e => setError(e.message)); }, []);
  const act = async (save) => {
    setBusy(true); setMessage(''); setError('');
    try {
      if (save) {
        setConfig(await request('/api/muse2api', { method: 'PUT', body: { baseUrl: config.baseUrl, key } }));
        setKey(''); setMessage('muse2api 连接设置已保存并生效');
      } else {
        const out = await request('/api/muse2api/test', { method: 'POST', body: {} });
        setMessage(out.message);
      }
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <section aria-label="muse2api 独立设置" className="space-y-3 rounded-xl border border-ink-600 bg-ink-800 p-3">
    <h2 className="text-sm font-semibold">muse2api 设置与测试</h2>
    <p className="text-sm text-mist-300">独立管理 muse2api 连接和账号池。点击上方「切换到 muse2api」即可用于新的画布任务。</p>
    {!canManage && <p className="text-sm text-mist-300">当前账号可查看和测试连接，修改地址和密钥需管理员登录。</p>}
    {config && <form onSubmit={e => { e.preventDefault(); act(true); }} className="grid gap-3 sm:grid-cols-2">
      <label className="block text-sm">服务地址<input required type="url" disabled={!canManage || busy} className={field} value={config.baseUrl} onChange={e => setConfig({ ...config, baseUrl: e.target.value })}/></label>
      <label className="block text-sm">API 密钥<input type="password" autoComplete="new-password" disabled={!canManage || busy} className={field} value={key} onChange={e => setKey(e.target.value)} placeholder={config.keySet ? '已设置，留空保留原密钥' : '填写 muse2api 的 MUSE2API_KEY'}/></label>
      <p className="text-xs text-mist-300 sm:col-span-2">本机服务通常为 http://127.0.0.1:18610。连接测试使用已保存的配置。</p>
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        {canManage && <button disabled={busy} className={button}>保存设置</button>}
        <button type="button" disabled={busy} className={button} onClick={() => act(false)}>{busy ? '处理中…' : '测试连接'}</button>
        <Link to="/accounts" className={button+' text-brand-500'}>账号池与浏览器绑定</Link>
      </div>
    </form>}
    {message && <p role="status" className="text-sm text-brand-500">{message}</p>}
    {error && <p role="alert" className="text-sm text-rose-500">{error}</p>}
    <p className="text-xs text-mist-300">切换时会检查连接与鉴权；本机默认地址的 muse2api 服务未运行时自动启动。</p>
  </section>;
}
