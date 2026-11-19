import { Router } from 'express';
import { requireAuth, requireAdmin } from '../auth.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { bridgeState, saveBridge, deleteBridge, testBridge, saveModels, saveSettings, checkBridges, gatewayRequest } from '../bridge/gateway.js';
import { CFG } from '../config.js';
const router = Router();
router.use(requireAuth);
router.get('/', (_req, res) => res.json(bridgeState()));
router.post('/test-run', async (req, res, next) => {
  const { model, prompt, image, ratio = '16:9', duration = 5 } = req.body || {};
  const definition = bridgeState().models.find(item => item.id === model && item.enabled);
  if (!definition || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100_000) {
    return res.status(400).json({ error: '请选择已启用模型并填写提示词' });
  }
  if (!['16:9', '9:16', '1:1', '4:3', '3:4'].includes(ratio) || ![5,6,8,10].includes(Number(duration))) {
    return res.status(400).json({ error: '比例或时长无效' });
  }
  if (image && (typeof image !== 'string' || image.length > 3_000_000 || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(image))) {
    return res.status(400).json({ error: '参考图请使用小于 2 MB 的 PNG、JPG、WebP 或 GIF' });
  }
  let text = prompt.trim();
  if (definition.type === 'image') text += '\n生成一张图片，画幅 ' + ratio + '，返回可下载图片链接。';
  if (definition.type === 'video') text += '\n生成一段视频，画幅 ' + ratio + '，时长 ' + duration + ' 秒，返回可下载 MP4 链接。';
  const content = image ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: image } }] : text;
  const controller = new AbortController();
  const close = () => { if (!res.writableFinished) controller.abort(); };
  res.on('close', close);
  try {
    const response = await gatewayRequest('/chat/completions', {
      method: 'POST', body: { model, messages: [{ role: 'user', content }], stream: true },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(CFG.bridgeTimeoutMs)]),
    });
    res.status(response.status).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    await pipeline(Readable.fromWeb(response.body), res);
  } catch (error) {
    if (!controller.signal.aborted && !res.headersSent) next(error);
    else if (!res.destroyed) res.destroy();
  } finally {
    res.off('close', close);
  }
});
router.post('/health', async (_req, res, next) => { try { res.json(await checkBridges()); } catch (e) { next(e); } });
router.post('/:id/test', async (req, res, next) => { try { res.json(await testBridge(req.params.id)); } catch (e) { next(e); } });
router.use(requireAdmin);
router.post('/', (req, res, next) => { try { res.json(saveBridge(null, req.body)); } catch (e) { next(e); } });
router.put('/models', (req, res, next) => { try { res.json(saveModels(req.body.models)); } catch (e) { next(e); } });
router.put('/settings', (req, res, next) => { try { res.json(saveSettings(req.body)); } catch (e) { next(e); } });
router.put('/:id', (req, res, next) => { try { res.json(saveBridge(req.params.id, req.body)); } catch (e) { next(e); } });
router.delete('/:id', (req, res, next) => { try { res.json(deleteBridge(req.params.id)); } catch (e) { next(e); } });
export default router;
