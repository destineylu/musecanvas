import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT } from './config.js';
import { legacyConfig } from './legacy-config.js';
import { health, scheduler } from './muse2api.js';

export async function ensureLegacyService() {
  try { await health(); } catch (error) {
    const url = new URL(legacyConfig().baseUrl);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || (url.port !== '18610' && process.env.MUSECANVAS_MANAGED_ENGINE !== '1') || process.platform !== 'win32') throw error;
    const home = path.resolve(ROOT, '..', 'upstream', 'muse2api');
    const bundled = path.resolve(ROOT, '..', 'runtime', 'python', 'python.exe');
    const python = fs.existsSync(bundled) ? bundled : path.join(home, '.venv', 'Scripts', 'python.exe');
    if (!fs.existsSync(python)) throw Object.assign(new Error('本机 muse2api Python 环境缺失，请先安装 upstream/muse2api 的依赖'), { status: 503 });
    const out = fs.openSync(path.join(home, 'server.log'), 'a');
    const err = fs.openSync(path.join(home, 'server.err.log'), 'a');
    try {
      const env = { ...process.env, MUSE2API_HOME: home };
      delete env.MUSE2API_KEY;
      const child = spawn(python, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', url.port], { cwd: home, env, windowsHide: true, detached: true, stdio: ['ignore', out, err] });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      fs.writeFileSync(path.join(home, 'server.log.pid'), String(child.pid));
      child.unref();
    } finally { fs.closeSync(out); fs.closeSync(err); }
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try { await health(); ready = true; break; } catch { await delay(1000); }
    }
    if (!ready) throw Object.assign(new Error('muse2api 启动未就绪，请检查 upstream/muse2api/server.err.log'), { status: 503 });
  }
  await scheduler();
}
