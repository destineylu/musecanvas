import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import { completeText } from '../museText.js';
import { referenceImage } from '../mediaRefs.js';

/*
 * 3D 导演台 AI 布景：让 Muse 一次性输出场景 JSON，服务端校验并收紧数值后返回。
 * Bridge 没有原生工具调用，所以不用多轮工具协议，失败时只让 Muse 修正一次 JSON。
 */
const r = Router();

const KINDS = ['mannequin', 'box', 'sphere', 'cylinder', 'cone', 'wall'];
const SKIES = ['studio', 'day', 'dusk', 'night', 'white', 'black'];
const JOINTS = ['hips', 'spine', 'neck', 'head', 'leftShoulder', 'leftElbow', 'leftWrist', 'rightShoulder', 'rightElbow', 'rightWrist',
  'leftHip', 'leftKnee', 'leftAnkle', 'rightHip', 'rightKnee', 'rightAnkle'];
const POSES = ['stand', 'walk', 'walk2', 'run', 'run2', 'sit', 'squat', 'wave', 'point', 'tpose', 'cheer', 'think'];
// 各几何体在 scale = 1 时的尺寸 [宽, 高, 深]（米）
const BASE_SIZE = { box: [1, 1, 1], sphere: [1, 1, 1], cylinder: [0.8, 1, 0.8], cone: [0.9, 1, 0.9], wall: [3, 2.4, 0.12] };

const GUIDE = `你是分镜预演的 3D 布景助手。根据用户描述，用简单几何体和关节人偶搭建一个预演场景，并设计几个镜头。
只输出一个 JSON 对象，不要输出解释、Markdown 或代码块标记。

坐标系：单位米，y 轴向上，地面 y = 0。场景中心在原点附近，物体之间保持合理距离（通常在 -6 到 6 米范围内）。
人偶身高约 1.75 米，position 是脚底中心。rotationY = 0 时人偶面朝 +z；rotationY 为正时向 +x 方向转身（90 表示面朝 +x，180 表示面朝 -z）。
几何体 position 是底面中心，size 为 [宽, 高, 深]（米）。墙面是竖立的薄板，可用来做墙壁、门板、屏风。

JSON 格式：
{
  "title": "方案名（10 字以内）",
  "duration": 动画总时长秒数 2~15,
  "settings": { "sky": "studio|day|dusk|night|white|black", "sunAzimuth": -180~180, "sunElevation": 5~89, "sunIntensity": 0~100 },
  "objects": [
    { "kind": "mannequin", "name": "角色名", "color": "#RRGGBB", "position": [x, 0, z], "rotationY": 角度,
      "posePreset": "stand|walk|walk2|run|run2|sit|squat|wave|point|tpose|cheer|think", "pose": { "关节名": [x, y, z] },
      "keys": [ { "t": 秒, "position": [x, 0, z], "rotationY": 角度, "posePreset": "...", "pose": { ... } } ] },
    { "kind": "box|sphere|cylinder|cone|wall", "name": "道具名", "color": "#RRGGBB", "position": [x, y, z], "rotationY": 角度, "size": [宽, 高, 深] }
  ],
  "shots": [
    { "name": "镜头名", "t": 秒, "position": [x, y, z], "target": [x, y, z], "fov": 20~90, "note": "这个镜头要表达什么" }
  ]
}

人偶姿势：先选最接近的 posePreset，再用 pose 微调关节。关节角度单位是度，表示相对父关节的 XYZ 旋转，零姿态是双臂自然下垂站立。
可用关节：${JOINTS.join('、')}。另有 "hipsY": [下移米数, 0, 0] 用来降低身体（坐下约 -0.46，下蹲约 -0.5）。
- 肩、髋：X 为负向前抬起（-90 为水平向前），X 为正向后摆；左肩 Z 为正、右肩 Z 为负表示向身体外侧抬起（±90 为侧平举）。
- 肘：X 为负向前弯（-90 为直角）。膝：X 为正向后弯（90 为直角）。
- 腰背 spine：X 为正身体前倾。头 head：X 为正低头，X 为负抬头，Y 为正转向自己的左边。
- 左右按人偶自身：人偶面朝 +z 时，它的左侧是 +x。

镜头：position 是摄像机位置，target 是看向的点（通常在人物胸口或头部高度，约 y = 1.2~1.6）。fov 越小越像长焦特写。
给出 2 到 5 个镜头，景别和角度要有变化（如全景、中景、近景、过肩、俯拍、仰拍），摄像机不要放进物体内部。
物体最多 12 个，人偶最多 4 个，颜色用来区分角色和道具。

动画（可选，描述里有动作、走位或运镜时使用）：
- 会动的物体给出 keys，按时间 t 从 0 到 duration 递增，每个物体 2~8 个关键帧；中间状态会自动平滑过渡。没有动作的物体不写 keys。
- 每个关键帧写出该时刻的 position、rotationY 和姿势；人偶走路时每约 0.4~0.5 秒在 walk 与 walk2 之间交替，跑步在 run 与 run2 之间交替，同时 position 沿前进方向移动（走路约 1.2 米/秒，跑步约 3.5 米/秒）。
- 镜头的 t 表示摄像机在该时刻到达这个机位，按时间递增；播放时摄像机会沿各镜头平滑移动，因此相邻镜头之间应是连贯可走的运镜路径。`;

