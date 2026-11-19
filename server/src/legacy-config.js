import fs from 'node:fs';
import path from 'node:path';
import { CFG } from './config.js';

const file = path.join(CFG.dataDir, 'muse2api.json');
let saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
export const legacyConfig = () => ({ baseUrl: saved.baseUrl || CFG.museBase, key: saved.key ?? CFG.museKey });
export const legacyState = () => ({ baseUrl: legacyConfig().baseUrl, keySet: !!legacyConfig().key });
export function saveLegacyConfig(input) {
  const url = new URL(input.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw Object.assign(new Error('请填写不含认证信息和查询参数的 HTTP(S) 服务地址'), { status: 400 });
  }
  const next = { baseUrl: url.href.replace(/\/+$/, '').replace(/\/v1$/, ''), key: legacyConfig().key };
  if (input.key) {
    if (typeof input.key !== 'string' || /[\r\n]/.test(input.key) || input.key.length > 4096) throw Object.assign(new Error('密钥格式无效'), { status: 400 });
    next.key = input.key.trim();
  }
  fs.mkdirSync(CFG.dataDir, { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  saved = next;
  return legacyState();
}
