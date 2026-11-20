// ComfyUI 工作流库：服务地址、节点定义缓存、参数自动提取、取值校验与写回、技能包。
// 思路参考 dsh-comfyui（MIT）的工作流库 / 参数快照 / 技能包设计，代码为 musecanvas 重写。
import fs from 'node:fs';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { CFG } from './config.js';
import { request } from './comfyui.js';
import { convertGraphToApi, isUiGraph } from '../../shared/comfy-graph.js';

const DIR = path.join(CFG.dataDir, 'comfy');
const LIB_FILE = path.join(DIR, 'library.json');
const CONF_FILE = path.join(DIR, 'config.json');
const SKILL_DIR = path.join(DIR, 'skills');
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const plain = (x) => x && typeof x === 'object' && !Array.isArray(x);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

/* ------------------------------ 服务地址 ------------------------------ */
let config = readJson(CONF_FILE, null) || { baseUrl: 'http://127.0.0.1:8188', apiKey: '' };
export const server = () => ({ baseUrl: config.baseUrl, apiKey: config.apiKey, comfy: { outputNode: '' } });
export const publicConfig = () => ({ baseUrl: config.baseUrl, keySet: !!config.apiKey });
export function saveConfig(input) {
  let url;
  try { url = new URL(String(input.baseUrl || '').trim()); } catch { throw bad('ComfyUI 地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw bad('ComfyUI 地址只能是不带账号和查询参数的 HTTP(S) 地址');
  const apiKey = input.apiKey === undefined || input.apiKey === '' ? config.apiKey : String(input.apiKey).trim();
  if (apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw bad('API Key 无效');
  config = { baseUrl: url.href.replace(/\/$/, ''), apiKey };
  infoCache = null;
  writeJson(CONF_FILE, config);
  return publicConfig();
}
export const comfyRequest = (route, opts) => request(server(), route, opts);

/* ------------------------------ 节点定义 ------------------------------ */
let infoCache = null;
export async function objectInfo(force = false) {
  if (!force && infoCache && Date.now() - infoCache.at < 5 * 60_000) return infoCache.data;
  const data = await comfyRequest('/object_info', { timeout: 90_000 });
  if (!plain(data) || !Object.keys(data).length) throw bad('ComfyUI 未返回节点定义', 502);
  infoCache = { at: Date.now(), data };
  return data;
}
export async function status() {
  const stats = await comfyRequest('/system_stats', { timeout: 8000 });
  const device = stats.devices?.[0];
  return {
    ok: true,
    version: stats.system?.comfyui_version || '',
    device: device ? `${device.name || device.type}`.replace(/^cuda:\d+\s*/, '') : '',
    vramTotal: device?.vram_total || 0,
    vramFree: device?.vram_free || 0,
  };
}

function specOf(info, classType, key) {
  const def = info?.[classType]?.input;
  const spec = def?.required?.[key] ?? def?.optional?.[key];
  return Array.isArray(spec) ? spec : undefined;
}
function describeSpec(info, classType, key) {
  const spec = specOf(info, classType, key);
  if (!spec) return {};
  const [type, meta = {}] = spec;
  if (Array.isArray(type)) return { options: type.slice(0, 400) };
  if (Array.isArray(meta?.options)) return { options: meta.options.slice(0, 400) };
  const names = typeof type === 'string' ? type.split(',').map((n) => n.split(':')[0].trim().toUpperCase()) : [];
  if (names.includes('INT') || names.includes('FLOAT')) {
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    return { numberKind: names.includes('FLOAT') ? 'float' : 'int', min: num(meta.min), max: num(meta.max), step: num(meta.step) };
  }
  return {};
}

/** 已安装的模型、LoRA、采样器等，供 AI 选择。 */
export async function modelDigest() {
  const info = await objectInfo();
  const opt = (cls, key) => describeSpec(info, cls, key).options || [];
  return {
    checkpoints: opt('CheckpointLoaderSimple', 'ckpt_name'),
    unets: opt('UNETLoader', 'unet_name'),
    loras: opt('LoraLoader', 'lora_name'),
    samplers: opt('KSampler', 'sampler_name'),
    schedulers: opt('KSampler', 'scheduler'),
  };
}

/* ------------------------------ 参数提取 ------------------------------ */
const TEXT_KEYS = new Set(['text', 'prompt', 'value', 'string', 'text_g', 'text_l', 'clip_l', 't5xxl', 'positive', 'negative']);
const ROLE_BY_KEY = [
  [/^(seed|noise_seed)$/, 'seed', 'seed'],
  [/^steps$/, 'steps', 'sampling'],
  [/^cfg$/, 'cfg', 'sampling'],
  [/^denoise$/, 'denoise', 'sampling'],
  [/^sampler_name$/, 'sampler', 'sampling'],
  [/^scheduler$/, 'scheduler', 'sampling'],
  [/^guidance$/, 'guidance', 'sampling'],
  [/^shift$/, 'shift', 'sampling'],
  [/^width$/, 'width', 'size'],
  [/^height$/, 'height', 'size'],
  [/^(length|num_frames|frames|video_length|frame_count)$/, 'frames', 'frames'],
  [/^(fps|frame_rate)$/, 'fps', 'fps'],
  [/^batch_size$/, 'batch_size', 'size'],
  [/^(ckpt_name|unet_name)$/, 'checkpoint', 'model'],
  [/^lora_name$/, 'lora', 'lora'],
  [/^strength_model$/, 'lora_strength', 'lora'],
  [/^strength_clip$/, 'lora_clip_strength', 'lora'],
];
const LABELS = {
  prompt: '正向提示词', negative_prompt: '负面提示词', seed: '随机种子', steps: '采样步数', cfg: 'CFG', denoise: '重绘幅度',
  sampler: '采样器', scheduler: '调度器', guidance: '引导强度', shift: 'Shift', width: '宽度', height: '高度', frames: '帧数',
  fps: '帧率', batch_size: '批量', checkpoint: '主模型', lora: 'LoRA', lora_strength: 'LoRA 强度', lora_clip_strength: 'LoRA CLIP 强度',
  image: '参考图', video: '参考视频',
};
const AI_ROLES = new Set(['prompt', 'negative', 'sampling', 'size', 'frames', 'fps', 'model', 'lora', 'seed']);

/** 从采样器的 positive / negative 输入向上游回溯，判断文本节点是正向还是负面。 */
function promptRoles(workflow) {
  const reach = (startKey) => {
    const found = new Set();
    const queue = [];
    for (const node of Object.values(workflow)) {
      const link = node.inputs?.[startKey];
      if (Array.isArray(link)) queue.push([link[0], 0]);
    }
    while (queue.length) {
      const [id, depth] = queue.shift();
      if (found.has(id) || depth > 8 || !workflow[id]) continue;
      found.add(id);
      const inputs = workflow[id].inputs || {};
      // 带 positive / negative 输入的中间节点（如 WanImageToVideo、ControlNet）只沿同一极性继续回溯
      const polar = Array.isArray(inputs.positive) || Array.isArray(inputs.negative);
      const next = polar ? [inputs[startKey]] : Object.values(inputs);
      for (const v of next) if (Array.isArray(v)) queue.push([v[0], depth + 1]);
    }
    return found;
  };
  return { pos: reach('positive'), neg: reach('negative') };
}

export function extractParams(workflow, info) {
  const params = [];
  const used = new Map();
  const unique = (base) => {
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  };
  const { pos, neg } = promptRoles(workflow);
  const ids = Object.keys(workflow).sort((a, b) => (Number(a) || 0) - (Number(b) || 0));
  for (const id of ids) {
    const node = workflow[id];
    const cls = node.class_type;
    for (const [key, value] of Object.entries(node.inputs || {})) {
      if (Array.isArray(value) || value === null || typeof value === 'object') continue;
      let name;
      let role;
      if (typeof value === 'string' && TEXT_KEYS.has(key) && /Text|Prompt|String|CLIP|Encode/i.test(cls)) {
        const negative = neg.has(id) && !pos.has(id);
        role = negative ? 'negative' : 'prompt';
        name = unique(negative ? 'negative_prompt' : 'prompt');
      } else if (/^Load(Image|ImageMask)/.test(cls) && key === 'image') {
        role = 'image';
        name = unique('image');
      } else if (/^Load.*Video|VHS_LoadVideo/.test(cls) && /video/.test(key)) {
        role = 'video';
        name = unique('video');
      } else {
        const hit = ROLE_BY_KEY.find(([re]) => re.test(key));
        if (!hit) continue;
        if (hit[2] === 'size' && !/Latent|Video|Resolution|Size|Image|Empty/i.test(cls)) continue;
        name = unique(hit[1]);
        role = hit[2];
      }
      const base = name.replace(/_\d+$/, '');
      params.push({
        name,
        label: (LABELS[base] || `${cls} · ${key}`) + (name !== base ? ` ${name.split('_').pop()}` : ''),
        role,
        type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string',
        nodeId: id,
        input: key,
        nodeTitle: node._meta?.title || cls,
        default: value,
        enabled: true,
        ai: AI_ROLES.has(role) && role !== 'image',
        ...(role === 'seed' ? { random: true } : {}),
        ...describeSpec(info, cls, key),
      });
    }
  }
  return params;
}

/** 工作流里引用、但本机 ComfyUI 下拉选项中不存在的值（通常是没下载的模型文件）。 */
export function missingValues(workflow, info) {
  if (!info) return [];
  const out = [];
  for (const [id, node] of Object.entries(workflow)) {
    for (const [key, value] of Object.entries(node.inputs || {})) {
      if (typeof value !== 'string' || Array.isArray(value)) continue;
      const options = describeSpec(info, node.class_type, key).options;
      if (options?.length && !options.includes(value) && /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx|sft)$/i.test(value)) {
        out.push({ nodeId: id, input: key, value, node: node._meta?.title || node.class_type });
      }
    }
  }
  return out;
}

function detectOutput(workflow) {
  const entries = Object.entries(workflow);
  const pick = (re) => entries.find(([, n]) => re.test(n.class_type))?.[0];
  const video = pick(/SaveVideo|VideoCombine|SaveWEBM|SaveAnimated/);
  const image = pick(/^SaveImage|Image.*Save/);
  return video ? { outputNode: video, kind: 'video' } : { outputNode: image || pick(/PreviewImage/) || '', kind: 'image' };
}

/* ------------------------------ 工作流库 ------------------------------ */
let library = readJson(LIB_FILE, []);
const persist = () => writeJson(LIB_FILE, library);

export const listWorkflows = () => library.map(summary);
export const getWorkflow = (id) => library.find((w) => w.id === id);
function summary(w) {
  return {
    id: w.id, name: w.name, kind: w.kind, description: w.description, tags: w.tags, nodes: Object.keys(w.workflow).length,
    params: w.params, outputNode: w.outputNode, requiresImage: w.requiresImage, skillRequired: w.skillRequired, missing: w.missing || [],
    hasSkill: !!readSkill(w.id).trim(), updatedAt: w.updatedAt, revision: w.revision, source: w.source,
  };
}

/** 导入 API 或界面格式工作流（界面格式用 /object_info 转换）。 */
export async function importWorkflow({ json, name, kind, description = '', tags = [], source = 'file' }) {
  if (!plain(json)) throw bad('工作流必须是 JSON 对象');
  let workflow = json.workflow && plain(json.workflow) && !isUiGraph(json) ? json.workflow : json.prompt && plain(json.prompt) ? json.prompt : json;
  const warnings = [];
  let info = null;
  try { info = await objectInfo(); } catch (e) { if (isUiGraph(workflow)) throw bad('转换界面工作流需要连接 ComfyUI：' + e.message, 502); }
  if (isUiGraph(workflow)) {
    const converted = convertGraphToApi(workflow, info);
    if (!converted.ok) throw bad(converted.error);
    workflow = converted.workflow;
    warnings.push(...converted.warnings);
  }
  const nodes = Object.entries(workflow);
  if (!nodes.length || nodes.length > 600 || !nodes.every(([, n]) => plain(n) && typeof n.class_type === 'string' && plain(n.inputs))) {
    throw bad('不是有效的 ComfyUI 工作流（API 格式或界面格式）');
  }
  if (info) {
    const missing = [...new Set(nodes.map(([, n]) => n.class_type).filter((c) => !info[c]))];
    if (missing.length) warnings.push(`ComfyUI 当前缺少节点：${missing.slice(0, 8).join('、')}`);
  } else warnings.push('未连接 ComfyUI，参数的可选项和范围暂未读取，连接后点「刷新参数」');
  const out = detectOutput(workflow);
  const params = extractParams(workflow, info);
  const missing = missingValues(workflow, info);
  if (missing.length) warnings.push(`本机缺少模型文件：${missing.map((m) => m.value).join('、')}`);
  if (!params.some((p) => p.role === 'prompt')) warnings.push('没有识别到正向提示词输入，请在参数表里手动指定');
  if (!out.outputNode) warnings.push('没有识别到保存图片或视频的输出节点');
  const entry = {
    id: randomUUID(),
    name: String(name || '未命名工作流').slice(0, 80),
    kind: kind === 'video' || kind === 'image' ? kind : out.kind,
    description: String(description).slice(0, 500),
    tags: Array.isArray(tags) ? tags.map(String).slice(0, 12) : [],
    workflow,
    params,
    outputNode: out.outputNode,
    requiresImage: params.some((p) => p.role === 'image'),
    skillRequired: false,
    missing,
    source,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: randomUUID(),
  };
  library = [...library, entry];
  persist();
  return { workflow: summary(entry), warnings };
}

export function updateWorkflow(id, input) {
  const w = getWorkflow(id);
  if (!w) throw bad('工作流不存在', 404);
  const next = { ...w };
  if (input.name !== undefined) next.name = String(input.name).trim().slice(0, 80) || w.name;
  if (input.description !== undefined) next.description = String(input.description).slice(0, 500);
  if (Array.isArray(input.tags)) next.tags = input.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12);
  if (['image', 'video'].includes(input.kind)) next.kind = input.kind;
  if (input.outputNode !== undefined) {
    if (!w.workflow[input.outputNode]) throw bad('输出节点不存在');
    next.outputNode = String(input.outputNode);
  }
  if (input.requiresImage !== undefined) next.requiresImage = !!input.requiresImage;
  if (input.skillRequired !== undefined) next.skillRequired = !!input.skillRequired;
  if (Array.isArray(input.params)) {
    const byName = new Map(w.params.map((p) => [p.name, p]));
    const names = new Set();
    next.params = input.params.map((p) => {
      const old = byName.get(p.name) || {};
      const nodeId = String(p.nodeId ?? old.nodeId);
      const key = String(p.input ?? old.input);
      if (!w.workflow[nodeId] || !(key in w.workflow[nodeId].inputs) || Array.isArray(w.workflow[nodeId].inputs[key])) throw bad(`参数 ${p.name} 指向的节点输入不存在`);
      const name = String(p.name || '').trim();
      if (!/^[a-z][a-z0-9_]{0,40}$/.test(name) || names.has(name)) throw bad(`参数名 ${name} 无效或重复（小写字母、数字、下划线）`);
      names.add(name);
      return {
        ...old,
        name,
        nodeId,
        input: key,
        label: String(p.label ?? old.label ?? name).slice(0, 40),
        role: String(p.role ?? old.role ?? 'other'),
        type: old.type || (typeof w.workflow[nodeId].inputs[key] === 'number' ? 'number' : 'string'),
        default: p.default !== undefined ? p.default : old.default ?? w.workflow[nodeId].inputs[key],
        description: String(p.description ?? old.description ?? '').slice(0, 200),
        enabled: p.enabled !== false,
        ai: !!(p.ai ?? old.ai),
        ...(p.random !== undefined ? { random: !!p.random } : {}),
      };
    });
  }
  next.updatedAt = Date.now();
  next.revision = randomUUID();
  library = library.map((x) => (x.id === id ? next : x));
  persist();
  return summary(next);
}

/** 用最新的 /object_info 刷新参数的可选项与范围；用户的开关、名称与默认值保留。 */
export async function refreshParams(id) {
  const w = getWorkflow(id);
  if (!w) throw bad('工作流不存在', 404);
  const info = await objectInfo(true);
  const params = w.params.map((p) => {
    const { options, min, max, step, numberKind, ...rest } = p;
    return { ...rest, ...describeSpec(info, w.workflow[p.nodeId]?.class_type, p.input) };
  });
  library = library.map((x) => (x.id === id ? { ...w, params, missing: missingValues(w.workflow, info), updatedAt: Date.now() } : x));
  persist();
  return summary(getWorkflow(id));
}

export function deleteWorkflow(id) {
  library = library.filter((w) => w.id !== id);
  persist();
  fs.rmSync(path.join(SKILL_DIR, safeId(id)), { recursive: true, force: true });
}

/* ------------------------------ 取值与写回 ------------------------------ */
function coerce(p, raw) {
  if (p.type === 'number') {
    let n = Number(raw);
    if (!Number.isFinite(n)) throw bad(`参数 ${p.name} 需要数字`);
    if (p.numberKind === 'int' || p.role === 'seed' || ['steps', 'width', 'height', 'frames', 'batch_size'].includes(p.name.replace(/_\d+$/, ''))) n = Math.round(n);
    if (p.min !== undefined) n = Math.max(p.min, n);
    if (p.max !== undefined) n = Math.min(p.max, n);
    return n;
  }
  if (p.type === 'boolean') return raw === true || raw === 'true' || raw === 1;
  const s = String(raw).slice(0, 20_000);
  if (p.options?.length && !p.options.includes(s)) throw bad(`参数 ${p.name} 的取值「${s.slice(0, 60)}」不在可选项中`);
  return s;
}

/** 校验一组取值：未知参数、不可调参数和不在可选项里的值会被拒绝。 */
export function checkValues(w, values = {}, { aiOnly = false } = {}) {
  const errors = [];
  const clean = {};
  for (const [name, raw] of Object.entries(values || {})) {
    const p = w.params.find((x) => x.name === name && x.enabled);
    if (!p) { errors.push(`未知参数 ${name}`); continue; }
    if (aiOnly && !p.ai) { errors.push(`参数 ${name} 不允许 AI 修改`); continue; }
    if (['image', 'video'].includes(p.role)) continue;
    try { clean[name] = coerce(p, raw); } catch (e) { errors.push(e.message); }
  }
  return { values: clean, errors };
}

function sizeFromRatio(w, ratio) {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio || '');
  const wp = w.params.find((p) => p.name === 'width' && p.enabled);
  const hp = w.params.find((p) => p.name === 'height' && p.enabled);
  if (!m || !wp || !hp) return {};
  const r = Number(m[1]) / Number(m[2]);
  const area = Number(wp.default) * Number(hp.default);
  const round = (n) => Math.max(64, Math.min(4096, Math.round(n / 16) * 16));
  return { width: round(Math.sqrt(area * r)), height: round(Math.sqrt(area / r)) };
}