const num = (v, min, max, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const vec = (v, lim, d = [0, 0, 0]) => (Array.isArray(v) && v.length === 3 ? v.map((x, i) => num(x, lim[i][0], lim[i][1], d ? d[i] : 0)) : d);
const color = (v, d) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : d);
const text = (v, max, d = '') => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : d);

function cleanPose(p) {
  const pose = {};
  if (p && typeof p === 'object') {
    for (const [k, v] of Object.entries(p)) {
      if (k === 'hipsY') pose.hipsY = [num(Array.isArray(v) ? v[0] : v, -0.7, 0.2), 0, 0];
      else if (JOINTS.includes(k)) pose[k] = vec(v, [[-180, 180], [-180, 180], [-180, 180]]);
    }
  }
  return pose;
}

export function validatePlan(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('方案不是 JSON 对象');
  const issues = [];
  const duration = num(raw.duration, 2, 15, 5);
  const objects = [];
  for (const o of Array.isArray(raw.objects) ? raw.objects.slice(0, 16) : []) {
    if (!o || !KINDS.includes(o.kind)) { issues.push(`忽略未知物体类型 ${o?.kind}`); continue; }
    if (objects.length >= 12) break;
    if (o.kind === 'mannequin' && objects.filter((x) => x.kind === 'mannequin').length >= 4) continue;
    const pos = vec(o.position, [[-15, 15], [0, 6], [-15, 15]]);
    const item = {
      kind: o.kind,
      name: text(o.name, 20, o.kind === 'mannequin' ? '人物' : '道具'),
      color: color(o.color, o.kind === 'mannequin' ? '#d9d4cc' : '#8aa0b8'),
      position: o.kind === 'mannequin' ? [pos[0], 0, pos[2]] : pos,
      rotation: [0, num(o.rotationY, -360, 360), 0],
    };
    if (o.kind === 'mannequin') {
      item.scale = [1, 1, 1];
      item.posePreset = POSES.includes(o.posePreset) ? o.posePreset : 'stand';
      item.pose = cleanPose(o.pose);
    } else {
      const base = BASE_SIZE[o.kind];
      const size = vec(o.size, [[0.05, 20], [0.05, 10], [0.02, 20]], base);
      item.scale = size.map((v, i) => Math.round((v / base[i]) * 1000) / 1000);
    }
    if (Array.isArray(o.keys) && o.keys.length) {
      const keys = o.keys.slice(0, 12).filter((k) => k && typeof k === 'object').map((k) => {
        const kp = vec(k.position, [[-15, 15], [0, 6], [-15, 15]], item.position);
        return {
          t: Math.round(num(k.t, 0, duration) * 100) / 100,
          position: o.kind === 'mannequin' ? [kp[0], 0, kp[2]] : kp,
          rotationY: num(k.rotationY, -720, 720, item.rotation[1]),
          ...(o.kind === 'mannequin' ? {
            posePreset: POSES.includes(k.posePreset) ? k.posePreset : item.posePreset,
            pose: cleanPose(k.pose),
          } : {}),
        };
      }).sort((a, b) => a.t - b.t);
      if (keys.length >= 2) item.keys = keys;
      else if (keys.length) issues.push(`${item.name} 只有一个动画关键帧，已忽略`);
    }
    objects.push(item);
  }
  if (!objects.length) throw new Error('方案里没有可用的物体');

  const shots = [];
  for (const s of Array.isArray(raw.shots) ? raw.shots.slice(0, 8) : []) {
    const position = vec(s?.position, [[-25, 25], [0.05, 15], [-25, 25]], null);
    const target = vec(s?.target, [[-25, 25], [0, 10], [-25, 25]], null);
    if (!position || !target) { issues.push('忽略缺少位置的镜头'); continue; }
    if (Math.hypot(position[0] - target[0], position[1] - target[1], position[2] - target[2]) < 0.2) continue;
    shots.push({
      name: text(s.name, 16, `镜头 ${shots.length + 1}`), position, target, fov: num(s.fov, 12, 100, 40), note: text(s.note, 120),
      ...(s.t !== undefined && Number.isFinite(Number(s.t)) ? { t: Math.round(num(s.t, 0, duration) * 100) / 100 } : {}),
    });
  }
  const st = raw.settings || {};
  return {
    title: text(raw.title, 20, 'AI 方案'),
    duration,
    settings: {
      sky: SKIES.includes(st.sky) ? st.sky : 'studio',
      sunAzimuth: num(st.sunAzimuth, -180, 180, -35),
      sunElevation: num(st.sunElevation, 5, 89, 50),
      sunIntensity: num(st.sunIntensity, 0, 100, 70),
    },
    objects,
    shots,
    issues,
  };
}

