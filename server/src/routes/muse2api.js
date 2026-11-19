import { Router } from 'express';
import { requireAuth, requireAdmin } from '../auth.js';
import { legacyState, saveLegacyConfig } from '../legacy-config.js';
import { health, scheduler } from '../muse2api.js';
const router = Router();
router.use(requireAuth);
router.get('/', (_req, res) => res.json(legacyState()));
router.put('/', requireAdmin, (req, res, next) => {
  try { res.json(saveLegacyConfig(req.body || {})); } catch (error) { if (error instanceof TypeError) error.status = 400; next(error); }
});
router.post('/test', async (_req, res) => {
  try {
    await health();
    await scheduler();
    res.json({ ok: true, message: 'muse2api 健康检查和管理接口鉴权通过' });
  } catch (error) { res.status(502).json({ error: error.message }); }
});
export default router;
