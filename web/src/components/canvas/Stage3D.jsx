import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

/*
 * 打光 / 多角度共用的三维舞台。
 * 坐标约定：原图立在原点，正面朝 +z（原机位方向），原图右侧是 +x。
 * 方位角 0° = 相机侧，90° = 原图右，±180° = 背侧，-90° = 原图左；俯仰角向上为正。
 */
const DEG = Math.PI / 180;
const RING_R = 2.5;

function spherical(THREE, az, el, r, cy) {
  return new THREE.Vector3(
    r * Math.sin(az * DEG) * Math.cos(el * DEG),
    cy + r * Math.sin(el * DEG),
    r * Math.cos(az * DEG) * Math.cos(el * DEG),
  );
}

const LABELS = {
  light: [['相机侧 · 0°', 0], ['原图右 · 90°', 90], ['背侧 · 180°', 180], ['原图左 · -90°', -90]],
  angle: [['正面 · 0°', 0], ['原图右 · 90°', 90], ['后方 · 180°', 180], ['原图左 · -90°', -90]],
};

/**
 * kind="light": state = { main:{azimuth,elevation,intensity,color}, rim:{enabled,azimuth,elevation,intensity,color}, active }
 * kind="angle": state = { azimuth, elevation, radius, fov }, view = "orbit" | "camera"
 * onDrag(which, { azimuth, elevation })
 */
