import { createHash } from 'node:crypto';
import { db, uid, now } from './db.js';
import { cleanShots } from '../../shared/canvas-workflow.js';

db.exec(`CREATE TABLE IF NOT EXISTS canvas_versions (
 id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL, label TEXT NOT NULL, document_json TEXT NOT NULL, signature TEXT NOT NULL, created_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_canvas_versions ON canvas_versions(canvas_id,created_at DESC);
 CREATE TABLE IF NOT EXISTS asset_notes (user_id TEXT NOT NULL,url TEXT NOT NULL,name TEXT NOT NULL DEFAULT '',tags TEXT NOT NULL DEFAULT '',favorite INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,url));`);

export function normalizeDocument(value) {
  if(!value||!Array.isArray(value.nodes)||!Array.isArray(value.links))throw Error('画布文档无效');
  const result={nodes:value.nodes.slice(0,2000),links:value.links.slice(0,5000),view:value.view||{x:0,y:0,z:1},storyboard:cleanShots(value.storyboard||[])};
  const serialized=JSON.stringify(result);if(serialized.length>12*1024*1024)throw Error('画布内容过大');return serialized;
}
export function snapshot(canvasId,userId,value,label='自动保存',force=false) {
  const serialized=normalizeDocument(typeof value==='string'?JSON.parse(value):value),doc=JSON.parse(serialized);
  const signature=createHash('sha256').update(JSON.stringify({nodes:doc.nodes,links:doc.links,storyboard:doc.storyboard})).digest('hex');
  const last=db.prepare('SELECT signature,created_at FROM canvas_versions WHERE canvas_id=? AND user_id=? ORDER BY rowid DESC LIMIT 1').get(canvasId,userId);
  if(last?.signature===signature&&!force)return;
  // Group rapid automatic edits; explicit actions always preserve a checkpoint.
  if(!force&&last&&now()-last.created_at<30_000)return;
  db.prepare('INSERT INTO canvas_versions(id,canvas_id,user_id,label,document_json,signature,created_at) VALUES(?,?,?,?,?,?,?)').run(uid('ver_'),canvasId,userId,String(label||'手动快照').slice(0,100),serialized,signature,now());
  db.prepare('DELETE FROM canvas_versions WHERE canvas_id=? AND id NOT IN (SELECT id FROM canvas_versions WHERE canvas_id=? ORDER BY rowid DESC LIMIT 80)').run(canvasId,canvasId);
}

export function library(userId) {
  const notes=new Map(db.prepare('SELECT * FROM asset_notes WHERE user_id=?').all(userId).map(n=>[n.url,n])), map=new Map();
  const uploads=db.prepare("SELECT * FROM uploads WHERE user_id=? AND (mime LIKE 'image/%' OR mime LIKE 'video/%') ORDER BY created_at DESC").all(userId);
  for(const u of uploads)map.set('/uploads/'+u.filename,{id:u.id,url:'/uploads/'+u.filename,name:u.filename,type:u.mime.startsWith('video/')?'video':'image',source:'upload',createdAt:u.created_at,bytes:u.bytes});
  for(const j of db.prepare("SELECT * FROM jobs WHERE user_id=? AND status='completed' AND media_file IS NOT NULL ORDER BY created_at DESC").all(userId))map.set('/media/'+j.media_file,{id:j.id,url:'/media/'+j.media_file,name:j.prompt.slice(0,60),prompt:j.prompt,type:j.type,source:'generation',canvasId:j.canvas_id,createdAt:j.finished_at||j.created_at});
  return [...map.values()].map(a=>{const n=notes.get(a.url);return {...a,name:n?.name||a.name,tags:n?.tags||'',favorite:!!n?.favorite};}).sort((a,b)=>b.createdAt-a.createdAt);
}
export function ownedAsset(userId,url) {
  if(typeof url!=='string')return false;
  if(/^\/uploads\/[A-Za-z0-9_.-]+$/.test(url))return !!db.prepare('SELECT id FROM uploads WHERE user_id=? AND filename=?').get(userId,url.slice(9));
  if(/^\/media\/[A-Za-z0-9_.-]+$/.test(url))return !!db.prepare('SELECT id FROM jobs WHERE user_id=? AND media_file=?').get(userId,url.slice(7));
  return false;
}
