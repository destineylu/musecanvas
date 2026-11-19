import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, RotateCcw, Sun, SwitchCamera, Wand2, X } from 'lucide-react';
import { clsx } from 'clsx';
import Stage3D from './Stage3D.jsx';
import {
  ANGLE_PRESETS, DEFAULT_ANGLE, DEFAULT_LIGHT, DISTANCES, LENS_FOV, LIGHT_COLORS, LIGHT_DIRECTIONS, LIGHT_PRESETS,
  anglePrompt, lightDirection, lightingPrompt,
} from './imageTools.js';

const PRESET_LOOK = {
  natural: 'linear-gradient(135deg, #fff4dc, #cfe3f7)',
  studio: 'linear-gradient(135deg, #f7f7f7, #c9ced6)',
  rembrandt: 'radial-gradient(circle at 30% 30%, #f3c98d, #3a2c22 70%)',
  golden: 'linear-gradient(135deg, #ffcf7a, #e2763c)',
  cinematic: 'linear-gradient(135deg, #f2a65a 0 45%, #2f5f8f 55%)',
  neon: 'linear-gradient(135deg, #ff4fa3, #2bd4e8)',
  moon: 'linear-gradient(135deg, #a9c4ff, #1d2a4a)',
  top: 'radial-gradient(circle at 50% 0%, #fff3cf, #26262b 70%)',
  custom: 'conic-gradient(#ff6b6b, #ffd36b, #6bff9e, #6bc7ff, #b66bff, #ff6b6b)',
};

function Shell({ icon: Icon, title, hint, onClose, onReset, busy, children, footer, className }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  return createPortal((
    <div className="mf-modal is-soft" role="presentation" onMouseDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget && !busy) onClose(); }}>
      <section className={clsx('mf-modal-card mf-studio3d', className)} role="dialog" aria-modal="true" aria-label={title}>
        <header className="mf-tool-head">
          <div><Icon size={18} /><strong>{title}</strong>{hint && <span>{hint}</span>}</div>
          <div>
            {onReset && <button type="button" className="mf-ghost" onClick={onReset} disabled={busy}><RotateCcw size={13} /> 重置</button>}
            <button type="button" className="mf-icon-btn" onClick={onClose} disabled={busy} aria-label={`关闭${title}`}><X size={17} /></button>
          </div>
        </header>
        <div className="mf-studio3d-body">{children}</div>
        <footer className="mf-studio3d-foot">{footer}</footer>
      </section>
    </div>
  ), document.body);
}

function Slider({ label, value, min, max, unit = '', onChange, disabled }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <label className="mf-slider">
      <span className="mf-slider-head"><b>{label}</b><em>{Math.round(value)}{unit}</em></span>
      <input type="range" min={min} max={max} value={value} disabled={disabled} style={{ '--pct': `${pct}%` }}
        onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function Toggle({ checked, onChange, disabled, label }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      className={clsx('mf-switch', checked && 'is-on')} onClick={() => onChange(!checked)}>
      <i />
    </button>
  );
}

function ColorRow({ value, onChange, disabled }) {
  const named = LIGHT_COLORS.find((c) => c.value === value);
  return (
    <div className="mf-color-row">
      <div className="mf-swatches">
        {LIGHT_COLORS.map((c) => (
          <button key={c.label} type="button" disabled={disabled} title={c.label} aria-pressed={value === c.value}
            className={clsx('mf-swatch', !c.value && 'is-white', value === c.value && 'is-on')}
            style={c.value ? { background: c.value } : undefined} onClick={() => onChange(c.value)} />
        ))}
        <label className="mf-swatch-custom" title="自定义颜色">
          <input type="color" value={value || '#ffffff'} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
        </label>
      </div>
      <em>{named ? named.label : value}</em>
    </div>
  );
}

