import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { CFG, MEDIA_DIR, ROOT, upstreamMode, usesMuse2api } from './config.js';
import { db, getSettings } from './db.js';
import { requireAuth, createUser, findUserByEmail } from './auth.js';
import { startWorker } from './worker.js';
import authRoutes from './routes/auth.js';
import { status as bridgeStatus } from './muse.js';
import { health as legacyHealth } from './muse2api.js';
import accountRoutes from './routes/accounts.js';
import bridgeRoutes from './routes/bridges.js';
import muse2apiRoutes from './routes/muse2api.js';
import upstreamRoutes from './routes/upstream.js';
import { legacyConfig } from './legacy-config.js';
import { startBridgePool, proxyMedia } from './bridge/gateway.js';
import genRoutes from './routes/generate.js';
import adminRoutes from './routes/admin.js';
import billingRoutes from './routes/billing.js';
import forumRoutes from './routes/forum.js';
import apiKeyRoutes from './routes/apikeys.js';
import v1Routes from './routes/v1.js';
import queueRoutes from './routes/queue.js';
import teamRoutes from './routes/team.js';
import chatRoutes from './routes/chat.js';
import directorRoutes from './routes/director.js';
import comfyRoutes from './routes/comfy.js';
import projectRoutes from './routes/projects.js';
import workbenchRoutes from './routes/workbench.js';
import modelRoutes from './routes/models.js';
import workflowRunRoutes from './routes/workflow-runs.js';
import { startWorkflowRunner } from './workflow-runner.js';

const app = express();
app.disable('x-powered-by');
if(!['local','account'].includes(CFG.accessMode))throw new Error('ACCESS_MODE 必须为 local 或 account');
app.use((req,res,next)=>{
  if(CFG.accessMode!=='account')return next();
  res.set('Cache-Control','no-store');
  // Bearer API callers do not use ambient browser cookies. Extension binding has its own one-use code.
  if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!req.headers.authorization?.startsWith('Bearer ')&&req.path!=='/api/accounts/bind'){
    const origin=req.get('origin');
    const expected=CFG.publicBase?new URL(CFG.publicBase).origin:req.protocol+'://'+req.get('host');
    if(req.get('sec-fetch-site')==='cross-site'||origin&&origin!==expected)return res.status(403).json({error:'请求来源与工作区地址不匹配'});
  }
  next();
});
app.use(express.json({ limit: '80mb' }));

// 简易 CORS：开发期前端跑在 5173
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const binding = req.path === '/api/accounts/bind' || req.path.startsWith('/api/accounts/bind/');
  if(CFG.accessMode==='account'&&!binding){if(req.method==='OPTIONS')return res.sendStatus(204);return next();}
  if (origin && (binding || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', binding ? '*' : origin);
    if (!binding) res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ------------------------------ 静态资源 ------------------------------ */
const protectFile=(kind)=>(req,res,next)=>{
  if(CFG.accessMode!=='account')return next();
  requireAuth(req,res,()=>{
    const filename=req.path.slice(1);
    const owned=kind==='media'?db.prepare('SELECT 1 FROM jobs WHERE media_file=? AND user_id=?').get(filename,req.user.id):db.prepare('SELECT 1 FROM uploads WHERE filename=? AND user_id=?').get(filename,req.user.id);
    if(!owned)return res.status(404).json({error:'文件不存在'});
    next();
  });
};
const privateHeaders=res=>{if(CFG.accessMode==='account')res.setHeader('Cache-Control','private, no-store');};
app.use('/media', protectFile('media'), express.static(MEDIA_DIR, { maxAge: CFG.accessMode==='account'?0:'7d', fallthrough: true,setHeaders:privateHeaders }));
app.get('/bridge-media/*', (req,res,next)=>CFG.accessMode==='account'?requireAuth(req,res,next):next(), proxyMedia);
app.use('/uploads', protectFile('uploads'), express.static(path.join(CFG.dataDir, 'uploads'), { maxAge: CFG.accessMode==='account'?0:'1d', fallthrough: true,setHeaders:privateHeaders }));

/* ------------------------------- 接口 ------------------------------- */
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'musecanvas',
    time: Date.now(),
    version: CFG.appVersion,
    upstreamMode,
    upstream: usesMuse2api ? legacyConfig().baseUrl : 'embedded',
    site: getSettings().siteName,
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/bridges', bridgeRoutes);
app.use('/api/muse2api', muse2apiRoutes);
app.use('/api/upstream', upstreamRoutes);
app.use('/api/models', modelRoutes);
app.get(['/api/bridge/status', '/api/upstream/status'], requireAuth, async (_req, res) => {
  try {
    if (usesMuse2api) {
      const health = await legacyHealth();
      return res.json({ mode: upstreamMode, online: health?.ok ?? health?.status === 'ok' });
    }
    res.json({ mode: upstreamMode, online: true, ...(await bridgeStatus()) });
  } catch (error) {
    res.status(502).json({ mode: upstreamMode, error: error.message });
  }
});
app.use('/api/accounts', accountRoutes);
  app.get('/download/museapi-video-extension.zip', (_req, res) => res.redirect(301, '/download/musecanvas-account-binding.zip'));
  app.get('/download/musecanvas-account-binding.zip', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'musecanvas-account-binding.zip')));
