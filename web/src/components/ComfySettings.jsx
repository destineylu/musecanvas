import { useEffect, useRef, useState } from 'react';
import { BookOpen, Cpu, Download, FolderOpen, Loader2, RefreshCw, Save, Trash2, Upload, Wifi, WifiOff } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api.js';
import { useToast } from './ui.jsx';
import './comfy.css';

const ROLE_LABELS = {
  prompt: '提示词', negative: '负面', seed: '种子', sampling: '采样', size: '尺寸', frames: '帧数', fps: '帧率',
  model: '模型', lora: 'LoRA', image: '参考图', video: '参考视频', other: '其它',
};

/** 设置 → ComfyUI：服务地址、工作流库、参数表与技能包。 */
export default function ComfySettings() {
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [url, setUrl] = useState('');
  const [list, setList] = useState([]);
  const [remote, setRemote] = useState(null);
  const [codex, setCodex] = useState([]);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState('');
  const fileRef = useRef(null);

  const load = async () => {
    const [s, w] = await Promise.all([api.comfyStatus().catch((e) => ({ ok: false, error: e.message })), api.comfyWorkflows()]);
    setStatus(s);
    setUrl((u) => u || s.baseUrl || 'http://127.0.0.1:8188');
    setList(w.workflows);
    return w.workflows;
  };
  useEffect(() => { load().catch((e) => toast(e.message, 'error')); api.comfyLibrary().then((d) => setCodex(d.workflows || [])).catch(() => {}); }, []);

  const run = async (key, work, ok) => {
    setBusy(key);
    try { const out = await work(); if (ok) toast(ok, 'ok'); return out; } catch (e) { toast(e.message, 'error'); return null; } finally { setBusy(''); }
  };
  const afterImport = async (out) => {
    if (!out) return;
    const all = await load();
    setSelected(all.find((w) => w.id === out.workflow.id)?.id || null);
    if (out.warnings?.length) toast(out.warnings.join('；'), 'error');
  };

  const importFile = async (file) => {
    if (!file) return;
    const text = await file.text();
    let json;
    try { json = JSON.parse(text); } catch { toast('不是有效的 JSON 文件', 'error'); return; }
    await afterImport(await run('import', () => api.comfyImport({ json, name: file.name.replace(/\.json$/i, '') }), '已导入工作流'));
  };

  const current = list.find((w) => w.id === selected);

  return (
    <section className="cf-settings" aria-label="ComfyUI 设置">
      <div className="cf-card">
        <header className="cf-head">
          <h2><Cpu size={16} /> ComfyUI 服务</h2>
          <span className={clsx('cf-status', status?.ok ? 'is-ok' : 'is-bad')}>
            {status?.ok ? <><Wifi size={13} /> 已连接 {status.version} · {status.device}</> : <><WifiOff size={13} /> {status?.error || '未连接'}</>}
          </span>
        </header>
        <div className="cf-row">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:8188" aria-label="ComfyUI 地址" />
          <button type="button" className="cf-btn is-accent" disabled={busy === 'config'} onClick={() => run('config', async () => { await api.comfyConfig({ baseUrl: url }); await load(); }, '已保存并重新连接')}>
            {busy === 'config' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} 保存并测试
          </button>
        </div>
        <p className="cf-note">AI 规划、自检和分镜流水线都只使用下面工作流库里的工作流。工作流引用的模型与自定义节点必须已安装在这台 ComfyUI 上。</p>
      </div>

      <div className="cf-card">
        <header className="cf-head">
          <h2><BookOpen size={16} /> 工作流库 <em>{list.length}</em></h2>
          <div className="cf-actions">
            <button type="button" className="cf-btn" onClick={() => fileRef.current?.click()} disabled={!!busy}><Upload size={14} /> 导入 JSON</button>
            <button type="button" className="cf-btn" disabled={!!busy} onClick={() => run('remote', async () => setRemote(await api.comfyRemote()))}>
              {busy === 'remote' ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />} 从 ComfyUI 导入
            </button>
            <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { importFile(e.target.files[0]); e.target.value = ''; }} />
          </div>
        </header>
        <p className="cf-note">支持 ComfyUI 的界面工作流（直接保存的 .json）和 API 格式。界面工作流会按本机节点定义自动转换，并自动识别提示词、种子、采样、尺寸、模型、LoRA、参考图等参数。</p>
        {remote && (
          <div className="cf-remote">
            <div className="cf-remote-head"><strong>ComfyUI 中保存的工作流</strong><button type="button" className="cf-link" onClick={() => setRemote(null)}>收起</button></div>
            <ul>
              {remote.files.filter((f) => !f.includes('/docs/') && !f.includes('metadata/')).map((f) => (
                <li key={f}>
                  <span title={f}>{f}</span>
                  <button type="button" className="cf-btn is-small" disabled={!!busy}
                    onClick={async () => afterImport(await run('r:' + f, () => api.comfyImportRemote(f), '已导入 ' + f.split('/').pop()))}>
                    {busy === 'r:' + f ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} 导入
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {codex.length > 0 && (
          <label className="cf-row is-compact">
            <span>codex-comfyui 本机库</span>
            <select defaultValue="" disabled={!!busy} onChange={async (e) => {
              const id = e.target.value;
              e.target.value = '';
              if (!id) return;
              const d = await run('codex', () => api.comfyWorkflow(id));
              if (d) await afterImport(await run('codex', () => api.comfyImport({ json: d.workflow, name: d.name, source: 'codex' }), '已导入 ' + d.name));
            }}>
              <option value="">选择要导入的工作流…</option>
              {codex.map((w) => <option key={w.id} value={w.id}>{w.name} · {w.nodes} 节点</option>)}
            </select>
          </label>
        )}

        <div className="cf-lib">
          <ul className="cf-lib-list">
            {list.map((w) => (
              <li key={w.id}>
                <button type="button" className={clsx(selected === w.id && 'is-on')} onClick={() => setSelected(w.id)}>
                  <strong>{w.name}</strong>
                  <span>{w.kind === 'video' ? '视频' : '图片'} · {w.params.filter((p) => p.ai && p.enabled).length} 个可调参数{w.requiresImage ? ' · 需参考图' : ''}{w.hasSkill ? ' · 技能包' : ''}</span>
                  {w.missing?.length > 0 && <span className="cf-missing" title={w.missing.map((m) => `${m.node} · ${m.value}`).join('；')}>缺少 {w.missing.length} 个模型文件</span>}
                </button>
              </li>
            ))}
            {!list.length && <p className="cf-note">还没有工作流。先导入一个能在本机 ComfyUI 跑通的工作流。</p>}
          </ul>
          {current && <WorkflowEditor key={current.id + current.revision} w={current} onChanged={load} onDeleted={() => { setSelected(null); load(); }} />}
        </div>
      </div>
    </section>
  );
}

function WorkflowEditor({ w, onChanged, onDeleted }) {
  const toast = useToast();
  const [form, setForm] = useState(() => ({ ...w, tagsText: (w.tags || []).join('，') }));
  const [skill, setSkill] = useState(null);
  const [busy, setBusy] = useState('');
  const [nodes, setNodes] = useState([]);
  useEffect(() => {
    api.comfySkill(w.id).then((d) => setSkill(d.text)).catch(() => setSkill(''));
    api.comfyWorkflowDetail(w.id).then((d) => setNodes(Object.entries(d.workflow.workflow).map(([id, n]) => ({ id, title: n._meta?.title || n.class_type, cls: n.class_type })))).catch(() => {});
  }, [w.id]);
  const set = (p) => setForm((f) => ({ ...f, ...p }));
  const setParam = (i, p) => setForm((f) => ({ ...f, params: f.params.map((x, k) => (k === i ? { ...x, ...p } : x)) }));
  const act = async (key, work, ok) => {
    setBusy(key);
    try { await work(); toast(ok, 'ok'); } catch (e) { toast(e.message, 'error'); } finally { setBusy(''); }
  };
  const save = () => act('save', async () => {
    await api.comfyUpdate(w.id, {
      name: form.name, description: form.description, kind: form.kind, outputNode: form.outputNode,
      tags: form.tagsText.split(/[,，\s]+/).filter(Boolean), requiresImage: form.requiresImage, skillRequired: form.skillRequired,
      params: form.params.map(({ name, nodeId, input, label, role, description, enabled, ai, default: d, random }) => ({ name, nodeId, input, label, role, description, enabled, ai, default: d, random })),
    });
    await onChanged();
  }, '已保存');

  return (
    <div className="cf-editor">
      <div className="cf-grid">
        <label>名称<input value={form.name} onChange={(e) => set({ name: e.target.value })} /></label>
        <label>类型
          <select value={form.kind} onChange={(e) => set({ kind: e.target.value })}><option value="image">图片</option><option value="video">视频</option></select>
        </label>
        <label className="is-wide">用途说明（给 AI 看，决定它什么时候选这个工作流）
          <input value={form.description || ''} onChange={(e) => set({ description: e.target.value })} placeholder="例如：Flux 写实人像，适合高质量单人照，速度较慢" />
        </label>
        <label>标签<input value={form.tagsText} onChange={(e) => set({ tagsText: e.target.value })} placeholder="写实，人像" /></label>
        <label>输出节点
          <select value={form.outputNode} onChange={(e) => set({ outputNode: e.target.value })}>
            {nodes.map((n) => <option key={n.id} value={n.id}>{n.id} · {n.title}</option>)}
          </select>
        </label>
      </div>
      {w.missing?.length > 0 && (
        <p className="cf-missing-box">本机 ComfyUI 缺少：{w.missing.map((m) => `${m.value}（${m.node}）`).join('、')}。下载后点「刷新参数」；缺模型的工作流不会被 AI 自动选用，也不能运行。</p>
      )}
      <div className="cf-checks">
        <label><input type="checkbox" checked={!!form.requiresImage} onChange={(e) => set({ requiresImage: e.target.checked })} /> 必须连接参考图</label>
        <label><input type="checkbox" checked={!!form.skillRequired} onChange={(e) => set({ skillRequired: e.target.checked })} /> 技能包运行前必读</label>
      </div>

      <h3>参数 <em>「AI」勾选的参数允许 AI 规划和自检时修改</em></h3>
      <div className="cf-params">
        <div className="cf-param is-head"><span>启用</span><span>AI</span><span>参数名</span><span>说明</span><span>默认值</span><span>来源节点</span></div>
        {form.params.map((p, i) => (
          <div key={p.name + i} className={clsx('cf-param', !p.enabled && 'is-off')}>
            <input type="checkbox" checked={p.enabled} onChange={(e) => setParam(i, { enabled: e.target.checked })} aria-label={`启用 ${p.name}`} />
            <input type="checkbox" checked={p.ai} disabled={p.role === 'image' || p.role === 'video'} onChange={(e) => setParam(i, { ai: e.target.checked })} aria-label={`AI 可调 ${p.name}`} />
            <span className="cf-pname"><b>{p.name}</b><i>{ROLE_LABELS[p.role] || p.role}</i></span>
            <input value={p.description || ''} onChange={(e) => setParam(i, { description: e.target.value })} placeholder={p.label} />
            {p.options?.length ? (
              <select value={String(p.default)} onChange={(e) => setParam(i, { default: e.target.value })}>
                {p.options.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
              </select>
            ) : p.type === 'string' ? (
              <input value={String(p.default ?? '')} onChange={(e) => setParam(i, { default: e.target.value })} />
            ) : (
              <input type="number" value={Number(p.default ?? 0)} step={p.step || 'any'} onChange={(e) => setParam(i, { default: Number(e.target.value) })} />
            )}
            <span className="cf-src" title={`${p.nodeTitle} · ${p.input}`}>{p.nodeId} · {p.input}</span>
          </div>
        ))}
      </div>

      <h3>技能包 SKILL.md <em>AI 规划与自检前会读取；自检得到的经验会追加到「经验记录」</em></h3>
      {skill === null ? <Loader2 size={16} className="animate-spin" /> : (
        <textarea className="cf-skill" value={skill} onChange={(e) => setSkill(e.target.value)} rows={10}
          placeholder={'# 适用场景\n这个工作流适合……\n\n# 提示词写法\n用英文标签式提示词……\n\n# 注意事项\n- 步数低于 20 时手部容易出错'} />
      )}

      <div className="cf-editor-foot">
        <button type="button" className="cf-btn is-danger" disabled={!!busy} onClick={() => { if (window.confirm(`删除工作流「${w.name}」和它的技能包？`)) act('del', async () => { await api.comfyDelete(w.id); onDeleted(); }, '已删除'); }}>
          <Trash2 size={14} /> 删除
        </button>
        <span className="cf-grow" />
        <button type="button" className="cf-btn" disabled={!!busy} onClick={() => act('refresh', async () => { await api.comfyRefresh(w.id); await onChanged(); }, '已按本机节点刷新可选项')}>
          {busy === 'refresh' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} 刷新参数
        </button>
        <button type="button" className="cf-btn" disabled={!!busy || skill === null} onClick={() => act('skill', () => api.comfySaveSkill(w.id, skill), '技能包已保存')}>
          <BookOpen size={14} /> 保存技能包
        </button>
        <button type="button" className="cf-btn is-accent" disabled={!!busy} onClick={save}>
          {busy === 'save' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} 保存工作流
        </button>
      </div>
    </div>
  );
}
