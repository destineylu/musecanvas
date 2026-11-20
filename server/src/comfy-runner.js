// 工作流库任务：提交、进度（WebSocket）、轮询结果、取消、释放显存。
import { createHash, randomUUID } from 'node:crypto';
import { createJob, getJob, updateJob, db } from './db.js';
import { referenceImage } from './mediaRefs.js';
import { comfyRequest, getWorkflow, buildWorkflow, server, checkValues } from './comfy-lib.js';
import { pollComfy, saveComfyResult, comfyOrigin, request } from './comfyui.js';

export const CLIENT_ID = 'musecanvas-' + randomUUID();
const endpointId = p => createHash('sha256').update(p.baseUrl + '\0' + p.apiKey).digest('hex');

async function interruptPrompt(taskId) {
  const stats = await comfyRequest('/system_stats');
  const v = String(stats.system?.comfyui_version || '').split('.').map(Number);
  if (!(v[0] > 0 || v[0] === 0 && v[1] >= 28)) throw bad('当前 ComfyUI 未确认支持定向中断，请到 ComfyUI 手动取消任务', 409);
  return comfyRequest('/interrupt', { body: { prompt_id: taskId } });
}
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

/* ------------------------------ 进度 ------------------------------ */
const progress = new Map(); // prompt_id -> { value, max, node, at }
let socket = null;
let socketUrl = '';
let retryAt = 0;

function ensureSocket() {
  const base = server().baseUrl;
  const url = base.replace(/^http/, 'ws') + '/ws?clientId=' + CLIENT_ID;
  if (socket && socketUrl === url && socket.readyState <= 1) return;
  if (Date.now() < retryAt || typeof WebSocket === 'undefined') return;
  try { socket?.close(); } catch { /* ignore */ }
  socketUrl = url;
  try {
    socket = new WebSocket(url);
  } catch {
    retryAt = Date.now() + 10_000;
    return;
  }
  socket.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    const id = m.data?.prompt_id;
    if (!id) return;
    const cur = progress.get(id) || {};
    if (m.type === 'progress') progress.set(id, { ...cur, value: m.data.value, max: m.data.max, node: m.data.node, at: Date.now() });
    else if (m.type === 'executing' && m.data.node) progress.set(id, { ...cur, node: m.data.node, at: Date.now() });
    else if (m.type === 'execution_success' || m.type === 'execution_error' || m.type === 'execution_interrupted') progress.delete(id);
  };
  socket.onclose = () => { retryAt = Date.now() + 5_000; };
  socket.onerror = () => { retryAt = Date.now() + 10_000; };
}
export const promptProgress = (id) => progress.get(id) || null;

/* ------------------------------ 提交 ------------------------------ */
/** 创建工作流库任务。values 已经过 AI 计划或用户确认。 */
export function enqueueComfyRun(userId, input, workspace = {}) {
  const w = getWorkflow(input.workflowId);
  if (!w) throw bad('工作流不存在，请刷新工作流库');
  if (w.missing?.length) throw bad(`工作流「${w.name}」需要的模型文件本机没有：${w.missing.map((m) => m.value).join('、')}。下载到 ComfyUI 后在设置里点「刷新参数」`);
  const { values, errors } = checkValues(w, input.values || {});
  if (errors.length) throw bad('参数无效：' + errors.join('；'));
  const images = Array.isArray(input.images) ? input.images.slice(0, 4) : [];
  for (const image of images) referenceImage(userId, image, false);
  if (w.requiresImage && !images.length) throw bad('此工作流需要参考图，请连接图片');
  // 提前构建一次，尽早发现取值问题
  buildWorkflow(w, { values, ratio: input.ratio, seconds: input.seconds, uploads: images.map(() => 'placeholder.png') });
  const label = String(input.label || values.prompt || w.name).slice(0, 4000) || w.name;
  const job = createJob(userId, w.kind, label, {
    size: input.ratio || '',
    duration: input.seconds || undefined,
    images,
    comfyLib: {
      workflowId: w.id, workflowName: w.name, revision: w.revision, values,
      ratio: input.ratio || '', seconds: input.seconds || 0,
      planId: input.planId || null, round: input.round || 1,
    },
    modelName: 'ComfyUI · ' + w.name,
  }, 0);
  updateJob(job.id, { upstream_id: 'comfylib:queued', project_id: workspace.projectId, canvas_id: workspace.canvasId });
  return getJob(job.id);
}

