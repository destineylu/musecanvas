import { Router } from 'express';
import { CFG } from '../config.js';
import { db, now, getSetting, addCredits } from '../db.js';
import {
  findUserByEmail, verifyPassword, signToken, publicUser,
  requireAuth, hashPassword, inviteCodeOf, invitedUsers, isLocalRequest, localSession,
  sessionCookieName,
} from '../auth.js';

const r = Router();
const sessionCookie=(res,token)=>res.cookie(sessionCookieName,token,{httpOnly:true,sameSite:'strict',secure:CFG.secureCookie,path:'/',maxAge:CFG.jwtDays*86400000});
r.get('/mode',(_req,res)=>res.json({mode:CFG.accessMode,registration:false}));
r.post('/logout',(_req,res)=>{res.clearCookie(sessionCookieName,{httpOnly:true,sameSite:'strict',secure:CFG.secureCookie,path:'/'});res.json({ok:true});});

r.post('/local-session', (req, res, next) => {
  if(CFG.accessMode!=='local')return res.status(403).json({error:'此工作区已启用账号登录'});
  if (!isLocalRequest(req)) return res.status(403).json({ error: '请从本机地址打开程序' });
  res.set('Cache-Control', 'no-store');
  try { res.json(localSession(req)); } catch (error) { next(error); }
});

r.post('/register', (_req, res) => res.status(410).json({ error: '程序已取消注册，请直接打开本机工作区' }));

r.get('/invite', requireAuth, (req, res) => {
  const code = inviteCodeOf(req.user.id);
  const list = invitedUsers(req.user.id);
  res.json({
    code,
    link: `${req.protocol}://${req.get('host')}/login?ref=${code}`,
    total: list.length,
    invited: list.map((u) => ({
      email: u.email.replace(/^(.{2}).*(@.*)$/, '$1***$2'),
      name: u.name || u.email.split('@')[0],
      createdAt: u.created_at,
    })),
    reward: { inviter: 50, invitee: 50 },
  });
});

const attempts=new Map();
r.post('/login', (req, res) => {
  const ip=req.socket.remoteAddress;
  for(const [key,value] of attempts)if(value.until<Date.now())attempts.delete(key);
  const attempt=attempts.get(ip)||{count:0,until:Date.now()+5*60000};
  if(attempt.count>=20)return res.status(429).json({error:'登录尝试过多，请五分钟后重试'});
  attempt.count++;attempts.set(ip,attempt);
  const { email, password } = req.body || {};
  const user = findUserByEmail(email);
  if (typeof password!=='string'||password.length>1024||!user || (CFG.accessMode==='account'&&user.email.toLowerCase()!==CFG.ownerEmail) || !verifyPassword(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }
  if (user.status !== 'active') return res.status(403).json({ error: '账号已被封禁' });
  attempts.delete(ip);
  const token=signToken(user);
  if(CFG.accessMode==='account')sessionCookie(res,token);
  res.set('Cache-Control','no-store').json({ token, user: publicUser(user) });
});

r.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

r.patch('/me', requireAuth, (req, res) => {
  const { name, password, oldPassword, avatarUrl } = req.body || {};
  if (avatarUrl !== undefined && avatarUrl !== null && avatarUrl !== '') {
    const match = String(avatarUrl).match(/^\/uploads\/([A-Za-z0-9_.-]+)$/);
    const owned = match && db.prepare('SELECT id FROM uploads WHERE user_id = ? AND filename = ?').get(req.user.id, match[1]);
    if (!owned) return res.status(400).json({ error: '头像必须是你刚刚上传的图片' });
  }
  if (name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(name).slice(0, 40), req.user.id);
  if (avatarUrl !== undefined) {
    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl || null, req.user.id);
  }
  if (password) {
    if (!verifyPassword(String(oldPassword || ''), req.user.password_hash)) {
      return res.status(400).json({ error: '原密码不正确' });
    }
    if (typeof password!=='string'||password.length<12||password.length>1024) return res.status(400).json({ error: '新密码需为 12–1024 个字符' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(password)), req.user.id);
  }
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

r.get('/ledger', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 100')
    .all(req.user.id);
  res.json({ ledger: rows });
});

export default r;
