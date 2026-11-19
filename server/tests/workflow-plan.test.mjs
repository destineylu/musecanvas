import test from 'node:test';
import assert from 'node:assert/strict';
import {parseWorkflowPlan} from '../src/workflow-plan.js';
const raw={title:'花园小猫',nodes:[{id:'t',type:'text',text:'花园中的小猫'},{id:'i',type:'image',text:'橘猫站在花园'},{id:'v',type:'video',text:'橘猫挥爪',duration:5}],links:[{from:'t',to:'i'},{from:'i',to:'v'}],storyboard:[{title:'镜头1',action:'小猫挥爪'}]};
test('valid code block includes braces and escaped quotes inside prompts',()=>{const data=structuredClone(raw);data.nodes[0].text='猫牌写着 "{hello}"';const plan=parseWorkflowPlan('方案如下\n```json\n'+JSON.stringify(data)+'\n```\n完成');assert.equal(plan.nodes[0].text,data.nodes[0].text);assert.equal(plan.nodes.length,3);});
test('missing comma between array elements is repaired without losing nodes',()=>{const broken=JSON.stringify(raw).replace('},{"id":"i"','}{"id":"i"');const plan=parseWorkflowPlan(broken);assert.equal(plan.nodes.length,3);assert.equal(plan.links.length,2);assert.equal(plan.storyboard.length,1);});
test('unquoted keys, single quotes and trailing commas are supported',()=>{const plan=parseWorkflowPlan("{title:'计划',nodes:[{id:'a',type:'text',text:'提示词',},],links:[],storyboard:[],}");assert.equal(plan.nodes[0].text,'提示词');});
test('separate corrected objects are extracted instead of greedy concatenation',()=>{const plan=parseWorkflowPlan(JSON.stringify({error:'wrong'})+'\n'+JSON.stringify(raw));assert.equal(plan.nodes.length,3);});
test('truncated output and structurally invalid plans remain errors',()=>{assert.throws(()=>parseWorkflowPlan(JSON.stringify(raw).slice(0,-15)));assert.throws(()=>parseWorkflowPlan('{"nodes":[{"id":"x","type":"text","text":"hi"}],"links":[{"from":"x","to":"missing"}]}'));assert.throws(()=>parseWorkflowPlan('{"nodes":[{"type":"image"}],"links":[]}'));});