export function LightingStudio({ src, onClose, onSubmit }) {
  const [s, setS] = useState(DEFAULT_LIGHT);
  const [source, setSource] = useState('main');
  const [busy, setBusy] = useState(false);
  const set = (patch) => setS((v) => ({ ...v, ...patch }));
  const editRim = source === 'rim';
  const az = editRim ? s.rimAzimuth : s.azimuth;
  const el = editRim ? s.rimElevation : s.elevation;
  const setDir = (patch) => set(editRim
    ? { ...(patch.azimuth !== undefined && { rimAzimuth: patch.azimuth }), ...(patch.elevation !== undefined && { rimElevation: patch.elevation }) }
    : patch);
  const submit = async () => {
    setBusy(true);
    try { await onSubmit({ label: '打光', prompt: lightingPrompt(s) }); onClose(); } catch { /* 已提示 */ } finally { setBusy(false); }
  };
  const stageState = {
    main: { azimuth: s.azimuth, elevation: s.elevation, intensity: s.brightness, color: s.color },
    rim: { enabled: s.rim, azimuth: s.rimAzimuth, elevation: s.rimElevation, intensity: s.rimBrightness, color: s.rimColor },
    active: source,
  };
  return (
    <Shell icon={Sun} title="打光" hint="调整光线，保留画面" busy={busy} onClose={onClose} className="is-light"
      onReset={() => { setS(DEFAULT_LIGHT); setSource('main'); }}
      footer={(
        <>
          <p className="mf-readout">{lightDirection(s.azimuth, s.elevation)}{s.rim ? ' · 已加轮廓光' : ''}</p>
          <button type="button" className="mf-primary is-lg" onClick={submit} disabled={busy || (s.preset === 'custom' && !s.desc.trim())}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />} 生成打光图
          </button>
        </>
      )}>
      <div className="mf-studio3d-main">
        <div className="mf-studio3d-left">
          <Stage3D kind="light" src={src} state={stageState} hint="拖动光球调整光位 · 拖动空白旋转视角 · 滚轮缩放"
            onDrag={(which, patch) => {
              if (which === 'rim') { setSource('rim'); set({ ...(patch.azimuth !== undefined && { rimAzimuth: patch.azimuth }), ...(patch.elevation !== undefined && { rimElevation: patch.elevation }) }); }
              else { setSource('main'); set(patch); }
            }} />
          <div className="mf-dir-row">
            {LIGHT_DIRECTIONS.map((d) => (
              <button key={d.id} type="button" disabled={busy} className={clsx('mf-dir', az === d.azimuth && el === d.elevation && 'is-on')}
                onClick={() => setDir({ azimuth: d.azimuth, elevation: d.elevation })}>
                {d.label}
              </button>
            ))}
          </div>
        </div>
        <div className="mf-studio3d-side">
          <div className="mf-tabs2">
            <button type="button" className={clsx(!editRim && 'is-on')} onClick={() => setSource('main')}>主光源</button>
            <button type="button" className={clsx(editRim && 'is-on')} onClick={() => { setSource('rim'); if (!s.rim) set({ rim: true }); }}>轮廓光源</button>
          </div>
          {editRim && !s.rim ? (
            <p className="mf-empty-note">轮廓光未启用，打开下方开关后可调整。</p>
          ) : (
            <>
              <Slider label="水平角" value={az} min={-180} max={180} unit="°" disabled={busy} onChange={(azimuth) => setDir({ azimuth })} />
              <Slider label="俯仰角" value={el} min={-60} max={85} unit="°" disabled={busy} onChange={(elevation) => setDir({ elevation })} />
              <Slider label="光照强度" value={editRim ? s.rimBrightness : s.brightness} min={0} max={100} unit="%" disabled={busy}
                onChange={(v) => set(editRim ? { rimBrightness: v } : { brightness: v })} />
              <div className="mf-field">
                <b>光线色彩</b>
                <ColorRow value={editRim ? s.rimColor : s.color} disabled={busy} onChange={(c) => set(editRim ? { rimColor: c } : { color: c })} />
              </div>
            </>
          )}
          <div className="mf-field is-row">
            <b>启用轮廓光</b>
            <Toggle label="启用轮廓光" checked={s.rim} disabled={busy} onChange={(rim) => { set({ rim }); setSource(rim ? 'rim' : 'main'); }} />
          </div>
        </div>
      </div>
      <div className="mf-section">
        <h4>光影预设</h4>
        <div className="mf-preset-cards">
          {LIGHT_PRESETS.map((p) => (
            <button key={p.id} type="button" disabled={busy} className={clsx('mf-preset-card', s.preset === p.id && 'is-on')} onClick={() => set({ preset: p.id })}>
              <i style={{ background: PRESET_LOOK[p.id] }} />
              <span>{p.label}</span>
            </button>
          ))}
        </div>
        <textarea className="mf-textarea" rows={2} value={s.desc} disabled={busy}
          placeholder={s.preset === 'custom' ? '描述想要的光影和氛围（必填）' : '补充描述光影、氛围或局部细节（可选）'}
          onChange={(e) => set({ desc: e.target.value })} />
      </div>
    </Shell>
  );
}

