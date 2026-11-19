import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CFG } from '../config.js';
import { Store, normalizeBridge, normalizeModel, normalizeSettings } from './config.js';
import { Pool } from './pool.js';
import { httpRequest, httpPipe } from './http.js';

const store = new Store(path.join(CFG.dataDir, 'bridges.json'));
store.load();
const pool = new Pool(store);
let started = false;
const logs = [];

export function startBridgePool() {
  if (started) return;
  started = true;
  pool.startHealth();
}
export function bridgeState() {
  const { requestTimeoutSec, queueTimeoutSec, retryDelaySec, maxRetries, healthIntervalSec, failThreshold, cooldownSec } = store.data.settings;
  return {
    settings: { requestTimeoutSec, queueTimeoutSec, retryDelaySec, maxRetries, healthIntervalSec, failThreshold, cooldownSec },
    bridges: store.data.bridges.map(({ token, ...item }) => ({ ...item, tokenSet: !!token })),
    models: store.data.models,
    pool: pool.snapshot(),
    logs: logs.slice(-60).reverse(),
  };
}
export function saveBridge(id, input) {
  const existing = id && store.bridge(id);
  if (id && !existing) throw Object.assign(new Error('Bridge 不存在'), { status: 404 });
  if (existing && pool.rt(id).busy) throw Object.assign(new Error('此 Bridge 正在生成，请完成后修改'), { status: 409 });
  const bridge = normalizeBridge(input, existing);
  if (!id && store.bridge(bridge.id)) throw Object.assign(new Error('Bridge ID 重复'), { status: 409 });
  const before = store.data.bridges;
  store.data.bridges = id ? before.map(item => item.id === id ? bridge : item) : [...before, bridge];
  try { store.save(); } catch (error) { store.data.bridges = before; throw error; }
  void pool.checkOne(bridge).then(() => pool.dispatch());
  return bridgeState();
}
export function deleteBridge(id) {
  if (pool.rt(id).busy) throw Object.assign(new Error('此 Bridge 正在生成'), { status: 409 });
  const before = store.data;
  store.data = { ...before, bridges: before.bridges.filter(b => b.id !== id),
    models: before.models.map(m => ({ ...m, bridges: m.bridges.filter(key => key !== id) })) };
  try { store.save(); } catch (error) { store.data = before; throw error; }
  pool.forget(id);
  return bridgeState();
}
export function saveModels(input) {
  if (!Array.isArray(input) || !input.length || input.length > 100) throw Object.assign(new Error('请提供模型列表'), { status: 400 });
  const ids = store.data.bridges.map(b => b.id);
  const models = input.map(item => normalizeModel(item, null, ids));
  if (new Set(models.map(m => m.id)).size !== models.length) throw Object.assign(new Error('模型 ID 重复'), { status: 400 });
  const before = store.data.models;
  store.data.models = models;
  try { store.save(); } catch (error) { store.data.models = before; throw error; }
  pool.dispatch();
  return bridgeState();
}
export function saveSettings(input) {
  const allowed = ['requestTimeoutSec', 'queueTimeoutSec', 'retryDelaySec', 'maxRetries', 'healthIntervalSec', 'failThreshold', 'cooldownSec'];
  const patch = Object.fromEntries(allowed.filter(k => k in input).map(k => [k, input[k]]));
  const before = store.data.settings;
  store.data.settings = normalizeSettings(patch, before);
  try { store.save(); } catch (error) { store.data.settings = before; throw error; }
  pool.startHealth();
  return bridgeState();
}
export async function checkBridges() {
  await pool.checkAll();
  return bridgeState();
}
export async function testBridge(id) {
  const b = store.bridge(id);
  if (!b) throw Object.assign(new Error('Bridge 不存在'), { status: 404 });
  const timed = async fn => {
    const time = Date.now();
    try { return { ...(await fn()), ms: Date.now() - time }; }
    catch (error) { return { ok: false, error: error.code || '连接失败', ms: Date.now() - time }; }
  };
  const [health, models, files] = await Promise.all([
    timed(async () => ({ ok: await pool.checkOne(b) })),
    timed(async () => {
      const r = await httpRequest(b.baseUrl + '/models', { headers: { Authorization: 'Bearer ' + b.token }, timeoutMs: 10_000 });
      if (r.status !== 200) return { ok: false, status: r.status };
      const data = JSON.parse(r.text);
      const ids = Array.isArray(data.data) ? data.data.map(m => m.id).filter(id => typeof id === 'string') : [];
      return { ok: ids.length > 0, status: r.status, ids };
    }),
    timed(async () => {
      const r = await httpRequest((b.fileFetchUrl || b.fileBaseUrl) + '/', { timeoutMs: 10_000 });
      return { ok: r.status >= 200 && r.status < 300, status: r.status };
    }),
  ]);
  pool.dispatch();
  return { health, models, files };
}

