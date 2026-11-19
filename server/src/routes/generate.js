import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../auth.js';
import { CFG, MEDIA_DIR, usesMuse2api } from '../config.js';
import {
  db, uid, now, getJob, listJobs, getSettings,
} from '../db.js';
import { enqueueJob } from '../worker.js';
import { referenceImage } from '../mediaRefs.js';
import { selectedModel } from '../model-config.js';

const r = Router();

function resolveWorkspace(req) {
  const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : null;
  const canvasId = typeof req.body?.canvasId === 'string' ? req.body.canvasId : null;
  if (canvasId) {
    const canvas = db.prepare('SELECT id,project_id FROM canvases WHERE id = ? AND user_id = ?').get(canvasId, req.user.id);
    if (!canvas || (projectId && projectId !== canvas.project_id)) return { error: '画布不存在或无权使用' };
    return { projectId: canvas.project_id, canvasId: canvas.id };
  }
  if (projectId && !db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(projectId, req.user.id)) {
    return { error: '项目不存在或无权使用' };
  }
  return { projectId, canvasId: null };
}

const UPLOAD_DIR = path.join(CFG.dataDir, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
      cb(null, `${uid('up_')}${ext}`);
    },
  }),
  limits: { fileSize: 40 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const document = ['.pdf', '.doc', '.docx'].includes(ext) && [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/octet-stream',
    ].includes(file.mimetype);
    const media = /^(image|video|audio)\//.test(file.mimetype);
    const ok = media || document;
    cb(ok ? null : new Error('支持图片、视频、音频、PDF 和 Word 文档'), ok);
  },
});

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.heic': 'image/heic', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/* ------------------------------ 上传 ------------------------------ */
r.post('/upload', requireAuth, upload.array('files', 10), (req, res) => {
  const files = (req.files || []).map((f) => {
    const mime = MIME[path.extname(f.originalname || '').toLowerCase()] || f.mimetype;
    db.prepare('INSERT INTO uploads(id, user_id, filename, mime, bytes, created_at) VALUES(?,?,?,?,?,?)')
      .run(uid('u_'), req.user.id, f.filename, mime, f.size, now());
    return { url: `/uploads/${f.filename}`, name: f.originalname, bytes: f.size, mime };
  });
  if (!files.length) return res.status(400).json({ error: '没有收到文件' });
  res.json({ files });
});

/* ------------------------------ 生成 ------------------------------ */
function submit(kind, req, res) {
  const { prompt, duration = 5, size, images = [], extra } = req.body || {};
  if (typeof prompt !== 'string' || prompt.trim().length < 2 || prompt.length > 100_000) {
    return res.status(400).json({ error: '请输入 2 到 100000 字的提示词' });
  }
  const workspace = resolveWorkspace(req);
  if (workspace.error) return res.status(404).json({ error: workspace.error });
  if (workspace.canvasId && db.prepare("SELECT 1 FROM workflow_runs WHERE canvas_id=? AND status IN ('running','paused')").get(workspace.canvasId)) return res.status(409).json({error:'一键流程执行中，请先停止流程再单独生成'});

  try {
    const provider = selectedModel(kind);
    const maxReferences = provider ? provider.maxReferences : usesMuse2api ? 3 : 1;
    if (!Array.isArray(images) || images.length > maxReferences) {
      return res.status(400).json({ error: '当前接入方式每个媒体任务最多支持 ' + maxReferences + ' 张参考图' });
    }
    for (const image of images) referenceImage(req.user.id, image, false);
    const video = kind === 'video';
    const sizes = video ? CFG.videoSizes : CFG.imageSizes;
    const params = {
      size: sizes.includes(size) ? size : video ? '16:9' : '1:1',
      images: images.map(image => typeof image === 'string' ? image : image.url),
      sourceNodeId: typeof req.body.sourceNodeId === 'string' ? req.body.sourceNodeId.slice(0,100) : null,
    };
    if (video) {
      const durations = provider?.durations || CFG.videoDurations;
      params.duration = durations.includes(Number(duration)) ? Number(duration) : durations[0];
      if (typeof extra === 'string' && extra.trim()) params.extra = extra.trim().slice(0, 500);
    }
    if (workspace.canvasId && params.sourceNodeId) {
      const running = db.prepare("SELECT id,params FROM jobs WHERE user_id=? AND canvas_id=? AND status IN ('queued','processing') ORDER BY created_at DESC").all(req.user.id,workspace.canvasId);
      const same = running.find(row=>{try{return JSON.parse(row.params).sourceNodeId===params.sourceNodeId;}catch{return false;}});
      if (same) {
        const job=getJob(same.id);
        if(job.type!==kind||job.prompt!==prompt.trim()||job.params.size!==params.size||JSON.stringify(job.params.images||[])!==JSON.stringify(params.images||[])||(kind==='video'&&job.params.duration!==params.duration)) {
          return res.status(409).json({error:'这个节点已有任务正在生成，请等待完成后再修改并提交'});
        }
        return res.json({job,reused:true});
      }
    }
    const job = enqueueJob(req.user.id, kind, prompt.trim(), params, workspace);
    return res.json({ job });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
}

r.post('/videos', requireAuth, (req, res) => submit('video', req, res));
r.post('/images', requireAuth, (req, res) => submit('image', req, res));

/* ------------------------------ 任务 ------------------------------ */
r.get('/jobs', requireAuth, (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(60, Math.max(1, Number(req.query.pageSize) || 24));
  const out = listJobs({
    userId: req.user.role === 'admin' && req.query.all === '1' ? null : req.user.id,
    type: req.query.type || null,
    status: req.query.status || null,
    projectId: req.query.projectId || null,
    canvasId: req.query.canvasId || null,
    page,
    pageSize,
  });
  res.json(out);
});

r.get('/jobs/:id', requireAuth, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (job.userId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '无权查看' });
  }
  res.json({ job });
});

r.delete('/jobs/:id', requireAuth, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (job.userId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '无权删除' });
  }
  if (['queued', 'processing'].includes(job.status)) return res.status(409).json({ error: '生成中的任务暂不能删除' });
  if (job.mediaFile) {
    try { fs.unlinkSync(path.join(CFG.dataDir, 'media', job.mediaFile)); } catch { /* ignore */ }
  }
  db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
  res.json({ ok: true });
});

/* --------------------------- 元信息 / 定价 --------------------------- */
r.get('/meta', requireAuth, (_req, res) => {
  const s = getSettings();
  res.json({
    siteName: s.siteName,
    version: CFG.appVersion,
    notice: s.notice,
    durations: CFG.videoDurations,
    sizes: CFG.imageSizes,
    imageSizes: CFG.imageSizes,
    videoSizes: CFG.videoSizes,
    price: {
      videoBase: Number(s.priceVideoBase),
      videoPerSecond: Number(s.priceVideoPerSecond),
      image: Number(s.priceImage),
    },
  });
});

export default r;