async function uploadRef(p, dataUrl, name) {
  const m = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw bad('参考图格式无效');
  const form = new FormData();
  form.append('image', new Blob([Buffer.from(m[2], 'base64')], { type: m[1] }), name + '.' + m[1].split('/')[1]);
  form.append('type', 'input');
  form.append('overwrite', 'true');
  const uploaded = await request(p, '/upload/image', { form, timeout: 60_000 });
  if (typeof uploaded.name !== 'string') throw bad('ComfyUI 未返回上传文件名', 502);
  return [uploaded.subfolder, uploaded.name].filter(Boolean).join('/');
}

/** 由 worker 调用：推进一个工作流库任务。返回 'done' | 'waiting'。 */
export async function stepComfyRun(job) {
  ensureSocket();
  const spec = job.params.comfyLib;
  const w = getWorkflow(spec.workflowId);
  let state = job.result || {};
  const p = { ...server(), comfy: { outputNode: state.outputNode || w?.outputNode } };
  if (state.endpoint && state.endpoint !== endpointId(p)) throw new Error('ComfyUI 服务设置已变更，请恢复原地址与密钥后续查任务；不会重新提交');
  if (job.upstreamId === 'comfylib:queued') {
    if (!w || spec.revision !== w.revision) throw new Error('排队期间工作流已变更，请重新确认参数后提交');
    updateJob(job.id, { upstream_id: 'comfylib:submitting', status: 'processing', progress: 5 });
    const uploads = [];
    for (const [i, image] of (job.params.images || []).entries()) {
      uploads.push(await uploadRef(p, referenceImage(job.userId, image), `musecanvas-${job.id}-${i}`));
    }
    const { workflow, used } = buildWorkflow(w, { values: spec.values, ratio: spec.ratio, seconds: spec.seconds, uploads });
    const result = await request(p, '/prompt', {
      body: { prompt: workflow, client_id: CLIENT_ID, extra_data: { musecanvas_job_id: job.id } },
      timeout: 60_000,
    });
    if (typeof result.prompt_id !== 'string') throw new Error('ComfyUI 未返回 prompt_id，请到队列核对，勿重复提交');
    // ComfyUI 在部分输出节点校验失败时仍会排队其余输出，并把失败放在 node_errors 里。
    const nodeErrors = Object.entries(result.node_errors || {});
    if (nodeErrors.length) {
      await comfyRequest('/queue', { body: { delete: [result.prompt_id] } }).catch(() => {});
      await interruptPrompt(result.prompt_id).catch(() => {});
      const detail = nodeErrors.map(([id, n]) => `${w.workflow[id]?._meta?.title || n.class_type || id}：${(n.errors || []).map((e) => `${e.message}${e.details ? `（${e.details}）` : ''}`).join('，')}`).join('；');
      throw new Error('ComfyUI 拒绝了工作流的部分节点：' + detail.slice(0, 600));
    }
    state = { taskId: result.prompt_id, submittedAt: Date.now(), used, outputNode: w.outputNode, endpoint: endpointId(p) };
    updateJob(job.id, { upstream_id: 'comfylib:polling', result: JSON.stringify(state), progress: 10 });
    return 'waiting';
  }
  if (job.upstreamId !== 'comfylib:polling' || !state.taskId) throw new Error('ComfyUI 提交时程序中断，结果未知，请核对队列后再提交');
  if (state.cancelled) throw new Error('已取消');
  if (Date.now() - (state.submittedAt || job.createdAt) > 3 * 60 * 60_000) throw new Error('ComfyUI 任务超过三小时，请核对队列；不会自动重新提交');
  const result = await pollComfy(p, state.taskId, job.type);
  if (result.state === 'missing') {
    if (state.missingSince && Date.now() - state.missingSince > 30_000) throw new Error('ComfyUI 队列和历史中找不到此任务，可能已重启或被清空');
    if (!state.missingSince) updateJob(job.id, { result: JSON.stringify({ ...state, missingSince: Date.now() }) });
    return 'waiting';
  }
  if (result.state !== 'done') {
    const pr = promptProgress(state.taskId);
    if (pr?.max) updateJob(job.id, { progress: Math.min(95, Math.round(10 + (85 * pr.value) / pr.max)) });
    return 'waiting';
  }
  if (getJob(job.id)?.status === 'failed') return 'done';
  const { fileName, bytes } = await saveComfyResult(p, job, result.url);
  updateJob(job.id, {
    status: 'completed', progress: 100, media_file: fileName, error: null, finished_at: Date.now(),
    result: JSON.stringify({ localUrl: '/media/' + fileName, bytes, taskId: state.taskId, used: state.used }),
  });
  return 'done';
}

