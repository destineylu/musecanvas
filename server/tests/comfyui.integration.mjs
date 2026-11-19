import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'muse-comfy-')),secret=randomBytes(24).toString('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9kAAAAASUVORK5CYII=','base64'),mp4=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom00000000')]);
const jobs=new Map(),requests=[];let seq=0,maxActive=0,server,token,chrome,browserSend;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const mock=http.createServer(async(req,res)=>{
 const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks).toString();requests.push({path:req.url,body});
 const json=x=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(x));};
 if(req.url==='/system_stats')return json({system:{comfyui_version:'test'},devices:[]});
 if(req.url.startsWith('/object_info/')){const name=decodeURIComponent(req.url.split('/').at(-1));return json(name==='MissingNode'?{}:{[name]:{input:{required:{}}}});}
 if(req.url==='/upload/image')return json({name:'reference.png',subfolder:'musecanvas',type:'input'});
 if(req.url==='/prompt'){
  const data=JSON.parse(body),id='prompt-'+(++seq),video=data.prompt['4'].class_type==='SaveVideo';
  jobs.set(id,{video,polls:0,done:false,prompt:data.prompt});maxActive=Math.max(maxActive,[...jobs.values()].filter(j=>!j.done).length);
  return json({prompt_id:id,number:seq,node_errors:{}});
 }
 if(req.url.startsWith('/history/')){
  const id=decodeURIComponent(req.url.split('/').at(-1)),j=jobs.get(id);if(!j)return json({});
  j.polls++;if(j.polls<3)return json({});
  j.done=true;
  if(j.prompt['1'].inputs.text==='FAIL')return json({[id]:{status:{status_str:'error',completed:false,messages:[['execution_error',{node_type:'KSampler'}]]}}});
  return json({[id]:{status:{completed:true,status_str:'success'},outputs:{'4':{[j.video?'gifs':'images']:[{filename:j.video?'out.mp4':'out.png',subfolder:'musecanvas',type:'output'}]}}}});
 }
 if(req.url==='/queue')return json({queue_running:[...jobs.entries()].filter(([,j])=>!j.done).map(([id])=>[0,id]),queue_pending:[]});
 if(req.url.startsWith('/view?')){res.setHeader('Content-Type',req.url.includes('mp4')?'video/mp4':'image/png');return res.end(req.url.includes('mp4')?mp4:png);}
 res.statusCode=404;json({error:'missing'});
}).listen(0,'127.0.0.1');await once(mock,'listening');
const reserve=http.createServer().listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const origin='http://127.0.0.1:'+port,remote='http://127.0.0.1:'+mock.address().port;
async function until(work,pred,timeout=30000){const start=Date.now();let v;while(Date.now()-start<timeout){v=await work();if(pred(v))return v;await wait(200);}throw Error('timeout: '+JSON.stringify(v));}
async function boot(){server=spawn(process.execPath,['src/index.js'],{env:{...process.env,DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',JWT_SECRET:secret,ADMIN_EMAIL:'comfy@example.test',ADMIN_PASSWORD:secret,MUA_UPSTREAM:'bridge'},windowsHide:true,stdio:['ignore','ignore','inherit']});await until(async()=>{try{return(await fetch(origin+'/api/health')).ok;}catch{return false;}},Boolean);}
async function call(route,method='GET',body,status=200){const r=await fetch(origin+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();assert.equal(r.status,status,JSON.stringify(d));return d;}
const config=video=>({workflow:{'1':{class_type:'CLIPTextEncode',inputs:{text:'positive'}},'2':{class_type:'EmptyLatentImage',inputs:{width:512,height:512}},'3':{class_type:'LoadImage',inputs:{image:'old.png'}},'4':{class_type:video?'SaveVideo':'SaveImage',inputs:{filename_prefix:'musecanvas'}}},bindings:[{source:'prompt',nodeId:'1',input:'text'},{source:'width',nodeId:'2',input:'width'},{source:'height',nodeId:'2',input:'height'},...(video?[{source:'image',nodeId:'3',input:'image'}]:[])],outputNode:'4',width:512,height:512});
try{
 await boot();token=(await call('/api/auth/local-session','POST',{})).token;
 const add=async video=>{const c=await call('/api/models','POST',{kind:video?'video':'image',protocol:'comfyui',name:video?'本地视频':'本地图片',model:'workflow',baseUrl:remote,maxConcurrency:4,comfy:config(video)});return c.providers.find(p=>p.kind===(video?'video':'image'));};
 const image=await add(false),video=await add(true);assert.equal(image.maxConcurrency,1);assert.equal(video.maxReferences,1);
 await call('/api/models/defaults','PUT',{image:image.id,video:video.id});
 assert.ok((await call('/api/models/'+image.id+'/test','POST',{})).ok);
 const missing=config(false);missing.workflow['1'].class_type='MissingNode';
 const c=await call('/api/models','POST',{kind:'image',protocol:'comfyui',name:'缺失测试',model:'bad',baseUrl:remote,comfy:missing});await call('/api/models/'+c.providers.find(p=>p.name==='缺失测试').id+'/test','POST',{},502);
 const scratch=(await call('/api/projects/scratch')).project,canvasId=scratch.canvases[0].id;
 await call('/api/videos','POST',{canvasId,prompt:'无参考图'},400);
 const doc={nodes:[{id:'i',type:'image',intent:'generate',label:'角色',text:'garden cat',size:'16:9',x:100,y:140},{id:'v',type:'video',intent:'generate',label:'镜头',text:'cat walking',size:'16:9',duration:5,x:550,y:140}],links:[{from:'i',to:'v'}]};
 await call('/api/projects/canvases/'+canvasId,'PATCH',{document:doc});await call('/api/workbench/'+canvasId+'/run','POST',{limit:3});
 await until(()=>call('/api/workbench/'+canvasId+'/run'),x=>x.run.steps.find(s=>s.nodeId==='v').jobId);
 await until(()=>call('/api/jobs?canvasId='+canvasId),x=>x.jobs.some(j=>j.type==='video'&&j.upstreamId==='external:polling'));
 server.kill();await once(server,'exit');await boot();
 const run=(await until(()=>call('/api/workbench/'+canvasId+'/run'),x=>x.run.status==='completed')).run;
 assert.equal(seq,2,'must resume prompt, not resubmit');assert.equal(run.steps.filter(s=>s.mediaUrl).length,2);
 assert.equal([...jobs.values()].find(j=>j.video).prompt['3'].inputs.image,'musecanvas/reference.png');
 assert.equal([...jobs.values()][0].prompt['1'].inputs.text,'garden cat');assert.ok([...jobs.values()][0].prompt['2'].inputs.width>[...jobs.values()][0].prompt['2'].inputs.height);
 const ref=run.steps.find(s=>s.nodeId==='i').mediaUrl;
 // Separate configured image/video providers still share one ComfyUI instance slot.
 const ji=(await call('/api/images','POST',{prompt:'another cat',images:[]})).job;
 const jv=(await call('/api/videos','POST',{prompt:'another video',images:[ref]})).job;
 await until(()=>call('/api/jobs/'+ji.id),x=>x.job.status==='completed');await until(()=>call('/api/jobs/'+jv.id),x=>x.job.status==='completed');assert.equal(maxActive,1);
 const jf=(await call('/api/images','POST',{prompt:'FAIL'})).job;assert.equal((await until(()=>call('/api/jobs/'+jf.id),x=>['completed','failed'].includes(x.job.status))).job.status,'failed');
 // UI file import, binding selection, save, default selection and canvas display.
 const profile=path.join(dir,'chrome');chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-proxy-server','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
 const marker=path.join(profile,'DevToolsActivePort');await until(()=>fs.existsSync(marker),Boolean);const debug=fs.readFileSync(marker,'utf8').split('\n')[0];
 const pages=await(await fetch('http://127.0.0.1:'+debug+'/json/list')).json();const ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await once(ws,'open');
 let sequence=0;const pending=new Map(),errors=[];
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});browserSend=send;
 const js=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
 const visible=exp=>until(()=>js(exp),Boolean,12000),click=label=>js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);
 const fill=(label,value)=>js(`(()=>{const e=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await send('Page.navigate',{url:origin+'/settings'});await visible(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='模型配置')`);await click('模型配置');await visible(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='添加图片模型')`);await click('添加图片模型');
 await js(`(()=>{const e=document.querySelector('select[aria-label="接口协议"]');e.value='comfyui';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await visible(`!!document.querySelector('[aria-label="ComfyUI 工作流配置"]')`);
 const workflowFile=path.join(dir,'api-workflow.json');fs.writeFileSync(workflowFile,JSON.stringify(config(false).workflow));
 const root=await send('DOM.getDocument');const input=await send('DOM.querySelector',{nodeId:root.root.nodeId,selector:'input[type="file"][accept=".json,application/json"]'});await send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[workflowFile]});
 await visible(`document.body.innerText.includes('已载入 4 个节点')`);
 await fill('显示名称','界面导入测试');await fill('Base URL',remote);
 await click('保存模型');await visible(`!document.querySelector('[aria-label="ComfyUI 工作流配置"]')&&document.body.innerText.includes('界面导入测试')`);
 const imported=(await call('/api/models/config')).providers.find(p=>p.name==='界面导入测试');assert.ok(imported.comfy.bindings.some(b=>b.source==='prompt'));
 await js(`(()=>{const e=document.querySelector('select[aria-label="默认图片模型"]');e.value=${JSON.stringify(imported.id)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await until(()=>call('/api/models'),c=>c.defaults.image===imported.id);
 const artifacts=path.resolve('data');fs.mkdirSync(artifacts,{recursive:true});fs.writeFileSync(path.join(artifacts,'comfy-settings-verified.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
 assert.equal(errors.length,0,errors.join('\n'));const exited=once(chrome,'exit');await send('Browser.close');await exited;chrome=null;ws.close();
 console.log('PASS ComfyUI upload, prompt binding, image/video history outputs, same-instance serialization, persistent prompt restart, validation errors, browser import/save/default selection');
}finally{
 if(chrome){const exited=once(chrome,'exit');try{await Promise.race([browserSend?.('Browser.close'),wait(1000)]);}catch{}await Promise.race([exited,wait(2000)]);if(chrome.exitCode===null)chrome.kill();}
 if(server&&server.exitCode===null){server.kill();await once(server,'exit');}mock.closeAllConnections();await new Promise(r=>mock.close(r));
 try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});}catch{console.warn('Temporary browser profile remains locked');}
}
