import { useCallback, useEffect, useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import BridgeManager from '../components/BridgeManager.jsx';
import Muse2apiSettings from '../components/Muse2apiSettings.jsx';
import { useAuth } from '../store/auth.jsx';

export default function Bridge({ embedded = false }) {
  const { user } = useAuth();
  const [mode, setMode] = useState(null);
  const [settingsTab, setSettingsTab] = useState('bridge');
  const [switching, setSwitching] = useState('');
  const [switchError, setSwitchError] = useState('');
  const [notice, setNotice] = useState('');
  const [state, setState] = useState({ busy: true });
  const refresh = useCallback(async () => {
    setState({ busy: true });
    try {
      setMode((await api.upstream()).mode);
      setState(await api.bridgeStatus());
    }
    catch (error) { setState({ error: error.message }); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const switchMode = async target => {
    setSwitching(target); setSwitchError(''); setNotice('');
    try {
      const next = await api.setUpstream(target);
      setMode(next.mode); setSettingsTab(next.mode);
      setNotice('已切换为 '+(next.mode === 'bridge' ? 'API Bridge' : 'muse2api')+'，新任务立即生效。');
      window.dispatchEvent(new Event('muse-upstream-changed'));
      await refresh();
    } catch (error) { setSwitchError(error.message); }
    finally { setSwitching(''); }
  };
  return (
    <main className={embedded ? 'w-full' : 'mx-auto w-full max-w-5xl px-6 py-10'}>
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          {!embedded && <h1 className="text-xl font-semibold text-ink-950">接入方式</h1>}
          <p className="text-xs text-mist-400">切换立即生效并保存，已有任务继续使用原上游。</p>
        </div>
        <button type="button" onClick={refresh} disabled={state.busy} className="flex items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-800 px-3 py-1.5 text-xs text-ink-950 disabled:opacity-60">
          <RefreshCw size={15} className={state.busy ? 'animate-spin' : ''} />重新检查
        </button>
      </header>
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        {[
          { id: 'bridge', label: 'API Bridge', description: '内置轮询、排队和媒体代理。' },
          { id: 'muse2api', label: 'muse2api', description: '使用原有账号池和浏览器绑定。' },
        ].map(item => (
          <section key={item.id} className={'rounded-xl border bg-ink-800 p-3 '+(mode===item.id?'border-brand-500/40':'border-ink-600')}>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium text-ink-950">{item.label}</h2>
              {mode === item.id && <span className="text-xs text-brand-500">当前接入</span>}
            </div>
            <p className="mt-1 text-xs text-mist-300">{item.description}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" disabled={!mode || !!switching || mode === item.id || user?.role !== 'admin'} onClick={() => switchMode(item.id)} className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs text-ink-900 disabled:opacity-50">{switching === item.id ? '正在检查并切换…' : mode === item.id ? '正在使用' : '切换到 '+item.label}</button>
            <button type="button" onClick={() => setSettingsTab(item.id)} aria-pressed={settingsTab === item.id} className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs text-brand-500">{item.label} 设置与测试</button>
            {item.id === 'muse2api' && (
              <Link to="/accounts" className="text-xs text-brand-500">账号池</Link>
            )}
            </div>
          </section>
        ))}
      </div>
      {notice && <p role="status" className="mb-4 text-sm text-brand-500">{notice}</p>}
      {switchError && <p role="alert" className="mb-4 text-sm text-rose-500">{switchError}</p>}
      {mode === 'muse2api' && state.online && <p className="mb-3 text-sm text-brand-500">muse2api 服务已连接</p>}
      {state.error && <p role="alert" className="mb-5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-500">{state.error}</p>}
      <div hidden={settingsTab !== 'bridge'}><BridgeManager canManage={user?.role === 'admin'} /></div>
      <div hidden={settingsTab !== 'muse2api'}><Muse2apiSettings canManage={user?.role === 'admin'} /></div>
    </main>
  );
}
