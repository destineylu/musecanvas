import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CFG } from './config.js';

const file = path.join(CFG.dataDir, 'models.json');
const kinds = ['chat', 'image', 'video'];
const empty = () => ({ providers: [], defaults: { chat: 'muse', image: 'muse', video: 'muse' } });
let state = empty();
if (fs.existsSync(file)) state = JSON.parse(fs.readFileSync(file, 'utf8'));
function persist(next) {
  fs.mkdirSync(CFG.dataDir, { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  state = next;
}
const bad = message => Object.assign(new Error(message), { status: 400 });
export function publicModels() {
  return { defaults: { ...state.defaults }, providers: state.providers.map(({ apiKey, ...p }) => ({ ...p, keySet: !!apiKey })) };
}
export function selectedModel(kind) {
  const id = state.defaults[kind];
  if (!id || id === 'muse') return null;
  const p = state.providers.find(p => p.id === id && p.kind === kind);
  if (!p) throw bad('所选模型不存在，请重新设置');
  return { ...p };
}
export function modelById(id) { return state.providers.find(p => p.id === id); }
export function saveModel(id, input) {
  const old = id ? modelById(id) : null;
  if (id && !old) throw bad('模型不存在');
  const p = { ...old, id: id || randomUUID(), revision: randomUUID() };
  for (const k of ['name', 'kind', 'baseUrl', 'model', 'protocol', 'createPath', 'pollPath', 'contentPath', 'editPath']) p[k] = String(input[k] ?? old?.[k] ?? '').trim();
  if (!p.name || p.name.length > 100 || !p.model || p.model.length > 200 || !kinds.includes(p.kind)) throw bad('请填写名称、模型 ID 和模型类型');
  let url; try { url = new URL(p.baseUrl); } catch { throw bad('Base URL 无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw bad('Base URL 仅允许不带密码和查询参数的 HTTP/HTTPS 地址');
  p.baseUrl = url.href.replace(/\/$/, '');
  const allowed = { chat: ['chat'], image: ['images'], video: ['video-json', 'video-openai'] };
  if (!allowed[p.kind].includes(p.protocol)) throw bad('模型类型与协议不匹配');
  for (const key of ['createPath', 'pollPath', 'contentPath', 'editPath']) {
    if (p[key] && (!p[key].startsWith('/') || p[key].startsWith('//') || /[?#\\]/.test(p[key]) || p[key].split('/').includes('..'))) throw bad('接口路径必须以 / 开头且不能包含查询参数');
  }
  if (!p.createPath) p.createPath = p.kind === 'chat' ? '/chat/completions' : p.kind === 'image' ? '/images/generations' : '/videos';
  if (!p.editPath) p.editPath = '/images/edits';
  if (!p.pollPath) p.pollPath = '/videos/{id}';
  if (!p.contentPath) p.contentPath = '/videos/{id}/content';
  p.apiKey = input.apiKey === undefined || input.apiKey === '' ? old?.apiKey || '' : String(input.apiKey).trim();
  if (p.apiKey.length > 4096 || /[\r\n]/.test(p.apiKey)) throw bad('API Key 无效');
  for (const key of ['extra', 'sizes']) {
    p[key] = input[key] ?? old?.[key] ?? {};
    if (!p[key] || typeof p[key] !== 'object' || Array.isArray(p[key]) || JSON.stringify(p[key]).length > 10000) throw bad('附加参数和比例映射必须是 JSON 对象');
  }
  if (Object.values(p.sizes).some(v => typeof v !== 'string' || v.length > 80)) throw bad('比例映射的值必须是尺寸字符串');
  if (['model','messages','prompt','stream','images','image','input_reference'].some(k => k in p.extra)) throw bad('附加参数不能覆盖模型、提示词和参考图字段');
  p.maxConcurrency = Math.max(1, Math.min(4, Math.floor(Number(input.maxConcurrency ?? old?.maxConcurrency) || 1)));
  p.maxReferences = Math.max(0, Math.min(p.protocol === 'video-openai' ? 1 : 3, Math.floor(Number(input.maxReferences ?? old?.maxReferences) || 0)));
  p.durations = input.durations ?? old?.durations ?? (p.protocol === 'video-openai' ? [4,8,12] : [5,6,8,10]);
  if (!Array.isArray(p.durations) || !p.durations.length || p.durations.length>20 || p.durations.some(n=>!Number.isInteger(n)||n<1||n>120)) throw bad('时长必须是 1–120 秒的整数数组');
  persist({ ...state, providers: [...state.providers.filter(x => x.id !== p.id), p] });
  return publicModels();
}
export function setDefaults(defaults) {
  const next = { ...state.defaults };
  for (const kind of kinds) if (Object.hasOwn(defaults, kind)) {
    const id = defaults[kind];
    if (id !== 'muse' && !state.providers.some(p => p.id === id && p.kind === kind)) throw bad('请选择正确类型的模型');
    next[kind] = id;
  }
  persist({ ...state, defaults: next });
  return publicModels();
}
export function deleteModel(id) {
  if (Object.values(state.defaults).includes(id)) throw bad('请先把默认模型切换到其它选项');
  persist({ ...state, providers: state.providers.filter(p => p.id !== id) });
  return publicModels();
}
