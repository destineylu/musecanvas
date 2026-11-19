import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { CFG } from './config.js';
import { db, uid, now, addCredits, getSetting, setSetting } from './db.js';
export const sessionCookieName='musecanvas_'+createHash('sha256').update(CFG.ownerEmail).digest('hex').slice(0,16);

export const hashPassword = (pw) => bcrypt.hashSync(pw, 10);
export const verifyPassword = (pw, hash) => bcrypt.compareSync(pw, hash);

export const signToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role }, CFG.jwtSecret, { expiresIn: `${CFG.jwtDays}d` });

export function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name || u.email.split('@')[0],
    avatarUrl: u.avatar_url || null,
    role: u.role,
    credits: u.credits,
    status: u.status,
    createdAt: u.created_at,
  };
}

export function createUser({ email, password, name, role = 'user', credits, invitedBy = null }) {
  const id = uid('u_');
  const gift = credits ?? Number(getSetting('signupCredits') || 0);
  db.prepare(
    'INSERT INTO users(id, email, password_hash, name, role, credits, status, created_at, invited_by) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(id, email.toLowerCase().trim(), hashPassword(password), name || null, role, 0, 'active', now(), invitedBy);
  if (gift > 0) addCredits(id, gift, '注册赠送');
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

/** 邀请码 = 用户 id 去掉前缀后取前 8 位，双向可查 */
export function inviteCodeOf(userId) {
  return String(userId || '').replace(/^u_/, '').slice(0, 8);
}

export function findByInviteCode(code) {
  if (!code || String(code).length < 4) return null;
  const rows = db.prepare('SELECT * FROM users').all();
  return rows.find((u) => inviteCodeOf(u.id) === String(code).trim()) || null;
}

export function invitedUsers(userId) {
  return db.prepare('SELECT id, email, name, created_at, credits FROM users WHERE invited_by = ? ORDER BY created_at DESC')
    .all(userId);
}

export function findUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase().trim());
}

export function findUserById(id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function isLocalRequest(req) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false;
  try {
    const host = new URL('http://' + req.get('host'));
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) return false;
    const origin = req.get('origin');
    if (origin && origin !== host.origin && !/^http:\/\/(localhost|127\.0\.0\.1):5173$/.test(origin)) return false;
    return req.get('sec-fetch-site') !== 'cross-site';
  } catch { return false; }
}

export function localSession(req) {
  if(CFG.accessMode!=='local')throw Object.assign(new Error('当前工作区需要账号登录'),{status:403});
  let user = findUserById(getSetting('localOwnerId'));
  if (!user || user.status !== 'active') {
    try {
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      user = findUserById(jwt.verify(token, CFG.jwtSecret).sub);
    } catch { user = null; }
    if (!user || user.status !== 'active') user = db.prepare(`SELECT u.* FROM users u WHERE status='active'
      ORDER BY (SELECT COUNT(*) FROM projects p WHERE p.user_id=u.id) DESC,
      CASE role WHEN 'user' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`).get();
    if (!user) throw new Error('本机工作区尚未初始化');
    setSetting('localOwnerId', user.id);
  }
  const owner = { ...user, role: 'admin' };
  return { user: publicUser(owner), token: jwt.sign({ sub: user.id, local: true }, CFG.jwtSecret, { expiresIn: `${CFG.jwtDays}d` }) };
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const cookie = (req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(sessionCookieName+'='))?.slice(sessionCookieName.length+1);
  const token = header.startsWith('Bearer ') ? header.slice(7) : CFG.accessMode==='account' ? cookie : req.query.token;
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    const payload = jwt.verify(token, CFG.jwtSecret);
    if(CFG.accessMode==='account'&&payload.local)return res.status(401).json({error:'请使用工作区账号重新登录'});
    if (payload.local && !isLocalRequest(req)) return res.status(403).json({ error: '本机会话仅允许在本机使用' });
    const user = findUserById(payload.sub);
    if (!user) return res.status(401).json({ error: '账号不存在' });
    if (user.status !== 'active') return res.status(403).json({ error: '账号已被封禁' });
    if(CFG.accessMode==='account'&&user.email.toLowerCase()!==CFG.ownerEmail)return res.status(403).json({error:'此账号不属于当前独立工作区'});
    req.user = payload.local ? { ...user, role: 'admin' } : user;
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}