function framesFor(w, seconds, values) {
  const fp = w.params.find((p) => p.name === 'frames' && p.enabled);
  if (!fp || !seconds) return {};
  const fps = Number(values.fps ?? w.params.find((p) => p.name === 'fps')?.default ?? 16) || 16;
  const def = Number(fp.default) || 81;
  let frames = Math.round(seconds * fps);
  if (def % 4 === 1) frames = Math.round((frames - 1) / 4) * 4 + 1;
  if (fp.max !== undefined) frames = Math.min(fp.max, frames);
  return { frames: Math.max(1, frames) };
}

/**
 * 生成可提交的 API 工作流：AI / 用户取值 > 画幅比例和时长换算 > 工作流默认值。
 * uploads 为已上传到 ComfyUI 的参考文件名，按顺序填入图片参数。
 */
export function buildWorkflow(w, { values = {}, ratio, seconds, uploads = [] } = {}) {
  const workflow = structuredClone(w.workflow);
  const merged = { ...sizeFromRatio(w, ratio), ...framesFor(w, seconds, values), ...values };
  const used = {};
  let upload = 0;
  for (const p of w.params.filter((x) => x.enabled)) {
    let value;
    if (p.role === 'image' || p.role === 'video') {
      if (upload < uploads.length) value = uploads[upload++];
      else if (w.requiresImage && p.role === 'image' && !w.params.slice(0, w.params.indexOf(p)).some((x) => x.role === 'image')) throw bad('此工作流需要参考图，请连接图片');
      else continue;
    } else if (merged[p.name] !== undefined) value = coerce(p, merged[p.name]);
    else if (p.role === 'seed' && p.random) value = randomInt(0, 2 ** 47);
    else continue;
    if (!workflow[p.nodeId]) continue;
    workflow[p.nodeId].inputs[p.input] = value;
    used[p.name] = value;
  }
  return { workflow, used };
}

