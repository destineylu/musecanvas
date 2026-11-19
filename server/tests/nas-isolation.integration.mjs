import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { spawn,execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
const root=path.resolve('..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'muse-nas-')),instances=[],png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9kAAAAASUVORK5CYII=','base64');
let chrome,browserSend;const wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(work,pred,timeout=20000)=>{const start=Date.now();let v;while(Date.now()-start<timeout){v=await work();if(pred(v))return v;await wait(150);}throw Error('timeout: '+JSON.stringify(v));};
async function make(name){
 const key=randomBytes(32).toString('hex'),secret=randomBytes(32).toString('hex'),password=randomBytes(16).toString('hex'),email=name+'@example.test',calls=[];
 const remote=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;calls.push({route:req.url,body,key:req.headers.authorization});
 const json=x=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(x));};
 if(req.url==='/healthz')return json({ok:true});
 if(req.headers.authorization!=='Bearer '+key){res.statusCode=401;return json({error:'bad key'});}
 if(req.url==='/admin/accounts')return json({accounts:[{id:name+'-muse',label:name+' private Muse',ok:true,generation_enabled:true}]});
 if(req.url==='/admin/scheduler')return json({max_concurrency:1});
 if(req.url==='/v1/models')return json({data:[{id:name+'-model'}]});
 if(req.url==='/v1/images/tasks'&&req.method==='POST')return json({id:name+'-task',status:'queued'});
 if(req.url==='/v1/images/tasks/'+name+'-task')return json({id:name+'-task',status:'completed',url:'/v1/media/result.png'});
 if(req.url==='/v1/media/result.png'){res.setHeader('Content-Type','image/png');return res.end(png);}
 json({ok:true});}).listen(0,'127.0.0.1');await once(remote,'listening');
 const reserve=http.createServer().listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const dataDir=path.join(dir,name);fs.mkdirSync(dataDir);
 const child=spawn(process.execPath,['src/index.js'],{env:{...process.env,ACCESS_MODE:'account',DATA_DIR:dataDir,JWT_SECRET:secret,ADMIN_EMAIL:email,ADMIN_PASSWORD:password,HOST:'127.0.0.1',PORT:String(port),MUSECANVAS_UPSTREAM:'muse2api',MUSE_BASE:'http://127.0.0.1:'+remote.address().port,MUSE_KEY:key,PUBLIC_BASE:'',COOKIE_SECURE:'0'},windowsHide:true,stdio:['ignore','ignore','inherit']});
 const instance={name,email,password,key,secret,child,remote,calls,base:'http://127.0.0.1:'+port,dataDir};instances.push(instance);
 await until(async()=>{try{return(await fetch(instance.base+'/api/health')).ok;}catch{return false;}},Boolean);
 return instance;
}
async function call(i,route,{method='GET',body,token=i.token,cookie,origin,status=200}={}){
 const res=await fetch(i.base+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(cookie?{Cookie:cookie}:{}),...(origin?{Origin:origin}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 const raw=await res.text();let data;try{data=JSON.parse(raw);}catch{data=raw;}
 assert.equal(res.status,status,typeof data==='object'?JSON.stringify(data):raw.slice(0,100));return {data,res};
}
try{
 const a=await make('alice'),b=await make('bob');
 for(const i of [a,b]){
  assert.equal((await call(i,'/api/auth/mode')).data.mode,'account');
  await call(i,'/api/auth/local-session',{method:'POST',body:{},status:403});
  await call(i,'/api/projects',{status:401});
  await call(i,'/api/auth/login',{method:'POST',body:{email:i.email,password:i.password},origin:'https://evil.test',status:403});
  const login=await call(i,'/api/auth/login',{method:'POST',body:{email:i.email,password:i.password}});i.token=login.data.token;i.userId=login.data.user.id;i.cookie=login.res.headers.get('set-cookie').split(';')[0];
  assert.match(login.res.headers.get('set-cookie'),/HttpOnly/);assert.match(login.res.headers.get('set-cookie'),/SameSite=Strict/);
  await call(i,'/api/auth/me',{token:jwt.sign({sub:i.userId,local:true},i.secret),status:401});
 }
 assert.notEqual(a.cookie.split('=')[0],b.cookie.split('=')[0]);
 await call(a,'/api/auth/login',{method:'POST',token:null,body:{email:b.email,password:b.password},status:401});
 await call(b,'/api/auth/me',{token:a.token,status:401});await call(b,'/api/auth/me',{token:null,cookie:a.cookie,status:401});
 const apiKey=(await call(a,'/api/keys',{method:'POST',body:{name:'isolation test'}})).data.key;
 await call(b,'/v1/models',{token:apiKey,status:401});assert.equal((await call(a,'/v1/models',{token:apiKey})).data.data[0].id,'alice-model');
 const aa=(await call(a,'/api/accounts')).data.accounts,bb=(await call(b,'/api/accounts')).data.accounts;
 assert.ok(aa.every(x=>x.label.startsWith('alice')));assert.ok(bb.every(x=>x.label.startsWith('bob')));
 await call(a,'/api/models',{method:'POST',body:{kind:'chat',protocol:'chat',name:'Alice model',model:'alice-model',baseUrl:a.base,apiKey:'alice-private-fixture'}});
 assert.equal((await call(b,'/api/models/config')).data.providers.length,0);
 const scratch=(await call(a,'/api/projects/scratch')).data.project,canvasId=scratch.canvases[0].id;
 await call(b,'/api/projects/canvases/'+canvasId,{status:404});
 const job=(await call(a,'/api/images',{method:'POST',body:{canvasId,prompt:'Alice own generation'}})).data.job;
 const done=(await until(()=>call(a,'/api/jobs/'+job.id),x=>x.data.job.status==='completed')).data.job;
 assert.ok(a.calls.some(c=>c.route==='/v1/images/tasks'&&c.body.includes('Alice own generation')));assert.ok(!b.calls.some(c=>c.route==='/v1/images/tasks'));
 assert.ok(a.calls.filter(c=>c.route!=='/healthz').every(c=>c.key==='Bearer '+a.key));
 await call(b,'/api/jobs/'+job.id,{status:404}); // Other instance has no task row.
 await call(a,done.mediaUrl,{token:null,status:401});await call(a,done.mediaUrl,{token:b.token,status:401});await call(a,done.mediaUrl,{token:null,cookie:a.cookie});
 const media=await fetch(a.base+done.mediaUrl,{headers:{Cookie:a.cookie}});assert.match(media.headers.get('cache-control'),/no-store/);assert.equal(Buffer.compare(Buffer.from(await media.arrayBuffer()),png),0);
 await call(b,done.mediaUrl,{status:404});
 const form=new FormData();form.append('files',new Blob([png],{type:'image/png'}),'test.png');const upload=await(await fetch(a.base+'/api/upload',{method:'POST',headers:{Authorization:'Bearer '+a.token},body:form})).json();
 await call(a,upload.files[0].url,{token:null,status:401});await call(a,upload.files[0].url,{token:null,cookie:a.cookie});await call(b,upload.files[0].url,{status:404});
 const logout=await call(a,'/api/auth/logout',{method:'POST',token:null,cookie:a.cookie,body:{}});assert.match(logout.res.headers.get('set-cookie'),/Expires=Thu, 01 Jan 1970/);
 const replacement=randomBytes(20).toString('hex');
 await call(b,'/api/auth/me',{method:'PATCH',body:{oldPassword:b.password,password:replacement}});
 await call(b,'/api/auth/login',{method:'POST',token:null,body:{email:b.email,password:b.password},status:401});
 await call(b,'/api/auth/login',{method:'POST',token:null,body:{email:b.email,password:replacement}});b.password=replacement;
 // Deployment manifests: unique project/network scopes, keys and no published muse2api ports.
 for(const name of ['alice','bob'])execFileSync(process.execPath,[path.join(root,'deploy/nas/create-instance.mjs'),'--name',name,'--email',name+'@example.test','--port',name==='alice'?'18781':'18782','--output',path.join(dir,'manifest-'+name)],{stdio:'pipe'});
 const ma=path.join(dir,'manifest-alice'),mb=path.join(dir,'manifest-bob');assert.notEqual(fs.readFileSync(path.join(ma,'.env'),'utf8'),fs.readFileSync(path.join(mb,'.env'),'utf8'));
 for(const folder of [ma,mb]){
  const manifest=JSON.parse(execFileSync('docker',['compose','--project-directory',folder,'-f',path.join(folder,'compose.yml'),'config','--format','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  assert.equal(manifest.services.app.environment.ACCESS_MODE,'account');assert.equal(manifest.services.muse2api,undefined);assert.equal(manifest.services.app.environment.EMBEDDED_ENGINE,'1');assert.ok(manifest.services.app.environment.MUSE_KEY);assert.equal(manifest.services.app.environment.MUSE_BASE,'http://127.0.0.1:18610');
 }
 assert.throws(()=>execFileSync(process.execPath,[path.join(root,'deploy/nas/create-instance.mjs'),'--name','alice','--email','alice@example.test','--output',ma],{stdio:'pipe'}));
 // Browser: account login, reload via private cookie, logout and inaccessible media.
 const profile=path.join(dir,'chrome');chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-proxy-server','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
 const marker=path.join(profile,'DevToolsActivePort');await until(()=>fs.existsSync(marker),Boolean);const debug=fs.readFileSync(marker,'utf8').split('\n')[0],pages=await(await fetch('http://127.0.0.1:'+debug+'/json/list')).json();const ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await once(ws,'open');
 let seq=0;const pending=new Map(),errors=[];ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});browserSend=send;
 const js=async expression=>(await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
 const visible=exp=>until(()=>js(exp),Boolean,15000);
 await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1200,height:850,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:a.base+'/projects'});
 await visible(`!!document.querySelector('input[aria-label="工作区账号"]')`);
 const fill=(label,value)=>js(`(()=>{const e=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await fill('工作区账号',a.email);await fill('登录密码',a.password);await js(`document.querySelector('button[type="submit"]').click()`);
 await visible(`!!document.querySelector('button[aria-label="退出登录"]')`);
 await send('Page.reload');await visible(`!!document.querySelector('button[aria-label="退出登录"]')`);
 assert.equal(await js(`(async()=>{const r=await fetch(${JSON.stringify(done.mediaUrl)});return r.status;})()`),200);
 await js(`document.querySelector('button[aria-label="退出登录"]').click()`);await visible(`!!document.querySelector('input[aria-label="工作区账号"]')`);
 assert.equal(await js(`(async()=>{const r=await fetch(${JSON.stringify(done.mediaUrl)});return r.status;})()`),401);assert.equal(errors.length,0,errors.join('\n'));
 await send('Page.navigate',{url:b.base+'/projects'});await visible(`!!document.querySelector('input[aria-label="工作区账号"]')`);
 const exited=once(chrome,'exit');await send('Browser.close');await exited;chrome=null;ws.close();
 // Reusing an existing database for a different owner must fail before listening.
 b.child.kill();await once(b.child,'exit');
 const wrong=spawn(process.execPath,['src/index.js'],{env:{...process.env,ACCESS_MODE:'account',DATA_DIR:b.dataDir,JWT_SECRET:b.secret,ADMIN_EMAIL:'charlie@example.test',ADMIN_PASSWORD:b.password,HOST:'127.0.0.1',PORT:'0'},windowsHide:true,stdio:['ignore','ignore','pipe']});
 let wrongError='';wrong.stderr.on('data',c=>wrongError+=c);const [exitCode]=await once(wrong,'exit');assert.notEqual(exitCode,0);assert.match(wrongError,/独立的新数据卷/);
 console.log('PASS two isolated workspaces: owner-only login, cookies, logout, password change, media privacy, upstream account/task isolation, config separation, cross-token/key rejection, mixed-owner database rejection, Compose manifests, browser login/reload/logout');
}finally{
 if(chrome){const exited=once(chrome,'exit');try{await Promise.race([browserSend?.('Browser.close'),wait(1000)]);}catch{}await Promise.race([exited,wait(2000)]);if(chrome.exitCode===null)chrome.kill();}
 for(const i of instances){if(i.child.exitCode===null&&i.child.signalCode===null){i.child.kill();await once(i.child,'exit');}i.remote.closeAllConnections();await new Promise(r=>i.remote.close(r));}
 try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});}catch{console.warn('Temporary browser profile remains locked');}
}
