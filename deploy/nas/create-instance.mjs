// Generate one self-contained private workspace for one owner. Never reuse its data/network/key.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){if(!args[i]?.startsWith('--')||args[i+1]===undefined)throw Error('参数格式：--name alice --email alice@example.com --port 8788');options[args[i].slice(2)]=args[i+1];}
const {name,email}=options,port=Number(options.port||8787),bind=options.bind||'127.0.0.1';
if(!/^[a-z][a-z0-9-]{1,29}$/.test(name||''))throw Error('name 使用 2–30 位小写字母、数字或横线，并以字母开头');
if(!/^[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email||''))throw Error('请填写有效账号邮箱');
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('port 必须为 1024–65535');
if(!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(bind)||bind.split('.').some(x=>+x>255))throw Error('bind 必须为 IPv4 地址');
let url=options.url||'';
if(url){const u=new URL(url);if(/[\r\n]/.test(url)||!['http:','https:'].includes(u.protocol)||u.pathname!=='/'||u.username||u.password||u.search||u.hash)throw Error('url 填写工作区独立域名根地址');url=u.origin;}
const out=path.resolve(options.output||path.join(root,'deploy/nas/instances',name));
if(fs.existsSync(out))throw Error('输出目录已存在，拒绝覆盖已有密钥或数据');
fs.mkdirSync(out,{recursive:true,mode:0o700});
const secret=()=>randomBytes(36).toString('base64url');
fs.writeFileSync(path.join(out,'.env'),[
 '# 私人工作区凭据：不要提交 Git，不要给其它成员复制使用。',
 'JWT_SECRET='+secret(),'ADMIN_EMAIL='+email.toLowerCase(),'ADMIN_PASSWORD='+secret(),
 'MUSE_KEY='+secret(),'PUBLIC_BASE='+url,'COOKIE_SECURE='+(url.startsWith('https:')?'1':'0'),
].join('\n')+'\n',{mode:0o600,flag:'wx'});
const relative=p=>{const v=path.relative(out,p).replaceAll('\\','/');return JSON.stringify(v||'.');};
const museKeyRef='$'+'{MUSE_KEY:?missing MUSE_KEY}';
const compose=`name: musecanvas-${name}
services:
  app:
    build:
      context: ${relative(root)}
      dockerfile: deploy/docker/Dockerfile
    image: musecanvas:1.0
    restart: unless-stopped
    env_file: .env
    environment:
      ACCESS_MODE: account
      HOST: 0.0.0.0
      PORT: "8787"
      MUSECANVAS_UPSTREAM: muse2api
      MUSE_BASE: http://127.0.0.1:18610
      EMBEDDED_ENGINE: "1"
      MUSE_KEY: ${museKeyRef}
      BRIDGE_CONCURRENCY: "1"
      ALLOW_REGISTER: "0"
    ports:
      - "${bind}:${port}:8787"
    volumes:
      - ./data/server:/app/server/data
      - ./data/engine:/app/engine
    shm_size: 256m
    mem_limit: 1536m
    cpus: 0.75
    pids_limit: 384
    logging:
      driver: json-file
      options: {max-size: "10m", max-file: "3"}
`;
fs.writeFileSync(path.join(out,'compose.yml'),compose,{flag:'wx'});
console.log('已生成独立工作区：'+out+'\n登录邮箱：'+email+'\n初始密码和专属服务密钥保存在该目录 .env 中（不在终端输出）。\n在该目录执行 docker compose up -d --build。');
