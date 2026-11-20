import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  BookPlus, Check, CircleStop, Clapperboard, Cpu, Film, Image as ImageIcon, Loader2, Play, RotateCcw, Sparkles, Wand2, X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../../lib/api.js';
import { SHOT_SIZES, MOVEMENTS, LIGHTS, DOF, LENSES, buildShotPrompt, buildMotionPrompt } from '../../../../shared/shot-prompt.js';
import '../director/director.css';
import '../comfy.css';

const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
const DONE = new Set(['completed', 'failed']);

export function defaultComfy() {
  return {
    tab: 'smart',
    smart: { intent: '', kind: 'image', ratio: '16:9', seconds: 5, workflowId: '', model: '', rounds: 2, auto: true, plan: null, runs: [] },
    shots: { script: '', count: 6, ratio: '16:9', styleHint: '', imageWorkflowId: '', videoWorkflowId: '', model: '', seed: Math.floor(Math.random() * 1e9), plan: null },
  };
}

/** 在浏览器里截取视频中间一帧，给 AI 自检用。 */
function captureFrame(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = url;
    v.onloadeddata = () => { v.currentTime = Math.min(v.duration / 2 || 0, Math.max(0, (v.duration || 1) - 0.1)); };
    v.onseeked = () => {
      const k = Math.min(1, 768 / (v.videoWidth || 768));
      const c = document.createElement('canvas');
      c.width = Math.round(v.videoWidth * k);
      c.height = Math.round(v.videoHeight * k);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    v.onerror = () => reject(new Error('视频读取失败，无法截帧'));
  });
}

function Media({ url, type, alt }) {
  if (!url) return null;
  return type === 'video'
    ? <video src={url} controls loop muted playsInline className="cs-media" />
    : <img src={url} alt={alt || ''} className="cs-media" />;
}

/**
 * ComfyUI 智能台：AI 规划参数 → 运行 → 看图自检 → 按建议再跑；以及分镜流水线。
 * incoming: 连入此节点的 { images:[{url,label}], texts:[string] }
 */
