import test from 'node:test';
import assert from 'node:assert/strict';
import {obsoleteWorkflowStep} from '../../shared/workflow-state.js';
test('terminal flow cannot replace a newer manual retry or restored result',()=>{
 const step={jobId:'old',mediaUrl:'/media/old.webp'};
 for(const status of ['failed','completed','stopped']){
  assert.equal(obsoleteWorkflowStep({status},{jobId:'new'},step),true);
  assert.equal(obsoleteWorkflowStep({status},{mediaUrl:'/media/restored.webp'},step),true);
  assert.equal(obsoleteWorkflowStep({status},{jobId:'old'},step),false);
  assert.equal(obsoleteWorkflowStep({status},{},step),false);
 }
});
test('active flow still owns its execution fields',()=>{
 for(const status of ['running','paused'])assert.equal(obsoleteWorkflowStep({status},{jobId:'old'},{jobId:'new'}),false);
});
