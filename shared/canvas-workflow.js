const text = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const ratios = ['16:9','9:16','1:1','4:3','3:4','3:2','2:3'];
export function cleanShots(rows) {
  if (!Array.isArray(rows) || rows.length > 100) throw Error('分镜表最多支持 100 个镜头');
  return rows.map((r, i) => ({ id: text(r?.id, 80) || 'shot_'+i, title: text(r?.title, 100) || '镜头 '+(i+1),
    scene: text(r?.scene, 300), characters: text(r?.characters, 300), action: text(r?.action, 3000),
    camera: text(r?.camera, 300), dialogue: text(r?.dialogue, 1000), prompt: text(r?.prompt, 4000),
    duration: [5,6,8,10].includes(Number(r?.duration)) ? Number(r.duration) : 5,
    ratio: ratios.includes(r?.ratio) ? r.ratio : '16:9' }));
}

export function repairWorkflowLinks(nodes, links) {
  const byId=new Map(nodes.map(n=>[n.id,n])),result=[],seen=new Set(),imageInput=new Set();
  const add=(from,to)=>{const a=byId.get(from),b=byId.get(to);if(!a||!b||from===to||b.type==='text'||a.type==='video')return;
    if(a.type==='image'&&imageInput.has(to))return;
    const key=JSON.stringify([from,to]);if(seen.has(key))return;
    seen.add(key);if(a.type==='image')imageInput.add(to);result.push({from,to});};
  for(const l of links){const a=byId.get(l.from),b=byId.get(l.to);if(a?.type==='text'&&b?.type==='text'){result.push({...l});seen.add(JSON.stringify([l.from,l.to]));}else add(l.from,l.to);}
  for(const l of links){if(byId.get(l.from)?.type==='image'&&byId.get(l.to)?.type==='text')for(const next of links.filter(e=>e.from===l.to))add(l.from,next.to);}
  const reference=nodes.find(n=>n.type==='image'&&/(角色.*参考|角色设定|character.*ref|reference.*character)/i.test(n.label||''));
  if(reference){
    const related=new Set([reference.id]),queue=[reference.id];
    for(let i=0;i<queue.length;i++)for(const l of links){const next=l.from===queue[i]?l.to:l.to===queue[i]?l.from:null;if(next&&byId.has(next)&&!related.has(next)){related.add(next);queue.push(next);}}
    for(const n of nodes.filter(n=>n.type==='image'&&n.id!==reference.id&&related.has(n.id)))add(reference.id,n.id);
  }
  return result;
}

export function validateWorkflow(raw) {
  if (!raw || !Array.isArray(raw.nodes) || !raw.nodes.length || raw.nodes.length > 80) throw Error('方案需要 1 到 80 个节点');
  const ids = new Set();
  const nodes = raw.nodes.map((n, i) => {
    if (!n || !['text','image','video'].includes(n.type)) throw Error('方案含不支持的节点类型');
    const id = text(n.id, 80) || 'plan_'+i;
    if (ids.has(id)) throw Error('方案节点 ID 重复');
    ids.add(id);
    return { id, type: n.type, label: text(n.label,80) || { text:'文本',image:'图片生成',video:'视频生成' }[n.type],
      text: text(n.text, 6000), size: ratios.includes(n.size) ? n.size : '16:9',
      duration: [5,6,8,10].includes(Number(n.duration)) ? Number(n.duration) : 5,
      intent: n.type === 'text' ? 'input' : 'generate', status: 'idle', x: 0, y: 0 };
  });
  const links = [], seen = new Set();
  if (raw.links !== undefined && (!Array.isArray(raw.links) || raw.links.length > 300)) throw Error('方案连线无效');
  for (const l of raw.links || []) {
    if (!l || !ids.has(l.from) || !ids.has(l.to) || l.from === l.to) throw Error('方案含无效连线');
    const key=JSON.stringify([l.from,l.to]);
    if (!seen.has(key)) { seen.add(key); links.push({from:l.from,to:l.to}); }
  }
  return { title:text(raw.title,100)||'AI 创作流程', nodes, links:repairWorkflowLinks(nodes,links), storyboard:cleanShots(raw.storyboard||[]) };
}