/* -------------------------------- 技能包 -------------------------------- */
const safeId = (id) => String(id).replace(/[^\w-]/g, '').slice(0, 64);
const skillFile = (id) => path.join(SKILL_DIR, safeId(id), 'SKILL.md');
export function readSkill(id) {
  try { return fs.readFileSync(skillFile(id), 'utf8'); } catch { return ''; }
}
export function writeSkill(id, text) {
  if (!getWorkflow(id)) throw bad('工作流不存在', 404);
  const body = String(text || '').slice(0, 60_000);
  fs.mkdirSync(path.dirname(skillFile(id)), { recursive: true });
  fs.writeFileSync(skillFile(id), body);
  return body;
}
export function appendLesson(id, lesson) {
  const text = String(lesson || '').trim().slice(0, 600);
  if (!text) throw bad('经验内容为空');
  const current = readSkill(id);
  const header = current.includes('## 经验记录') ? '' : `${current.trim() ? '\n\n' : ''}## 经验记录\n`;
  const date = new Date().toISOString().slice(0, 10);
  return writeSkill(id, `${current.trimEnd()}${header}\n- ${date}：${text.replace(/\n+/g, ' ')}\n`);
}
export function skillSummary(id) {
  const text = readSkill(id);
  const line = text.split('\n').map((s) => s.replace(/^#+\s*/, '').trim()).find((s) => s && !/^(SKILL|技能)/i.test(s));
  return line ? line.slice(0, 120) : '';
}

/* --------------------------- ComfyUI 端保存的工作流 --------------------------- */
export async function remoteWorkflows() {
  const list = await comfyRequest('/userdata?dir=workflows&recurse=true&split=false', { timeout: 15000 });
  return (Array.isArray(list) ? list : []).filter((f) => typeof f === 'string' && f.endsWith('.json')).slice(0, 500);
}
export async function importRemote(file) {
  if (typeof file !== 'string' || file.includes('..')) throw bad('文件名无效');
  const json = await comfyRequest('/userdata/' + encodeURIComponent('workflows/' + file), { timeout: 30000 });
  return importWorkflow({ json, name: file.replace(/\.json$/i, '').split('/').pop(), source: 'comfyui' });
}
