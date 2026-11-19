import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Box, Camera, Circle, Clapperboard, Copy, Cone, Cylinder, Download, Eye, Grid3x3, Image as ImageIcon, Loader2, Move3d,
  Diamond, Film, Pause, PersonStanding, Play, Plus, RectangleVertical, Rotate3d, Save, Scale3d, Sparkles, Trash2, Undo2, Video, X, CircleHelp,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { clsx } from 'clsx';
import { JOINTS, POSES, applyPose, buildMannequin, setMannequinColor } from './mannequin.js';
import {
  DEFAULT_ANIMATION, cameraAt, cameraTimes, objectsAt, pickVideoType, snapshotObject, upsertKey,
} from './animation.js';
import './director.css';

const DEG = Math.PI / 180;
const RATIOS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '2.39:1': 2.39 };
const SKIES = [
  { id: 'studio', label: '摄影棚', sky: '#c9d0d8', ground: '#aeb6bf' },
  { id: 'day', label: '晴天', sky: '#9fc9ee', ground: '#8fa486' },
  { id: 'dusk', label: '黄昏', sky: '#e6a47a', ground: '#7a6253' },
  { id: 'night', label: '夜晚', sky: '#121829', ground: '#1f2433' },
  { id: 'white', label: '纯白', sky: '#f3f3f3', ground: '#e2e2e2' },
  { id: 'black', label: '纯黑', sky: '#0a0a0b', ground: '#1a1a1c' },
];
const KINDS = {
  mannequin: { label: '人偶', icon: PersonStanding, color: '#d9d4cc' },
  box: { label: '方块', icon: Box, color: '#8aa0b8' },
  sphere: { label: '球体', icon: Circle, color: '#c99a7a' },
  cylinder: { label: '圆柱', icon: Cylinder, color: '#9db394' },
  cone: { label: '圆锥', icon: Cone, color: '#b9a0c9' },
  wall: { label: '墙面', icon: RectangleVertical, color: '#b8b2a6' },
  image: { label: '图片板', icon: ImageIcon, color: '#ffffff' },
};

let seq = 1;
const uid = (p) => `${p}_${Date.now().toString(36)}_${seq++}`;

export function defaultDirector() {
  return {
    version: 1,
    objects: [{ id: uid('obj'), kind: 'mannequin', name: '人偶 1', color: KINDS.mannequin.color, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pose: {} }],
    keyframes: [],
    shot: { position: [0.6, 1.45, 4.2], yaw: 8, pitch: -6, fov: 42 },
    settings: { ratio: '16:9', grid: true, sky: 'studio', sunAzimuth: -35, sunElevation: 50, sunIntensity: 70 },
    animation: { ...DEFAULT_ANIMATION },
  };
}

function normalize(data) {
  const base = defaultDirector();
  if (!data || !Array.isArray(data.objects)) return base;
  return { ...base, ...data, settings: { ...base.settings, ...(data.settings || {}) }, shot: { ...base.shot, ...(data.shot || {}) }, keyframes: data.keyframes || [], animation: { ...DEFAULT_ANIMATION, ...(data.animation || {}), objectKeys: { ...(data.animation?.objectKeys || {}) } } };
}

function NumberRow({ label, values, step = 0.05, onChange, digits = 2 }) {
  return (
    <div className="dr-numrow">
      <span>{label}</span>
      {['X', 'Y', 'Z'].map((axis, i) => (
        <label key={axis}>
          <i>{axis}</i>
          <input type="number" step={step} value={Number(values[i]).toFixed(digits).replace(/\.?0+$/, '') || 0}
            onChange={(e) => { const v = [...values]; v[i] = Number(e.target.value) || 0; onChange(v); }} />
        </label>
      ))}
    </div>
  );
}

function JointSlider({ axis, value, onChange }) {
  return (
    <label className="dr-joint-slider">
      <i>{axis}</i>
      <input type="range" min={-180} max={180} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <em>{Math.round(value)}°</em>
    </label>
  );
}

/**
 * 3D 导演台（第一阶段：手动布景与取景，不调用 AI）。
 * props.images: 画布上可作为图片板的图片 [{ url, label }]
 * onSave(data, previewDataUrl) 保存到节点；onExport([{ file, label, width, height }]) 导出到画布。
 */
