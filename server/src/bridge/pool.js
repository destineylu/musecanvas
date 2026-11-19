// Bridge 池：轮询调度 + 每个 Bridge 的并发上限（默认 1 = 单 worker）+ 排队 + 健康检查 + 冷却
import { httpRequest } from "./http.js";

export class NoBridgeError extends Error {
  constructor(message) {
    super(message);
    this.status = 503;
  }
}

export class Pool {
  constructor(store) {
    this.store = store;
    this.runtime = new Map();
    this.queue = [];
    this.rr = 0;
    this.checking = false;
    this.timer = null;
    this.tick = setInterval(() => this.dispatch(), 5000); // 冷却到期后重新派发
    this.tick.unref();
  }

  rt(id) {
    let r = this.runtime.get(id);
    if (!r) {
      r = {
        busy: 0,
        healthy: null, // null = 还没检查过（允许使用）
        consecutiveFails: 0,
        cooldownUntil: 0,
        lastCheck: 0,
        lastError: "",
        healthMs: null,
        ok: 0,
        fail: 0,
        totalMs: 0,
        lastUsed: 0,
      };
      this.runtime.set(id, r);
    }
    return r;
  }

  /** 能否“原则上”服务该模型（不看忙闲）。 */
  serviceable(b, model) {
    if (!b.enabled || !b.token) return false;
    if (model.bridges?.length && !model.bridges.includes(b.id)) return false;
    return true;
  }

  available(b, model, exclude, now) {
    if (!this.serviceable(b, model)) return false;
    if (exclude?.has(b.id)) return false;
    const r = this.rt(b.id);
    if (r.healthy === false) return false;
    if (r.cooldownUntil > now) return false;
    return r.busy < (b.maxConcurrency || 1);
  }

  /**
   * 取得一个空闲 Bridge。没有空闲的就排队（FIFO，但被限定到忙碌 Bridge 的任务不会挡住别的任务）。
   * exclude：重试时尽量避开刚失败的 Bridge；如果除它以外没有可用 Bridge，就忽略 exclude。
   */
  acquire(model, { exclude, signal, timeoutMs } = {}) {
    const bridges = this.store.data.bridges;
    const pool = bridges.filter((b) => this.serviceable(b, model));
    if (!pool.length) {
      return Promise.reject(new NoBridgeError(`没有可用于模型 ${model.id} 的 Bridge（检查是否启用、是否已填 token）`));
    }
    // 只有“别的 Bridge 里至少有一个健康且不在冷却”时才避开刚失败的 Bridge，否则会白等冷却结束
    if (exclude?.size) {
      const now = Date.now();
      const others = pool.filter((b) => !exclude.has(b.id) && this.rt(b.id).healthy !== false && this.rt(b.id).cooldownUntil <= now);
      if (!others.length) exclude = undefined;
    }

    return new Promise((resolve, reject) => {
      const job = { model, exclude, enqueuedAt: Date.now() };
      const cleanup = () => {
        clearTimeout(job.timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        this.remove(job);
        cleanup();
        reject(Object.assign(new Error("客户端已断开"), { status: 499, aborted: true }));
      };
      job.done = (bridge) => {
        cleanup();
        resolve(bridge);
      };
      if (timeoutMs) {
        job.timer = setTimeout(() => {
          this.remove(job);
          cleanup();
          reject(Object.assign(new Error(`排队超时（${Math.round(timeoutMs / 1000)} 秒内没有空闲 Bridge）`), { status: 504 }));
        }, timeoutMs);
      }
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(job);
      this.dispatch();
    });
  }

  remove(job) {
    const i = this.queue.indexOf(job);
    if (i >= 0) this.queue.splice(i, 1);
  }

  dispatch() {
    const bridges = this.store.data.bridges;
    const n = bridges.length;
    if (!n) return;
    const now = Date.now();
    for (let i = 0; i < this.queue.length; ) {
      const job = this.queue[i];
      let picked = null;
      for (let k = 0; k < n; k++) {
        const idx = (this.rr + k) % n;
        if (this.available(bridges[idx], job.model, job.exclude, now)) {
          picked = bridges[idx];
          this.rr = (idx + 1) % n;
          break;
        }
      }
      if (!picked) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      const r = this.rt(picked.id);
      r.busy++;
      r.lastUsed = now;
      job.done(picked);
    }
  }

  /** outcome.bridgeFault=true 表示是 Bridge 本身的问题（5xx/超时/网络），会累计进冷却。 */
  release(bridge, { ms = 0, bridgeFault = false, error = "" } = {}) {
    const r = this.rt(bridge.id);
    r.busy = Math.max(0, r.busy - 1);
    r.totalMs += ms;
    if (bridgeFault) {
      r.fail++;
      r.consecutiveFails++;
      r.lastError = error;
      const { failThreshold, cooldownSec } = this.store.data.settings;
      if (r.consecutiveFails >= failThreshold) r.cooldownUntil = Date.now() + cooldownSec * 1000;
    } else {
      r.ok++;
      r.consecutiveFails = 0;
    }
    this.dispatch();
  }

  forget(id) {
    this.runtime.delete(id);
  }

  async checkOne(b) {
    const r = this.rt(b.id);
    const origin = b.baseUrl.replace(/\/v1$/, "");
    const t0 = Date.now();
    try {
      const res = await httpRequest(`${origin}/health`, { timeoutMs: 10_000 });
      r.healthy = res.status === 200;
      r.lastError = r.healthy ? "" : `health HTTP ${res.status}`;
    } catch (e) {
      r.healthy = false;
      r.lastError = `health ${e.code || e.message}`;
    }
    r.healthMs = Date.now() - t0;
    r.lastCheck = Date.now();
    return r.healthy;
  }

  async checkAll() {
    if (this.checking) return;
    this.checking = true;
    try {
      await Promise.all(this.store.data.bridges.filter((b) => b.enabled).map((b) => this.checkOne(b)));
    } finally {
      this.checking = false;
      this.dispatch();
    }
  }

  startHealth() {
    clearInterval(this.timer);
    this.checkAll();
    this.timer = setInterval(() => this.checkAll(), this.store.data.settings.healthIntervalSec * 1000);
    this.timer.unref();
  }

  snapshot() {
    const now = Date.now();
    return {
      queued: this.queue.length,
      queue: this.queue.map((j) => ({ model: j.model.id, waitingSec: Math.round((now - j.enqueuedAt) / 1000) })),
      bridges: Object.fromEntries(
        this.store.data.bridges.map((b) => {
          const r = this.rt(b.id);
          let state = "idle";
          if (!b.enabled) state = "disabled";
          else if (!b.token) state = "no-token";
          else if (r.healthy === false) state = "unhealthy";
          else if (r.cooldownUntil > now) state = "cooldown";
          else if (r.busy >= (b.maxConcurrency || 1)) state = "busy";
          else if (r.busy > 0) state = "partial";
          return [
            b.id,
            {
              state,
              busy: r.busy,
              healthy: r.healthy,
              healthMs: r.healthMs,
              lastCheck: r.lastCheck,
              lastError: r.lastError,
              cooldownLeftSec: Math.max(0, Math.round((r.cooldownUntil - now) / 1000)),
              ok: r.ok,
              fail: r.fail,
              avgMs: r.ok + r.fail ? Math.round(r.totalMs / (r.ok + r.fail)) : null,
              lastUsed: r.lastUsed,
            },
          ];
        }),
      ),
    };
  }
}
