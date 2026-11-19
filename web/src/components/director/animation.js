// 导演台动画：物体关键帧插值（位置、旋转、缩放、人偶姿势）与镜头路径插值。
// 纯函数，不依赖 three.js，方便在预览与导出时共用。
import { JOINTS } from './mannequin.js';

export const DEFAULT_ANIMATION = { duration: 5, fps: 30, cameraFollow: true, objectKeys: {} };

const lerp = (a, b, u) => a + (b - a) * u;
const lerp3 = (a, b, u) => [0, 1, 2].map((i) => lerp(a[i], b[i], u));
const ease = (u) => u * u * (3 - 2 * u);

/** 两个姿势之间插值，缺失的关节按 0。 */
function lerpPose(a = {}, b = {}, u) {
  const out = {};
  for (const { id } of JOINTS) {
    const pa = a[id] || [0, 0, 0];
    const pb = b[id] || [0, 0, 0];
    if (pa.some((v) => v) || pb.some((v) => v)) out[id] = lerp3(pa, pb, u);
  }
  const ha = a.hipsY?.[0] || 0;
  const hb = b.hipsY?.[0] || 0;
  if (ha || hb) out.hipsY = [lerp(ha, hb, u), 0, 0];
  return out;
}

export function sortKeys(keys) {
  return [...(keys || [])].sort((a, b) => a.t - b.t);
}

/** 物体在时间 t 的状态；没有关键帧时返回 null。 */
export function objectStateAt(keys, t) {
  const list = sortKeys(keys);
  if (!list.length) return null;
  if (t <= list[0].t) return list[0];
  const last = list[list.length - 1];
  if (t >= last.t) return last;
  let i = 0;
  while (i < list.length - 1 && list[i + 1].t < t) i++;
  const a = list[i];
  const b = list[i + 1];
  const u = ease((t - a.t) / Math.max(1e-6, b.t - a.t));
  return {
    t,
    position: lerp3(a.position, b.position, u),
    rotation: lerp3(a.rotation, b.rotation, u),
    scale: lerp3(a.scale, b.scale, u),
    ...(a.pose || b.pose ? { pose: lerpPose(a.pose, b.pose, u) } : {}),
  };
}

/** 镜头关键帧的时间：未设置的按时长均匀分布。 */
export function cameraTimes(keyframes, duration) {
  const n = keyframes.length;
  return keyframes.map((k, i) => (Number.isFinite(k.t) ? k.t : n > 1 ? (i / (n - 1)) * duration : 0));
}

function catmull(p0, p1, p2, p3, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  return [0, 1, 2].map((i) => 0.5 * ((2 * p1[i]) + (-p0[i] + p2[i]) * u + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * u2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * u3));
}

const wrapDelta = (a, b) => ((((b - a) % 360) + 540) % 360) - 180;

/** 镜头在时间 t 的位置与朝向：位置走 Catmull-Rom 曲线，朝向取最短角度插值。 */
export function cameraAt(keyframes, duration, t) {
  if (!keyframes.length) return null;
  const times = cameraTimes(keyframes, duration);
  const order = keyframes.map((k, i) => ({ k, t: times[i] })).sort((a, b) => a.t - b.t);
  if (order.length === 1 || t <= order[0].t) return pick(order[0].k);
  const last = order[order.length - 1];
  if (t >= last.t) return pick(last.k);
  let i = 0;
  while (i < order.length - 1 && order[i + 1].t < t) i++;
  const a = order[i];
  const b = order[i + 1];
  const u = ease((t - a.t) / Math.max(1e-6, b.t - a.t));
  const p0 = (order[i - 1] || a).k.position;
  const p3 = (order[i + 2] || b).k.position;
  return {
    position: catmull(p0, a.k.position, b.k.position, p3, u),
    yaw: a.k.yaw + wrapDelta(a.k.yaw, b.k.yaw) * u,
    pitch: lerp(a.k.pitch, b.k.pitch, u),
    fov: lerp(a.k.fov, b.k.fov, u),
  };
}

function pick(k) {
  return { position: k.position, yaw: k.yaw, pitch: k.pitch, fov: k.fov };
}

/** 把物体当前状态写进关键帧列表（同一时间附近的关键帧会被替换）。 */
export function upsertKey(keys, key) {
  const list = (keys || []).filter((k) => Math.abs(k.t - key.t) > 0.04);
  return sortKeys([...list, key]);
}

export function snapshotObject(o, t) {
  return {
    t: Math.round(t * 100) / 100,
    position: [...o.position],
    rotation: [...o.rotation],
    scale: [...o.scale],
    ...(o.kind === 'mannequin' ? { pose: JSON.parse(JSON.stringify(o.pose || {})) } : {}),
  };
}

/** 按时间 t 计算所有有关键帧的物体状态，返回新的 objects 数组。 */
export function objectsAt(objects, objectKeys, t) {
  return objects.map((o) => {
    const s = objectStateAt(objectKeys?.[o.id], t);
    if (!s) return o;
    return { ...o, position: s.position, rotation: s.rotation, scale: s.scale, ...(o.kind === 'mannequin' && s.pose ? { pose: s.pose } : {}) };
  });
}

export function pickVideoType() {
  const types = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}
