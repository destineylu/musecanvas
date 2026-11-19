import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useToast } from './ui.jsx';
import { Link } from 'react-router-dom';

export default function ApiSettings() {
  const toast = useToast();
  const [keys, setKeys] = useState([]);
  const [base, setBase] = useState(location.origin + '/v1');
  const [name, setName] = useState('我的密钥');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try { const data = await api.keys(); setKeys(data.keys || []); setBase(new URL(data.baseUrl || '/v1', location.origin).href); }
    catch (error) { toast(error.message, 'error'); }
  };
  useEffect(() => { load(); }, []);
  const copy = async value => {
    try { await navigator.clipboard.writeText(value); toast('已复制', 'ok'); }
    catch { toast('复制失败，请检查浏览器剪贴板权限', 'error'); }
  };
  const create = async event => {
    event.preventDefault(); setBusy(true);
    try { await api.createKey(name.trim() || '我的密钥'); await load(); toast('密钥已创建，可点击复制', 'ok'); }
    catch (error) { toast(error.message, 'error'); }
    finally { setBusy(false); }
  };
  const remove = async key => {
    if (!confirm(`删除密钥「${key.name}」？使用此密钥的程序会立即失去访问权限。`)) return;
    try { await api.deleteKey(key.id); await load(); }
    catch (error) { toast(error.message, 'error'); }
  };
  return <section aria-label="API 设置" className="space-y-4 rounded-xl border border-ink-600 bg-ink-800 p-4 text-sm">
    <div><h2 className="font-semibold">Muse 账号反代 · Harness 接入</h2><p className="mt-1 text-xs text-mist-300">在「接入方式」选择 muse2api，再到<Link to="/accounts" className="text-brand-500 underline">账号池粘贴自己的 Muse Cookie</Link>并检测。此处的地址和密钥会将 harness 请求转发到该工作区绑定的 Muse 账号。</p><p className="mt-1 text-xs text-mist-300">API Key 用于调用反代接口；它与 Muse Cookie、工作区登录密码和 API Bridge 密钥分别管理。每个人只使用自己工作区的地址和密钥。</p></div>
    <div className="flex flex-wrap items-center gap-2"><span>Base URL</span><code className="break-all rounded bg-ink-700 px-3 py-2">{base}</code><button type="button" onClick={() => copy(base)} className="text-brand-500">复制地址</button></div>
    <form onSubmit={create} className="flex flex-wrap gap-2"><input aria-label="密钥名称" maxLength={40} value={name} onChange={e => setName(e.target.value)} className="rounded-lg border border-ink-600 bg-ink-900 px-3 py-2"/><button disabled={busy} className="rounded-lg bg-brand-500 px-3 py-2 text-white">{busy ? '创建中…' : '创建 API Key'}</button></form>
    <ul className="divide-y divide-ink-600">{keys.map(key => <li key={key.id} className="flex flex-wrap items-center gap-3 py-3"><span>{key.name}</span><code className="text-mist-300">{key.key}</code><button type="button" onClick={() => copy(key.full)} className="text-brand-500">复制密钥</button><button type="button" onClick={() => remove(key)} className="text-red-400">删除</button></li>)}</ul>
    {!keys.length && <p className="text-mist-300">尚未创建密钥。</p>}
    <p className="text-xs leading-6 text-mist-300">Harness 选择 OpenAI 兼容 Chat Completions，Base URL 填上方完整地址，API Key 填复制的密钥，模型填 muse-spark，建议启用 stream 并将超时设为至少 600 秒。模型列表 GET /v1/models；聊天 POST /v1/chat/completions。也提供 /v1/responses 兼容适配。工具调用通过提示词协议转换，实际兼容性需按具体 harness 验证。</p>
    <p className="text-xs leading-6 text-mist-300">muse2api 接入还可使用图片和视频接口；切换 API Bridge 后仅提供模型列表和聊天接口，便不再调用 Cookie 绑定的 Muse 账号。画布中的其它模型和 ComfyUI 配置不通过此 API 导出。</p>
  </section>;
}