/** 同一 ComfyUI 服务一次只推进一个在途任务（含模型设置里配置的 ComfyUI 模型）。 */
export const libOrigin = () => comfyOrigin(server());

/* ------------------------------ 队列与控制 ------------------------------ */
export async function queueState(userId, isAdmin) {
  ensureSocket();
  const queue = await comfyRequest('/queue', { timeout: 8000 });
  const ours = new Map();
  for (const row of db.prepare("SELECT * FROM jobs WHERE upstream_id LIKE 'comfylib:%' AND status IN ('queued','processing')").all()) {
    let r = {};
    try { r = JSON.parse(row.result || '{}'); } catch { /* ignore */ }
    if (r.taskId) ours.set(r.taskId, row);
  }
  const shape = (row, running) => {
    const id = row[1];
    const job = ours.get(id);
    const mine = job && (isAdmin || job.user_id === userId);
    return {
      promptId: id, running, ours: !!job,
      ...(mine ? { jobId: job.id, label: String(job.prompt || '').slice(0, 80), type: job.type } : {}),
      progress: running ? promptProgress(id) : null,
    };
  };
  return {
    running: (queue.queue_running || []).map((row) => shape(row, true)),
    pending: (queue.queue_pending || []).map((row) => shape(row, false)),
  };
}

/** 取消自己的任务：排队中的从队列删除，运行中的只中断这一个 prompt。 */
export async function cancelJob(userId, jobId, isAdmin) {
  const job = getJob(jobId);
  if (!job || (!isAdmin && job.userId !== userId)) throw bad('任务不存在', 404);
  if (!job.upstreamId?.startsWith('comfylib:') || !['queued', 'processing'].includes(job.status)) throw bad('只能取消进行中的工作流库任务');
  if (job.upstreamId === 'comfylib:submitting') throw bad('任务正在提交，请等返回任务编号后再取消', 409);
  const taskId = job.result?.taskId;
  if (job.result?.endpoint && job.result.endpoint !== endpointId(server())) throw bad('服务设置已变更，请恢复原设置后取消', 409);
  if (taskId) {
    const queue = await comfyRequest('/queue', { timeout: 8000 });
    const running = (queue.queue_running || []).some((row) => row[1] === taskId);
    if (running) await interruptPrompt(taskId);
    else await comfyRequest('/queue', { body: { delete: [taskId] } });
  }
  updateJob(job.id, {
    status: 'failed', error: '已取消', finished_at: Date.now(),
    ...(taskId ? { result: JSON.stringify({ ...job.result, cancelled: true }) } : {}),
  });
  return { ok: true };
}

export async function freeMemory() {
  const queue = await comfyRequest('/queue');
  if (queue.queue_running?.length || queue.queue_pending?.length) throw bad('ComfyUI 仍有任务，队列空闲后才能释放显存', 409);
  return comfyRequest('/free', { body: { unload_models: true, free_memory: true } });
}
