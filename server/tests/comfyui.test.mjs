import test from 'node:test';
import assert from 'node:assert/strict';
import { validateComfy, buildComfyPrompt, suggestComfy } from '../../shared/comfy-workflow.js';
export const imageGraph={
 '1':{class_type:'CLIPTextEncode',inputs:{text:'positive'}},
 '2':{class_type:'EmptyLatentImage',inputs:{width:512,height:512,batch_size:1}},
 '3':{class_type:'KSampler',inputs:{seed:0,positive:['1',0],latent_image:['2',0]}},
 '4':{class_type:'SaveImage',inputs:{images:['3',0],filename_prefix:'musecanvas'}},
};
test('workflow validation and deterministic binding preserve original graph',()=>{
 const suggested=suggestComfy(imageGraph);const config=validateComfy({workflow:imageGraph,...suggested},'image');
 const output=buildComfyPrompt(config,{prompt:'garden cat',params:{size:'16:9'}},null,123);
 assert.equal(output['1'].inputs.text,'garden cat');assert.equal(output['3'].inputs.seed,123);
 assert.ok(output['2'].inputs.width>output['2'].inputs.height);assert.equal(imageGraph['1'].inputs.text,'positive');
});
test('reject UI format, broken binding, node connection replacement and missing prompt',()=>{
 assert.throws(()=>validateComfy({workflow:{nodes:[]}},'image'),/API 格式/);
 assert.throws(()=>validateComfy({workflow:imageGraph,bindings:[{source:'prompt',nodeId:'missing',input:'text'}]},'image'),/不存在/);
 assert.throws(()=>validateComfy({workflow:imageGraph,bindings:[{source:'prompt',nodeId:'3',input:'positive'}]},'image'),/节点连接/);
 assert.throws(()=>validateComfy({workflow:imageGraph,bindings:[],outputNode:'4'},'image'),/绑定/);
});
test('required reference and video frame cap prevent unsafe submissions',()=>{
 const workflow={...imageGraph,'5':{class_type:'LoadImage',inputs:{image:'old.png'}},'6':{class_type:'Video',inputs:{frames:81,fps:16}}};
 const config=validateComfy({workflow,outputNode:'4',bindings:[{source:'prompt',nodeId:'1',input:'text'},{source:'image',nodeId:'5',input:'image'},{source:'frames',nodeId:'6',input:'frames'}],maxFrames:81},'video');
 assert.throws(()=>buildComfyPrompt(config,{prompt:'cat',params:{duration:5}},null,1),/需要参考图/);
 assert.equal(buildComfyPrompt(config,{prompt:'cat',params:{duration:5}},'new.png',1)['6'].inputs.frames,81);
 assert.throws(()=>buildComfyPrompt(config,{prompt:'cat',params:{duration:10}},'new.png',1),/最大帧数/);
});
