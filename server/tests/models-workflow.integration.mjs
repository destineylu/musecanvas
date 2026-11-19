import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'muse-models-'));
const secret=randomBytes(24).toString('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9kAAAAASUVORK5CYII=','base64');
const mp4=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom00000000')]);
const requests=[],tasks=new Map();let imageActive=0,maxImage=0,taskSeq=0;
const mock=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=Buffer.concat(chunks).toString();requests.push({url:req.url,body,auth:req.headers.authorization,contentType:req.headers['content-type']});
  const json=data=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};
  if(req.url==='/v1/models')return json({data:['chat-test','image-test','video-test'].map(id=>({id}))});
  if(req.url==='/v1/chat/completions')return json({choices:[{message:{content:'外部语言模型已接入'}}]});
  if(req.url==='/v1/images/generations'||req.url==='/v1/images/edits'){
    imageActive++;maxImage=Math.max(maxImage,imageActive);await new Promise(r=>setTimeout(r,500));imageActive--;
    if(body.includes('FAIL_BRANCH')){res.statusCode=500;return json({error:'test failure'});}
    return json({data:[{b64_json:png.toString('base64')}]});
  }
  if(req.url==='/v1/videos'){
    const id='video-'+(++taskSeq);tasks.set(id,{polls:0,openai:req.headers['content-type'].startsWith('multipart/')});return json({id,status:'queued'});
  }
  const task=/^\/v1\/videos\/(video-\d+)$/.exec(req.url);
  if(task){const t=tasks.get(task[1]);t.polls++;return json({id:task[1],status:t.polls<3?'in_progress':'completed',url:t.polls<3||t.openai?undefined:`http://127.0.0.1:${mock.address().port}/video.mp4`});}
  if(/^\/v1\/videos\/video-\d+\/content$/.test(req.url)){res.setHeader('Content-Type','video/mp4');return res.end(mp4);}
  if(req.url==='/video.mp4'){res.setHeader('Content-Type','video/mp4');return res.end(mp4);}
  res.statusCode=404;json({error:'missing'});
}).listen(0,'127.0.0.1');await once(mock,'listening');
const reserve=http.createServer().listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const origin='http://127.0.0.1:'+port,remote='http://127.0.0.1:'+mock.address().port+'/v1';
let server,token,chrome,browserSend;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function boot(){
  server=spawn(process.execPath,['src/index.js'],{env:{...process.env,DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',JWT_SECRET:secret,MUSECANVAS_UPSTREAM:'bridge',ADMIN_EMAIL:'models@example.test',ADMIN_PASSWORD:secret},stdio:['ignore','ignore','pipe'],windowsHide:true});
  let errors='';server.stderr.on('data',c=>{errors+=c;});
  for(let i=0;i<60;i++){try{if((await fetch(origin+'/api/health')).ok)return;}catch{}if(server.exitCode!==null)throw Error(errors);await wait(100);}throw Error('server boot timed out');
}
async function call(route,method='GET',body,expected=200){
  const res=await fetch(origin+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await res.json();assert.equal(res.status,expected,JSON.stringify(data));return data;
}
async function until(work,predicate,timeout=30000){const start=Date.now();let value;while(Date.now()-start<timeout){value=await work();if(predicate(value))return value;await wait(250);}throw Error('condition timed out: '+JSON.stringify(value));}
const node=(id,type,text)=>({id,type,text,label:id,intent:'generate',x:0,y:0,size:'16:9',duration:8});
try{
  await boot();token=(await call('/api/auth/local-session','POST',{})).token;
  const add=async(kind,protocol)=>{
    const c=await call('/api/models','POST',{kind,protocol,name:kind+' test',model:kind+'-test',baseUrl:remote,apiKey:'fixture-provider-key',maxReferences:1,maxConcurrency:1});
    assert.ok(!JSON.stringify(c).includes('fixture-provider-key'));return c.providers.find(p=>p.kind===kind);
  };
  const chat=await add('chat','chat'),image=await add('image','images'),video=await add('video','video-json');
  await call('/api/models/defaults','PUT',{chat:chat.id,image:image.id,video:video.id});
  await call('/api/models/defaults','PUT',{image:chat.id},400);
  assert.ok((await call('/api/models/'+image.id+'/test','POST',{})).ok);
  await call('/api/models/'+image.id,'DELETE',undefined,400);
  await call('/api/models','POST',{kind:'image',name:'bad',model:'bad',protocol:'images',baseUrl:remote,createPath:'//other.test'},400);
  await call('/api/models','POST',{kind:'image',name:'bad',model:'bad',protocol:'images',baseUrl:remote,extra:{prompt:'override'}},400);
  const scratch=(await call('/api/projects/scratch')).project,canvasId=scratch.canvases[0].id;
  const response=await call('/api/chat','POST',{canvasId,messages:[{role:'user',content:'测试语言模型'}]});assert.equal(response.model,'chat-test');assert.equal(response.content,'外部语言模型已接入');
  const document={nodes:[node('ref','image','角色参考'),node('shot1','image','镜头一'),node('shot2','image','镜头二'),node('video1','video','视频一'),node('video2','video','视频二')],links:[{from:'ref',to:'shot1'},{from:'ref',to:'shot2'},{from:'shot1',to:'video1'},{from:'shot2',to:'video2'}]};
  await call('/api/projects/canvases/'+canvasId,'PATCH',{document});
  let run=(await call('/api/workbench/'+canvasId+'/run','POST',{limit:2})).run;assert.equal(run.steps.filter(s=>s.state==='running').length,1);
  await call('/api/workbench/'+canvasId+'/run','POST',{limit:2},400);
  await call('/api/images','POST',{canvasId,prompt:'重复提交测试'},409);
  await call('/api/workbench/'+canvasId+'/run','PUT',{action:'pause'});
  run=(await until(()=>call('/api/workbench/'+canvasId+'/run'),x=>x.run.steps.find(s=>s.nodeId==='ref').state==='done')).run;
  assert.equal(run.status,'paused');assert.equal(requests.filter(r=>r.url.startsWith('/v1/images/')).length,1);
  // A stale browser save cannot erase the running/completed reference result.
  await call('/api/projects/canvases/'+canvasId,'PATCH',{document});
  let saved=(await call('/api/projects/canvases/'+canvasId)).canvas.document;assert.ok(saved.nodes.find(n=>n.id==='ref').mediaUrl);
  await call('/api/workbench/'+canvasId+'/run','PUT',{action:'resume'});
  // Switching defaults only affects new flows, not these already bound steps.
  await call('/api/models/defaults','PUT',{image:'muse',video:'muse'});
  await until(()=>call('/api/workbench/'+canvasId+'/run'),v=>v.run.steps.some(s=>s.type==='video'&&s.jobId));
  await until(()=>call('/api/jobs?canvasId='+canvasId),v=>v.jobs.some(j=>j.upstreamId==='external:polling'));
  const oldPid=server.pid;server.kill();await once(server,'exit');await boot();assert.notEqual(oldPid,server.pid);
  run=(await until(()=>call('/api/workbench/'+canvasId+'/run'),v=>v.run.status==='completed')).run;
  assert.equal(run.steps.filter(s=>s.state==='done').length,5);assert.equal(taskSeq,2,'restart must not duplicate video submission');assert.equal(maxImage,1,'external provider concurrency cap');
  assert.equal(requests.filter(r=>r.url==='/v1/images/edits').length,2);
  assert.ok(requests.filter(r=>r.url==='/v1/images/edits').every(r=>r.contentType.startsWith('multipart/form-data;')&&r.body.includes('reference-0')));
  saved=(await call('/api/projects/canvases/'+canvasId)).canvas.document;assert.ok(saved.nodes.every(n=>n.mediaUrl));
  const firstRefDone=requests.findIndex(r=>r.url==='/v1/images/edits');assert.ok(firstRefDone>requests.findIndex(r=>r.url==='/v1/images/generations'));
  const secretPublic=JSON.stringify(await call('/api/models/config'));assert.ok(!secretPublic.includes('fixture-provider-key'));
  await call('/api/models/defaults','PUT',{image:image.id,video:video.id});
  // Failed reference blocks only its dependent branch; independent work completes.
  const failing={nodes:[node('bad','image','FAIL_BRANCH'),node('blocked','video','依赖视频'),node('good','image','独立分支')],links:[{from:'bad',to:'blocked'}]};
  await call('/api/projects/canvases/'+canvasId,'PATCH',{document:failing});
  await call('/api/workbench/'+canvasId+'/run','POST',{limit:2});
  run=(await until(()=>call('/api/workbench/'+canvasId+'/run'),v=>v.run.status==='failed')).run;
  assert.equal(run.steps.find(s=>s.nodeId==='blocked').state,'blocked');assert.equal(run.steps.find(s=>s.nodeId==='good').state,'done');
  const cyclic={nodes:[node('a','image','图片甲'),node('b','image','图片乙')],links:[{from:'a',to:'b'},{from:'b',to:'a'}]};
  await call('/api/projects/canvases/'+canvasId,'PATCH',{document:cyclic});await call('/api/workbench/'+canvasId+'/run','POST',{},400);
  // Stop prevents downstream tasks; submitted work still finishes safely.
  await call('/api/projects/canvases/'+canvasId,'PATCH',{document});
  await call('/api/workbench/'+canvasId+'/run','POST',{limit:1});await call('/api/workbench/'+canvasId+'/run','PUT',{action:'stop'});
  run=(await until(()=>call('/api/workbench/'+canvasId+'/run'),x=>x.run.steps.find(s=>s.nodeId==='ref').state==='done')).run;assert.equal(run.status,'stopped');assert.equal(run.steps.filter(s=>s.state==='cancelled').length,4);
  const openaiConfig=await call('/api/models','POST',{kind:'video',protocol:'video-openai',name:'OpenAI 视频测试',model:'video-test',baseUrl:remote,apiKey:'fixture-provider-key',maxReferences:1});
  const openai=openaiConfig.providers.find(p=>p.name==='OpenAI 视频测试');
  await call('/api/models/defaults','PUT',{video:openai.id});
  const refUrl=run.steps.find(s=>s.nodeId==='ref').mediaUrl;
  const job=(await call('/api/videos','POST',{canvasId,prompt:'参考图视频测试',images:[refUrl],duration:5})).job;
  assert.equal(job.params.duration,4);
  const final=await until(()=>call('/api/jobs/'+job.id),x=>['failed','completed'].includes(x.job.status));assert.equal(final.job.status,'completed',final.job.error);
  const multipart=requests.filter(r=>r.url==='/v1/videos'&&r.contentType.startsWith('multipart/')).at(-1);
  assert.ok(multipart.body.includes('input_reference'));assert.ok(multipart.body.includes('name="seconds"'));
  // Browser coverage: configure a model, select it, and execute a canvas workflow.
  const profile=path.join(dir,'chrome');
  chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-proxy-server','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
  const marker=path.join(profile,'DevToolsActivePort');await until(async()=>fs.existsSync(marker),Boolean,10000);
  const debugPort=fs.readFileSync(marker,'utf8').split('\n')[0],pages=await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();
  const ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await once(ws,'open');
  let seq=0;const pending=new Map(),errors=[];
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  browserSend=send;
  const js=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
  const visible=expression=>until(()=>js(expression),Boolean,12000);
  const click=label=>js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);
  const fill=(label,value)=>js(`(()=>{const e=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:origin+'/settings'});await visible(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='模型配置')`);await click('模型配置');
  await visible(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='添加语言模型')`);await click('添加语言模型');
  await visible(`!!document.querySelector('input[aria-label="显示名称"]')`);
  await fill('显示名称','UI 语言测试');await fill('Base URL',remote);await fill('模型 ID','chat-test');await fill('API Key','fixture-provider-key');await click('保存模型');
  await visible(`document.body.innerText.includes('UI 语言测试')&&!document.querySelector('input[aria-label="显示名称"]')`);
  const uiModel=(await call('/api/models/config')).providers.find(p=>p.name==='UI 语言测试');assert.ok(uiModel);
  await js(`(()=>{const e=document.querySelector('select[aria-label="默认语言模型"]');e.value=${JSON.stringify(uiModel.id)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(()=>call('/api/models'),c=>c.defaults.chat===uiModel.id);
  const artifacts=path.resolve('data');fs.mkdirSync(artifacts,{recursive:true});
  fs.writeFileSync(path.join(artifacts,'models-settings-verified.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  const uiCanvas=(await call('/api/projects/'+scratch.id+'/canvases','POST',{name:'一键流程界面验证'},201)).canvas;
  const uiDoc={nodes:[node('ui_ref','image','参考图片'),node('ui_shot','image','镜头图片')],links:[{from:'ui_ref',to:'ui_shot'}]};
  await call('/api/projects/canvases/'+uiCanvas.id,'PATCH',{document:uiDoc});
  await send('Page.navigate',{url:origin+'/canvas/'+uiCanvas.id});await visible(`!!document.querySelector('button[aria-label="一键生成"]')`);
  await visible(`!!document.querySelector('.mf-model')&&document.querySelector('.mf-model').textContent.includes('image test')`);
  await js(`document.querySelector('button[aria-label="一键生成"]').click()`);
  await visible(`!!document.querySelector('button[aria-label="暂停流程"]')`);
  await js(`document.querySelector('button[aria-label="暂停流程"]').click()`);
  await visible(`!!document.querySelector('button[aria-label="继续流程"]')`);
  await js(`document.querySelector('button[aria-label="继续流程"]').click()`);
  await visible(`document.body.innerText.includes('流程完成')`);
  fs.writeFileSync(path.join(artifacts,'workflow-ui-verified.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  assert.equal(errors.length,0,errors.join('\n'));const chromeExit=once(chrome,'exit');await send('Browser.close');await chromeExit;ws.close();chrome=null;
  console.log('PASS model configuration, language routing, multipart references, dependency scheduling, concurrency, pause/resume/stop, failure isolation, restart without duplicate submissions, secret redaction');
}finally{
  if(chrome){const exited=once(chrome,'exit');try{await Promise.race([browserSend?.('Browser.close'),wait(1000)]);}catch{}await Promise.race([exited,wait(2000)]);if(chrome.exitCode===null)chrome.kill();}
  if(server&&server.exitCode===null){server.kill();await once(server,'exit');}
  mock.closeAllConnections();await new Promise(r=>mock.close(r));
  try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});}catch{console.warn('Temporary browser profile remains locked; cleanup skipped.');}
}
