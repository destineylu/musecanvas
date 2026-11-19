import jwt from 'jsonwebtoken';import bcrypt from 'bcryptjs';import {DatabaseSync} from 'node:sqlite';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import {spawn} from 'node:child_process';import {once} from 'node:events';import {randomBytes} from 'node:crypto';import assert from 'node:assert/strict';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'museflow-screen-'));
const secret=randomBytes(24).toString('hex');
const mockPlan={title:'花园小猫短片',nodes:[{id:'prompt',type:'text',text:'小猫在花园中散步',label:'镜头提示词'},{id:'image',type:'image',text:'花园中橘猫',label:'镜头图片',mediaUrl:'https://not-allowed.example'},{id:'video',type:'video',text:'小猫向镜头走来',label:'镜头视频',duration:5,size:'16:9'}],links:[{from:'prompt',to:'image'},{from:'image',to:'video'}],storyboard:[{title:'镜头1',action:'小猫向镜头走来',scene:'花园',duration:5,ratio:'16:9'}]};
const mock=http.createServer(async(req,res)=>{
 for await(const c of req){}
 if(req.url==='/v1/chat/completions')return res.setHeader('Content-Type','application/json').end(JSON.stringify({choices:[{index:0,message:{role:'assistant',content:JSON.stringify(mockPlan)},finish_reason:'stop'}]}));
 if(req.url==='/v1/models')return res.end('{"data":[{"id":"muse"}]}');
 res.end('{"status":"ok"}');
}).listen(0,'127.0.0.1');await once(mock,'listening');
const remote='http://127.0.0.1:'+mock.address().port;
fs.writeFileSync(path.join(dir,'bridges.json'),JSON.stringify({bridges:[{id:'test',name:'测试节点',baseUrl:remote+'/v1',fileBaseUrl:remote,token:'private-test-key',enabled:true,maxConcurrency:1}]}));
const server=spawn(process.execPath,['src/index.js'],{env:{...process.env,DATA_DIR:dir,PORT:'18772',HOST:'127.0.0.1',JWT_SECRET:secret,MUSECANVAS_UPSTREAM:'bridge',ADMIN_EMAIL:'admin@example.test',ADMIN_PASSWORD:secret},stdio:['ignore','ignore','inherit']});
const origin='http://127.0.0.1:18772';const wait=ms=>new Promise(r=>setTimeout(r,ms));
let chrome;
try{
 for(let i=0;i<40;i++){try{if((await fetch(origin+'/api/health')).ok)break;}catch{}await wait(150);}

 const db=new DatabaseSync(path.join(dir,'studio.db'));const id='u_existing';const stamp=Date.now();
 db.prepare('INSERT INTO users(id,email,password_hash,name,role,credits,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,'existing@example.test',bcrypt.hashSync(secret,4),'Existing workspace','user',100,'active',stamp);
 db.prepare('INSERT INTO projects(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run('p_existing',id,'Retained project',stamp,stamp);db.prepare('INSERT INTO canvases(id,project_id,user_id,name,document_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('c_workbench','p_existing',id,'工作台测试',JSON.stringify({nodes:[{id:'original',type:'text',label:'原有文本',text:'保留的原始内容',x:200,y:200}],links:[],view:{x:0,y:0,z:1}}),stamp,stamp);db.prepare('INSERT INTO users(id,email,password_hash,role,status,created_at) VALUES(?,?,?,?,?,?)').run('u_other','other@example.test',bcrypt.hashSync(secret,4),'user','active',stamp);db.close();
 const oldToken=jwt.sign({sub:id,role:'user'},secret,{expiresIn:'5m'});
 const local=await fetch(origin+'/api/auth/local-session',{method:'POST',headers:{Authorization:'Bearer '+oldToken,'Content-Type':'application/json'},body:'{}'});assert.equal(local.status,200);const session=await local.json();assert.equal(session.user.id,id);assert.equal(session.user.role,'admin');
 const token=session.token,headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
 const again=await(await fetch(origin+'/api/auth/local-session',{method:'POST'})).json();assert.equal(again.user.id,id);
 const foreign=await fetch(origin+'/api/auth/local-session',{method:'POST',headers:{Origin:'https://evil.example'}});assert.equal(foreign.status,403);
 const rebound=await new Promise(resolve=>{const r=http.request(origin+'/api/auth/local-session',{method:'POST',headers:{Host:'evil.example'}},response=>{response.resume();resolve(response.statusCode)});r.end();});assert.equal(rebound,403);
 const stolen=await fetch(origin+'/api/bridges',{headers:{...headers,Origin:'https://evil.example'}});assert.equal(stolen.status,403);
 const signup=await fetch(origin+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'new@example.test',password:secret})});assert.equal(signup.status,410);
 const projects=await(await fetch(origin+'/api/projects',{headers})).json();assert.ok(JSON.stringify(projects).includes('Retained project'));
 const state=await fetch(origin+'/api/bridges',{headers});assert.equal(state.status,200);

 const call=async(route,method='GET',body)=>{const r=await fetch(origin+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(r.status+' '+JSON.stringify(data));return data;};
 const form=new FormData();form.append('files',new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9kAAAAASUVORK5CYII=','base64')],{type:'image/png'}),'test.png');
 const uploaded=await(await fetch(origin+'/api/upload',{method:'POST',headers:{Authorization:headers.Authorization},body:form})).json();assert.equal(uploaded.files.length,1);const assetUrl=uploaded.files[0].url;
 let lib=await call('/api/library');assert.equal(lib.items.length,1);await call('/api/library/item','PUT',{url:assetUrl,name:'花园角色参考',tags:'橘猫 花园',favorite:true});assert.equal((await call('/api/library?q='+encodeURIComponent('橘猫')+'&favorite=1')).total,1);
 const otherHeaders={Authorization:'Bearer '+jwt.sign({sub:'u_other',role:'user'},secret), 'Content-Type':'application/json'};
 assert.equal((await(await fetch(origin+'/api/library',{headers:otherHeaders})).json()).total,0);
 for(const route of ['/api/workbench/c_workbench/versions','/api/workbench/c_workbench/generations'])assert.equal((await fetch(origin+route,{headers:otherHeaders})).status,404);
 assert.equal((await fetch(origin+'/api/library/item',{method:'PUT',headers:otherHeaders,body:JSON.stringify({url:assetUrl,favorite:true})})).status,404);
 await call('/api/workbench/c_workbench/versions','POST',{label:'初始版本'});
 let versions=(await call('/api/workbench/c_workbench/versions')).versions;assert.equal(versions.length,1);
 const original=(await call('/api/workbench/c_workbench/versions/'+versions[0].id)).version.document;assert.equal(original.nodes[0].text,'保留的原始内容');
 const plan=(await call('/api/workbench/c_workbench/plan','POST',{prompt:'给我规划花园小猫的三个节点和分镜'})).plan;assert.equal(plan.nodes.length,3);assert.equal(plan.links.length,2);assert.equal(plan.storyboard.length,1);assert(!('mediaUrl' in plan.nodes[1]));
 const updated={...original,storyboard:[{id:'initial_shot',title:'已有镜头',action:'猫转身',duration:5,ratio:'16:9'}]};await call('/api/projects/canvases/c_workbench','PATCH',{document:updated});assert.equal((await call('/api/projects/canvases/c_workbench')).canvas.document.storyboard.length,1);
 console.log('PASS: library upload/search/favorites/tags, ownership isolation, snapshots, storyboard persistence, validated AI plan');

 fs.mkdirSync(path.join(dir,'media'),{recursive:true});fs.writeFileSync(path.join(dir,'media','history.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9kAAAAASUVORK5CYII=','base64'));
 const seedDb=new DatabaseSync(path.join(dir,'studio.db'));seedDb.prepare('INSERT INTO jobs(id,user_id,type,prompt,params,upstream_id,status,media_file,canvas_id,project_id,created_at,updated_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('job_history',id,'image','历史橘猫参考图',JSON.stringify({sourceNodeId:'former_node',size:'16:9'}),'bridge:download','completed','history.png','c_workbench','p_existing',stamp,stamp,stamp);seedDb.close();
 assert.equal((await call('/api/library')).items.length,2);assert.equal((await call('/api/workbench/c_workbench/generations')).jobs[0].id,'job_history');
 const profile=path.join(dir,'chrome');
 chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-proxy-server','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
 const marker=path.join(profile,'DevToolsActivePort');for(let i=0;i<50&&!fs.existsSync(marker);i++)await wait(150);
 const port=fs.readFileSync(marker,'utf8').split('\n')[0];const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
 const ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 let seq=0;const pending=new Map(),errors=[];
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description);if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 const js=async expression=>(await send('Runtime.evaluate',{expression,returnByValue:true})).result.value;
 const until=async expression=>{for(let i=0;i<60;i++){if(await js(expression))return;await wait(150);}throw Error(expression);};
 const click=async text=>{await js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(text)+').click()');};
 await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});



 await send('Page.navigate',{url:origin+'/canvas/c_workbench'});await until('!!Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")==="分镜表")');
 const clickAria=async label=>js('Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")==='+JSON.stringify(label)+').click()');
 await clickAria('分镜表');await until('document.body.innerText.includes("已有镜头")||!!document.querySelector(".wb-table")');
 assert.equal(await js('document.querySelectorAll(".wb-table tbody tr").length'),1);
 await click('添加镜头');await until('document.querySelectorAll(".wb-table tbody tr").length===2');
 await js('(()=>{const el=Array.from(document.querySelectorAll("textarea")).find(e=>e.getAttribute("aria-label")==="动作 2");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(el,"小猫跳上花坛");el.dispatchEvent(new Event("input",{bubbles:true}));})()');await wait(1000);
 let current=(await call('/api/projects/canvases/c_workbench')).canvas.document;assert.equal(current.storyboard[1].action,'小猫跳上花坛');
 await click('生成画布节点');await until('document.body.innerText.includes("已添加 6 个节点")');await wait(1000);current=(await call('/api/projects/canvases/c_workbench')).canvas.document;assert.equal(current.nodes.length,7);assert.equal(current.links.length,4);assert.equal(current.storyboard.length,2);
 await click('AI 搭建');await until('!!Array.from(document.querySelectorAll("textarea")).find(e=>e.getAttribute("aria-label")==="AI 画布创作要求")');
 await js('(()=>{const el=Array.from(document.querySelectorAll("textarea")).find(e=>e.getAttribute("aria-label")==="AI 画布创作要求");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(el,"花园小猫短片");el.dispatchEvent(new Event("input",{bubbles:true}));})()');
 await click('生成画布方案');await until('document.body.innerText.includes("花园小猫短片")&&!!document.querySelector(".wb-plan")');await click('应用方案到画布');await until('document.body.innerText.includes("已加入画布")');await wait(1000);current=(await call('/api/projects/canvases/c_workbench')).canvas.document;assert.equal(current.nodes.length,10);assert(current.nodes.some(n=>n.id==='original'));
 await clickAria('关闭创作工作台');await clickAria('自动整理画布');await wait(1000);current=(await call('/api/projects/canvases/c_workbench')).canvas.document;assert.equal(current.nodes.length,10);const savedPositions=current.nodes.map(n=>[n.x,n.y]);assert(new Set(savedPositions.map(JSON.stringify)).size===10);
 await clickAria('生成历史与版本');await click('画布版本');await until('document.querySelectorAll(".wb-version").length>2');
 await js('Array.from(document.querySelectorAll(".wb-version")).find(b=>b.textContent.includes("初始版本")).click()');await until('document.querySelector(".wb-version-detail")?.innerText.includes("1 个节点")');await click('恢复此版本');await wait(1000);current=(await call('/api/projects/canvases/c_workbench')).canvas.document;assert.equal(current.nodes.length,1);assert.equal(current.nodes[0].text,'保留的原始内容');assert((await call('/api/workbench/c_workbench/versions')).versions.some(v=>v.label==='回退前备份'));
 await click('素材库');await until('document.querySelectorAll(".wb-asset").length===2');await js('Array.from(document.querySelectorAll(".wb-asset")).find(a=>a.innerText.includes("花园角色参考")).querySelector(".wb-accent").click()');await wait(1000);current=(await call('/api/projects/canvases/c_workbench')).canvas.document;assert.equal(current.nodes.length,2);assert(current.nodes.some(n=>n.mediaUrl===assetUrl));

 await clickAria('生成历史与版本');await until('document.querySelectorAll(".wb-job").length===1');await click('应用到选中节点');await wait(1000);
 current=(await call('/api/projects/canvases/c_workbench')).canvas.document;assert(current.nodes.some(n=>n.mediaUrl==='/media/history.png'&&n.jobId==='job_history'));
 await clickAria('关闭创作工作台');
 await send('Page.reload');await until('document.querySelectorAll(".mf-node").length===2');

 await clickAria('分镜表');await click('添加镜头');await wait(500);
 await js('(()=>{const el=Array.from(document.querySelectorAll("input")).find(e=>e.accept===".csv,text/csv");const dt=new DataTransfer();dt.items.add(new File(["镜头,动作,时长,比例"+String.fromCharCode(10)+"镜头CSV,小猫转身,8,9:16"],"test.csv",{type:"text/csv"}));el.files=dt.files;el.dispatchEvent(new Event("change",{bubbles:true}));})()');await wait(1000);current=(await call('/api/projects/canvases/c_workbench')).canvas.document;assert.equal(current.storyboard.length,2);assert.equal(current.storyboard[1].duration,8);
 await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:path.join(dir,'downloads')});await click('导出 CSV');await wait(500);assert(fs.readdirSync(path.join(dir,'downloads')).some(f=>f.endsWith('.csv')));
 const shotLight=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync('data/workbench-storyboard-filled.png',Buffer.from(shotLight.data,'base64'));
 await click('素材库');await until('document.querySelectorAll(".wb-asset").length===2');

 assert.deepEqual(errors,[]);
 const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync('data/workbench-browser-visible.png',Buffer.from(shot.data,'base64'));
 ws.close();
 console.log('PASS: browser storyboard edit -> node workflow, AI preview/apply, auto layout, version restore with backup, library insertion and reload');
}finally{chrome?.kill();const exit=once(server,'exit');server.kill();await exit;mock.closeAllConnections();mock.close();}