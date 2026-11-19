import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

const upstreamFile = path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'upstream.json');
const savedUpstream = fs.existsSync(upstreamFile) ? JSON.parse(fs.readFileSync(upstreamFile, 'utf8')).mode : null;
export let upstreamMode = (process.env.MUSECANVAS_UPSTREAM_OVERRIDE || savedUpstream || process.env.MUSECANVAS_UPSTREAM || 'bridge').trim().toLowerCase();
if (!['bridge', 'muse2api'].includes(upstreamMode)) throw new Error('MUSECANVAS_UPSTREAM 必须是 bridge 或 muse2api');
export let usesMuse2api = upstreamMode === 'muse2api';

export function setUpstreamMode(mode) {
  if (!['bridge', 'muse2api'].includes(mode)) throw Object.assign(new Error('接入方式无效'), { status: 400 });
  fs.mkdirSync(path.dirname(upstreamFile), { recursive: true });
  fs.writeFileSync(upstreamFile + '.tmp', JSON.stringify({ mode }, null, 2));
  fs.renameSync(upstreamFile + '.tmp', upstreamFile);
  upstreamMode = mode;
  usesMuse2api = mode === 'muse2api';
}

const museBase = new URL(process.env.MUSE_BASE || 'http://127.0.0.1:18610');
if (!['http:', 'https:'].includes(museBase.protocol) || museBase.username || museBase.password || museBase.search || museBase.hash) {
  throw new Error('MUSE_BASE 必须是无认证信息和查询参数的 HTTP(S) 地址');
}
museBase.pathname = museBase.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') || '/';

export const CFG = {
  appVersion: '1.0',
  port: num(process.env.PORT, 8787),
  host: process.env.HOST || '127.0.0.1',

  museBase: museBase.href.replace(/\/$/, ''),
  museKey: (process.env.MUSE_KEY || process.env.MUSE2API_KEY || '').trim(),
  museQueueSeconds: Math.max(1, num(process.env.MUSE_QUEUE_TIMEOUT_SECONDS, 1800)),
  museImageSeconds: Math.min(1800, Math.max(1, num(process.env.MUSE_IMAGE_TIMEOUT_SECONDS, 1800))),
  museVideoSeconds: Math.max(1, num(process.env.MUSE_VIDEO_TIMEOUT_SECONDS, 1800)),
  bridgeModels: {
    chat: process.env.BRIDGE_CHAT_MODEL || 'muse',
    image: process.env.BRIDGE_IMAGE_MODEL || 'muse-image',
    video: process.env.BRIDGE_VIDEO_MODEL || 'muse-video',
  },
  bridgeTimeoutMs: num(process.env.BRIDGE_TIMEOUT_MS, 7_800_000),
  bridgeDownloadTimeoutMs: num(process.env.BRIDGE_DOWNLOAD_TIMEOUT_MS, 1_900_000),
  bridgeConcurrency: Math.min(16, Math.max(1, Math.floor(num(process.env.BRIDGE_CONCURRENCY, 3)))),

  // 平台自身
  jwtSecret: process.env.JWT_SECRET || '',
  jwtDays: num(process.env.JWT_DAYS, 14),
  accessMode: process.env.ACCESS_MODE || 'local',
  ownerEmail: (process.env.ADMIN_EMAIL || 'admin@muse.local').trim().toLowerCase(),
  secureCookie: process.env.COOKIE_SECURE === '1',

  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
  publicBase: (process.env.PUBLIC_BASE || '').replace(/\/+$/, ''),

  // 定价（积分）
  price: {
    videoBase: num(process.env.PRICE_VIDEO_BASE, 10),
    videoPerSecond: num(process.env.PRICE_VIDEO_PER_SEC, 2),
    image: num(process.env.PRICE_IMAGE, 5),
  },
  signupCredits: num(process.env.SIGNUP_CREDITS, 100),

  // 允许自助注册
  allowRegister: (process.env.ALLOW_REGISTER ?? '1') !== '0',

  // 默认时长/画幅。图片和视频的可用比例不同，不能共用一份名单。
  videoDurations: [5, 6, 8, 10],
  // 2:1 / 4:1 供全景图（720° 球面、360° 环绕）使用。
  imageSizes: ['1:1', '3:4', '4:3', '2:3', '3:2', '4:5', '5:4', '9:16', '16:9', '21:9', '2:1', '4:1'],
  videoSizes: ['9:16', '16:9', '1:1', '3:4', '4:3', '21:9'],
  sizes: ['1:1', '3:4', '4:3', '2:3', '3:2', '4:5', '5:4', '9:16', '16:9', '21:9'],
};

export const MEDIA_DIR = path.join(CFG.dataDir, 'media');
export const DB_FILE = path.join(CFG.dataDir, 'studio.db');
