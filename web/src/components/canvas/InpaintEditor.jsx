import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Brush, Eraser, Loader2, Trash2, Undo2, Wand2, X } from 'lucide-react';
import { clsx } from 'clsx';
import { canvasToFile, inpaintPrompt, loadImage } from './imageTools.js';

const MAX_SIDE = 2048;

/**
 * 局部重绘：在原图上涂抹要修改的区域。提交时把半透明红色标注合成进原图，
 * 作为唯一一张参考图交给 Bridge（Bridge 每个任务只接受一张参考图）。
 */
export default function InpaintEditor({ src, onClose, onSubmit }) {
  const maskRef = useRef(null);
  const imgRef = useRef(null);
  const drawing = useRef(null);
  const history = useRef([]);
  const [size, setSize] = useState(null);
  const [brush, setBrush] = useState(48);
  const [mode, setMode] = useState('brush');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [painted, setPainted] = useState(false);
  const [cursor, setCursor] = useState(null);

  useEffect(() => {
    let alive = true;
    loadImage(src).then((img) => {
      if (!alive) return;
      const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      imgRef.current = img;
      setSize({ w: Math.round(img.naturalWidth * k), h: Math.round(img.naturalHeight * k) });
    }).catch(() => alive && setSize({ error: true }));
    return () => { alive = false; };
  }, [src]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onClose();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); undo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const ctx = () => maskRef.current?.getContext('2d');
  const scale = () => {
    const rect = maskRef.current.getBoundingClientRect();
    return size.w / rect.width;
  };
  const toPoint = (e) => {
    const rect = maskRef.current.getBoundingClientRect();
    const k = size.w / rect.width;
    return { x: (e.clientX - rect.left) * k, y: (e.clientY - rect.top) * k };
  };
  const snapshot = () => {
    const c = ctx();
    if (!c) return;
    history.current.push(c.getImageData(0, 0, size.w, size.h));
    if (history.current.length > 25) history.current.shift();
  };
  const refreshPainted = () => {
    const data = ctx()?.getImageData(0, 0, size.w, size.h).data;
    let any = false;
    if (data) for (let i = 3; i < data.length; i += 16) if (data[i]) { any = true; break; }
    setPainted(any);
  };
  const stroke = (from, to) => {
    const c = ctx();
    c.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over';
    c.strokeStyle = '#ff2a2a';
    c.fillStyle = '#ff2a2a';
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.lineWidth = brush * scale();
    c.beginPath();
    c.moveTo(from.x, from.y);
    c.lineTo(to.x, to.y);
    c.stroke();
  };
  const down = (e) => {
    if (busy || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    snapshot();
    const p = toPoint(e);
    drawing.current = p;
    stroke(p, { x: p.x + 0.01, y: p.y });
  };
  const move = (e) => {
    const rect = maskRef.current.getBoundingClientRect();
    setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    if (!drawing.current) return;
    const p = toPoint(e);
    stroke(drawing.current, p);
    drawing.current = p;
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = null;
    refreshPainted();
  };
  function undo() {
    const last = history.current.pop();
    if (!last || !ctx()) return;
    ctx().putImageData(last, 0, 0);
    refreshPainted();
  }
  const clear = () => {
    snapshot();
    ctx().clearRect(0, 0, size.w, size.h);
    setPainted(false);
  };

  const submit = async () => {
    if (!painted || prompt.trim().length < 2) return;
    setBusy(true);
    try {
      const out = document.createElement('canvas');
      out.width = size.w;
      out.height = size.h;
      const c = out.getContext('2d');
      c.drawImage(imgRef.current, 0, 0, size.w, size.h);
      c.globalAlpha = 0.55;
      c.drawImage(maskRef.current, 0, 0);
      const file = await canvasToFile(out, 'inpaint-guide.jpg', 'image/jpeg', 0.92);
      out.width = out.height = 0;
      await onSubmit({ file, prompt: inpaintPrompt(prompt) });
      onClose();
    } catch { /* toast already shown */ } finally {
      setBusy(false);
    }
  };

  return createPortal((
    <div className="mf-modal" role="dialog" aria-modal="true" aria-label="局部重绘" onMouseDown={(e) => e.stopPropagation()}>
      <div className="mf-modal-card mf-inpaint">
        <header className="mf-tool-head">
          <div><Brush size={16} /><strong>局部重绘</strong><span>涂抹需要修改的区域，再描述修改内容</span></div>
          <button type="button" className="mf-icon-btn" onClick={onClose} disabled={busy} aria-label="关闭局部重绘"><X size={16} /></button>
        </header>
        <div className="mf-inpaint-stage">
          {!size ? <Loader2 className="animate-spin" /> : size.error ? <p>图片加载失败</p> : (
            <div className="mf-inpaint-frame" style={{ aspectRatio: `${size.w} / ${size.h}` }}>
              <img src={src} alt="原图" draggable={false} />
              <canvas
                ref={maskRef}
                width={size.w}
                height={size.h}
                onPointerDown={down}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={up}
                onPointerLeave={() => setCursor(null)}
              />
              {cursor && (
                <span className={clsx('mf-brush-cursor', mode === 'erase' && 'is-erase')}
                  style={{ left: cursor.x, top: cursor.y, width: brush, height: brush }} />
              )}
            </div>
          )}
        </div>
        <div className="mf-inpaint-tools">
          <div className="mf-segmented">
            <button type="button" className={clsx(mode === 'brush' && 'is-on')} onClick={() => setMode('brush')} disabled={busy}><Brush size={13} /> 涂抹</button>
            <button type="button" className={clsx(mode === 'erase' && 'is-on')} onClick={() => setMode('erase')} disabled={busy}><Eraser size={13} /> 擦除</button>
          </div>
          <label className="mf-range is-inline">
            <span>笔刷</span>
            <input type="range" min={8} max={160} value={brush} disabled={busy} onChange={(e) => setBrush(Number(e.target.value))} />
            <em>{brush}px</em>
          </label>
          <button type="button" className="mf-ghost" onClick={undo} disabled={busy}><Undo2 size={13} /> 撤销</button>
          <button type="button" className="mf-ghost" onClick={clear} disabled={busy || !painted}><Trash2 size={13} /> 清空</button>
        </div>
        <footer className="mf-inpaint-foot">
          <textarea
            className="mf-textarea"
            rows={2}
            value={prompt}
            disabled={busy}
            placeholder="描述涂抹区域要变成什么，例如：把杯子换成一束白色郁金香"
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); }}
          />
          <button type="button" className="mf-primary" onClick={submit} disabled={busy || !painted || prompt.trim().length < 2}
            title={!painted ? '先涂抹需要修改的区域' : prompt.trim().length < 2 ? '请输入重绘提示词' : 'Ctrl+Enter 提交'}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
            重绘
          </button>
        </footer>
      </div>
    </div>
  ), document.body);
}
