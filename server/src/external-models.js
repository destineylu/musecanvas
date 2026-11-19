import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MEDIA_DIR } from './config.js';

const failure = message => Object.assign(new Error(message), { status: 502 });
// Native HTTP keeps long generation requests independent of fetch's header timeout.
export function requestBuffer(url, { method = 'GET', headers = {}, body, timeout = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return reject(failure('媒体或接口地址无效'));
    const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const req = (u.protocol === 'https:' ? https : http).request(u, { method, headers: payload ? { ...headers, 'Content-Length': payload.length } : headers }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 100 * 1024 * 1024) req.destroy(failure('响应超过 100 MB')); else chunks.push(chunk); });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }); });
      res.on('error', e => {clearTimeout(timer);reject(e);}); res.on('aborted', () => {clearTimeout(timer);reject(failure('响应下载中断'));});
    });
    const timer = setTimeout(() => req.destroy(failure('外部模型请求超时')), timeout);
    req.on('error', e => { clearTimeout(timer); reject(e); });
    if (payload) req.write(payload); req.end();
  });
}
const endpoint = (p, route) => p.baseUrl + route;
const auth = p => p.apiKey ? { Authorization: 'Bearer ' + p.apiKey } : {};
export async function modelRequest(p, route, payload, multipart = false) {
  let headers = auth(p), body;
  if (multipart) {
    const form = new FormData();
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'image' || key === 'input_reference') {
        const refs = Array.isArray(value) ? value : [value];
        for (let i = 0; i < refs.length; i++) {
          const m = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(refs[i]);
          if (!m) throw failure('参考图片格式无效');
          form.append(key === 'image' && refs.length > 1 ? 'image[]' : key, new Blob([Buffer.from(m[2], 'base64')], { type: m[1] }), 'reference-' + i + '.' + m[1].split('/')[1]);
        }
      } else form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    const request = new Request('http://local.invalid', { method: 'POST', body: form });
    headers['Content-Type'] = request.headers.get('content-type');
    body = Buffer.from(await request.arrayBuffer());
  } else if (payload !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(payload); }
  const res = await requestBuffer(endpoint(p, route), { method: payload === undefined ? 'GET' : 'POST', headers, body });
  if (res.status < 200 || res.status >= 300) throw failure(p.name + ' 请求失败（HTTP ' + res.status + '），请检查密钥、模型和接口参数');
  let data; try { data = JSON.parse(res.buffer.toString('utf8')); } catch { throw failure(p.name + ' 未返回 JSON，请检查接口路径'); }
  if (data.error) throw failure(p.name + ' 返回生成错误，请在供应商控制台核对任务');
  return data;
}
const textSlots = new Map();
export async function externalText(p, messages) {
  let slots=textSlots.get(p.id);
  if(!slots){slots={active:0,queue:[]};textSlots.set(p.id,slots);}
  if(slots.active>=p.maxConcurrency){
    if(slots.queue.length>=16)throw failure('语言模型等待队列已满，请稍后再试');
    await new Promise((resolve,reject)=>{
      const item={resolve:()=>{clearTimeout(timer);resolve();}};
      const timer=setTimeout(()=>{slots.queue=slots.queue.filter(x=>x!==item);reject(failure('语言模型排队超时'));},600000);
      slots.queue.push(item);
    });
  }else slots.active++;
  try{
    const result = await modelRequest(p, p.createPath, { ...p.extra, model: p.model, messages, stream: false });
    const text = result.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw failure('语言模型未返回有效的 choices.message.content');
    return text;
  }finally{
    const next=slots.queue.shift();if(next)next.resolve();else{slots.active--;if(!slots.active)textSlots.delete(p.id);}
  }
}
export async function testModel(p) {
  const data = await modelRequest(p, '/models');
  if (!Array.isArray(data.data)) throw failure('模型列表协议不兼容；请核对 /models 接口');
  if (!data.data.some(m => m.id === p.model)) throw failure('已连通，但模型列表中没有配置的模型 ID');
  return { ok: true, message: '连接与模型列表检查通过；未提交生成任务。实际生成仍取决于供应商协议、额度和参数。' };
}
const sizes = (p, ratio) => p.sizes[ratio] || (p.kind === 'image'
  ? (ratio === '1:1' ? '1024x1024' : Number(ratio.split(':')[0]) > Number(ratio.split(':')[1]) ? '1536x1024' : '1024x1536')
  : (Number(ratio.split(':')[0]) > Number(ratio.split(':')[1]) ? '1280x720' : '720x1280'));
