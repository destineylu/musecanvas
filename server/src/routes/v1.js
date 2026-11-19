import { Router } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CFG, usesMuse2api } from '../config.js';
import { bridgeRequest } from '../muse.js';
import { legacyRequest } from '../muse2api.js';
import { apiKeyAuth } from './apikeys.js';

const r = Router();
r.use(apiKeyAuth);

async function proxy(req, res) {
  const body = req.method === 'POST' ? { ...req.body } : undefined;
  if (!usesMuse2api && body?.model === 'muse-spark') body.model = CFG.bridgeModels.chat;
  const client = new AbortController();
  const disconnected = () => { if (!res.writableFinished) client.abort(); };
  res.on('close', disconnected);
  try {
    const signal = AbortSignal.any([client.signal, AbortSignal.timeout(usesMuse2api ? 900_000 : CFG.bridgeTimeoutMs)]);
    const query = new URL(req.originalUrl, 'http://localhost').search;
    const options = { method: req.method, body, signal };
    const up = usesMuse2api
      ? await legacyRequest('/v1' + req.path + query, { ...options, headers: req.headers.range ? { Range: req.headers.range } : {} })
      : await bridgeRequest(req.path + query, options);
    const type = up.headers.get('content-type') || 'application/json';
    res.status(up.status).set('Content-Type', type);
    for (const key of ['accept-ranges', 'content-range']) {
      if (up.headers.has(key)) res.set(key, up.headers.get(key));
    }
    if (type.includes('text/event-stream')) {
      res.set('X-Accel-Buffering', 'no');
      res.flushHeaders();
    }
    if (up.body) await pipeline(Readable.fromWeb(up.body), res);
    else res.end();
  } catch (error) {
    if (client.signal.aborted) return;
    if (res.headersSent) res.destroy();
    else res.status(error.name === 'TimeoutError' ? 504 : 502).json({
      error: { message: '上游请求未完成', type: 'upstream_error' },
    });
  } finally {
    res.off('close', disconnected);
  }
}

r.get('/models', proxy);
r.post('/chat/completions', proxy);
const legacyOnly = (req, res, next) => usesMuse2api ? proxy(req, res) : next();
r.post(['/images/tasks', '/images/generations', '/images/edits', '/videos', '/videos/generations', '/responses'], legacyOnly);
r.get(['/images/tasks/:id', '/videos/:id', '/videos/generations/:id', '/media/:name'], legacyOnly);
r.use((_req, res) => res.status(404).json({ error: { message: '当前接入方式不支持这个接口', type: 'invalid_request_error' } }));

export default r;
