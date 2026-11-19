import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CFG, MEDIA_DIR } from './config.js';
import { gatewayRequest, mediaFetchUrl, bridgeState } from './bridge/gateway.js';

export class MuseError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export const bridgeRequest = gatewayRequest;

export async function status() {
  const { models, bridges, pool } = bridgeState();
  const usable = bridges.some(b => b.enabled && b.tokenSet && pool.bridges[b.id]?.healthy !== false);
  return {
    online: usable,
    models: Object.entries(CFG.bridgeModels).map(([type, id]) => ({
      type, id, available: usable && models.some(m => m.id === id && m.enabled),
    })),
  };
}

export async function complete(model, messages, onHeaders) {
  const signal = AbortSignal.timeout(CFG.bridgeTimeoutMs);
  const response = await bridgeRequest('/chat/completions', {
    method: 'POST', body: { model, messages, stream: true }, signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new MuseError('API Bridge 请求失败（HTTP ' + response.status + '）', response.status);
  }
  onHeaders?.();
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new MuseError('API Bridge 返回空内容');
    return content;
  }

  let text = '';
  let buffer = '';
  let done = false;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { done = true; break; }
      if (!data) continue;
      const event = JSON.parse(data);
      if (event.error) throw new MuseError('API Bridge：' + String(event.error.message || '生成失败').slice(0, 400));
      text += event.choices?.[0]?.delta?.content || '';
    }
    if (done) break;
    if (text.length + buffer.length > 40 * 1024 * 1024) throw new MuseError('API Bridge 响应过大');
  }
  if (!done || !text.trim()) throw new MuseError('API Bridge 流式响应未完成或内容为空');
  return text;
}

const imageTypes = new Set(['webp', 'png', 'jpg', 'jpeg', 'gif', 'avif']);
const videoTypes = new Set(['mp4', 'webm', 'mov']);

function mediaTarget(value, kind) {
  const url = new URL(value);
  const ext = path.posix.extname(url.pathname).slice(1).toLowerCase();
  const extensions = kind === 'video' ? videoTypes : imageTypes;
  if (url.username || url.password || !extensions.has(ext)) return null;
  const target = mediaFetchUrl(url.href);
  if (!target) return null;
  return { url, ext, fetchUrl: target };
}

export async function generateMedia(job, references, onHeaders) {
  const instructions = job.type === 'video'
    ? '生成一段视频。画幅 ' + job.params.size + '，时长 ' + job.params.duration + ' 秒，返回可下载的 MP4 地址。'
    : '生成一张图片。画幅 ' + job.params.size + '，返回可下载的图片地址。';
  const text = [job.prompt, job.params.extra, instructions].filter(Boolean).join('\n');
  const content = references.length ? [
    { type: 'text', text },
    { type: 'image_url', image_url: { url: references[0] } },
  ] : text;
  const reply = await complete(CFG.bridgeModels[job.type], [{ role: 'user', content }], onHeaders);
  const candidates = reply.match(/https?:\/\/[^\s<>"'\x60)\]]+/gi) || [];
  for (const candidate of candidates) {
    try {
      const target = mediaTarget(candidate.replace(/[.,;，。；]+$/, ''), job.type);
      if (target) return target.url.href;
    } catch { /* The response can also contain non-media links. */ }
  }
  throw new MuseError('API Bridge 未返回受信任的' + (job.type === 'video' ? '视频' : '图片') + '下载地址');
}

export async function downloadMedia(value, jobId, kind) {
  const target = mediaTarget(value, kind);
  if (!target) throw new MuseError('媒体下载地址不在允许范围内');
  const response = await fetch(target.fetchUrl, {
    redirect: 'error', signal: AbortSignal.timeout(CFG.bridgeDownloadTimeoutMs),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new MuseError('媒体下载失败（HTTP ' + response.status + '）');
  }

  const maximum = 100 * 1024 * 1024;
  const declared = Number(response.headers.get('content-length'));
  const mime = response.headers.get('content-type')?.split(';')[0];
  if (declared > maximum || (mime && mime !== 'application/octet-stream' && !mime.startsWith(kind + '/'))) {
    await response.body.cancel();
    throw new MuseError('媒体类型无效或文件超过 100 MB');
  }
  let bytes = 0;
  const meter = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > maximum) return callback(new MuseError('媒体文件超过 100 MB'));
    callback(null, chunk);
  } });
  const fileName = jobId + '.' + target.ext;
  const dest = path.join(MEDIA_DIR, fileName);
  const tmp = dest + '.part';
  try {
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(tmp));
    if (!bytes || (declared && bytes !== declared)) throw new MuseError('媒体下载不完整');
    await fs.promises.rename(tmp, dest);
    return { fileName, bytes };
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}
