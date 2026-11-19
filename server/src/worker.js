import { CFG, usesMuse2api } from './config.js';
import { pendingJobs, updateJob, addCredits, getJob, db, createJob } from './db.js';
import { downloadMedia, generateMedia } from './muse.js';
import { referenceImage } from './mediaRefs.js';
import * as legacy from './muse2api.js';

const inflight = new Set();

function transaction(work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function createQueuedJob(userId, type, prompt, params, workspace = {}) {
  // 本机部署不计积分：生成任务不检查、不扣除积分，失败也无需退还。
  const cost = 0;
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) {
    throw Object.assign(new Error('账号不存在'), { status: 401 });
  }
  const job = createJob(userId, type, prompt, params, cost);
  updateJob(job.id, { upstream_id: usesMuse2api ? 'muse2api:queued' : 'bridge:queued', project_id: workspace.projectId, canvas_id: workspace.canvasId });
  return getJob(job.id);
}

export const enqueueJob = (...args) => transaction(() => createQueuedJob(...args));

const failJob = (id, message) => transaction(() => {
  const job = getJob(id);
  if (!job || !['queued', 'processing'].includes(job.status)) return;
  if (!job.refunded && job.cost > 0) addCredits(job.userId, job.cost, '任务失败退还', job.id);
  updateJob(id, {
    status: 'failed', error: String(message).slice(0, 500), finished_at: Date.now(),
    refunded: job.refunded || job.cost > 0 ? 1 : 0,
  });
});

async function runBridgeJob(job) {
  if (inflight.has(job.id)) return;
  inflight.add(job.id);
  try {
    let url = job.result?.url;
    if (job.upstreamId === 'bridge:queued') {
      const references = (job.params.images || []).map(item => referenceImage(job.userId, item));
      updateJob(job.id, { upstream_id: 'bridge:running', status: 'processing', progress: 15 });
      url = await generateMedia(job, references);
      updateJob(job.id, { upstream_id: 'bridge:download', status: 'processing', progress: 85, result: JSON.stringify({ url }) });
    } else if (job.upstreamId !== 'bridge:download' || !url) {
      return failJob(job.id, '旧上游任务或已中断的生成无法续接，请重新提交');
    }
    const { fileName, bytes } = await downloadMedia(url, job.id, job.type);
    updateJob(job.id, {
      status: 'completed', progress: 100, media_file: fileName, error: null,
      result: JSON.stringify({ localUrl: '/media/' + fileName, bytes }), finished_at: Date.now(),
    });
  } catch (error) {
    const timeout = ['TimeoutError', 'AbortError'].includes(error.name);
    failJob(job.id, timeout ? 'API Bridge 生成或下载超时，请重试' : error.message);
  } finally {
    inflight.delete(job.id);
    queueMicrotask(dispatch);
  }
}