export function AngleStudio({ src, onClose, onSubmit }) {
  const [s, setS] = useState(DEFAULT_ANGLE);
  const [view, setView] = useState('orbit');
  const [busy, setBusy] = useState(false);
  const set = (patch) => setS((v) => ({ ...v, ...patch }));
  const preset = ANGLE_PRESETS.find((p) => p.azimuth === s.azimuth && p.elevation === s.elevation);
  const radius = (DISTANCES.find((d) => d.id === s.distance) || DISTANCES[1]).radius;
  const submit = async () => {
    setBusy(true);
    try { await onSubmit({ label: `多角度 · ${preset?.label || `${s.azimuth}°`}`, prompt: anglePrompt(s) }); onClose(); } catch { /* 已提示 */ } finally { setBusy(false); }
  };
  return (
    <Shell icon={SwitchCamera} title="多角度" hint="移动机位，重拍同一瞬间" busy={busy} onClose={onClose} className="is-angle"
      onReset={() => setS(DEFAULT_ANGLE)}
      footer={(
        <>
          <p className="mf-readout">水平 {s.azimuth}° · 俯仰 {s.elevation}° · {(DISTANCES.find((d) => d.id === s.distance) || DISTANCES[1]).label} · {s.lens === 'wide' ? '广角' : '标准镜头'}</p>
          <button type="button" className="mf-primary is-lg" onClick={submit} disabled={busy}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />} 生成新视角
          </button>
        </>
      )}>
      <div className="mf-angle-main">
        <aside className="mf-angle-presets">
          <h4>常用视角</h4>
          <div>
            {ANGLE_PRESETS.map((p) => (
              <button key={p.id} type="button" disabled={busy} className={clsx('mf-dir', preset?.id === p.id && 'is-on')}
                onClick={() => set({ azimuth: p.azimuth, elevation: p.elevation })}>
                {p.label}
              </button>
            ))}
          </div>
        </aside>
        <div className="mf-angle-stage">
          <div className="mf-angle-bar">
            <strong>{preset?.label || '自定义机位'}</strong>
            <div className="mf-tabs2 is-compact">
              <button type="button" className={clsx(view === 'orbit' && 'is-on')} onClick={() => setView('orbit')}>空间总览</button>
              <button type="button" className={clsx(view === 'camera' && 'is-on')} onClick={() => setView('camera')}>机位预览</button>
            </div>
          </div>
          <Stage3D kind="angle" src={src} view={view}
            state={{ azimuth: s.azimuth, elevation: s.elevation, radius, fov: LENS_FOV[s.lens] || 40 }}
            hint={view === 'orbit' ? '拖动相机调整机位 · 拖动空白旋转视角 · 滚轮缩放' : '从新机位看到的构图示意 · 拖动可环绕移动机位'}
            onDrag={(_, patch) => set(patch)} />
          <div className="mf-angle-controls">
            <Slider label="水平角" value={s.azimuth} min={-180} max={180} unit="°" disabled={busy} onChange={(azimuth) => set({ azimuth })} />
            <Slider label="俯仰角" value={s.elevation} min={-80} max={80} unit="°" disabled={busy} onChange={(elevation) => set({ elevation })} />
            <div className="mf-field">
              <b>景别</b>
              <div className="mf-tabs2 is-compact">
                {DISTANCES.map((d) => <button key={d.id} type="button" disabled={busy} className={clsx(s.distance === d.id && 'is-on')} onClick={() => set({ distance: d.id })}>{d.label}</button>)}
              </div>
            </div>
            <div className="mf-field">
              <b>镜头</b>
              <div className="mf-tabs2 is-compact">
                {[['standard', '标准'], ['wide', '广角']].map(([id, label]) => <button key={id} type="button" disabled={busy} className={clsx(s.lens === id && 'is-on')} onClick={() => set({ lens: id })}>{label}</button>)}
              </div>
            </div>
          </div>
          <textarea className="mf-textarea" rows={2} value={s.note} disabled={busy} placeholder="补充要求（可选），例如：人物看向镜头"
            onChange={(e) => set({ note: e.target.value })} />
        </div>
      </div>
    </Shell>
  );
}