app.use('/api/admin', adminRoutes);
app.use('/api', apiKeyRoutes);   // /api/keys
app.use('/api', billingRoutes);
app.use('/api', forumRoutes);
app.use('/api', queueRoutes);
app.use('/api', teamRoutes);
app.use('/api', chatRoutes);
app.use('/api', directorRoutes);
app.use('/api', comfyRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api', workbenchRoutes);
app.use('/api', workflowRunRoutes);
app.use('/api', genRoutes);

// OpenAI 兼容对外接口（用 sk- 密钥鉴权，转发到上游）
app.use('/v1', v1Routes);

app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));

/* --------------------------- 前端产物（生产） --------------------------- */
const webDist = path.join(ROOT, '..', 'web', 'dist');
// 注意：必须按路径段判断，否则 /api-platform 会被当成 API 前缀拦掉
const under = (p, base) => p === base || p.startsWith(base + '/');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist, { index: false }));
  app.get('*', (req, res, next) => {
    if (under(req.path, '/api') || under(req.path, '/media') || under(req.path, '/uploads') || under(req.path, '/v1') || under(req.path, '/download') || under(req.path, '/bridge-media')) {
      return next();
    }
    res.sendFile(path.join(webDist, 'index.html'));
  });
  console.log('[server] 已挂载前端产物', webDist);
}

/* ------------------------------ 错误兜底 ------------------------------ */
app.use((err, _req, res, _next) => {
  console.error('[server] 未捕获异常:', err.message);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: err.message || '服务器内部错误' });
});

/* ------------------------------ 引导数据 ------------------------------ */
function bootstrap() {
  if(CFG.accessMode==='account'&&db.prepare('SELECT 1 FROM users WHERE lower(email)<>? LIMIT 1').get(CFG.ownerEmail))throw new Error('隔离工作区禁止混用已有多人数据，请为每个人使用独立的新数据卷');
  if (CFG.jwtSecret.length < 32) {
    throw new Error('JWT_SECRET 必须在 server/.env 中配置为至少 32 个字符的随机密钥');
  }
  const email = (process.env.ADMIN_EMAIL || 'admin@muse.local').toLowerCase();
  const existing = findUserByEmail(email);
  if (!existing) {
    const password = process.env.ADMIN_PASSWORD || '';
    if (password.length < 12) {
      throw new Error('首次启动时必须在 server/.env 中设置至少 12 个字符的 ADMIN_PASSWORD');
    }
    createUser({ email, password, name: '管理员', role: 'admin', credits: 10000 });
    console.log(`[server] 已创建管理员：${email}`);
  }
  const n = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  console.log(`[server] 用户总数 ${n}，媒体目录 ${MEDIA_DIR}`);
}

bootstrap();
startBridgePool();
startWorker();
startWorkflowRunner();

app.listen(CFG.port, CFG.host, () => {
  console.log(`[server] 平台后端已启动 http://${CFG.host}:${CFG.port}`);
  console.log(`[server] 上游 ${upstreamMode} ${usesMuse2api ? CFG.museBase : 'embedded'}`);
});