async function runLegacyJob(job) {
  inflight.add(job.id);
  try {
    let url = job.result?.url;
    let account = job.accountId;
    if (job.upstreamId === 'muse2api:queued') {
      const images = (job.params.images || []).map(item => ({ url: referenceImage(job.userId, item) }));
      const video = job.type === 'video';
      const payload = { prompt: job.prompt, model: video ? 'muse-video' : 'muse-image', size: job.params.size };
      if (video) {
        payload.duration = job.params.duration;
        if (job.params.extra) payload.extra = job.params.extra;
      }
      if (images.length) payload.images = images;
      updateJob(job.id, { upstream_id: 'muse2api:submitting', status: 'processing', progress: 10 });
      const task = await (video ? legacy.createVideo(payload) : legacy.createImageTask(payload));
      const id = task?.id || task?.task_id;
      if (!id) throw new Error('muse2api 未返回任务 ID');
      updateJob(job.id, { upstream_id: 'muse2api:id:' + id, result: JSON.stringify({ submittedAt: Date.now() }) });
      return;
    }
    if (job.upstreamId === 'muse2api:submitting') {
      return failJob(job.id, 'muse2api 提交时进程已退出，无法核对上游任务 ID');
    }
    if (job.upstreamId !== 'muse2api:download') {
      const id = job.upstreamId.replace(/^muse2api:id:/, '');
      const video = job.type === 'video';
      const submittedAt = job.result?.submittedAt || job.createdAt;
      if (Date.now() - submittedAt > (video ? 15 : 8) * 60_000) {
        return failJob(job.id, 'muse2api 任务超时，请重试');
      }
      let task;
      try {
        task = await (video ? legacy.getVideo(id) : legacy.getImageTask(id));
      } catch (error) {
        if (!error.status || error.status === 429 || error.status >= 500) return;
        throw error;
      }
      const state = String(task.status || '').toLowerCase();
      if (['failed', 'error', 'canceled', 'cancelled'].includes(state)) {
        return failJob(job.id, task.error?.message || task.error || 'muse2api 生成失败');
      }
      account = task.account || account;
      if (!['completed', 'succeeded', 'success', 'done'].includes(state)) {
        updateJob(job.id, { status: 'processing', progress: Math.max(Number(task.progress) || 0, job.progress), account_id: account });
        return;
      }
      url = task.url || task.result?.url || task.video?.url || task.data?.[0]?.url;
      if (!url) throw new Error('muse2api 未返回媒体地址');
      updateJob(job.id, { upstream_id: 'muse2api:download', status: 'processing', progress: 85, account_id: account, result: JSON.stringify({ url }) });
    }
    const { fileName, bytes } = await legacy.downloadMedia(url, job.id, job.type);
    updateJob(job.id, {
      status: 'completed', progress: 100, media_file: fileName, account_id: account, error: null,
      result: JSON.stringify({ localUrl: '/media/' + fileName, bytes }), finished_at: Date.now(),
    });
  } catch (error) {
    failJob(job.id, error.message);
  } finally {
    inflight.delete(job.id);
  }
}

const runJob = job => job.upstreamId?.startsWith('bridge:') ? runBridgeJob(job) : runLegacyJob(job);

function dispatch() {
  const free = CFG.bridgeConcurrency - inflight.size;
  if (free <= 0) return;
  for (const job of pendingJobs().filter(item => item.upstreamId && item.phase !== 'paused' && !inflight.has(item.id)).slice(0, free)) {
    runJob(job).catch(error => console.error('[worker]', job.id, error.message));
  }
}

const scheduleQueue = () => transaction(() => {
  const due = db.prepare(
    "SELECT * FROM queue_items WHERE status = 'pending' AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY sort_order ASC LIMIT 3"
  ).all(Date.now());
  for (const item of due) {
    let params = {};
    try { params = JSON.parse(item.params || '{}'); } catch { /* use defaults */ }
    const duration = Number(params.duration);
    try {
      const job = createQueuedJob(item.user_id, 'video', item.prompt, {
        duration: CFG.videoDurations.includes(duration) ? duration : 5,
        size: CFG.videoSizes.includes(params.size) ? params.size : '16:9',
      });
      db.prepare("UPDATE queue_items SET status = 'running', job_id = ?, runs = runs + 1, last_run_at = ? WHERE id = ?")
        .run(job.id, Date.now(), item.id);
    } catch (error) {
      if (error.status !== 402) throw error;
      db.prepare("UPDATE queue_items SET status = 'paused', note = ? WHERE id = ?").run(error.message, item.id);
    }
  }

  for (const item of db.prepare("SELECT * FROM queue_items WHERE status = 'running' AND job_id IS NOT NULL").all()) {
    const job = getJob(item.job_id);
    if (!job || !['completed', 'failed'].includes(job.status)) continue;
    const finished = job.status === 'completed';
    if (item.runs >= item.max_runs) {
      db.prepare('UPDATE queue_items SET status = ?, note = ? WHERE id = ?')
        .run(finished ? 'done' : 'failed', finished ? '全部执行完成' : (job.error || '执行失败'), item.id);
    } else {
      db.prepare("UPDATE queue_items SET status = 'pending', next_run_at = ?, note = ? WHERE id = ?")
        .run(Date.now() + item.interval_min * 60_000, finished ? '已执行，等待下次' : (job.error || '执行失败'), item.id);
    }
  }
});

export function startWorker() {
  dispatch();
  setInterval(dispatch, 1000);
  setInterval(() => {
    try { scheduleQueue(); dispatch(); }
    catch (error) { console.error('[queue]', error.message); }
  }, 20_000);
}

export { runJob as pollOne };
