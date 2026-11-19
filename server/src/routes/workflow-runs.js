import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { getRun,startRun,controlRun } from '../workflow-runner.js';
const r=Router();r.use(requireAuth);
r.get('/workbench/:id/run',(req,res)=>res.json({run:getRun(req.params.id,req.user.id)}));
r.post('/workbench/:id/run',(req,res,next)=>{try{res.json({run:startRun(req.params.id,req.user.id,req.body?.limit)});}catch(e){next(e);}});
r.put('/workbench/:id/run',(req,res,next)=>{try{res.json({run:controlRun(req.params.id,req.user.id,req.body?.action)});}catch(e){next(e);}});
export default r;
