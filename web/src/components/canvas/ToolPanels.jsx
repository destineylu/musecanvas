import { useState } from 'react';
import { Grid2x2, Loader2, RotateCcw, Wand2, X } from 'lucide-react';
import { clsx } from 'clsx';

const stop = (e) => e.stopPropagation();

export function ToolPanel({ icon: Icon, title, hint, onClose, onReset, busy, style, children, footer, wide }) {
  return (
    <section
      className={clsx('mf-tool-panel', wide && 'is-wide')}
      style={style}
      onMouseDown={stop}
      onDoubleClick={stop}
      onWheel={stop}
      onKeyDown={stop}
      aria-label={title}
    >
      <header className="mf-tool-head">
        <div>
          <Icon size={16} />
          <strong>{title}</strong>
          {hint && <span>{hint}</span>}
        </div>
        <div>
          {onReset && (
            <button type="button" className="mf-ghost" onClick={onReset} disabled={busy} title="重置">
              <RotateCcw size={13} /> 重置
            </button>
          )}
          <button type="button" className="mf-icon-btn" onClick={onClose} disabled={busy} aria-label={`关闭${title}`}>
            <X size={15} />
          </button>
        </div>
      </header>
      <div className="mf-tool-body">{children}</div>
      {footer && <footer className="mf-tool-foot">{footer}</footer>}
    </section>
  );
}

export function GenerateButton({ busy, label = '生成', onClick, disabled }) {
  return (
    <button type="button" className="mf-primary" onClick={onClick} disabled={busy || disabled}>
      {busy ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
      {label}
    </button>
  );
}

export function GridSplitPanel({ style, src, onClose, onSubmit }) {
  const [rows, setRows] = useState(2);
  const [cols, setCols] = useState(2);
  const [busy, setBusy] = useState(false);
  const [ratio, setRatio] = useState(null);
  const clamp = (v) => Math.max(1, Math.min(8, Math.round(Number(v) || 1)));
  const submit = async () => {
    setBusy(true);
    try { await onSubmit({ rows, cols }); onClose(); } catch { /* toast already shown */ } finally { setBusy(false); }
  };
  return (
    <ToolPanel icon={Grid2x2} title="宫格切分" hint="保留原图，在本地切分" style={style} busy={busy} onClose={onClose}
      footer={(
        <button type="button" className="mf-primary" onClick={submit} disabled={busy || rows * cols < 2}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Grid2x2 size={14} />}
          切分为 {rows * cols} 张
        </button>
      )}>
      <div className="mf-grid-presets">
        {[2, 3, 4, 5].map((n) => (
          <button key={n} type="button" disabled={busy} className={clsx('mf-grid-preset', rows === n && cols === n && 'is-on')}
            onClick={() => { setRows(n); setCols(n); }}>
            <i style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}>{Array.from({ length: n * n }, (_, k) => <b key={k} />)}</i>
            <span>{n * n} 宫格</span>
          </button>
        ))}
      </div>
      <div className="mf-grid-custom">
        <label>行<input type="number" min={1} max={8} value={rows} disabled={busy} onChange={(e) => setRows(clamp(e.target.value))} /></label>
        <span>×</span>
        <label>列<input type="number" min={1} max={8} value={cols} disabled={busy} onChange={(e) => setCols(clamp(e.target.value))} /></label>
      </div>
      <div className="mf-grid-preview">
        {/* 网格叠在与图片同比例的框上，竖图 9:16 等比例也能对齐切分线。 */}
        <div className="mf-grid-frame" style={ratio ? (ratio >= 1.1 ? { width: '100%', aspectRatio: ratio } : { height: 280, aspectRatio: ratio }) : { height: 280 }}>
          <img src={src} alt="宫格切分预览" draggable={false} onLoad={(e) => setRatio(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight || 1)} />
          {ratio && (
            <div style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }} aria-hidden="true">
              {Array.from({ length: rows * cols }, (_, k) => <i key={k}><span>{k + 1}</span></i>)}
            </div>
          )}
        </div>
      </div>
    </ToolPanel>
  );
}
