import { useState } from 'react';
import { Activity, Palette, Settings as SettingsIcon, Sun, Moon, Monitor } from 'lucide-react';
import { applyTheme, readTheme } from '../theme.js';
import Bridge from './Bridge.jsx';

export default function Settings() {
  const [section, setSection] = useState('connection');
  const [theme, setTheme] = useState(readTheme);
  return <div className="mx-auto w-full max-w-6xl px-4 py-4 sm:px-6">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-ink-600 pb-3">
    <header className="flex items-center gap-2"><SettingsIcon size={19} className="text-brand-500"/><h1 className="text-xl font-semibold">设置</h1></header>
    <nav aria-label="设置分类" className="flex gap-1">
      {[[ 'connection', '接入方式', Activity ],[ 'appearance', '主题', Palette ]].map(([id,label,Icon]) => <button key={id} type="button" aria-pressed={section===id} onClick={()=>setSection(id)} className={'flex items-center gap-2 rounded-xl px-4 py-2 text-sm '+(section===id?'bg-brand-500/10 text-brand-500':'text-mist-300')}><Icon size={16}/>{label}</button>)}
    </nav></div>
    <div hidden={section!=='connection'}><Bridge embedded/></div>
    {section==='appearance'&&<section aria-label="主题设置" className="rounded-xl border border-ink-600 bg-ink-800 p-4">
      <h2 className="text-sm font-semibold">主题</h2><p className="mb-3 mt-1 text-xs text-mist-300">选择界面外观，自动保存并立即生效。</p>
      <div className="grid gap-2 sm:grid-cols-3">{[['system','跟随系统',Monitor],['light','浅色',Sun],['dark','深色',Moon]].map(([id,label,Icon])=><button key={id} type="button" aria-pressed={theme===id} onClick={()=>setTheme(applyTheme(id))} className={'flex items-center gap-3 rounded-lg border px-4 py-3 text-sm '+(theme===id?'border-brand-500 bg-brand-500/10 text-brand-500':'border-ink-600 text-mist-300')}><Icon size={18}/>{label}</button>)}</div>
    </section>}
  </div>;
}