export async function submitExternal(p, job, refs) {
  const payload = { ...p.extra, model: p.model, prompt: [job.prompt, job.params.extra].filter(Boolean).join('\n'), size: sizes(p, job.params.size) };
  if (p.kind === 'image') {
    return modelRequest(p, refs.length ? p.editPath : p.createPath, { ...payload, ...(refs.length ? { image: refs } : {}) }, !!refs.length);
  }
  if (p.protocol === 'video-openai') return modelRequest(p, p.createPath, { ...payload, seconds: String(job.params.duration), ...(refs.length ? { input_reference: refs[0] } : {}) }, true);
  return modelRequest(p, p.createPath, { ...payload, duration: job.params.duration, ...(refs.length ? { images: refs.map(url => ({ url })) } : {}) });
}
export const pollExternal = (p, id) => modelRequest(p, p.pollPath.replace('{id}', encodeURIComponent(id)));
export function externalResult(data) {
  const result = data.data?.[0] || data.result || data.output || data;
  return { b64: result.b64_json, url: result.url || result.video_url || result.image_url || data.video?.url || data.url };
}
async function download(p, value, depth = 0) {
  if (depth > 4) throw failure('媒体下载重定向过多');
  const u = new URL(value);
  // Only configured API origins receive the API key, never third-party CDNs.
  const res = await requestBuffer(u.href, { headers: u.origin === new URL(p.baseUrl).origin ? auth(p) : {}, timeout: 180000 });
  if ([301,302,303,307,308].includes(res.status) && res.headers.location) return download(p, new URL(res.headers.location, u).href, depth + 1);
  if (res.status !== 200) throw failure('媒体下载失败（HTTP ' + res.status + '）');
  return res.buffer;
}
export async function saveExternalResult(p, job, data, taskId) {
  const result = externalResult(data);
  let bytes;
  if (result.b64) {
    if (typeof result.b64 !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(result.b64) || result.b64.length > 140000000) throw failure('图片 Base64 数据无效或过大');
    bytes = Buffer.from(result.b64, 'base64');
  } else {
    const url = result.url || (p.protocol === 'video-openai' && taskId ? endpoint(p, p.contentPath.replace('{id}', encodeURIComponent(taskId))) : null);
    if (!url || typeof url !== 'string') throw failure('模型未返回可下载的媒体结果');
    bytes = await download(p, new URL(url, p.baseUrl + '/').href);
  }
  let ext;
  if (job.type === 'image') {
    if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ext = 'png';
    else if (bytes[0] === 255 && bytes[1] === 216) ext = 'jpg';
    else if (bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') ext = 'webp';
    else if (bytes.toString('ascii',0,3) === 'GIF') ext = 'gif';
  } else if (bytes.toString('ascii',4,8) === 'ftyp') ext = 'mp4';
  else if (bytes.subarray(0,4).equals(Buffer.from([26,69,223,163]))) ext = 'webm';
  if (!ext) throw failure('供应商返回的文件不是受支持的图片或视频');
  const fileName = job.id + '.' + ext;
  const dest = path.join(MEDIA_DIR, fileName);
  try { await fs.writeFile(dest + '.part', bytes); await fs.rename(dest + '.part', dest); }
  finally { await fs.rm(dest + '.part', { force: true }); }
  return { fileName, bytes: bytes.length };
}
