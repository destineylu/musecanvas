import { Router } from 'express';
import { requireAuth, requireAdmin } from '../auth.js';
import { upstreamMode, usesMuse2api, setUpstreamMode } from '../config.js';
import { ensureLegacyService } from '../legacy-service.js';
import { checkBridges } from '../bridge/gateway.js';
import { status } from '../muse.js';
const router = Router();
let switching = false;
const state = () => ({ mode: upstreamMode, maxReferences: usesMuse2api ? 3 : 1, documentAttachments: usesMuse2api });
router.use(requireAuth);
router.get('/', (_req, res) => res.json(state()));
router.put('/', requireAdmin, async (req, res, next) => {
  const mode = req.body?.mode;
  if (!['bridge', 'muse2api'].includes(mode)) return res.status(400).json({ error: '请选择 API Bridge 或 muse2api' });
  if (switching) return res.status(409).json({ error: '正在切换，请稍候' });
  if (mode === upstreamMode) return res.json(state());
  switching = true;
  try {
    if (mode === 'muse2api') await ensureLegacyService();
    else {
      await checkBridges();
      if (!(await status()).online) throw Object.assign(new Error('没有可用 Bridge 节点，请先配置节点并测试连接'), { status: 503 });
    }
    setUpstreamMode(mode);
    res.json(state());
  } catch (error) { next(error); }
  finally { switching = false; }
});
export default router;