export function arrangeNodes(nodes, links, dimensions = () => ({ width:360,height:260 })) {
  if (!nodes.length) return [];
  const ids = new Set(nodes.map(n=>n.id)), edges = links.filter(e=>ids.has(e.from)&&ids.has(e.to)&&e.from!==e.to);
  const size = n => { const s=dimensions(n);return {width:Math.max(100,Number(s.width)||360),height:Math.max(80,Number(s.height)||260)}; };
  const rank = new Map(nodes.map(n=>[n.id,0])), incoming = new Map(nodes.map(n=>[n.id,0])), outgoing = new Map(nodes.map(n=>[n.id,[]]));
  for(const e of edges){incoming.set(e.to,incoming.get(e.to)+1);outgoing.get(e.from).push(e.to);}
  const queue=nodes.filter(n=>incoming.get(n.id)===0).map(n=>n.id);let index=0;
  while(index<queue.length){const id=queue[index++];for(const to of outgoing.get(id)){rank.set(to,Math.max(rank.get(to),rank.get(id)+1));incoming.set(to,incoming.get(to)-1);if(!incoming.get(to))queue.push(to);}}
  // Cycles remain in one column. They still receive distinct vertical positions.
  if (!edges.length) {
    const cols=Math.min(3,nodes.length), widths=Array(cols).fill(0), heights=[];
    nodes.forEach((n,i)=>{widths[i%cols]=Math.max(widths[i%cols],size(n).width);const row=Math.floor(i/cols);heights[row]=Math.max(heights[row]||0,size(n).height);});
    return nodes.map((n,i)=>({...n,x:60+widths.slice(0,i%cols).reduce((a,b)=>a+b+80,0),y:100+heights.slice(0,Math.floor(i/cols)).reduce((a,b)=>a+b+90,0)}));
  }
  const columns=new Map();for(const n of nodes){const r=rank.get(n.id);if(!columns.has(r))columns.set(r,[]);columns.get(r).push(n);}
  const result=new Map();let x=60;
  for(const [,items] of [...columns].sort((a,b)=>a[0]-b[0])){let y=100,width=0;for(const n of items){result.set(n.id,{...n,x,y});const s=size(n);y+=s.height+90;width=Math.max(width,s.width);}x+=width+100;}
  return nodes.map(n=>result.get(n.id));
}

export function shotsToWorkflow(rows) {
  const shots=cleanShots(rows),nodes=[],links=[];
  shots.forEach((s,i)=>{
    const prompt=[s.scene&&'场景：'+s.scene,s.characters&&'角色：'+s.characters,s.action,s.camera&&'镜头：'+s.camera,s.dialogue&&'对白：'+s.dialogue,s.prompt].filter(Boolean).join('\n');
    if(!prompt.trim())return;
    const base='shot_'+i;
    nodes.push({id:base+'_text',type:'text',label:s.title+' · 提示词',text:prompt,intent:'input',x:60,y:100+i*450},
      {id:base+'_image',type:'image',label:s.title+' · 图片',text:prompt,intent:'generate',size:s.ratio,duration:s.duration,status:'idle',x:460,y:100+i*450},
      {id:base+'_video',type:'video',label:s.title+' · 视频',text:prompt,intent:'generate',size:s.ratio,duration:s.duration,status:'idle',x:960,y:100+i*450});
    links.push({from:base+'_text',to:base+'_image'},{from:base+'_image',to:base+'_video'});
  });
  return {title:'分镜流程',nodes,links,storyboard:shots,fromStoryboard:true};
}

export function parseCSV(input) {
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<input.length;i++){const c=input[i];if(c==='"'){if(quoted&&input[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(cell);cell='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&input[i+1]==='\n')i++;row.push(cell);if(row.some(v=>v.trim()))rows.push(row);row=[];cell='';}else cell+=c;}
  if(quoted)throw Error('CSV 引号未闭合');row.push(cell);if(row.some(v=>v.trim()))rows.push(row);return rows;
}
