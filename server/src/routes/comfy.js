import { Router } from 'express';
import { requireAuth, requireAdmin } from '../auth.js';
import { db } from '../db.js';
import {
  publicConfig, saveConfig, status, listWorkflows, getWorkflow, importWorkflow, updateWorkflow, deleteWorkflow,
  refreshParams, readSkill, writeSkill, appendLesson, remoteWorkflows, importRemote, modelDigest,
} from '../comfy-lib.js';
import { enqueueComfyRun, queueState, cancelJob, freeMemory } from '../comfy-runner.js';
import { planRun, reviewRun, planShots } from '../comfy-agent.js';

const r = Router();
r.use(requireAuth);
const isAdmin = (req) => req.user.role === 'admin';
const wrap = (fn) => async (req, res, next) => {
  try { res.json(await fn(req, res)); } catch (e) {
    const timedOut = ['TimeoutError', 'AbortError'].includes(e.name);
    res.status(timedOut ? 504 : e.status && e.status < 600 ? e.status : 502).json({ error: timedOut ? '模型响应超时，请稍后重试' : e.message });
  }
};
function workspace(req) {
  const canvasId = typeof req.body?.canvasId === 'string' ? req.body.canvasId : null;
  if (!canvasId) return {};
  const canvas = db.prepare('SELECT id, project_id FROM canvases WHERE id = ? AND user_id = ?').get(canvasId, req.user.id);
  if (!canvas) throw Object.assign(new Error('画布不存在或无权使用'), { status: 404 });
  return { canvasId: canvas.id, projectId: canvas.project_id };
}

/* ------------------------------ 服务与状态 ------------------------------ */
r.get('/comfy/status', wrap(async () => {
  try { return { ...publicConfig(), ...(await status()) }; } catch (e) { return { ...publicConfig(), ok: false, error: e.message }; }
}));
r.get('/comfy/models', wrap(() => modelDigest()));
r.put('/comfy/config', requireAdmin, wrap((req) => saveConfig(req.body || {})));

/* ------------------------------ 工作流库 ------------------------------ */
r.get('/comfy/workflows', wrap(() => ({ workflows: listWorkflows() })));
r.get('/comfy/workflows/:id', wrap((req) => {
  const w = getWorkflow(req.params.id);
  if (!w) throw Object.assign(new Error('工作流不存在'), { status: 404 });
  return { workflow: w };
}));
r.post('/comfy/workflows', requireAdmin, wrap((req) => importWorkflow(req.body || {})));
r.put('/comfy/workflows/:id', requireAdmin, wrap((req) => ({ workflow: updateWorkflow(req.params.id, req.body || {}) })));
r.post('/comfy/workflows/:id/refresh', requireAdmin, wrap(async (req) => ({ workflow: await refreshParams(req.params.id) })));
r.delete('/comfy/workflows/:id', requireAdmin, wrap((req) => { deleteWorkflow(req.params.id); return { ok: true }; }));
r.get('/comfy/remote', requireAdmin, wrap(async () => ({ files: await remoteWorkflows() })));
r.post('/comfy/remote', requireAdmin, wrap((req) => importRemote(req.body?.file)));

/* -------------------------------- 技能包 -------------------------------- */
r.get('/comfy/workflows/:id/skill', wrap((req) => ({ text: readSkill(req.params.id) })));
r.put('/comfy/workflows/:id/skill', requireAdmin, wrap((req) => ({ text: writeSkill(req.params.id, req.body?.text) })));
r.post('/comfy/workflows/:id/lesson', wrap((req) => ({ text: appendLesson(req.params.id, req.body?.lesson) })));

/* ------------------------------ AI 与运行 ------------------------------ */
r.post('/comfy/plan', wrap(async (req) => {
  workspace(req);
  const b = req.body || {};
  return { plan: await planRun({ intent: b.intent, kind: b.kind, refCount: Number(b.refCount) || 0, ratio: b.ratio, seconds: Number(b.seconds) || 0, workflowId: b.workflowId || undefined, model: b.model, notes: b.notes }) };
}));
r.post('/comfy/run', wrap((req) => {
  const ws = workspace(req);
  const b = req.body || {};
  return { job: enqueueComfyRun(req.user.id, { workflowId: b.workflowId, values: b.values, images: b.images, ratio: b.ratio, seconds: Number(b.seconds) || 0, label: b.label, round: b.round }, ws) };
}));
r.post('/comfy/review', wrap(async (req) => {
  const b = req.body || {};
  return { review: await reviewRun({ jobId: b.jobId, userId: req.user.id, isAdmin: isAdmin(req), intent: b.intent, expect: b.expect, frame: b.frame, model: b.model, round: Number(b.round) || 1, maxRounds: Number(b.maxRounds) || 3 }) };
}));
r.post('/comfy/shots/plan', wrap(async (req) => {
  workspace(req);
  const b = req.body || {};
  return { plan: await planShots({ script: b.script, count: b.count, ratio: b.ratio, styleHint: b.styleHint, imageWorkflowId: b.imageWorkflowId, model: b.model }) };
}));

/* ------------------------------ 队列控制 ------------------------------ */
r.get('/comfy/queue', wrap((req) => queueState(req.user.id, isAdmin(req))));
r.post('/comfy/jobs/:id/cancel', wrap((req) => cancelJob(req.user.id, req.params.id, isAdmin(req))));
r.post('/comfy/free', requireAdmin, wrap(async () => { await freeMemory(); return { ok: true }; }));

export default r;
