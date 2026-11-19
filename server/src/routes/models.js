import { Router } from 'express';
import { requireAuth, requireAdmin } from '../auth.js';
import { publicModels, saveModel, deleteModel, setDefaults, modelById } from '../model-config.js';
import { testModel } from '../external-models.js';
import { checkComfy } from '../comfyui.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const r = Router();
r.use(requireAuth);
r.get('/', (_req,res) => { const {defaults,providers}=publicModels(); res.json({defaults,providers:providers.map(({id,name,kind,model,maxReferences,durations})=>({id,name,kind,model,maxReferences,durations}))}); });
r.use(requireAdmin);
r.get('/config', (_req,res) => res.json(publicModels()));
function savedWorkflows(){
  const file=path.join(os.homedir(),'.codex','data','codex-comfyui','workflows.json');
  if(!fs.existsSync(file))return [];
  if(fs.statSync(file).size>20*1024*1024)throw new Error('本机工作流库超过 20 MB，请改用文件导入');
  const data=JSON.parse(fs.readFileSync(file,'utf8'));return Array.isArray(data)?data:[];
}
r.get('/comfy/library',(_req,res,next)=>{try{res.json({workflows:savedWorkflows().map(w=>({id:w.id,name:w.name,nodes:Object.keys(w.workflow||{}).length}))});}catch(e){next(e);}});
r.get('/comfy/library/:id', (req,res,next)=>{try{
  const w=savedWorkflows().find(w=>w.id===req.params.id);if(!w)return res.status(404).json({error:'本机工作流不存在'});
  res.json({name:w.name,workflow:w.workflow,parameters:(w.parameters||[]).map(p=>({name:p.name,nodeId:p.nodeId,inputKey:p.inputKey,options:p.name==='aspect_ratio'?p.options:undefined}))});
}catch(e){next(e);}});
r.put('/defaults', (req,res,next) => { try { res.json(setDefaults(req.body || {})); } catch(e) { next(e); } });
r.post('/', (req,res,next) => { try { res.json(saveModel(null,req.body || {})); } catch(e) { next(e); } });
r.put('/:id', (req,res,next) => { try { res.json(saveModel(req.params.id,req.body || {})); } catch(e) { next(e); } });
r.delete('/:id', (req,res,next) => { try { res.json(deleteModel(req.params.id)); } catch(e) { next(e); } });
r.post('/:id/test', async(req,res,next) => { try { const p=modelById(req.params.id); if(!p)return res.status(404).json({error:'模型不存在'});res.json(await (p.protocol==='comfyui'?checkComfy(p):testModel(p))); } catch(e) { next(e); } });
export default r;