export default function Stage3D({ kind, src, state, view = 'orbit', onDrag, hint }) {
  const hostRef = useRef(null);
  const labelRefs = useRef([]);
  const handleLabelRefs = useRef([]);
  const stateRef = useRef(state);
  const viewRef = useRef(view);
  const dragRef = useRef(onDrag);
  const [status, setStatus] = useState('loading');
  stateRef.current = state;
  viewRef.current = view;
  dragRef.current = onDrag;

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    (async () => {
      const THREE = await import('three');
      const host = hostRef.current;
      if (disposed || !host) return;
      const dark = document.documentElement.dataset.resolved === 'dark';

      let renderer;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      } catch {
        setStatus('nogl');
        return;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.domElement.className = 'mf-stage-canvas';
      host.prepend(renderer.domElement);

      const scene = new THREE.Scene();
      const viewCam = new THREE.PerspectiveCamera(36, 1, 0.05, 100);
      const shotCam = new THREE.PerspectiveCamera(40, 1, 0.05, 100);

      // 参考图卡片
      let tex = null;
      let ratio = 3 / 4;
      try {
        tex = await new THREE.TextureLoader().loadAsync(src);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        ratio = tex.image.width / tex.image.height || ratio;
      } catch { /* 图片读不到时用灰色卡片代替 */ }
      if (disposed) { renderer.dispose(); return; }
      const longSide = 1.9;
      const cardW = ratio >= 1 ? longSide : longSide * ratio;
      const cardH = ratio >= 1 ? longSide / ratio : longSide;
      const cy = cardH / 2 + 0.03;
      const sideMat = new THREE.MeshStandardMaterial({ color: dark ? 0x3a3f48 : 0x8e98a6, roughness: 0.7 });
      const frontMat = new THREE.MeshStandardMaterial({ map: tex, color: tex ? 0xffffff : 0x9aa3ad, roughness: 0.85 });
      const backMat = new THREE.MeshStandardMaterial({ color: dark ? 0x2c3038 : 0xb7bfc9, roughness: 0.9 });
      const card = new THREE.Mesh(new THREE.BoxGeometry(cardW, cardH, 0.04), [sideMat, sideMat, sideMat, sideMat, frontMat, backMat]);
      card.position.y = cy;
      card.castShadow = true;
      scene.add(card);

      // 地面与网格
      const ground = new THREE.Mesh(
        new THREE.CircleGeometry(3.3, 96),
        new THREE.MeshStandardMaterial({ color: dark ? 0x2b3038 : 0xd9dfe6, roughness: 1 }),
      );
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      scene.add(ground);
      const grid = new THREE.GridHelper(10, 20, dark ? 0x4b515c : 0xaab4c0, dark ? 0x3a3f48 : 0xc3cbd4);
      grid.material.transparent = true;
      grid.material.opacity = 0.45;
      grid.position.y = 0.003;
      scene.add(grid);

      const dashed = (color, opacity = 0.7) => new THREE.LineDashedMaterial({ color, dashSize: 0.08, gapSize: 0.06, transparent: true, opacity });
      const circle = (r, y, color, opacity, segments = 128) => {
        const pts = Array.from({ length: segments + 1 }, (_, i) => {
          const a = (i / segments) * Math.PI * 2;
          return new THREE.Vector3(Math.sin(a) * r, y, Math.cos(a) * r);
        });
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), dashed(color, opacity));
        line.computeLineDistances();
        return line;
      };
      const guideColor = dark ? 0x8c95a3 : 0x7d8796;
      const overlay = new THREE.Group();
      scene.add(overlay);

      const handles = [];
      const lineTo = (color) => {
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), dashed(color, 0.85));
        overlay.add(line);
        return line;
      };
      const setLine = (line, a, b) => {
        line.geometry.setFromPoints([a, b]);
        line.computeLineDistances();
      };

      let update;
      if (kind === 'light') {
        overlay.add(circle(RING_R, cy, guideColor, 0.75));
        scene.add(new THREE.HemisphereLight(0xffffff, dark ? 0x30343c : 0x8c939c, 0.55));
        const key = new THREE.DirectionalLight(0xffffff, 2);
        key.castShadow = true;
        key.shadow.mapSize.set(1024, 1024);
        Object.assign(key.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.5, far: 20 });
        key.shadow.radius = 4;
        key.target = card;
        const rim = new THREE.DirectionalLight(0xffffff, 1);
        rim.target = card;
        scene.add(key, rim);
        const ball = (hex) => {
          const g = new THREE.Group();
          const core = new THREE.Mesh(new THREE.SphereGeometry(0.13, 32, 16), new THREE.MeshBasicMaterial({ color: hex }));
          const halo = new THREE.Mesh(new THREE.SphereGeometry(0.27, 32, 16), new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.22, depthWrite: false }));
          g.add(core, halo);
          overlay.add(g);
          return { g, core, halo };
        };
        const mainBall = ball(0xffd27a);
        const rimBall = ball(0x8fb8ff);
        const mainLine = lineTo(0xf0b24f);
        const rimLine = lineTo(0x7aa7f5);
        handles.push({ which: 'main', obj: mainBall.g }, { which: 'rim', obj: rimBall.g });
        const center = new THREE.Vector3(0, cy, 0);
        update = (s) => {
          const m = s.main;
          const mp = spherical(THREE, m.azimuth, m.elevation, RING_R, cy);
          mainBall.g.position.copy(mp);
          const mc = new THREE.Color(m.color || '#ffffff');
          mainBall.core.material.color.copy(mc).lerp(new THREE.Color('#ffd27a'), m.color ? 0 : 0.6);
          mainBall.halo.material.color.copy(mainBall.core.material.color);
          mainBall.halo.material.opacity = 0.12 + (m.intensity / 100) * 0.3;
          mainBall.g.scale.setScalar(s.active === 'main' ? 1.12 : 0.92);
          key.position.copy(mp.clone().sub(center).multiplyScalar(2.6).add(center));
          key.color.copy(mc);
          key.intensity = 0.25 + (m.intensity / 100) * 3.2;
          setLine(mainLine, mp, center);

          const r = s.rim;
          rimBall.g.visible = r.enabled;
          rimLine.visible = r.enabled;
          rim.visible = r.enabled;
          if (r.enabled) {
            const rp = spherical(THREE, r.azimuth, r.elevation, RING_R, cy);
            rimBall.g.position.copy(rp);
            const rc = new THREE.Color(r.color || '#cfe0ff');
            rimBall.core.material.color.copy(rc);
            rimBall.halo.material.color.copy(rc);
            rimBall.g.scale.setScalar(s.active === 'rim' ? 1.12 : 0.92);
            rim.position.copy(rp.clone().sub(center).multiplyScalar(2.6).add(center));
            rim.color.copy(rc);
            rim.intensity = (r.intensity / 100) * 2.4;
            setLine(rimLine, rp, center);
          }
          return [
            { pos: mp, text: '主光', show: true },
            { pos: r.enabled ? spherical(THREE, r.azimuth, r.elevation, RING_R, cy) : mp, text: '轮廓光', show: r.enabled },
          ];
        };
      } else {
        scene.add(new THREE.HemisphereLight(0xffffff, dark ? 0x30343c : 0x9aa1aa, 1.1));
        const sun = new THREE.DirectionalLight(0xffffff, 1.3);
        sun.position.set(2, 6, 4);
        sun.castShadow = true;
        sun.shadow.mapSize.set(1024, 1024);
        Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4 });
        scene.add(sun);
        // 半球穹顶：纬线 + 经线
        const dome = new THREE.Group();
        for (const el of [0, 30, 60]) dome.add(circle(RING_R * Math.cos(el * DEG), cy + RING_R * Math.sin(el * DEG), guideColor, el ? 0.35 : 0.75));
        for (let az = 0; az < 180; az += 45) {
          const pts = Array.from({ length: 65 }, (_, i) => spherical(THREE, az, (i / 64) * 180, RING_R, cy));
          const meridian = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), dashed(guideColor, 0.25));
          meridian.computeLineDistances();
          dome.add(meridian);
        }
        overlay.add(dome);
        // 相机图标
        const accent = dark ? 0x5fd6b1 : 0x13866a;
        const gizmo = new THREE.Group();
        const bodyMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.45, metalness: 0.1 });
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.3, 0.26), bodyMat);
        const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.2, 24), new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.3 }));
        lens.rotation.x = Math.PI / 2;
        lens.position.z = 0.2;
        const top = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.08, 0.12), bodyMat);
        top.position.set(-0.08, 0.19, 0);
        gizmo.add(body, lens, top);
        overlay.add(gizmo);
        handles.push({ which: 'camera', obj: gizmo });
        const frustum = [0, 1, 2, 3].map(() => lineTo(accent));
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => new THREE.Vector3((x * cardW) / 2, cy + (y * cardH) / 2, 0.03));
        update = (s) => {
          const p = spherical(THREE, s.azimuth, s.elevation, s.radius || RING_R, cy);
          gizmo.position.copy(p);
          gizmo.lookAt(0, cy, 0);
          frustum.forEach((line, i) => setLine(line, p, corners[i]));
          shotCam.position.copy(p);
          shotCam.fov = s.fov || 40;
          shotCam.lookAt(0, cy, 0);
          shotCam.updateProjectionMatrix();
          return [{ pos: p.clone().add(new THREE.Vector3(0, -0.34, 0)), text: '机位', show: true }];
        };
      }

      // 视角控制
      const orbit = { yaw: kind === 'light' ? -34 : -48, pitch: 22, dist: kind === 'light' ? 6.6 : 7.6 };
      const target = new THREE.Vector3(0, cy * 0.8, 0);
      const placeViewCam = () => {
        const p = new THREE.Vector3(
          Math.sin(orbit.yaw * DEG) * Math.cos(orbit.pitch * DEG),
          Math.sin(orbit.pitch * DEG),
          Math.cos(orbit.yaw * DEG) * Math.cos(orbit.pitch * DEG),
        ).multiplyScalar(orbit.dist).add(target);
        viewCam.position.copy(p);
        viewCam.lookAt(target);
      };

      const resize = () => {
        const w = host.clientWidth || 1;
        const h = host.clientHeight || 1;
        renderer.setSize(w, h);
        viewCam.aspect = w / h;
        shotCam.aspect = w / h;
        viewCam.updateProjectionMatrix();
        shotCam.updateProjectionMatrix();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(host);
      resize();

      // 拖动
      const ray = new THREE.Raycaster();
      const ndc = new THREE.Vector2();
      const toNdc = (e) => {
        const r = renderer.domElement.getBoundingClientRect();
        ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      };
      const center = new THREE.Vector3(0, cy, 0);
      let drag = null;
      const onDown = (e) => {
        if (e.button !== 0) return;
        try { renderer.domElement.setPointerCapture(e.pointerId); } catch { /* 合成事件没有真实指针 */ }
        if (viewRef.current === 'camera') {
          drag = { mode: 'shot', x: e.clientX, y: e.clientY, az: stateRef.current.azimuth, el: stateRef.current.elevation };
          return;
        }
        toNdc(e);
        ray.setFromCamera(ndc, viewCam);
        const hit = handles.filter((h) => h.obj.visible).find((h) => ray.intersectObject(h.obj, true).length);
        drag = hit ? { mode: 'handle', which: hit.which } : { mode: 'orbit', x: e.clientX, y: e.clientY, yaw: orbit.yaw, pitch: orbit.pitch };
        renderer.domElement.style.cursor = 'grabbing';
      };
      const onMove = (e) => {
        if (!drag) {
          if (viewRef.current === 'camera') return;
          toNdc(e);
          ray.setFromCamera(ndc, viewCam);
          const over = handles.some((h) => h.obj.visible && ray.intersectObject(h.obj, true).length);
          renderer.domElement.style.cursor = over ? 'pointer' : 'grab';
          return;
        }
        if (drag.mode === 'orbit') {
          orbit.yaw = drag.yaw - (e.clientX - drag.x) * 0.4;
          orbit.pitch = Math.max(4, Math.min(82, drag.pitch + (e.clientY - drag.y) * 0.3));
          return;
        }
        if (drag.mode === 'shot') {
          // 在机位预览里拖动，直接环绕移动机位
          const azimuth = ((drag.az - (e.clientX - drag.x) * 0.4 + 540) % 360) - 180;
          const elevation = Math.max(-80, Math.min(80, drag.el + (e.clientY - drag.y) * 0.3));
          dragRef.current?.('camera', { azimuth: Math.round(azimuth), elevation: Math.round(elevation) });
          return;
        }
        toNdc(e);
        ray.setFromCamera(ndc, viewCam);
        const radius = kind === 'angle' ? (stateRef.current.radius || RING_R) : RING_R;
        const hitPoint = new THREE.Vector3();
        let azimuth;
        let elevation;
        if (ray.ray.intersectSphere(new THREE.Sphere(center, radius), hitPoint)) {
          const v = hitPoint.sub(center);
          azimuth = Math.atan2(v.x, v.z) / DEG;
          elevation = Math.asin(Math.max(-1, Math.min(1, v.y / radius))) / DEG;
        } else if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -cy), hitPoint)) {
          azimuth = Math.atan2(hitPoint.x, hitPoint.z) / DEG;
        } else {
          return;
        }
        const patch = { azimuth: Math.round(azimuth) };
        if (elevation !== undefined) patch.elevation = Math.round(Math.max(-60, Math.min(85, elevation)));
        dragRef.current?.(drag.which, patch);
      };
      const onUp = () => { drag = null; renderer.domElement.style.cursor = viewRef.current === 'camera' ? 'grab' : 'grab'; };
      const onWheel = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (viewRef.current === 'camera') return;
        orbit.dist = Math.max(4.5, Math.min(14, orbit.dist * Math.exp(e.deltaY * 0.001)));
      };
      const canvas = renderer.domElement;
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointercancel', onUp);
      canvas.addEventListener('wheel', onWheel, { passive: false });

      // 渲染循环
      const project = new THREE.Vector3();
      const place = (el, pos, show) => {
        if (!el) return;
        project.copy(pos).project(viewCam);
        const visible = show && project.z < 1;
        el.style.opacity = visible ? '1' : '0';
        if (!visible) return;
        el.style.transform = `translate(-50%, -50%) translate(${((project.x + 1) / 2) * host.clientWidth}px, ${((1 - project.y) / 2) * host.clientHeight}px)`;
      };
      let frame = 0;
      const tick = () => {
        frame = requestAnimationFrame(tick);
        const tags = update(stateRef.current);
        const shot = kind === 'angle' && viewRef.current === 'camera';
        overlay.visible = !shot;
        grid.visible = true;
        placeViewCam();
        LABELS[kind].forEach(([, az], i) => place(labelRefs.current[i], spherical(THREE, az, 0, RING_R + 0.42, cy), !shot));
        tags.forEach((tag, i) => place(handleLabelRefs.current[i], tag.pos.clone().add(new THREE.Vector3(0, -0.38, 0)), tag.show && !shot));
        renderer.render(scene, shot ? shotCam : viewCam);
      };
      tick();
      setStatus('ready');

      cleanup = () => {
        cancelAnimationFrame(frame);
        ro.disconnect();
        canvas.removeEventListener('wheel', onWheel);
        scene.traverse((obj) => {
          obj.geometry?.dispose?.();
          const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
          mats.forEach((m) => m.dispose());
        });
        tex?.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
        canvas.remove();
      };
    })().catch(() => !disposed && setStatus('error'));
    return () => { disposed = true; cleanup(); };
  }, [kind, src]);

  return (
    <div ref={hostRef} className="mf-stage" onMouseDown={(e) => e.stopPropagation()}>
      {LABELS[kind].map(([text], i) => (
        <span key={text} ref={(el) => { labelRefs.current[i] = el; }} className="mf-stage-label">{text}</span>
      ))}
      {(kind === 'light' ? ['主光', '轮廓光'] : ['机位']).map((text, i) => (
        <span key={text} ref={(el) => { handleLabelRefs.current[i] = el; }} className="mf-stage-tag">{text}</span>
      ))}
      {status !== 'ready' && (
        <div className="mf-stage-status">
          {status === 'loading' ? <><Loader2 size={16} className="animate-spin" /> 正在准备三维视图…</> : '当前浏览器无法显示三维视图，可用右侧滑块调整'}
        </div>
      )}
      {status === 'ready' && hint && <span className="mf-stage-hint">{hint}</span>}
    </div>
  );
}
