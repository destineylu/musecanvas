import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, Loader2, Orbit, RotateCcw, X } from 'lucide-react';
import { canvasToFile } from './imageTools.js';

const SHOT_W = 1280;
const SHOT_H = 720;

const VERT = `
attribute vec2 p;
varying vec2 v;
void main() { v = p; gl_Position = vec4(p, 0.0, 1.0); }`;

// 每个像素求出视线方向，再按球面（等距柱状）或圆柱投影取样全景纹理。
const FRAG = `
precision highp float;
varying vec2 v;
uniform sampler2D tex;
uniform float yaw;
uniform float pitch;
uniform float tanHalf;
uniform float aspect;
uniform float mode;
uniform float halfH;
const float PI = 3.14159265359;
void main() {
  vec3 d = normalize(vec3(v.x * tanHalf * aspect, v.y * tanHalf, -1.0));
  float cp = cos(pitch), sp = sin(pitch);
  d = vec3(d.x, d.y * cp - d.z * sp, d.y * sp + d.z * cp);
  float cy = cos(yaw), sy = sin(yaw);
  d = vec3(d.x * cy - d.z * sy, d.y, d.x * sy + d.z * cy);
  float u = fract(atan(d.x, -d.z) / (2.0 * PI) + 0.5);
  float t;
  if (mode < 0.5) {
    t = 0.5 - asin(clamp(d.y, -1.0, 1.0)) / PI;
  } else {
    float h = d.y / max(length(d.xz), 1e-4);
    t = 0.5 - h / (2.0 * halfH);
    if (t < 0.0 || t > 1.0) { gl_FragColor = vec4(0.07, 0.08, 0.09, 1.0); return; }
  }
  gl_FragColor = texture2D(tex, vec2(u, t));
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || '着色器编译失败');
  return shader;
}

export default function PanoramaViewer({ src, initialMode = 'sphere', onClose, onCapture }) {
  const canvasRef = useRef(null);
  const glRef = useRef(null);
  const [mode, setMode] = useState(initialMode);
  const [cam, setCam] = useState({ yaw: 0, pitch: 0, fov: 75 });
  const [state, setState] = useState('loading');
  const [shot, setShot] = useState('single');
  const [busy, setBusy] = useState(false);
  const camRef = useRef(cam);
  camRef.current = cam;

  useEffect(() => {
    const canvas = canvasRef.current;
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: true });
    if (!gl) { setState('nogl'); return undefined; }
    let disposed = false;
    try {
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      const u = (name) => gl.getUniformLocation(prog, name);
      glRef.current = { gl, u: { yaw: u('yaw'), pitch: u('pitch'), tanHalf: u('tanHalf'), aspect: u('aspect'), mode: u('mode'), halfH: u('halfH') }, halfH: 0.78 };
    } catch {
      setState('nogl');
      return undefined;
    }
    const img = new Image();
    img.onload = () => {
      if (disposed) return;
      const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      let source = img;
      if (img.naturalWidth > max || img.naturalHeight > max) {
        const k = max / Math.max(img.naturalWidth, img.naturalHeight);
        const c = document.createElement('canvas');
        c.width = Math.floor(img.naturalWidth * k);
        c.height = Math.floor(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        source = c;
      }
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      glRef.current.halfH = Math.PI * (img.naturalHeight / img.naturalWidth);
      setState('ready');
    };
    img.onerror = () => !disposed && setState('error');
    img.src = src;
    return () => {
      disposed = true;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      glRef.current = null;
    };
  }, [src]);

  const draw = (c = camRef.current) => {
    const g = glRef.current;
    if (!g || state !== 'ready') return;
    const { gl, u } = g;
    gl.viewport(0, 0, SHOT_W, SHOT_H);
    gl.uniform1f(u.yaw, (c.yaw * Math.PI) / 180);
    gl.uniform1f(u.pitch, (c.pitch * Math.PI) / 180);
    gl.uniform1f(u.tanHalf, Math.tan((c.fov * Math.PI) / 360));
    gl.uniform1f(u.aspect, SHOT_W / SHOT_H);
    gl.uniform1f(u.mode, mode === 'sphere' ? 0 : 1);
    gl.uniform1f(u.halfH, g.halfH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  useEffect(() => { draw(); });

  const maxPitch = mode === 'sphere' ? 85 : 30;
  const setView = (patch) => setCam((c) => {
    const next = { ...c, ...patch };
    next.yaw = ((next.yaw % 360) + 540) % 360 - 180;
    next.pitch = Math.max(-maxPitch, Math.min(maxPitch, next.pitch));
    next.fov = Math.max(30, Math.min(110, next.fov));
    return next;
  });

  useEffect(() => {
    const onKey = (e) => {
      if (busy) return;
      if (e.key === 'Escape') onClose();
      const step = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, 5], ArrowDown: [0, -5] }[e.key];
      if (step) { e.preventDefault(); setView({ yaw: camRef.current.yaw + step[0], pitch: camRef.current.pitch + step[1] }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const drag = useRef(null);
  const onDown = (e) => {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 合成事件没有真实指针 */ }
    drag.current = { x: e.clientX, y: e.clientY, cam: camRef.current };
  };
  const onMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const degPerPx = d.cam.fov / rect.height;
    setView({ yaw: d.cam.yaw - (e.clientX - d.x) * degPerPx, pitch: d.cam.pitch + (e.clientY - d.y) * degPerPx });
  };

  const capture = async () => {
    setBusy(true);
    try {
      const views = shot === 'four'
        ? [0, 90, 180, 270].map((yaw) => ({ ...camRef.current, yaw: camRef.current.yaw + yaw }))
        : [camRef.current];
      const files = [];
      for (const [i, v] of views.entries()) {
        draw(v);
        const yaw = Math.round(((v.yaw % 360) + 360) % 360);
        files.push({ file: await canvasToFile(canvasRef.current, `全景截图-${i + 1}.png`), label: `全景截图 · ${yaw}°` });
      }
      draw();
      await onCapture(files);
      onClose();
    } catch { /* toast already shown */ } finally {
      setBusy(false);
    }
  };

  const title = mode === 'sphere' ? '720° 全景' : '360° 环绕';

  return createPortal((
    <div className="mf-modal" role="dialog" aria-modal="true" aria-label={`预览${title}`} onMouseDown={(e) => e.stopPropagation()}>
      <div className="mf-modal-card mf-pano">
        <header className="mf-tool-head">
          <div><Orbit size={16} /><strong>{title}</strong><span>预览与取景截图</span></div>
          <div>
            <div className="mf-segmented">
              <button type="button" className={mode === 'sphere' ? 'is-on' : ''} onClick={() => setMode('sphere')} disabled={busy}>720° 球面</button>
              <button type="button" className={mode === 'cylinder' ? 'is-on' : ''} onClick={() => { setMode('cylinder'); setView({ pitch: 0 }); }} disabled={busy}>360° 环绕</button>
            </div>
            <button type="button" className="mf-icon-btn" onClick={onClose} disabled={busy} aria-label="关闭全景预览"><X size={16} /></button>
          </div>
        </header>
        <div className="mf-pano-stage">
          <canvas
            ref={canvasRef}
            width={SHOT_W}
            height={SHOT_H}
            tabIndex={0}
            aria-label="全景预览，拖动或方向键旋转，滚轮缩放"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={() => { drag.current = null; }}
            onPointerCancel={() => { drag.current = null; }}
            onWheel={(e) => setView({ fov: camRef.current.fov + Math.sign(e.deltaY) * 4 })}
          />
          {state !== 'ready' && (
            <div className="mf-pano-status">
              {state === 'loading' ? <><Loader2 size={16} className="animate-spin" /> 正在加载全景图…</>
                : state === 'nogl' ? '当前浏览器无法启用 WebGL，不能预览全景' : '全景图加载失败'}
            </div>
          )}
          {state === 'ready' && <span className="mf-pano-hint">拖动旋转 · 滚轮缩放 · 16:9 取景</span>}
        </div>
        <footer className="mf-pano-foot">
          <span className="mf-readout">水平 {Math.round(cam.yaw)}° · 俯仰 {Math.round(cam.pitch)}°</span>
          <label className="mf-range is-inline">
            <span>视野</span>
            <input type="range" min={30} max={110} value={cam.fov} onChange={(e) => setView({ fov: Number(e.target.value) })} />
            <em>{Math.round(cam.fov)}°</em>
          </label>
          <button type="button" className="mf-ghost" onClick={() => setCam({ yaw: 0, pitch: 0, fov: 75 })} disabled={busy}><RotateCcw size={13} /> 重置</button>
          <div className="mf-segmented">
            <button type="button" className={shot === 'single' ? 'is-on' : ''} onClick={() => setShot('single')} disabled={busy}>当前视角</button>
            <button type="button" className={shot === 'four' ? 'is-on' : ''} onClick={() => setShot('four')} disabled={busy}>四方向</button>
          </div>
          <button type="button" className="mf-primary" onClick={capture} disabled={busy || state !== 'ready'}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />}
            截图到画布
          </button>
        </footer>
      </div>
    </div>
  ), document.body);
}