export default function ComfyStudio({ title, canvasId, initial, incoming, isAdmin, onSave, onPlace, onClose }) {
  const [data, setData] = useState(() => {
    const d = defaultComfy();
    return { ...d, ...(initial || {}), smart: { ...d.smart, ...(initial?.smart || {}) }, shots: { ...d.shots, ...(initial?.shots || {}) } };
  });
  const [workflows, setWorkflows] = useState([]);
  const [chatModels, setChatModels] = useState([]);
  const [status, setStatus] = useState(null);
  const [queue, setQueue] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const dataRef = useRef(data);
  dataRef.current = data;
  const refs = incoming.images.slice(0, 2);
  const upd = (key, patch) => setData((d) => ({ ...d, [key]: typeof patch === 'function' ? patch(d[key]) : { ...d[key], ...patch } }));

  useEffect(() => {
    api.comfyWorkflows().then((d) => setWorkflows(d.workflows)).catch((e) => setError(e.message));
    api.models().then((d) => setChatModels((d.providers || []).filter((p) => p.kind === 'chat'))).catch(() => {});
    api.comfyStatus().then(setStatus).catch(() => {});
    setData((d) => ({
      ...d,
      smart: { ...d.smart, intent: d.smart.intent || incoming.texts.join('\n').slice(0, 4000) },
      shots: { ...d.shots, script: d.shots.script || incoming.texts.join('\n').slice(0, 12000) },
    }));
  }, []);

  // 保存到节点（关闭时与每次变化后）
  useEffect(() => {
    const t = setTimeout(() => onSave(dataRef.current, latestPreview(dataRef.current)), 600);
    return () => clearTimeout(t);
  }, [data]);

  // 轮询任务与队列
  const pendingIds = useMemo(() => {
    const ids = data.smart.runs.filter((r) => !DONE.has(r.status)).map((r) => r.jobId);
    for (const s of data.shots.plan?.shots || []) {
      if (s.imageJob && !DONE.has(s.imageStatus)) ids.push(s.imageJob);
      if (s.videoJob && !DONE.has(s.videoStatus)) ids.push(s.videoJob);
    }
    return ids;
  }, [data]);
  useEffect(() => {
    if (!pendingIds.length) { setQueue(null); return undefined; }
    let alive = true;
    const tick = async () => {
      const jobs = await Promise.all(pendingIds.map((id) => api.job(id).then((d) => d.job).catch(() => null)));
      if (!alive) return;
      const byId = new Map(jobs.filter(Boolean).map((j) => [j.id, j]));
      setData((d) => ({
        ...d,
        smart: { ...d.smart, runs: d.smart.runs.map((r) => (byId.has(r.jobId) ? { ...r, status: byId.get(r.jobId).status, progress: byId.get(r.jobId).progress, mediaUrl: byId.get(r.jobId).mediaUrl || r.mediaUrl, error: byId.get(r.jobId).error } : r)) },
        shots: d.shots.plan ? { ...d.shots, plan: { ...d.shots.plan, shots: d.shots.plan.shots.map((s) => {
          const i = byId.get(s.imageJob);
          const v = byId.get(s.videoJob);
          return {
            ...s,
            ...(i ? { imageStatus: i.status, imageProgress: i.progress, imageUrl: i.mediaUrl || s.imageUrl, imageError: i.error } : {}),
            ...(v ? { videoStatus: v.status, videoProgress: v.progress, videoUrl: v.mediaUrl || s.videoUrl, videoError: v.error } : {}),
          };
        }) } } : d.shots,
      }));
      api.comfyQueue().then((q) => alive && setQueue(q)).catch(() => {});
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [pendingIds.join(',')]);

  const guard = async (key, work) => {
    setBusy(key);
    setError('');
    try { return await work(); } catch (e) { setError(e.message); return null; } finally { setBusy(''); }
  };

  /* ------------------------------ 智能生成 ------------------------------ */
  const s = data.smart;
  const kindFlows = workflows.filter((w) => w.kind === s.kind);
  const planWorkflow = workflows.find((w) => w.id === s.plan?.workflowId);

  const plan = () => guard('plan', async () => {
    const { plan: p } = await api.comfyPlan({
      canvasId, intent: s.intent, kind: s.kind, refCount: refs.length, ratio: s.ratio, seconds: s.kind === 'video' ? s.seconds : 0,
      workflowId: s.workflowId || undefined, model: s.model || undefined,
    });
    upd('smart', { plan: p });
  });

  const runValues = (values, round) => guard('run', async () => {
    const p = dataRef.current.smart.plan;
    const { job } = await api.comfyRun({
      canvasId, workflowId: p.workflowId, values, images: refs.map((r) => r.url), ratio: s.ratio,
      seconds: s.kind === 'video' ? s.seconds : 0, label: s.intent.slice(0, 200), round,
    });
    upd('smart', (cur) => ({ ...cur, runs: [...cur.runs, { jobId: job.id, round, values, workflowId: p.workflowId, status: job.status, progress: 0 }] }));
  });

  const reviewing = useRef(new Set());
  useEffect(() => {
    for (const r of s.runs) {
      if (r.status !== 'completed' || r.review || reviewing.current.has(r.jobId) || !s.rounds || r.round > s.rounds) continue;
      reviewing.current.add(r.jobId);
      (async () => {
        try {
          const w = workflows.find((x) => x.id === r.workflowId);
          const frame = w?.kind === 'video' && r.mediaUrl ? await captureFrame(r.mediaUrl) : undefined;
          upd('smart', (cur) => ({ ...cur, runs: cur.runs.map((x) => (x.jobId === r.jobId ? { ...x, reviewing: true } : x)) }));
          const { review } = await api.comfyReview({ jobId: r.jobId, intent: s.intent, expect: s.plan?.expect, frame, model: s.model || undefined, round: r.round, maxRounds: s.rounds });
          upd('smart', (cur) => ({ ...cur, runs: cur.runs.map((x) => (x.jobId === r.jobId ? { ...x, reviewing: false, review } : x)) }));
          const cur = dataRef.current.smart;
          if (cur.auto && review.verdict === 'retry' && r.round < cur.rounds && Object.keys(review.changes || {}).length && cur.runs.at(-1)?.jobId === r.jobId) {
            runValues({ ...r.values, ...review.changes }, r.round + 1);
          }
        } catch (e) {
          upd('smart', (cur) => ({ ...cur, runs: cur.runs.map((x) => (x.jobId === r.jobId ? { ...x, reviewing: false, review: { error: e.message } } : x)) }));
        }
      })();
    }
  }, [s.runs, workflows]);

  const placeRun = (r) => {
    const w = workflows.find((x) => x.id === r.workflowId);
    onPlace([{ url: r.mediaUrl, type: w?.kind || 'image', label: `${w?.name || 'ComfyUI'} · 第 ${r.round} 轮` }]);
  };

  /* ------------------------------ 分镜流水线 ------------------------------ */
  const sh = data.shots;
  const imageFlows = workflows.filter((w) => w.kind === 'image' && !w.requiresImage);
  const videoFlows = workflows.filter((w) => w.kind === 'video');
  const imageWf = workflows.find((w) => w.id === sh.imageWorkflowId) || imageFlows[0];
  const videoWf = workflows.find((w) => w.id === sh.videoWorkflowId) || videoFlows.find((w) => w.requiresImage) || videoFlows[0];
  const has = (w, name) => w?.params.some((p) => p.name === name && p.enabled);

  const planShots = () => guard('shots', async () => {
    const { plan: p } = await api.comfyShots({ canvasId, script: sh.script, count: sh.count, ratio: sh.ratio, styleHint: sh.styleHint, imageWorkflowId: imageWf?.id, model: sh.model || undefined });
    upd('shots', { plan: p });
  });
  const setShot = (id, patch) => upd('shots', (cur) => ({
    ...cur,
    plan: { ...cur.plan, shots: cur.plan.shots.map((x) => {
      if (x.id !== id) return x;
      const next = { ...x, ...patch };
      return { ...next, prompt: buildShotPrompt(next, cur.plan.style), motionPrompt: buildMotionPrompt(next, cur.plan.style) };
    }) },
  }));
  const setStyle = (patch) => upd('shots', (cur) => {
    const style = { ...cur.plan.style, ...patch };
    return { ...cur, plan: { ...cur.plan, style, shots: cur.plan.shots.map((x) => ({ ...x, prompt: buildShotPrompt(x, style), motionPrompt: buildMotionPrompt(x, style) })) } };
  });

  const makeImages = (only) => guard('images', async () => {
    if (!imageWf) throw new Error('工作流库里没有不需要参考图的图片工作流');
    const cur = dataRef.current.shots;
    for (const shot of cur.plan.shots) {
      if (only ? shot.id !== only : shot.imageUrl || (shot.imageJob && !DONE.has(shot.imageStatus))) continue;
      const values = { prompt: shot.prompt };
      if (has(imageWf, 'negative_prompt') && cur.plan.style.negative) values.negative_prompt = cur.plan.style.negative;
      if (has(imageWf, 'seed')) values.seed = cur.seed;
      const { job } = await api.comfyRun({ canvasId, workflowId: imageWf.id, values, ratio: cur.ratio, label: `${cur.plan.title} · ${shot.title}` });
      setShotRaw(shot.id, { imageJob: job.id, imageStatus: job.status, imageUrl: null, imageError: null, videoJob: null, videoUrl: null, videoStatus: null });
    }
  });
  const makeVideos = (only) => guard('videos', async () => {
    if (!videoWf) throw new Error('工作流库里没有视频工作流');
    const cur = dataRef.current.shots;
    for (const shot of cur.plan.shots) {
      if (!shot.imageUrl) continue;
      if (only ? shot.id !== only : shot.videoUrl || (shot.videoJob && !DONE.has(shot.videoStatus))) continue;
      const values = { prompt: shot.motionPrompt };
      if (has(videoWf, 'negative_prompt') && cur.plan.style.negative) values.negative_prompt = cur.plan.style.negative;
      const { job } = await api.comfyRun({
        canvasId, workflowId: videoWf.id, values, images: videoWf.requiresImage ? [shot.imageUrl] : [], ratio: cur.ratio, seconds: shot.seconds,
        label: `${cur.plan.title} · ${shot.title}`,
      });
      setShotRaw(shot.id, { videoJob: job.id, videoStatus: job.status, videoUrl: null, videoError: null });
    }
  });
  function setShotRaw(id, patch) {
    upd('shots', (cur) => ({ ...cur, plan: { ...cur.plan, shots: cur.plan.shots.map((x) => (x.id === id ? { ...x, ...patch } : x)) } }));
  }
  const placeShots = () => {
    const items = [];
    for (const shot of sh.plan?.shots || []) {
      if (shot.imageUrl) items.push({ url: shot.imageUrl, type: 'image', label: `${shot.title} · 关键帧`, row: items.length });
      if (shot.videoUrl) items.push({ url: shot.videoUrl, type: 'video', label: `${shot.title} · 视频` });
    }
    if (items.length) onPlace(items, { columns: sh.plan.shots.some((x) => x.videoUrl) ? 2 : 4 });
  };
  const imagesDone = sh.plan?.shots.length && sh.plan.shots.every((x) => x.imageUrl);
  const shotsBusy = sh.plan?.shots.some((x) => (x.imageJob && !DONE.has(x.imageStatus)) || (x.videoJob && !DONE.has(x.videoStatus)));

  const ModelSelect = ({ value, onChange }) => (
    <label className="cs-field">
      <span>AI 模型</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">默认对话模型</option>
        <option value="muse">Muse</option>
        {chatModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
    </label>
  );

  return createPortal((
    <div className="dr-backdrop" onMouseDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <section className="dr-shell cs-shell" role="dialog" aria-modal="true" aria-label="ComfyUI 智能台">
        <header className="dr-head">
          <div className="dr-title"><Cpu size={18} /><strong>ComfyUI 智能台</strong><span>{title}</span></div>
          <div className="cs-tabs dr-seg">
            <button type="button" className={clsx(data.tab === 'smart' && 'is-on')} onClick={() => setData((d) => ({ ...d, tab: 'smart' }))}><Sparkles size={14} /> 智能生成</button>
            <button type="button" className={clsx(data.tab === 'shots' && 'is-on')} onClick={() => setData((d) => ({ ...d, tab: 'shots' }))}><Clapperboard size={14} /> 分镜流水线</button>
          </div>
          <div className="dr-head-actions">
            <span className={clsx('cs-conn', status?.ok ? 'is-ok' : 'is-bad')} title={status?.error || ''}>{status ? (status.ok ? `ComfyUI ${status.version}` : 'ComfyUI 未连接') : '…'}</span>
            {isAdmin && <button type="button" className="dr-btn" onClick={() => guard('free', () => api.comfyFree())} title="卸载模型并释放显存">释放显存</button>}
            <button type="button" className="dr-icon" onClick={() => { onSave(dataRef.current, latestPreview(dataRef.current)); onClose(); }} aria-label="关闭"><X size={18} /></button>
          </div>
        </header>
        {queue && (queue.running.length > 0 || queue.pending.length > 0) && (
          <div className="cs-queue">
            {queue.running.map((q) => (
              <span key={q.promptId} className="is-running">
                <Loader2 size={12} className="animate-spin" /> {q.ours ? q.label || '本台任务' : '其它任务'}
                {q.progress?.max ? <i><b style={{ width: `${(q.progress.value / q.progress.max) * 100}%` }} /></i> : null}
                {q.progress?.max ? `${q.progress.value}/${q.progress.max}` : ''}
                {q.jobId && <button type="button" onClick={() => api.comfyCancel(q.jobId).catch((e) => setError(e.message))} title="中断这个任务"><CircleStop size={13} /></button>}
              </span>
            ))}
            {queue.pending.length > 0 && <span>排队 {queue.pending.length} 个</span>}
          </div>
        )}
        {error && <p className="cs-error" role="alert">{error}</p>}
        {!workflows.length && <p className="cs-error">工作流库是空的：先到「设置 → ComfyUI」导入能在本机跑通的工作流。</p>}

        {data.tab === 'smart' ? (
          <div className="cs-body">
            <aside className="cs-left">
              <label className="cs-field is-col">
                <span>想要什么</span>
                <textarea rows={6} value={s.intent} onChange={(e) => upd('smart', { intent: e.target.value })}
                  placeholder="用自然语言描述画面或视频，例如：清晨薄雾中的山间小木屋，窗户透出暖光，写实摄影" />
              </label>
              {refs.length > 0 && (
                <div className="cs-refs"><span>参考图</span>{refs.map((r) => <img key={r.url} src={r.url} alt={r.label} title={r.label} />)}</div>
              )}
              <div className="dr-seg is-full">
                <button type="button" className={clsx(s.kind === 'image' && 'is-on')} onClick={() => upd('smart', { kind: 'image', workflowId: '', plan: null })}><ImageIcon size={14} /> 图片</button>
                <button type="button" className={clsx(s.kind === 'video' && 'is-on')} onClick={() => upd('smart', { kind: 'video', workflowId: '', plan: null })}><Film size={14} /> 视频</button>
              </div>
              <div className="cs-pair">
                <label className="cs-field"><span>比例</span><select value={s.ratio} onChange={(e) => upd('smart', { ratio: e.target.value })}>{RATIOS.map((r) => <option key={r}>{r}</option>)}</select></label>
                {s.kind === 'video' && <label className="cs-field"><span>时长</span><select value={s.seconds} onChange={(e) => upd('smart', { seconds: Number(e.target.value) })}>{[2, 3, 4, 5, 6, 8, 10].map((n) => <option key={n} value={n}>{n} 秒</option>)}</select></label>}
              </div>
              <label className="cs-field">
                <span>工作流</span>
                <select value={s.workflowId} onChange={(e) => upd('smart', { workflowId: e.target.value })}>
                  <option value="">AI 自动选择</option>
                  {kindFlows.map((w) => <option key={w.id} value={w.id}>{w.name}{w.requiresImage ? '（需参考图）' : ''}</option>)}
                </select>
              </label>
              <ModelSelect value={s.model} onChange={(model) => upd('smart', { model })} />
              <div className="cs-pair">
                <label className="cs-field"><span>自检轮数</span><select value={s.rounds} onChange={(e) => upd('smart', { rounds: Number(e.target.value) })}>{[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n ? `${n} 轮` : '不自检'}</option>)}</select></label>
                <label className="cs-check"><input type="checkbox" checked={s.auto} onChange={(e) => upd('smart', { auto: e.target.checked })} /> 按建议自动重跑</label>
              </div>
              <button type="button" className="dr-btn is-accent is-block" disabled={!!busy || s.intent.trim().length < 2 || !workflows.length} onClick={plan}>
                {busy === 'plan' ? <><Loader2 size={14} className="animate-spin" /> AI 规划中…</> : <><Wand2 size={14} /> AI 规划参数</>}
              </button>
            </aside>
            <main className="cs-main">
              {s.plan ? (
                <PlanCard plan={s.plan} workflow={planWorkflow} busy={busy === 'run'}
                  onChange={(values) => upd('smart', (cur) => ({ ...cur, plan: { ...cur.plan, values } }))}
                  onRun={() => runValues(s.plan.values, (s.runs.at(-1)?.round || 0) + 1)} />
              ) : <p className="cs-empty">写下想要的内容，点「AI 规划参数」。AI 会读取工作流库与各工作流的技能包，挑选工作流、改写提示词并调整采样参数；所有取值都按本机 ComfyUI 的可选项校验。</p>}
              {s.runs.slice().reverse().map((r) => (
                <RunCard key={r.jobId} run={r} kind={workflows.find((w) => w.id === r.workflowId)?.kind}
                  onPlace={() => placeRun(r)}
                  onRetry={(changes) => runValues({ ...r.values, ...changes }, r.round + 1)}
                  onCancel={() => api.comfyCancel(r.jobId).catch((e) => setError(e.message))}
                  onLesson={(lesson) => guard('lesson', async () => { await api.comfyLesson(r.workflowId, lesson); upd('smart', (cur) => ({ ...cur, runs: cur.runs.map((x) => (x.jobId === r.jobId ? { ...x, lessonSaved: true } : x)) })); })}
                />
              ))}
            </main>
          </div>
        ) : (
          <div className="cs-body">
            <aside className="cs-left">
              <label className="cs-field is-col">
                <span>故事 / 脚本</span>
                <textarea rows={8} value={sh.script} onChange={(e) => upd('shots', { script: e.target.value })} placeholder="粘贴故事、脚本或分镜描述，AI 会拆成镜头并定一份全片风格契约" />
              </label>
              <div className="cs-pair">
                <label className="cs-field"><span>镜头数</span><input type="number" min={1} max={16} value={sh.count} onChange={(e) => upd('shots', { count: Number(e.target.value) })} /></label>
                <label className="cs-field"><span>比例</span><select value={sh.ratio} onChange={(e) => upd('shots', { ratio: e.target.value })}>{RATIOS.map((r) => <option key={r}>{r}</option>)}</select></label>
              </div>
              <label className="cs-field"><span>风格</span><input value={sh.styleHint} onChange={(e) => upd('shots', { styleHint: e.target.value })} placeholder="如：日系清新胶片、赛博朋克夜景" /></label>
              <label className="cs-field"><span>出图工作流</span>
                <select value={imageWf?.id || ''} onChange={(e) => upd('shots', { imageWorkflowId: e.target.value })}>{imageFlows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
              </label>
              <label className="cs-field"><span>视频工作流</span>
                <select value={videoWf?.id || ''} onChange={(e) => upd('shots', { videoWorkflowId: e.target.value })}>
                  {!videoFlows.length && <option value="">（库里没有视频工作流）</option>}
                  {videoFlows.map((w) => <option key={w.id} value={w.id}>{w.name}{w.requiresImage ? '' : '（不用关键帧）'}</option>)}
                </select>
              </label>
              <ModelSelect value={sh.model} onChange={(model) => upd('shots', { model })} />
              <label className="cs-field"><span>统一种子</span><input type="number" value={sh.seed} onChange={(e) => upd('shots', { seed: Number(e.target.value) })} /></label>
              <button type="button" className="dr-btn is-accent is-block" disabled={!!busy || sh.script.trim().length < 4 || !imageFlows.length} onClick={planShots}>
                {busy === 'shots' ? <><Loader2 size={14} className="animate-spin" /> AI 拆分镜中…</> : <><Sparkles size={14} /> {sh.plan ? '重新拆分镜' : 'AI 拆分镜'}</>}
              </button>
              <ol className="cs-gates">
                <li className={clsx(sh.plan && 'is-done')}>拆分镜并确认风格契约</li>
                <li className={clsx(imagesDone && 'is-done')}>生成并确认关键帧</li>
                <li className={clsx(sh.plan?.shots.some((x) => x.videoUrl) && 'is-done')}>关键帧生成视频</li>
              </ol>
            </aside>
            <main className="cs-main">
              {!sh.plan ? <p className="cs-empty">AI 会把内容拆成镜头：每个镜头单独设定景别、焦段、光线和运镜，风格只作为全片共用的一句收尾，并锁定人物外观和种子，保证画面统一而不雷同。每一步都需要你确认后才继续。</p> : (
                <>
                  <div className="cs-style">
                    <strong>「{sh.plan.title}」风格契约</strong>
                    <label>风格句<input value={sh.plan.style.clause} onChange={(e) => setStyle({ clause: e.target.value })} /></label>
                    <label>人物外观<input value={sh.plan.style.character} onChange={(e) => setStyle({ character: e.target.value })} /></label>
                    <label>负面提示词<input value={sh.plan.style.negative} onChange={(e) => setStyle({ negative: e.target.value })} /></label>
                  </div>
                  <div className="cs-shots">
                    {sh.plan.shots.map((shot, i) => (
                      <ShotCard key={shot.id} index={i} shot={shot} busy={!!busy}
                        onChange={(patch) => setShot(shot.id, patch)}
                        onImage={() => makeImages(shot.id)} onVideo={() => makeVideos(shot.id)} />
                    ))}
                  </div>
                  <div className="cs-actions">
                    <button type="button" className="dr-btn is-accent" disabled={!!busy || shotsBusy} onClick={() => makeImages()}>
                      {busy === 'images' ? <Loader2 size={14} className="animate-spin" /> : <ImageIcon size={14} />} 生成全部关键帧
                    </button>
                    <button type="button" className="dr-btn is-accent" disabled={!!busy || shotsBusy || !imagesDone || !videoWf} onClick={() => makeVideos()} title={imagesDone ? '' : '先确认所有关键帧'}>
                      {busy === 'videos' ? <Loader2 size={14} className="animate-spin" /> : <Film size={14} />} 确认关键帧，生成视频
                    </button>
                    <span className="dr-grow" />
                    <button type="button" className="dr-btn" disabled={!sh.plan.shots.some((x) => x.imageUrl)} onClick={placeShots}><Check size={14} /> 放到画布</button>
                  </div>
                </>
              )}
            </main>
          </div>
        )}
      </section>
    </div>
  ), document.body);
}

function latestPreview(d) {
  const run = d.smart.runs.slice().reverse().find((r) => r.mediaUrl);
  const shot = d.shots.plan?.shots.find((x) => x.imageUrl);
  return run?.mediaUrl || shot?.imageUrl || null;
}

function PlanCard({ plan, workflow, busy, onChange, onRun }) {
  const [add, setAdd] = useState('');
  const params = workflow?.params.filter((p) => p.enabled && p.ai) || [];
  const set = (name, value) => onChange({ ...plan.values, [name]: value });
  const remove = (name) => { const v = { ...plan.values }; delete v[name]; onChange(v); };
  return (
    <div className="cs-card">
      <header><Wand2 size={15} /><strong>AI 方案 · {plan.workflowName}</strong></header>
      {plan.reason && <p className="cs-reason">{plan.reason}</p>}
      {plan.issues?.length > 0 && <p className="cs-warn">已忽略：{plan.issues.join('；')}</p>}
      <div className="cs-values">
        {Object.entries(plan.values).map(([name, value]) => {
          const p = params.find((x) => x.name === name);
          return (
            <label key={name} className={clsx('cs-value', typeof value === 'string' && value.length > 60 && 'is-long')}>
              <span>{p?.label || name}<button type="button" onClick={() => remove(name)} aria-label={`恢复默认 ${name}`} title="恢复默认值"><X size={11} /></button></span>
              {p?.options?.length ? (
                <select value={String(value)} onChange={(e) => set(name, e.target.value)}>{p.options.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}</select>
              ) : typeof value === 'number' ? (
                <input type="number" value={value} step={p?.step || 'any'} onChange={(e) => set(name, Number(e.target.value))} />
              ) : typeof value === 'string' && value.length > 60 ? (
                <textarea rows={3} value={value} onChange={(e) => set(name, e.target.value)} />
              ) : (
                <input value={String(value)} onChange={(e) => set(name, e.target.value)} />
              )}
            </label>
          );
        })}
      </div>
      <div className="cs-plan-foot">
        <select value={add} onChange={(e) => { const p = params.find((x) => x.name === e.target.value); if (p) set(p.name, p.default); setAdd(''); }}>
          <option value="">＋ 调整其它参数…</option>
          {params.filter((p) => !(p.name in plan.values)).map((p) => <option key={p.name} value={p.name}>{p.label}（默认 {String(p.default).slice(0, 30)}）</option>)}
        </select>
        <span className="dr-grow" />
        {plan.expect && <em title="生成后 AI 自检会对照这些要点">预期：{plan.expect}</em>}
        <button type="button" className="dr-btn is-accent" disabled={busy} onClick={onRun}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} 运行</button>
      </div>
    </div>
  );
}

function RunCard({ run, kind, onPlace, onRetry, onCancel, onLesson }) {
  const rv = run.review;
  const running = !DONE.has(run.status);
  return (
    <div className={clsx('cs-card cs-run', run.status === 'failed' && 'is-failed')}>
      <header>
        <strong>第 {run.round} 轮</strong>
        <span>{running ? `生成中 ${run.progress || 0}%` : run.status === 'failed' ? `失败：${run.error || ''}` : '已完成'}</span>
        {running && <button type="button" className="dr-btn" onClick={onCancel}><CircleStop size={13} /> 取消</button>}
      </header>
      <div className="cs-run-body">
        <div className="cs-run-media">{run.mediaUrl ? <Media url={run.mediaUrl} type={kind} /> : running ? <div className="cs-pending"><Loader2 size={20} className="animate-spin" /><i><b style={{ width: `${run.progress || 0}%` }} /></i></div> : null}</div>
        <div className="cs-run-info">
          <details><summary>使用的参数</summary><pre>{JSON.stringify(run.values, null, 1)}</pre></details>
          {run.reviewing && <p className="cs-note"><Loader2 size={13} className="animate-spin" /> AI 正在看图自检…</p>}
          {rv?.error && <p className="cs-warn">自检失败：{rv.error}</p>}
          {rv && !rv.error && (
            <div className={clsx('cs-review', rv.verdict === 'accept' ? 'is-ok' : 'is-retry')}>
              <strong>{rv.verdict === 'accept' ? '通过' : '建议重跑'} · {rv.score}/10</strong>
              {rv.issues?.length > 0 && <ul>{rv.issues.map((x) => <li key={x}>{x}</li>)}</ul>}
              {Object.keys(rv.changes || {}).length > 0 && <p className="cs-note">建议修改：{Object.entries(rv.changes).map(([k, v]) => `${k} → ${String(v).slice(0, 80)}`).join('；')}</p>}
              {rv.lesson && (
                <p className="cs-lesson">经验：{rv.lesson}
                  <button type="button" className="dr-btn" disabled={run.lessonSaved} onClick={() => onLesson(rv.lesson)}><BookPlus size={13} /> {run.lessonSaved ? '已写入技能包' : '写入技能包'}</button>
                </p>
              )}
            </div>
          )}
          <div className="cs-run-actions">
            {run.mediaUrl && <button type="button" className="dr-btn is-accent" onClick={onPlace}><Check size={14} /> 采用，放到画布</button>}
            {rv && !rv.error && Object.keys(rv.changes || {}).length > 0 && <button type="button" className="dr-btn" onClick={() => onRetry(rv.changes)}><RotateCcw size={14} /> 按建议再跑一轮</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

function ShotCard({ index, shot, busy, onChange, onImage, onVideo }) {
  const sel = (table, key) => (
    <select value={shot[key]} onChange={(e) => onChange({ [key]: e.target.value })}>
      {Object.entries(table).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
    </select>
  );
  const imgRunning = shot.imageJob && !DONE.has(shot.imageStatus);
  const vidRunning = shot.videoJob && !DONE.has(shot.videoStatus);
  return (
    <article className="cs-shot">
      <header><b>{index + 1}</b><input value={shot.title} onChange={(e) => onChange({ title: e.target.value })} /><span>{shot.seconds} 秒</span></header>
      <div className="cs-shot-media">
        {shot.imageUrl ? <Media url={shot.imageUrl} type="image" /> : imgRunning ? <div className="cs-pending"><Loader2 size={18} className="animate-spin" /><i><b style={{ width: `${shot.imageProgress || 0}%` }} /></i></div> : shot.imageError ? <p className="cs-warn">{shot.imageError}</p> : <p className="cs-note">待生成</p>}
        {shot.videoUrl ? <Media url={shot.videoUrl} type="video" /> : vidRunning ? <div className="cs-pending"><Loader2 size={18} className="animate-spin" /><i><b style={{ width: `${shot.videoProgress || 0}%` }} /></i></div> : shot.videoError ? <p className="cs-warn">{shot.videoError}</p> : null}
      </div>
      <textarea rows={2} value={shot.subject} onChange={(e) => onChange({ subject: e.target.value })} title="画面内容（英文）" />
      <div className="cs-shot-grid">
        {sel(SHOT_SIZES, 'shotSize')}
        <select value={shot.lens} onChange={(e) => onChange({ lens: e.target.value })}>{LENSES.map((l) => <option key={l}>{l}</option>)}</select>
        {sel(DOF, 'dof')}
        {sel(LIGHTS, 'lighting')}
        {sel(MOVEMENTS, 'movement')}
        <input type="number" min={2} max={10} value={shot.seconds} onChange={(e) => onChange({ seconds: Number(e.target.value) })} title="秒" />
      </div>
      <input value={shot.motion} onChange={(e) => onChange({ motion: e.target.value })} placeholder="镜头动作（英文，用于图生视频）" />
      <details><summary>最终提示词</summary><p>{shot.prompt}</p><p>{shot.motionPrompt}</p></details>
      <div className="cs-shot-actions">
        <button type="button" className="dr-btn" disabled={busy || imgRunning} onClick={onImage}><ImageIcon size={13} /> {shot.imageUrl ? '重做关键帧' : '生成关键帧'}</button>
        <button type="button" className="dr-btn" disabled={busy || vidRunning || !shot.imageUrl} onClick={onVideo}><Film size={13} /> {shot.videoUrl ? '重做视频' : '生成视频'}</button>
      </div>
    </article>
  );
}