export default function DirectorStage({ title, canvasId, initial, images = [], onSave, onExport, onExportVideo, onClose }) {
  const [data, setData] = useState(() => normalize(initial));
  const [selectedId, setSelectedId] = useState(null);
  const [joint, setJoint] = useState('rightShoulder');
  const [view, setView] = useState('edit');
  const [tmode, setTmode] = useState('translate');
  const [flying, setFlying] = useState(false);
  const [activeKey, setActiveKey] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [imageMenu, setImageMenu] = useState(false);
  const [ready, setReady] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [ai, setAi] = useState({ prompt: '', ref: '', mode: 'new', busy: false, error: '', note: '' });
  const [undo, setUndo] = useState(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState(null);
  const playheadRef = useRef(null);
  const timeLabelRef = useRef(null);
  const hostRef = useRef(null);
  const engine = useRef(null);
  const dataRef = useRef(data);
  const viewRef = useRef(view);
  const selRef = useRef(selectedId);
  dataRef.current = data;
  viewRef.current = view;
  selRef.current = selectedId;

  const patch = useCallback((fn) => setData((d) => fn(d)), []);
  const patchObject = useCallback((id, p) => setData((d) => ({ ...d, objects: d.objects.map((o) => (o.id === id ? { ...o, ...p } : o)) })), []);
  const selected = data.objects.find((o) => o.id === selectedId) || null;
  const ratio = RATIOS[data.settings.ratio] || 16 / 9;

  /* ----------------------------- three.js 引擎 ----------------------------- */
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    (async () => {
      const THREE = await import('three');
      const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
      const { TransformControls } = await import('three/examples/jsm/controls/TransformControls.js');
      const host = hostRef.current;
      if (disposed || !host) return;

      const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.domElement.className = 'dr-canvas';
      host.prepend(renderer.domElement);

      const scene = new THREE.Scene();
      const editCam = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
      editCam.position.set(5.5, 4.2, 7.5);
      const shotCam = new THREE.PerspectiveCamera(42, ratio, 0.05, 200);
      shotCam.rotation.order = 'YXZ';

      const hemi = new THREE.HemisphereLight(0xffffff, 0x666a70, 0.9);
      const sun = new THREE.DirectionalLight(0xffffff, 2);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 0.5, far: 60 });
      sun.shadow.bias = -0.0004;
      scene.add(hemi, sun, sun.target);

      const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0xaeb6bf, roughness: 1 }));
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      ground.userData.ground = true;
      scene.add(ground);
      const grid = new THREE.GridHelper(40, 40, 0x6d7580, 0x8d959f);
      grid.material.transparent = true;
      grid.material.opacity = 0.35;
      grid.position.y = 0.002;
      scene.add(grid);

      // 编辑视图里显示取景相机
      const helpers = new THREE.Group();
      scene.add(helpers);
      const proxy = new THREE.PerspectiveCamera(42, ratio, 0.1, 0.9);
      proxy.rotation.order = 'YXZ';
      const camHelper = new THREE.CameraHelper(proxy);
      const camBody = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.16, 0.24), new THREE.MeshBasicMaterial({ color: 0x5fd6b1 }));
      helpers.add(camHelper, camBody);

      const orbit = new OrbitControls(editCam, renderer.domElement);
      orbit.target.set(0, 0.9, 0);
      orbit.enableDamping = true;
      orbit.maxPolarAngle = Math.PI * 0.495;
      orbit.update();

      const transform = new TransformControls(editCam, renderer.domElement);
      transform.setSize(0.85);
      const tHelper = transform.getHelper();
      scene.add(tHelper);
      transform.addEventListener('dragging-changed', (e) => { orbit.enabled = !e.value; });
      transform.addEventListener('objectChange', () => {
        const obj = transform.object;
        if (!obj) return;
        const id = obj.userData.objectId;
        setData((d) => ({
          ...d,
          objects: d.objects.map((o) => (o.id === id ? {
            ...o,
            position: obj.position.toArray().map((v) => Math.round(v * 1000) / 1000),
            rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z].map((v) => Math.round((v / DEG) * 10) / 10),
            scale: obj.scale.toArray().map((v) => Math.round(v * 1000) / 1000),
          } : o)),
        }));
      });

      const items = new Map(); // id -> { kind, obj, rig?, src? }
      const texLoader = new THREE.TextureLoader();
      const makeObject = (o) => {
        let obj;
        let rig = null;
        const mat = () => new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.7 });
        if (o.kind === 'mannequin') {
          rig = buildMannequin(THREE, o.color);
          obj = rig.root;
        } else if (o.kind === 'image') {
          obj = new THREE.Group();
          const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, side: THREE.DoubleSide });
          const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
          plane.castShadow = true;
          obj.add(plane);
          texLoader.load(o.src, (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            m.map = tex;
            m.needsUpdate = true;
            const a = tex.image.width / tex.image.height || 1;
            const h = 2;
            plane.scale.set(h * a, h, 1);
            plane.position.y = h / 2;
          });
          plane.scale.set(2, 2, 1);
          plane.position.y = 1;
        } else {
          const geo = {
            box: () => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
            sphere: () => new THREE.SphereGeometry(0.5, 32, 20).translate(0, 0.5, 0),
            cylinder: () => new THREE.CylinderGeometry(0.4, 0.4, 1, 32).translate(0, 0.5, 0),
            cone: () => new THREE.ConeGeometry(0.45, 1, 32).translate(0, 0.5, 0),
            wall: () => new THREE.BoxGeometry(3, 2.4, 0.12).translate(0, 1.2, 0),
          }[o.kind]();
          obj = new THREE.Mesh(geo, mat());
          obj.castShadow = true;
          obj.receiveShadow = true;
        }
        obj.userData.objectId = o.id;
        obj.traverse((c) => { c.userData.objectId = o.id; });
        scene.add(obj);
        return { kind: o.kind, obj, rig, src: o.src, color: o.color };
      };

      const sync = (d) => {
        const ids = new Set(d.objects.map((o) => o.id));
        for (const [id, it] of items) {
          if (!ids.has(id)) {
            if (transform.object === it.obj) transform.detach();
            scene.remove(it.obj);
            items.delete(id);
          }
        }
        for (const o of d.objects) {
          let it = items.get(o.id);
          if (!it) { it = makeObject(o); items.set(o.id, it); }
          if (!(transform.dragging && transform.object === it.obj)) {
            it.obj.position.fromArray(o.position);
            it.obj.rotation.set(o.rotation[0] * DEG, o.rotation[1] * DEG, o.rotation[2] * DEG);
            it.obj.scale.fromArray(o.scale);
          }
          if (it.color !== o.color) {
            it.color = o.color;
            if (it.rig) setMannequinColor(it.rig, o.color, THREE);
            else if (o.kind !== 'image') it.obj.material.color.set(o.color);
          }
          if (it.rig) applyPose(it.rig, o.pose);
        }
        const s = d.settings;
        const sky = SKIES.find((k) => k.id === s.sky) || SKIES[0];
        scene.background = new THREE.Color(sky.sky);
        ground.material.color.set(sky.ground);
        grid.visible = s.grid;
        const az = s.sunAzimuth * DEG;
        const el = s.sunElevation * DEG;
        sun.position.set(Math.sin(az) * Math.cos(el) * 20, Math.sin(el) * 20, Math.cos(az) * Math.cos(el) * 20);
        sun.intensity = 0.3 + (s.sunIntensity / 100) * 3;
        hemi.intensity = s.sky === 'night' ? 0.35 : 0.9;
        const r = RATIOS[s.ratio] || 16 / 9;
        if (!fly.active) applyShot(d.shot);
        shotCam.aspect = r;
        proxy.aspect = r;
        shotCam.updateProjectionMatrix();
        proxy.updateProjectionMatrix();
      };

      // 取景相机（飞行）
      const fly = { active: false, keys: new Set(), yaw: 0, pitch: 0 };
      const applyShot = (shot) => {
        shotCam.position.fromArray(shot.position);
        fly.yaw = shot.yaw;
        fly.pitch = shot.pitch;
        shotCam.rotation.set(shot.pitch * DEG, shot.yaw * DEG, 0);
        shotCam.fov = shot.fov;
        shotCam.updateProjectionMatrix();
      };
      const readShot = () => ({
        position: shotCam.position.toArray().map((v) => Math.round(v * 1000) / 1000),
        yaw: Math.round(fly.yaw * 10) / 10,
        pitch: Math.round(fly.pitch * 10) / 10,
        fov: Math.round(shotCam.fov),
      });

      const frameRect = () => {
        const w = host.clientWidth;
        const h = host.clientHeight;
        const r = shotCam.aspect;
        const pad = 24;
        let fw = w - pad * 2;
        let fh = fw / r;
        if (fh > h - pad * 2) { fh = h - pad * 2; fw = fh * r; }
        return { x: (w - fw) / 2, y: (h - fh) / 2, w: fw, h: fh };
      };

      const resize = () => {
        const w = host.clientWidth || 1;
        const h = host.clientHeight || 1;
        renderer.setSize(w, h);
        editCam.aspect = w / h;
        editCam.updateProjectionMatrix();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(host);
      resize();

      // 选择：点击（非拖动）拾取物体与人偶关节
      const ray = new THREE.Raycaster();
      const ndc = new THREE.Vector2();
      let down = null;
      const canvas = renderer.domElement;
      const onDown = (e) => {
        down = { x: e.clientX, y: e.clientY, button: e.button };
        if (fly.active) {
          e.preventDefault();
          if (e.button === 2) captureKeyframe();
          else if (e.button === 0) document.exitPointerLock();
        }
      };
      const onUp = (e) => {
        if (!down || fly.active) { down = null; return; }
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
        const button = down.button;
        down = null;
        if (moved || button !== 0) return;
        if (viewRef.current === 'shot') {
          canvas.requestPointerLock?.();
          return;
        }
        if (transform.dragging || transform.axis) return;
        const rect = canvas.getBoundingClientRect();
        ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        ray.setFromCamera(ndc, editCam);
        const hits = ray.intersectObjects([...items.values()].map((it) => it.obj), true);
        const hit = hits.find((h) => h.object.visible);
        if (!hit) { setSelectedId(null); return; }
        setSelectedId(hit.object.userData.objectId);
        if (hit.object.userData.joint) setJoint(hit.object.userData.joint);
      };
      const onContext = (e) => e.preventDefault();
      const onMove = (e) => {
        if (!fly.active) return;
        fly.yaw -= e.movementX * 0.12;
        fly.pitch = Math.max(-85, Math.min(85, fly.pitch - e.movementY * 0.12));
        shotCam.rotation.set(fly.pitch * DEG, fly.yaw * DEG, 0);
      };
      const onWheel = (e) => {
        if (viewRef.current !== 'shot') return;
        e.preventDefault();
        shotCam.fov = Math.max(12, Math.min(100, shotCam.fov + Math.sign(e.deltaY) * 2));
        shotCam.updateProjectionMatrix();
        if (!fly.active) setData((d) => ({ ...d, shot: { ...d.shot, fov: Math.round(shotCam.fov) } }));
      };
      const onLock = () => {
        fly.active = document.pointerLockElement === canvas;
        setFlying(fly.active);
        if (!fly.active) {
          fly.keys.clear();
          setData((d) => ({ ...d, shot: readShot() }));
        }
      };
      const onKey = (e) => {
        if (!fly.active) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.type === 'keydown') fly.keys.add(e.code); else fly.keys.delete(e.code);
      };
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('contextmenu', onContext);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      document.addEventListener('mousemove', onMove);
      document.addEventListener('pointerlockchange', onLock);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('keyup', onKey, true);

      // 渲染
      const withHelpersHidden = (fn) => {
        const vis = [helpers.visible, tHelper.visible];
        helpers.visible = false;
        tHelper.visible = false;
        fn();
        helpers.visible = vis[0];
        tHelper.visible = vis[1];
      };
      const snapshot = (width, quality) => {
        // 以指定尺寸渲染取景相机画面，返回 2D canvas
        const r = shotCam.aspect;
        const W = Math.round(width);
        const H = Math.round(width / r);
        const prevRatio = renderer.getPixelRatio();
        const size = renderer.getSize(new THREE.Vector2());
        renderer.setPixelRatio(1);
        renderer.setSize(W, H, false);
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, W, H);
        const gridVis = grid.visible;
        if (quality === 'export') grid.visible = false;
        withHelpersHidden(() => renderer.render(scene, shotCam));
        grid.visible = gridVis;
        const out = document.createElement('canvas');
        out.width = W;
        out.height = H;
        out.getContext('2d').drawImage(renderer.domElement, 0, 0, W, H, 0, 0, W, H);
        renderer.setPixelRatio(prevRatio);
        renderer.setSize(size.x, size.y);
        return out;
      };
      function captureKeyframe() {
        const shot = readShot();
        const thumb = snapshot(240, 'thumb').toDataURL('image/jpeg', 0.72);
        const key = { id: uid('key'), ...shot, thumb };
        setData((d) => ({ ...d, shot, keyframes: [...d.keyframes, key] }));
        setActiveKey(key.id);
        host.classList.add('is-flash');
        setTimeout(() => host.classList.remove('is-flash'), 180);
      }

      // 动画：播放时只改三维对象，不写回 React 状态；停止后再由 sync 还原
      const play = { playing: false, exporting: false, start: 0, from: 0, onTime: null, onEnd: null };
      const applyFrame = (d, t) => {
        const anim = d.animation || DEFAULT_ANIMATION;
        const objs = objectsAt(d.objects, anim.objectKeys, t);
        for (const o of objs) {
          const it = items.get(o.id);
          if (!it) continue;
          it.obj.position.fromArray(o.position);
          it.obj.rotation.set(o.rotation[0] * DEG, o.rotation[1] * DEG, o.rotation[2] * DEG);
          it.obj.scale.fromArray(o.scale);
          if (it.rig) applyPose(it.rig, o.pose);
        }
        if (anim.cameraFollow && d.keyframes.length >= 2) {
          const c = cameraAt(d.keyframes, anim.duration, t);
          if (c) applyShot(c);
        }
      };
      const recordVideo = ({ width, fps, type, onProgress }) => new Promise((resolve, reject) => {
        const d = dataRef.current;
        const duration = d.animation?.duration || 5;
        const r = shotCam.aspect;
        const W = Math.round(width / 2) * 2;
        const H = Math.round(width / r / 2) * 2;
        const out = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        out.outputColorSpace = THREE.SRGBColorSpace;
        out.shadowMap.enabled = true;
        out.shadowMap.type = THREE.PCFSoftShadowMap;
        out.setPixelRatio(1);
        out.setSize(W, H, false);
        const stream = out.domElement.captureStream(fps);
        let recorder;
        try {
          recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 10_000_000 });
        } catch (error) {
          out.dispose();
          reject(error);
          return;
        }
        const chunks = [];
        recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        const finish = () => {
          play.exporting = false;
          out.dispose();
          out.forceContextLoss();
          sync(dataRef.current);
        };
        recorder.onstop = () => { finish(); resolve({ blob: new Blob(chunks, { type: type.split(';')[0] }), width: W, height: H }); };
        recorder.onerror = (e) => { finish(); reject(e.error || new Error('视频录制失败')); };
        play.exporting = true;
        play.playing = false;
        const gridVis = grid.visible;
        let begin = 0;
        const step = (now) => {
          if (!begin) begin = now;
          const t = Math.min(duration, (now - begin) / 1000);
          applyFrame(d, t);
          grid.visible = false;
          withHelpersHidden(() => out.render(scene, shotCam));
          grid.visible = gridVis;
          onProgress?.(t / duration);
          if (t >= duration) {
            setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), 1000 / fps + 60);
            return;
          }
          requestAnimationFrame(step);
        };
        recorder.start(250);
        requestAnimationFrame(step);
      });

      const clock = new THREE.Clock();
      const dir = new THREE.Vector3();
      let frame = 0;
      const tick = () => {
        frame = requestAnimationFrame(tick);
        const dt = Math.min(0.05, clock.getDelta());
        if (play.exporting) return;
        if (play.playing) {
          const d = dataRef.current;
          const duration = d.animation?.duration || 5;
          let t = play.from + (performance.now() - play.start) / 1000;
          if (t >= duration) {
            t = duration;
            play.playing = false;
            play.onEnd?.(t);
          }
          applyFrame(d, t);
          play.onTime?.(t);
        }
        if (fly.active && fly.keys.size) {
          const speed = (fly.keys.has('ShiftLeft') && fly.keys.has('ControlLeft') ? 6 : 2.4) * dt;
          shotCam.getWorldDirection(dir);
          const fwd = new THREE.Vector3(dir.x, 0, dir.z).normalize();
          const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
          if (fly.keys.has('KeyW')) shotCam.position.addScaledVector(fwd, speed);
          if (fly.keys.has('KeyS')) shotCam.position.addScaledVector(fwd, -speed);
          if (fly.keys.has('KeyD')) shotCam.position.addScaledVector(right, speed);
          if (fly.keys.has('KeyA')) shotCam.position.addScaledVector(right, -speed);
          if (fly.keys.has('Space')) shotCam.position.y += speed;
          if (fly.keys.has('ShiftLeft') || fly.keys.has('ShiftRight')) shotCam.position.y = Math.max(0.05, shotCam.position.y - speed);
        }
        proxy.position.copy(shotCam.position);
        proxy.rotation.copy(shotCam.rotation);
        proxy.fov = shotCam.fov;
        proxy.updateProjectionMatrix();
        proxy.updateMatrixWorld();
        camHelper.update();
        camBody.position.copy(shotCam.position);
        camBody.rotation.copy(shotCam.rotation);

        const w = host.clientWidth;
        const h = host.clientHeight;
        if (viewRef.current === 'shot') {
          orbit.enabled = false;
          tHelper.visible = false;
          helpers.visible = false;
          const f = frameRect();
          renderer.setScissorTest(true);
          renderer.setScissor(0, 0, w, h);
          renderer.setViewport(0, 0, w, h);
          renderer.setClearColor(0x0b0c0e, 1);
          renderer.clear();
          renderer.setScissor(f.x, h - f.y - f.h, f.w, f.h);
          renderer.setViewport(f.x, h - f.y - f.h, f.w, f.h);
          renderer.render(scene, shotCam);
          renderer.setScissorTest(false);
          host.style.setProperty('--fx', `${f.x}px`);
          host.style.setProperty('--fy', `${f.y}px`);
          host.style.setProperty('--fw', `${f.w}px`);
          host.style.setProperty('--fh', `${f.h}px`);
        } else {
          orbit.enabled = !transform.dragging;
          orbit.update();
          helpers.visible = true;
          tHelper.visible = !!transform.object;
          renderer.setViewport(0, 0, w, h);
          renderer.render(scene, editCam);
        }
      };

      engine.current = {
        sync,
        attach: (id) => {
          const it = id && items.get(id);
          if (it) transform.attach(it.obj); else transform.detach();
        },
        setMode: (m) => transform.setMode(m),
        applyShot: (shot) => applyShot(shot),
        exportFrames: (keys, width) => keys.map((k) => {
          applyShot(k);
          return snapshot(width, 'export');
        }),
        restoreShot: () => applyShot(dataRef.current.shot),
        play: (from, onTime, onEnd) => {
          transform.detach();
          Object.assign(play, { playing: true, from, start: performance.now(), onTime, onEnd });
        },
        stop: () => { play.playing = false; },
        recordVideo,
        focus: (id) => {
          const it = items.get(id);
          if (!it) return;
          const box = new THREE.Box3().setFromObject(it.obj);
          const c = box.getCenter(new THREE.Vector3());
          const off = editCam.position.clone().sub(orbit.target);
          orbit.target.copy(c);
          editCam.position.copy(c).add(off);
        },
      };
      sync(dataRef.current);
      tick();
      setReady(true);

      cleanup = () => {
        cancelAnimationFrame(frame);
        ro.disconnect();
        if (document.pointerLockElement === canvas) document.exitPointerLock();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('pointerlockchange', onLock);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('keyup', onKey, true);
        transform.detach();
        transform.dispose();
        orbit.dispose();
        scene.traverse((o) => {
          o.geometry?.dispose?.();
          const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
          mats.forEach((m) => { m.map?.dispose?.(); m.dispose(); });
        });
        renderer.dispose();
        renderer.forceContextLoss();
        canvas.remove();
        engine.current = null;
      };
    })();
    return () => { disposed = true; cleanup(); };
  // 引擎只在打开时创建一次，之后通过 sync 同步数据
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { engine.current?.sync(data); }, [data, ready]);
  useEffect(() => { engine.current?.attach(view === 'edit' ? selectedId : null); }, [selectedId, view, ready]);
  useEffect(() => { engine.current?.setMode(tmode); }, [tmode, ready]);

  // 导演台打开期间，键盘事件不传到画布（避免 Delete 删除画布节点等）
  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      e.stopPropagation();
      if (typing || e.type !== 'keydown' || document.pointerLockElement) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selRef.current) {
        e.preventDefault();
        removeObject(selRef.current);
      }
      if (viewRef.current === 'edit' && ['1', '2', '3'].includes(e.key)) setTmode(['translate', 'rotate', 'scale'][Number(e.key) - 1]);
      if (e.key.toLowerCase() === 'f' && selRef.current) engine.current?.focus(selRef.current);
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      if (e.key.toLowerCase() === 'k') recordKeys();
    };
    const block = (e) => e.stopPropagation();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', block, true);
    window.addEventListener('paste', block, true);
    window.addEventListener('copy', block, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', block, true);
      window.removeEventListener('paste', block, true);
      window.removeEventListener('copy', block, true);
    };
  });

  /* ------------------------------- 物体操作 ------------------------------- */
  const addObject = (kind, extra = {}) => {
    const count = data.objects.filter((o) => o.kind === kind).length + 1;
    const offset = data.objects.length ? ((data.objects.length % 5) - 2) * 0.9 : 0;
    const o = {
      id: uid('obj'), kind, name: `${extra.label || KINDS[kind].label} ${count}`, color: KINDS[kind].color,
      position: [offset, 0, kind === 'wall' || kind === 'image' ? -2 : 0.6], rotation: [0, 0, 0], scale: [1, 1, 1],
      ...(kind === 'mannequin' ? { pose: {} } : {}), ...(extra.src ? { src: extra.src } : {}),
    };
    setData((d) => ({ ...d, objects: [...d.objects, o] }));
    setSelectedId(o.id);
    setView('edit');
    setImageMenu(false);
  };
  function removeObject(id) {
    setData((d) => ({ ...d, objects: d.objects.filter((o) => o.id !== id) }));
    setSelectedId(null);
  }
  const duplicate = (o) => {
    const copy = { ...o, id: uid('obj'), name: `${o.name} 副本`, position: [o.position[0] + 0.8, o.position[1], o.position[2]], pose: o.pose ? { ...o.pose } : undefined };
    setData((d) => ({ ...d, objects: [...d.objects, copy] }));
    setSelectedId(copy.id);
  };
  const setJointAxis = (axis, value) => {
    if (!selected) return;
    const cur = selected.pose?.[joint] || [0, 0, 0];
    const next = [...cur];
    next[axis] = value;
    patchObject(selected.id, { pose: { ...selected.pose, [joint]: next } });
  };

  /* ------------------------------- AI 布景 ------------------------------- */
  const sceneSummary = () => ({
    settings: data.settings,
    objects: data.objects.filter((o) => o.kind !== 'image').map((o) => ({
      kind: o.kind, name: o.name, color: o.color, position: o.position, rotationY: o.rotation[1],
      ...(o.kind === 'mannequin' ? { pose: o.pose } : { size: o.scale }),
    })),
  });
  const runAi = async () => {
    if (ai.prompt.trim().length < 2 || ai.busy) return;
    setAi((v) => ({ ...v, busy: true, error: '', note: '' }));
    try {
      const { plan } = await api.directorPlan({
        canvasId, prompt: ai.prompt, referenceImage: ai.ref || undefined,
        current: ai.mode === 'edit' ? sceneSummary() : undefined,
      });
      const before = dataRef.current;
      const presetPose = (id, extra) => ({ ...JSON.parse(JSON.stringify(POSES.find((p) => p.id === id)?.pose || {})), ...(extra || {}) });
      const objectKeys = {};
      const objects = plan.objects.map((o, i) => {
        const obj = {
          id: uid('obj'), kind: o.kind, name: o.name || `${KINDS[o.kind].label} ${i + 1}`, color: o.color,
          position: o.position, rotation: o.rotation, scale: o.scale,
          ...(o.kind === 'mannequin' ? { pose: presetPose(o.posePreset, o.pose) } : {}),
        };
        if (o.keys?.length >= 2) {
          objectKeys[obj.id] = o.keys.map((k) => ({
            t: k.t, position: k.position, rotation: [0, k.rotationY, 0], scale: o.scale,
            ...(o.kind === 'mannequin' ? { pose: presetPose(k.posePreset, k.pose) } : {}),
          }));
          const first = objectKeys[obj.id][0];
          Object.assign(obj, { position: first.position, rotation: first.rotation, ...(first.pose ? { pose: first.pose } : {}) });
        }
        return obj;
      });
      const boards = ai.mode === 'edit' ? before.objects.filter((o) => o.kind === 'image') : [];
      const keys = plan.shots.map((shot) => {
        const dx = shot.target[0] - shot.position[0];
        const dy = shot.target[1] - shot.position[1];
        const dz = shot.target[2] - shot.position[2];
        return {
          id: uid('key'), position: shot.position, fov: Math.round(shot.fov),
          yaw: Math.round((Math.atan2(-dx, -dz) / DEG) * 10) / 10,
          pitch: Math.round((Math.atan2(dy, Math.hypot(dx, dz)) / DEG) * 10) / 10,
          name: shot.name, note: shot.note,
          ...(Number.isFinite(shot.t) ? { t: shot.t } : {}),
        };
      });
      setUndo(before);
      setData({
        ...before,
        objects: [...objects, ...boards],
        settings: { ...before.settings, ...plan.settings },
        animation: {
          ...(before.animation || DEFAULT_ANIMATION),
          duration: plan.duration || before.animation?.duration || 5,
          objectKeys,
        },
        keyframes: keys.length ? keys : before.keyframes,
        shot: keys[0] ? { position: keys[0].position, yaw: keys[0].yaw, pitch: keys[0].pitch, fov: keys[0].fov } : before.shot,
      });
      setSelectedId(null);
      setView('shot');
      setActiveKey(keys[0]?.id || null);
      const skipped = plan.issues?.length ? `（已忽略 ${plan.issues.length} 处无效内容）` : '';
      const moving = Object.keys(objectKeys).length;
      setTime(0);
      setAi((v) => ({ ...v, busy: false, note: `「${plan.title}」：${objects.length} 个物体，${keys.length} 个镜头${moving ? `，${moving} 个物体有动画（${plan.duration} 秒）` : ''}${skipped}` }));
      // 等场景同步后为镜头渲染缩略图
      if (keys.length) {
        setTimeout(() => {
          const e = engine.current;
          if (!e) return;
          const thumbs = e.exportFrames(keys, 240).map((c) => c.toDataURL('image/jpeg', 0.72));
          e.restoreShot();
          setData((d) => ({ ...d, keyframes: d.keyframes.map((k) => { const i = keys.findIndex((x) => x.id === k.id); return i >= 0 ? { ...k, thumb: thumbs[i] } : k; }) }));
        }, 150);
      }
    } catch (error) {
      setAi((v) => ({ ...v, busy: false, error: error.message }));
    }
  };
  const undoAi = () => {
    if (!undo) return;
    setData(undo);
    setUndo(null);
    setSelectedId(null);
    setAi((v) => ({ ...v, note: '已撤销 AI 方案' }));
  };

  /* -------------------------------- 动画 -------------------------------- */
  const anim = data.animation || DEFAULT_ANIMATION;
  const camTimes = cameraTimes(data.keyframes, anim.duration);
  const setAnim = (p) => patch((d) => ({ ...d, animation: { ...d.animation, ...p } }));
  const showTime = (t) => {
    const pct = `${(t / anim.duration) * 100}%`;
    if (playheadRef.current) playheadRef.current.style.left = pct;
    if (timeLabelRef.current) timeLabelRef.current.textContent = `${t.toFixed(2)} / ${anim.duration.toFixed(1)} 秒`;
  };
  const scrub = (t) => {
    const tt = Math.max(0, Math.min(anim.duration, Math.round(t * 100) / 100));
    setTime(tt);
    showTime(tt);
    setData((d) => {
      const a = d.animation || DEFAULT_ANIMATION;
      const c = a.cameraFollow && d.keyframes.length >= 2 ? cameraAt(d.keyframes, a.duration, tt) : null;
      return { ...d, objects: objectsAt(d.objects, a.objectKeys, tt), ...(c ? { shot: c } : {}) };
    });
  };
  const togglePlay = () => {
    const e = engine.current;
    if (!e) return;
    if (playing) {
      e.stop();
      setPlaying(false);
      return;
    }
    const from = time >= anim.duration - 0.01 ? 0 : time;
    setPlaying(true);
    setSelectedId(null);
    e.play(from, showTime, (t) => { setPlaying(false); scrub(t); });
  };
  const stopAndScrub = () => {
    if (!playing) return;
    engine.current?.stop();
    setPlaying(false);
    const label = timeLabelRef.current?.textContent || '';
    scrub(Number(label.split(' ')[0]) || time);
  };
  const recordKeys = () => {
    const targets = selected ? [selected] : data.objects.filter((o) => o.kind !== 'image');
    if (!targets.length) return;
    patch((d) => {
      const keys = { ...(d.animation?.objectKeys || {}) };
      for (const o of targets) keys[o.id] = upsertKey(keys[o.id], snapshotObject(d.objects.find((x) => x.id === o.id) || o, time));
      return { ...d, animation: { ...d.animation, objectKeys: keys } };
    });
  };
  const keyedIds = Object.keys(anim.objectKeys || {}).filter((id) => anim.objectKeys[id]?.length);
  const keyHere = (id) => (anim.objectKeys?.[id] || []).some((k) => Math.abs(k.t - time) <= 0.04);
  const deleteKeysHere = () => {
    const ids = selected ? [selected.id] : keyedIds;
    patch((d) => {
      const keys = { ...(d.animation?.objectKeys || {}) };
      for (const id of ids) keys[id] = (keys[id] || []).filter((k) => Math.abs(k.t - time) > 0.04);
      return { ...d, animation: { ...d.animation, objectKeys: keys } };
    });
  };
  const clearObjectKeys = (id) => patch((d) => {
    const keys = { ...(d.animation?.objectKeys || {}) };
    delete keys[id];
    return { ...d, animation: { ...d.animation, objectKeys: keys } };
  });
  const trackRef = useRef(null);
  const timeFromEvent = (e) => {
    const r = trackRef.current.getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * anim.duration;
  };
  const onTrackDown = (e) => {
    if (e.button !== 0) return;
    stopAndScrub();
    const cam = e.target.closest?.('[data-cam]');
    const move = (ev) => {
      const t = Math.max(0, Math.min(anim.duration, Math.round(timeFromEvent(ev) * 20) / 20));
      if (cam) {
        const id = cam.getAttribute('data-cam');
        patch((d) => ({ ...d, keyframes: d.keyframes.map((k) => (k.id === id ? { ...k, t } : k)) }));
      } else {
        scrub(t);
      }
    };
    move(e);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const exportVideo = async () => {
    const e = engine.current;
    const type = pickVideoType();
    if (!e || recording) return;
    if (!type) { setAi((v) => ({ ...v, error: '当前浏览器不支持录制视频' })); return; }
    stopAndScrub();
    setView('shot');
    setRecording(0);
    try {
      const r = RATIOS[data.settings.ratio] || 16 / 9;
      const { blob, width, height } = await e.recordVideo({ width: r >= 1 ? 1280 : 720, fps: anim.fps || 30, type, onProgress: (p) => setRecording(p) });
      const ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
      await onExportVideo({ file: new File([blob], `导演台动画.${ext}`, { type: blob.type }), label: `${title || '导演台'} · 动画`, width, height });
    } catch (error) {
      setAi((v) => ({ ...v, error: `视频导出失败：${error.message || error}` }));
    } finally {
      setRecording(null);
    }
  };

  /* -------------------------------- 关键帧 -------------------------------- */
  const goToKey = (k) => {
    setActiveKey(k.id);
    setView('shot');
    patch((d) => ({ ...d, shot: { position: k.position, yaw: k.yaw, pitch: k.pitch, fov: k.fov } }));
  };
  const addKeyFromView = () => {
    // 不进入飞行，直接记录当前取景
    const e = engine.current;
    if (!e) return;
    setView('shot');
    requestAnimationFrame(() => {
      const [canvas] = e.exportFrames([dataRef.current.shot], 240);
      e.restoreShot();
      const key = { id: uid('key'), ...dataRef.current.shot, thumb: canvas.toDataURL('image/jpeg', 0.72) };
      patch((d) => ({ ...d, keyframes: [...d.keyframes, key] }));
      setActiveKey(key.id);
    });
  };
  const dragKey = useRef(null);
  const moveKey = (from, to) => patch((d) => {
    const list = [...d.keyframes];
    const [k] = list.splice(from, 1);
    list.splice(to, 0, k);
    return { ...d, keyframes: list };
  });

  const doExport = async (keys) => {
    const e = engine.current;
    if (!e || !keys.length) return;
    setExporting(true);
    try {
      await new Promise((r) => requestAnimationFrame(r));
      const r = RATIOS[data.settings.ratio] || 16 / 9;
      const width = r >= 1 ? 1600 : Math.round(1600 * r);
      const canvases = e.exportFrames(keys, width);
      e.restoreShot();
      const files = await Promise.all(canvases.map((c, i) => new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve({
        file: new File([b], `关键帧-${i + 1}.png`, { type: 'image/png' }),
        label: `${title || '导演台'} · 关键帧 ${data.keyframes.findIndex((k) => k.id === keys[i].id) + 1}`,
        width: c.width,
        height: c.height,
      }) : reject(new Error('关键帧渲染失败'))), 'image/png'))));
      await onExport(files);
    } catch { /* 画布侧已提示 */ } finally {
      setExporting(false);
    }
  };

  const save = () => onSave(data, data.keyframes[0]?.thumb || null);
  const close = () => { save(); onClose(); };

  const jointRot = selected?.pose?.[joint] || [0, 0, 0];
  const groups = useMemo(() => JOINTS.reduce((acc, j) => { (acc[j.group] ||= []).push(j); return acc; }, {}), []);
  const s = data.settings;

  return createPortal((
    <div className="dr-backdrop" onMouseDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <section className="dr-shell" role="dialog" aria-modal="true" aria-label="3D 导演台">
        <header className="dr-head">
          <div className="dr-title"><Clapperboard size={18} /><strong>3D 导演台</strong><span>{title}</span></div>
          <div className="dr-head-actions">
            <button type="button" className="dr-btn" aria-expanded={showHelp} aria-controls="director-help" onClick={() => setShowHelp(value => !value)}><CircleHelp size={14}/>使用说明</button>
            <button type="button" className="dr-btn" onClick={save}><Save size={14} /> 保存</button>
            <button type="button" className="dr-icon" onClick={close} aria-label="保存并关闭导演台"><X size={18} /></button>
          </div>
        </header>

        {showHelp && <section id="director-help" className="dr-help" aria-label="导演台使用说明">
          <strong>快速上手</strong>
          <ol>
            <li><b>布景：</b>左侧添加人偶和道具；点击物体，拖动彩色轴移动。按 1 / 2 / 3 切换移动、旋转、缩放，右侧可调整人偶姿势与关节。</li>
            <li><b>取景：</b>点击「取景」再点击画面。鼠标控制朝向，WASD 移动，空格上升，Shift 下降，滚轮调焦；左键或 Esc 退出飞行。</li>
            <li><b>关键帧：</b>构图满意后点击「添加关键帧」，飞行时也可按右键记录。底部点击缩略图回看，点击「全部导出到画布」得到参考图。</li>
            <li><b>动画：</b>拖动时间轴到开始时刻，摆好姿势后点「记录」；到下一时刻改变位置或姿势并再次记录。点击播放检查，再点「导出视频」。</li>
            <li><b>AI 布景：</b>输入场景和动作描述，点「生成方案」。此功能调用当前接入的 Muse；手动布景和导出在本机完成。</li>
          </ol>
          <p>这是构图和动作预演工具。要生成最终画面，可把导出的关键帧连接到图片或视频生成节点作为参考图。点右上角「保存」或关闭按钮保存场景，回到画布后拖动节点卡片或标题旁手柄移动位置。</p>
        </section>}

        <div className="dr-body">
          <aside className="dr-left">
            <section className="dr-ai">
              <h4><Sparkles size={13} /> AI 布景</h4>
              <div className="dr-seg is-full">
                <button type="button" className={clsx(ai.mode === 'new' && 'is-on')} onClick={() => setAi((v) => ({ ...v, mode: 'new' }))} disabled={ai.busy}>重新搭建</button>
                <button type="button" className={clsx(ai.mode === 'edit' && 'is-on')} onClick={() => setAi((v) => ({ ...v, mode: 'edit' }))} disabled={ai.busy}>修改当前</button>
              </div>
              <textarea value={ai.prompt} disabled={ai.busy} rows={5}
                placeholder={ai.mode === 'new' ? '描述场景、人物动作和镜头，例如：咖啡馆里两人隔桌对坐，一人激动地指向对方；给全景、过肩和特写三个镜头' : '说明要怎么改，例如：让右边的人站起来挥手，再加一个低角度仰拍镜头'}
                onChange={(e) => setAi((v) => ({ ...v, prompt: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runAi(); }} />
              {images.length > 0 && (
                <label className="dr-ref">
                  <span>参考图</span>
                  <select value={ai.ref} disabled={ai.busy} onChange={(e) => setAi((v) => ({ ...v, ref: e.target.value }))}>
                    <option value="">不使用</option>
                    {images.map((img) => <option key={img.url} value={img.url}>{img.label}</option>)}
                  </select>
                </label>
              )}
              <button type="button" className="dr-btn is-accent is-block" onClick={runAi} disabled={ai.busy || ai.prompt.trim().length < 2}>
                {ai.busy ? <><Loader2 size={14} className="animate-spin" /> Muse 布景中…</> : <><Sparkles size={14} /> 生成方案</>}
              </button>
              {ai.error && <p className="dr-ai-error">{ai.error}</p>}
              {ai.note && <p className="dr-note">{ai.note}</p>}
              {undo && !ai.busy && <button type="button" className="dr-btn is-block" onClick={undoAi}><Undo2 size={14} /> 撤销 AI 方案</button>}
            </section>
            <h4>添加</h4>
            <div className="dr-add-grid">
              {['mannequin', 'box', 'sphere', 'cylinder', 'cone', 'wall'].map((k) => {
                const Icon = KINDS[k].icon;
                return <button key={k} type="button" onClick={() => addObject(k)}><Icon size={17} /><span>{KINDS[k].label}</span></button>;
              })}
              <div className="dr-add-image">
                <button type="button" onClick={() => setImageMenu((v) => !v)} disabled={!images.length} title={images.length ? '用画布上的图片做布景板' : '画布上还没有图片'}>
                  <ImageIcon size={17} /><span>图片板</span>
                </button>
                {imageMenu && (
                  <div className="dr-image-menu">
                    {images.map((img) => (
                      <button key={img.url} type="button" onClick={() => addObject('image', { src: img.url, label: img.label })}>
                        <img src={img.url} alt="" /><span>{img.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <h4>场景物体 <em>{data.objects.length}</em></h4>
            <ul className="dr-objects">
              {data.objects.map((o) => {
                const Icon = KINDS[o.kind]?.icon || Box;
                return (
                  <li key={o.id}>
                    <button type="button" className={clsx(selectedId === o.id && 'is-on')} onClick={() => { setSelectedId(o.id); setView('edit'); }}
                      onDoubleClick={() => engine.current?.focus(o.id)} title="双击聚焦">
                      <Icon size={15} /><span>{o.name}</span>
                    </button>
                    <button type="button" className="dr-mini" onClick={() => duplicate(o)} title="复制"><Copy size={13} /></button>
                    <button type="button" className="dr-mini is-danger" onClick={() => removeObject(o.id)} title="删除"><Trash2 size={13} /></button>
                  </li>
                );
              })}
              {!data.objects.length && <p className="dr-note">场景是空的，先从上方添加人偶或道具。</p>}
            </ul>
          </aside>

          <main className="dr-center">
            <div className="dr-toolbar">
              <div className="dr-seg">
                <button type="button" className={clsx(view === 'edit' && 'is-on')} onClick={() => setView('edit')}><Move3d size={14} /> 布景</button>
                <button type="button" className={clsx(view === 'shot' && 'is-on')} onClick={() => { setSelectedId(null); setView('shot'); }}><Camera size={14} /> 取景</button>
              </div>
              {view === 'edit' ? (
                <div className="dr-seg">
                  {[['translate', Move3d, '移动 (1)'], ['rotate', Rotate3d, '旋转 (2)'], ['scale', Scale3d, '缩放 (3)']].map(([m, Icon, label]) => (
                    <button key={m} type="button" className={clsx(tmode === m && 'is-on')} onClick={() => setTmode(m)} title={label}><Icon size={14} /></button>
                  ))}
                </div>
              ) : (
                <label className="dr-select" title="画面比例">
                  <select value={s.ratio} onChange={(e) => patch((d) => ({ ...d, settings: { ...d.settings, ratio: e.target.value } }))}>
                    {Object.keys(RATIOS).map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </label>
              )}
              <span className="dr-grow" />
              <button type="button" className={clsx('dr-btn', s.grid && 'is-on')} onClick={() => patch((d) => ({ ...d, settings: { ...d.settings, grid: !d.settings.grid } }))}>
                <Grid3x3 size={14} /> 网格
              </button>
              <button type="button" className="dr-btn is-accent" onClick={addKeyFromView}><Plus size={14} /> 添加关键帧</button>
            </div>
            <div ref={hostRef} className={clsx('dr-viewport', view === 'shot' && 'is-shot', flying && 'is-flying')}>
              {view === 'shot' && <div className="dr-frame" aria-hidden="true"><i /><i /><i /><i /></div>}
              {!ready && <div className="dr-loading"><Loader2 size={18} className="animate-spin" /> 正在搭建三维场景…</div>}
              <div className="dr-hint">
                {view === 'edit'
                  ? '左键选择 · 拖动空白旋转视角 · 右键平移 · 滚轮缩放 · 1/2/3 切换移动旋转缩放 · F 聚焦 · Delete 删除'
                  : flying
                    ? 'WASD 移动 · 空格上升 · Shift 下降 · 滚轮调焦 · 右键记录关键帧 · 左键 / Esc 退出取景'
                    : '点击画面进入取景（鼠标控制朝向） · 滚轮调焦'}
              </div>
              {view === 'shot' && <span className="dr-fov">焦距 {Math.round(12 / Math.tan((data.shot.fov * DEG) / 2))}mm · 视角 {Math.round(data.shot.fov)}°</span>}
            </div>
            <div className="dr-timeline">
              <div className="dr-tl-bar">
                <button type="button" className="dr-play" onClick={togglePlay} disabled={recording != null} aria-label={playing ? '暂停' : '播放'} title="播放 / 暂停（空格）">
                  {playing ? <Pause size={15} /> : <Play size={15} />}
                </button>
                <span className="dr-time" ref={timeLabelRef}>{time.toFixed(2)} / {anim.duration.toFixed(1)} 秒</span>
                <label className="dr-select" title="动画时长">
                  <select value={anim.duration} disabled={playing || recording != null} onChange={(e) => setAnim({ duration: Number(e.target.value) })}>
                    {[2, 3, 5, 8, 10, 15].map((d) => <option key={d} value={d}>{d} 秒</option>)}
                  </select>
                </label>
                <label className="dr-check" title="播放时镜头沿关键帧路径移动">
                  <input type="checkbox" checked={anim.cameraFollow} onChange={(e) => setAnim({ cameraFollow: e.target.checked })} /> 镜头运动
                </label>
                <span className="dr-grow" />
                <button type="button" className="dr-btn" onClick={recordKeys} disabled={playing || !data.objects.length} title="把物体当前的位置和姿势记在这一时刻（K）">
                  <Diamond size={13} /> {selected ? `记录「${selected.name}」` : '记录全部物体'}
                </button>
                <button type="button" className="dr-btn" onClick={deleteKeysHere} disabled={playing || !(selected ? keyHere(selected.id) : keyedIds.some(keyHere))}>
                  <Trash2 size={13} /> 删除此刻
                </button>
                <button type="button" className="dr-btn is-accent" onClick={exportVideo} disabled={playing || recording != null || (!keyedIds.length && data.keyframes.length < 2)}
                  title="按时间轴录制动画，导出为视频节点">
                  {recording != null ? <><Loader2 size={14} className="animate-spin" /> 录制 {Math.round(recording * 100)}%</> : <><Film size={14} /> 导出视频</>}
                </button>
              </div>
              <div className="dr-track">
              <div className="dr-track-inner" ref={trackRef} onPointerDown={onTrackDown}>
                <div className="dr-ruler">
                  {Array.from({ length: Math.floor(anim.duration) + 1 }, (_, i) => <i key={i} style={{ left: `${(i / anim.duration) * 100}%` }}>{i}s</i>)}
                </div>
                <div className="dr-row" title="镜头关键帧，可拖动调整时间">
                  <span className="dr-row-label">镜头</span>
                  {data.keyframes.map((k, i) => (
                    <b key={k.id} data-cam={k.id} className={clsx('dr-cam-mark', activeKey === k.id && 'is-on')} style={{ left: `${(camTimes[i] / anim.duration) * 100}%` }} title={`${k.name || `镜头 ${i + 1}`} · ${camTimes[i].toFixed(2)} 秒`}>{i + 1}</b>
                  ))}
                </div>
                {(selected ? [selected] : data.objects.filter((o) => keyedIds.includes(o.id))).slice(0, 4).map((o) => (
                  <div key={o.id} className="dr-row">
                    <span className="dr-row-label" title={o.name}>{o.name}</span>
                    {(anim.objectKeys?.[o.id] || []).map((k) => (
                      <i key={k.t} className="dr-obj-mark" style={{ left: `${(k.t / anim.duration) * 100}%` }} title={`${k.t.toFixed(2)} 秒`} />
                    ))}
                    {anim.objectKeys?.[o.id]?.length > 0 && !playing && (
                      <button type="button" className="dr-row-clear" onPointerDown={(e) => e.stopPropagation()} onClick={() => clearObjectKeys(o.id)} title="清除此物体的全部动画">清除</button>
                    )}
                  </div>
                ))}
                {!selected && !keyedIds.length && <p className="dr-track-hint">拖动时间轴到某一时刻，摆好物体或人偶后点「记录」，再到下一时刻改动并记录，即可生成动画。</p>}
                <div className="dr-playhead" ref={playheadRef} style={{ left: `${(time / anim.duration) * 100}%` }} />
              </div>
              </div>
            </div>
            <div className="dr-keys">
              <div className="dr-keys-head">
                <strong>关键帧 <em>{data.keyframes.length}</em></strong>
                <span className="dr-grow" />
                <button type="button" className="dr-btn" disabled={!activeKey || exporting} onClick={() => doExport(data.keyframes.filter((k) => k.id === activeKey))}>
                  <Download size={14} /> 导出当前
                </button>
                <button type="button" className="dr-btn is-accent" disabled={!data.keyframes.length || exporting} onClick={() => doExport(data.keyframes)}>
                  {exporting ? <Loader2 size={14} className="animate-spin" /> : <ImageIcon size={14} />} 全部导出到画布
                </button>
              </div>
              {data.keyframes.length ? (
                <ol className="dr-key-list">
                  {data.keyframes.map((k, i) => (
                    <li key={k.id} draggable
                      onDragStart={() => { dragKey.current = i; }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => { if (dragKey.current != null && dragKey.current !== i) moveKey(dragKey.current, i); dragKey.current = null; }}
                      className={clsx(activeKey === k.id && 'is-on')}>
                      <button type="button" onClick={() => goToKey(k)} title={[k.name, k.note].filter(Boolean).join('：') || '回看此关键帧'}>
                        {k.thumb ? <img src={k.thumb} alt="" /> : <Video size={16} />}
                        <span>{i + 1}{k.name ? ` · ${k.name}` : ''}</span>
                      </button>
                      <button type="button" className="dr-key-del" aria-label={`删除关键帧 ${i + 1}`}
                        onClick={() => { patch((d) => ({ ...d, keyframes: d.keyframes.filter((x) => x.id !== k.id) })); if (activeKey === k.id) setActiveKey(null); }}>
                        <X size={12} />
                      </button>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="dr-note">进入「取景」后点击画面飞行取景，按右键或「添加关键帧」记录镜头。关键帧可拖动排序。</p>
              )}
            </div>
          </main>

          <aside className="dr-right">
            {selected ? (
              <>
                <h4>{KINDS[selected.kind]?.label || '物体'}</h4>
                <input className="dr-name" value={selected.name} onChange={(e) => patchObject(selected.id, { name: e.target.value.slice(0, 30) })} />
                {selected.kind !== 'image' && (
                  <label className="dr-color">
                    <span>颜色</span>
                    <input type="color" value={selected.color} onChange={(e) => patchObject(selected.id, { color: e.target.value })} />
                    <em>{selected.color}</em>
                  </label>
                )}
                <NumberRow label="位置" values={selected.position} onChange={(position) => patchObject(selected.id, { position })} />
                <NumberRow label="旋转" values={selected.rotation} step={5} digits={1} onChange={(rotation) => patchObject(selected.id, { rotation })} />
                <NumberRow label="缩放" values={selected.scale} step={0.1} onChange={(scale) => patchObject(selected.id, { scale })} />
                {selected.kind === 'mannequin' && (
                  <>
                    <h4>姿势</h4>
                    <div className="dr-poses">
                      {POSES.map((p) => (
                        <button key={p.id} type="button" onClick={() => patchObject(selected.id, { pose: JSON.parse(JSON.stringify(p.pose)) })}>{p.label}</button>
                      ))}
                    </div>
                    <h4>关节 <em>点人偶的部位也可选中</em></h4>
                    <div className="dr-joints">
                      {Object.entries(groups).map(([g, list]) => (
                        <div key={g}>
                          <span>{g}</span>
                          {list.map((j) => (
                            <button key={j.id} type="button" className={clsx(joint === j.id && 'is-on', selected.pose?.[j.id]?.some((v) => v) && 'is-set')} onClick={() => setJoint(j.id)}>{j.label}</button>
                          ))}
                        </div>
                      ))}
                    </div>
                    <div className="dr-joint-edit">
                      <strong>{JOINTS.find((j) => j.id === joint)?.label}</strong>
                      {['X', 'Y', 'Z'].map((axis, i) => <JointSlider key={axis} axis={axis} value={jointRot[i]} onChange={(v) => setJointAxis(i, v)} />)}
                      <button type="button" className="dr-btn" onClick={() => { const p = { ...selected.pose }; delete p[joint]; patchObject(selected.id, { pose: p }); }}>复位此关节</button>
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <h4>场景</h4>
                <div className="dr-skies">
                  {SKIES.map((k) => (
                    <button key={k.id} type="button" className={clsx(s.sky === k.id && 'is-on')} onClick={() => patch((d) => ({ ...d, settings: { ...d.settings, sky: k.id } }))}>
                      <i style={{ background: `linear-gradient(${k.sky} 55%, ${k.ground} 55%)` }} />{k.label}
                    </button>
                  ))}
                </div>
                <h4>光照</h4>
                {[['sunAzimuth', '光线方向', -180, 180, '°'], ['sunElevation', '光线高度', 5, 89, '°'], ['sunIntensity', '光照强度', 0, 100, '%']].map(([key, label, min, max, unit]) => (
                  <label key={key} className="dr-range">
                    <span>{label}<em>{s[key]}{unit}</em></span>
                    <input type="range" min={min} max={max} value={s[key]} onChange={(e) => patch((d) => ({ ...d, settings: { ...d.settings, [key]: Number(e.target.value) } }))} />
                  </label>
                ))}
                <h4>取景相机</h4>
                <p className="dr-note">位置 {data.shot.position.map((v) => v.toFixed(2)).join(', ')} · 朝向 {Math.round(data.shot.yaw)}° / {Math.round(data.shot.pitch)}° · 视角 {Math.round(data.shot.fov)}°</p>
                <button type="button" className="dr-btn is-block" onClick={() => setView('shot')}><Eye size={14} /> 进入取景</button>
                <p className="dr-note">选中物体后在这里编辑位置、颜色和人偶姿势。</p>
              </>
            )}
          </aside>
        </div>
      </section>
    </div>
  ), document.body);
}
