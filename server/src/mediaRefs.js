import fs from 'node:fs';
import path from 'node:path';
import { CFG, MEDIA_DIR } from './config.js';
import { db } from './db.js';

const imageMimes = {
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.avif': 'image/avif',
};

export function referenceImage(userId, reference, read = true) {
  const value = typeof reference === 'string' ? reference : reference?.url;
  const match = typeof value === 'string' && /^\/(uploads|media)\/([\w-]+\.[a-z0-9]+)$/i.exec(value);
  const invalid = () => Object.assign(new Error('请上传或连接一张当前账号可用的 JPG、PNG、WebP、GIF 或 AVIF 图片'), { status: 400 });
  if (!match) throw invalid();
  const [, kind, filename] = match;
  const mime = imageMimes[path.extname(filename).toLowerCase()];
  if (!mime) throw invalid();
  const ownsFile = kind === 'uploads'
    ? db.prepare('SELECT 1 FROM uploads WHERE user_id = ? AND filename = ? AND mime LIKE ?').get(userId, filename, 'image/%')
    : db.prepare("SELECT 1 FROM jobs WHERE user_id = ? AND media_file = ? AND type = 'image'").get(userId, filename);
  if (!ownsFile) throw invalid();
  const file = path.join(kind === 'uploads' ? path.join(CFG.dataDir, 'uploads') : MEDIA_DIR, filename);
  const size = fs.statSync(file, { throwIfNoEntry: false })?.size;
  if (!size) throw invalid();
  if (size > 25 * 1024 * 1024) throw Object.assign(new Error('参考图不能超过 25 MB'), { status: 413 });
  return read ? 'data:' + mime + ';base64,' + fs.readFileSync(file).toString('base64') : undefined;
}