const mediaPattern = /https?:\/\/[^\s<>"'\x60)\]]+\.(?:webp|png|jpe?g|gif|avif|mp4|webm|mov)(?:\?[^\s<>"'\x60)\]]*)?/gi;
const publicOrigin = () => CFG.publicBase || 'http://127.0.0.1:' + CFG.port;
function rewriteMedia(content) {
  return content.replace(mediaPattern, value => {
    const url = new URL(value);
    const bridge = store.data.bridges.find(b => new URL(b.fileBaseUrl).origin === url.origin);
    if (!bridge) return value;
    return publicOrigin() + '/bridge-media/' + encodeURIComponent(bridge.id) + url.pathname + url.search;
  });
}
export function mediaFetchUrl(value) {
  const url = new URL(value);
  if (url.username || url.password) return null;
  const publicBase = new URL(publicOrigin());
  if (url.origin === publicBase.origin && url.pathname.startsWith('/bridge-media/')) {
    const parts = url.pathname.slice('/bridge-media/'.length).split('/');
    const bridge = store.bridge(decodeURIComponent(parts.shift()));
    if (!bridge || !parts.length) return null;
    const decoded = parts.map(decodeURIComponent);
    if (decoded.some(p => !p || p === '.' || p === '..' || /[\/\\\x00-\x1f]/.test(p))) return null;
    return (bridge.fileFetchUrl || bridge.fileBaseUrl) + '/' + decoded.map(encodeURIComponent).join('/') + url.search;
  }
  return null;
}
export async function proxyMedia(req, res) {
  try {
    const value = publicOrigin() + req.originalUrl;
    const target = mediaFetchUrl(value);
    if (!target) return res.status(404).end();
    await httpPipe(target, res, { method: req.method, headers: req.headers.range ? { Range: req.headers.range } : {} });
  } catch {
    if (!res.headersSent) res.status(502).json({ error: '媒体代理下载失败' });
    else res.destroy();
  }
}

async function run(body, signal) {
  const model = store.model(body.model);
  if (!model?.enabled) throw Object.assign(new Error('模型不存在或已停用'), { status: 404 });
  const settings = { ...store.data.settings };
  const entry = { model: model.id, bridge: '', state: 'queued', attempts: 0, startedAt: Date.now() };
  logs.push(entry);
  if (logs.length > 100) logs.shift();
  const exclude = new Set();
  let lastError;
  try {
    for (let attempt = 0; attempt <= settings.maxRetries; attempt++) {
      signal?.throwIfAborted();
      if (attempt) await delay(settings.retryDelaySec * 1000, undefined, { signal });
      entry.state = 'queued';
      const b = await pool.acquire(model, { exclude, signal, timeoutMs: settings.queueTimeoutSec * 1000 });
      const start = Date.now();
      entry.state = 'running'; entry.bridge = b.id; entry.attempts++;
      let fault = false;
      let message = '';
      try {
        // Keep the worker reserved through completion even after a client disconnects.
        const r = await httpRequest(b.baseUrl + '/chat/completions', {
          method: 'POST', headers: { Authorization: 'Bearer ' + b.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, model: model.upstreamModel, stream: false }),
          timeoutMs: settings.requestTimeoutSec * 1000,
        });
        if (r.status >= 400) throw Object.assign(new Error('Bridge 返回 HTTP ' + r.status), { status: r.status });
        const data = JSON.parse(r.text);
        const content = data?.choices?.[0]?.message?.content;
        const tools = data?.choices?.[0]?.message?.tool_calls;
        if (typeof content !== 'string' && !tools?.length) throw new Error('Bridge 返回格式无效');
        if (!content?.trim() && !tools?.length) throw new Error('Bridge 返回空内容');
        if (model.type !== 'chat') {
          const links = content?.match(mediaPattern) || [];
          const video = u => /\.(mp4|webm|mov)(?:\?|$)/i.test(u);
          if (!links.some(u => model.type === 'video' ? video(u) : !video(u))) throw new Error('Bridge 未返回对应类型的媒体链接');
        }
        if (content) data.choices[0].message.content = rewriteMedia(content);
        data.model = model.id;
        entry.state = 'ok';
        return data;
      } catch (error) {
        fault = !error.status || error.status >= 500 || [401,403].includes(error.status);
        message = error.status ? 'HTTP ' + error.status : '连接或响应失败';
        lastError = Object.assign(new Error('Bridge ' + b.name + ' ' + message), { status: error.status || 502 });
        exclude.add(b.id);
        if (error.status && error.status >= 400 && error.status < 500) throw lastError;
      } finally {
        pool.release(b, { ms: Date.now() - start, bridgeFault: fault, error: message });
      }
    }
    throw lastError || new Error('Bridge 请求失败');
  } catch (error) {
    entry.state = signal?.aborted ? 'client-gone' : 'error';
    entry.error = error.message;
    throw error;
  } finally { entry.ms = Date.now() - entry.startedAt; }
}
export async function gatewayRequest(pathname, { method = 'GET', body, signal } = {}) {
  const route = new URL(pathname, 'http://localhost').pathname;
  if (route === '/models' && method === 'GET') {
    return Response.json({ object: 'list', data: store.data.models.filter(m => m.enabled).map(m => ({ id: m.id, object: 'model', owned_by: 'musecanvas' })) });
  }
  if (route !== '/chat/completions' || method !== 'POST') return Response.json({ error: { message: '未知接口' } }, { status: 404 });
  if (!body?.stream) {
    try { return Response.json(await run(body, signal)); }
    catch (e) { return Response.json({ error: { message: e.message } }, { status: e.status || 502 }); }
  }
  const encoder = new TextEncoder();
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const stream = new ReadableStream({
    start(sink) {
      let closed = false;
      const write = text => { if (!closed) sink.enqueue(encoder.encode(text)); };
      write(': queued\n\n');
      const heartbeat = setInterval(() => write(': ping\n\n'), 15_000);
      void run(body, combined).then(data => {
        const base = { id: data.id || 'chatcmpl-' + Date.now(), object: 'chat.completion.chunk', created: data.created || Math.floor(Date.now()/1000), model: body.model };
        const msg = data.choices[0].message;
        const delta = { role: 'assistant', content: msg.content || '' };
        if (msg.tool_calls) delta.tool_calls = msg.tool_calls.map((tool, index) => ({ index, ...tool }));
        write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
        write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: data.choices[0].finish_reason || 'stop' }], ...(data.usage ? { usage: data.usage } : {}) }) + '\n\n');
      }).catch(e => write('data: ' + JSON.stringify({ error: { message: e.message } }) + '\n\n'))
        .finally(() => {
          clearInterval(heartbeat);
          if (!closed) { write('data: [DONE]\n\n'); closed = true; sink.close(); }
        });
      this.cleanup = () => { closed = true; clearInterval(heartbeat); controller.abort(); };
    },
    cancel() { this.cleanup?.(); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}
