import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MEDIA_DIR } from './config.js';
import { legacyConfig } from './legacy-config.js';

class MuseError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'MuseError';
    this.status = status;
    this.body = body;
  }
}

export function legacyRequest(pathname, { method = 'GET', body, signal = AbortSignal.timeout(120_000), headers = {} } = {}) {
  const config = legacyConfig();
  return fetch(config.baseUrl + pathname, {
    method, signal, redirect: 'error',
    headers: { Authorization: 'Bearer ' + config.key, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call(pathname, { method = 'GET', body, timeout = 120_000 } = {}) {
  try {
    const res = await legacyRequest(pathname, { method, body, signal: AbortSignal.timeout(timeout) });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = (data && (data.message || data.detail || data.error)) || `上游 HTTP ${res.status}`;
      throw new MuseError(typeof msg === 'string' ? msg : JSON.stringify(msg), res.status, data);
    }
    return data;
  } catch (err) {
    if (['AbortError', 'TimeoutError'].includes(err.name)) throw new MuseError('上游请求超时', 504);
    if (err instanceof TypeError && /fetch failed|failed to fetch/i.test(err.message)) {
      throw new MuseError(`无法连接 Muse2API（${legacyConfig().baseUrl}），请确认本地上游服务正在运行`, 503, {
        code: 'UPSTREAM_UNAVAILABLE',
      });
    }
    throw err;
  }
}

/* --------------------------- 健康 / 概览 --------------------------- */
export const health = () => call('/healthz', { timeout: 8000 });
export const status = () => call('/admin/status', { timeout: 20_000 });

/* ----------------------------- 账号池 ----------------------------- */
export async function listAccounts() {
  const data = await call('/admin/accounts');
  return { accounts: data?.accounts || [], stats: data?.stats || {} };
}

export const scheduler = () => call('/admin/scheduler');
export const updateScheduler = (maxConcurrency) => call('/admin/scheduler', {
  method: 'PATCH', body: { max_concurrency: maxConcurrency },
});
export const updateAccount = (upstreamId, body) => call(`/admin/accounts/${encodeURIComponent(upstreamId)}`, {
  method: 'PATCH', body,
});

export async function addAccount({ label, cookie, expires, proxy }) {
  const body = { label };
  if (cookie) body.cookie_header = cookie;
  if (expires) body.expires = expires;
  if (proxy) body.proxy = proxy;
  return call('/admin/accounts', { method: 'POST', body });
}

export async function deleteAccount(upstreamId) {
  return call(`/admin/accounts/${encodeURIComponent(upstreamId)}`, { method: 'DELETE' });
}

export async function testAccount(upstreamId) {
  return call(`/admin/accounts/${encodeURIComponent(upstreamId)}/test`, { method: 'POST', timeout: 180_000 });
}

export async function reloginAccount(upstreamId) {
  return call(`/admin/accounts/${encodeURIComponent(upstreamId)}/relogin`, { method: 'POST', timeout: 180_000 });
}

export async function keepaliveAccount(upstreamId) {
  return call(`/admin/accounts/${encodeURIComponent(upstreamId)}/keepalive`, { method: 'POST', timeout: 180_000 });
}

/** 查询额度：不传 id 查全池（用最久未用的账号），传 id 查指定账号 */
export async function queryQuota(upstreamId) {
  if (upstreamId) {
    return call(`/admin/accounts/${encodeURIComponent(upstreamId)}/quota`, { method: 'POST', timeout: 150_000 });
  }
  return call('/admin/quota', { method: 'POST', timeout: 150_000 });
}

/* ------------------------------ 视频 ------------------------------ */
export async function createVideo(payload) {
  return call('/v1/videos', { method: 'POST', body: payload, timeout: 120_000 });
}

export async function getVideo(id) {
  return call(`/v1/videos/${encodeURIComponent(id)}`);
}

/* ------------------------------ 图片 ------------------------------ */
export async function createImage(payload) {
  return call('/v1/images/generations', { method: 'POST', body: payload, timeout: 300_000 });
}

export async function createImageTask(payload) {
  return call('/v1/images/tasks', { method: 'POST', body: payload, timeout: 60_000 });
}

export async function getImageTask(id) {
  return call(`/v1/images/tasks/${encodeURIComponent(id)}`);
}

/* ------------------------------ 媒体 ------------------------------ */
const EXT_BY_KIND = { image: '.webp', video: '.mp4', audio: '.mp3' };

export function extOf(name = '', kind = 'video') {
  const m = /\.([a-z0-9]{2,5})$/i.exec(name);
  return m ? `.${m[1].toLowerCase()}` : EXT_BY_KIND[kind] || '.bin';
}

/**
 * 把上游媒体下载到本地 media 目录，返回本地文件名。
 * 上游重启或清理后仍可回放，这是作品库不丢的前提。
 */
export async function downloadMedia(mediaPathOrUrl, jobId, kind = 'video', timeout = 300_000) {
  const url = new URL(mediaPathOrUrl, legacyConfig().baseUrl);
  if (!/^\/v1\/media\/[^/]+$/.test(url.pathname)) throw new MuseError('muse2api 媒体路径无效', 502);
  const res = await legacyRequest(url.pathname + url.search, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok || !res.body) throw new MuseError('muse2api 媒体下载失败 HTTP ' + res.status, res.status);
  const fileName = jobId + extOf(url.pathname, kind);
  const dest = path.join(MEDIA_DIR, fileName);
  const tmp = dest + '.part';
  let bytes = 0;
  const meter = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > 100 * 1024 * 1024) return callback(new MuseError('媒体文件超过 100 MB', 502));
    callback(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(tmp));
    if (!bytes) throw new MuseError('muse2api 媒体为空', 502);
    await fs.promises.rename(tmp, dest);
    return { fileName, bytes };
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}

export async function complete(messages, attachments = []) {
  const data = await call('/v1/chat/completions', {
    method: 'POST', timeout: 300_000,
    body: { model: 'muse-spark', messages, stream: false, ...(attachments.length ? { images: attachments } : {}) },
  });
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new MuseError('muse2api 返回空内容', 502);
  return content;
}

export { MuseError };