export function extractJson(reply) {
  const s = String(reply || '').replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  if (start < 0) throw new Error('回复中没有 JSON');
  // 从第一个 { 开始做括号配对，忽略字符串里的括号
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(s.slice(start, i + 1).replace(/,\s*([}\]])/g, '$1'));
  }
  throw new Error('JSON 不完整');
}

r.post('/director/plan', requireAuth, async (req, res) => {
  const canvasId = String(req.body?.canvasId || '');
  if (!db.prepare('SELECT id FROM canvases WHERE id = ? AND user_id = ?').get(canvasId, req.user.id)) {
    return res.status(404).json({ error: '画布不存在或无权访问' });
  }
  const prompt = text(req.body?.prompt, 4000);
  if (prompt.length < 2) return res.status(400).json({ error: '请描述场景、人物动作和镜头' });
  const current = req.body?.current && typeof req.body.current === 'object' ? JSON.stringify(req.body.current).slice(0, 12_000) : '';
  let image = null;
  if (req.body?.referenceImage) {
    try { image = referenceImage(req.user.id, req.body.referenceImage); } catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  }

  const ask = [
    GUIDE,
    current ? `\n当前场景（在此基础上按要求修改，未提到的物体尽量保留位置和姿势）：\n${current}` : '',
    image ? '\n附带的参考图展示了想要的场景或构图，请据此布置物体位置、人物姿势和镜头。' : '',
    `\n用户要求：${prompt}`,
  ].join('\n');
  const content = image ? [{ type: 'text', text: ask }, { type: 'image_url', image_url: { url: image } }] : ask;

  try {
    let reply = await completeText([{ role: 'user', content }]);
    let plan;
    try {
      plan = validatePlan(extractJson(reply));
    } catch (first) {
      // 让 Muse 修正一次
      reply = await completeText([
        { role: 'user', content },
        { role: 'assistant', content: reply.slice(0, 12_000) },
        { role: 'user', content: `上面的输出无法使用（${first.message}）。请只输出一个符合格式的完整 JSON 对象，不要任何其他文字。` },
      ]);
      plan = validatePlan(extractJson(reply));
    }
    res.json({ plan });
  } catch (error) {
    const timedOut = ['TimeoutError', 'AbortError'].includes(error.name);
    res.status(timedOut ? 504 : (error.status && error.status < 600 ? error.status : 502)).json({
      error: timedOut ? 'Muse 响应超时，请稍后重试' : `AI 布景失败：${error.message}`,
    });
  }
});

export default r;
