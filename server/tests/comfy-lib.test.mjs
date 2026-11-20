import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-lib-'));
process.env.JWT_SECRET ||= 'comfy-lib-test-secret-0123456789-abcdef';
const { convertGraphToApi } = await import('../../shared/comfy-graph.js');
const { extractParams, checkValues, missingValues } = await import('../src/comfy-lib.js');
const { buildShotPrompt } = await import('../../shared/shot-prompt.js');

const info = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['a.safetensors', 'b.safetensors']] } }, output: ['MODEL', 'CLIP', 'VAE'] },
  CLIPTextEncode: { input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } }, output: ['CONDITIONING'] },
  KSampler: {
    input: { required: {
      model: ['MODEL'], seed: ['INT', { min: 0, max: 2 ** 48, control_after_generate: true }], steps: ['INT', { min: 1, max: 100 }],
      cfg: ['FLOAT', { min: 0, max: 30 }], sampler_name: [['euler', 'dpmpp_2m']], scheduler: [['normal', 'karras']],
      positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], denoise: ['FLOAT', { min: 0, max: 1 }],
    } },
    output: ['LATENT'],
  },
  EmptyLatentImage: { input: { required: { width: ['INT', { min: 16, max: 8192 }], height: ['INT', { min: 16, max: 8192 }], batch_size: ['INT', { min: 1 }] } }, output: ['LATENT'] },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } }, output: [] },
  VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } }, output: ['IMAGE'] },
  WanImageToVideo: { input: { required: { positive: ['CONDITIONING'], negative: ['CONDITIONING'], width: ['INT'], height: ['INT'], length: ['INT'] } }, output: ['CONDITIONING', 'CONDITIONING', 'LATENT'] },
};

test('界面工作流转换：连线、种子控件占位、绕过节点与 Reroute', () => {
  const graph = {
    nodes: [
      { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['a.safetensors'], outputs: [{ links: [1, 2, 3, 9] }] },
      { id: 2, type: 'CLIPTextEncode', inputs: [{ name: 'clip', link: 1 }], widgets_values: ['a cat'], outputs: [{ links: [4] }] },
      { id: 3, type: 'CLIPTextEncode', inputs: [{ name: 'clip', link: 2 }], widgets_values: ['blurry'], outputs: [{ links: [5] }] },
      { id: 4, type: 'EmptyLatentImage', widgets_values: [512, 768, 1], outputs: [{ links: [6] }] },
      { id: 5, type: 'KSampler', inputs: [{ name: 'model', link: 3 }, { name: 'positive', link: 4 }, { name: 'negative', link: 5 }, { name: 'latent_image', link: 6 }],
        widgets_values: [42, 'randomize', 20, 7, 'euler', 'normal', 1], outputs: [{ links: [7] }] },
      { id: 9, type: 'Reroute', inputs: [{ name: '', link: 7 }], outputs: [{ links: [10] }] },
      { id: 6, type: 'VAEDecode', inputs: [{ name: 'samples', link: 10 }, { name: 'vae', link: 9 }], outputs: [{ links: [8] }] },
      { id: 7, type: 'SaveImage', inputs: [{ name: 'images', link: 8 }], widgets_values: ['out'] },
      { id: 8, type: 'Note', widgets_values: ['hello'] },
      { id: 10, type: 'SaveImage', mode: 4, inputs: [{ name: 'images', link: null }], widgets_values: ['bypassed'] },
    ],
    links: [[1, 1, 1, 2, 0, 'CLIP'], [2, 1, 1, 3, 0, 'CLIP'], [3, 1, 0, 5, 0, 'MODEL'], [4, 2, 0, 5, 1, 'CONDITIONING'], [5, 3, 0, 5, 2, 'CONDITIONING'],
      [6, 4, 0, 5, 3, 'LATENT'], [7, 5, 0, 9, 0, 'LATENT'], [8, 6, 0, 7, 0, 'IMAGE'], [9, 1, 2, 6, 1, 'VAE'], [10, 9, 0, 6, 0, 'LATENT']],
  };
  const out = convertGraphToApi(graph, info);
  assert.ok(out.ok, out.error);
  const wf = out.workflow;
  assert.deepEqual(Object.keys(wf).sort(), ['1', '2', '3', '4', '5', '6', '7']);
  assert.equal(wf['5'].inputs.seed, 42);
  assert.equal(wf['5'].inputs.steps, 20, 'control_after_generate 只占位，不能错位');
  assert.equal(wf['5'].inputs.sampler_name, 'euler');
  assert.deepEqual(wf['6'].inputs.samples, ['5', 0], 'Reroute 被直通');

  const params = extractParams(wf, info);
  const byName = Object.fromEntries(params.map((p) => [p.name, p]));
  assert.equal(byName.prompt.default, 'a cat');
  assert.equal(byName.negative_prompt.default, 'blurry');
  assert.deepEqual(byName.sampler.options, ['euler', 'dpmpp_2m']);
  assert.equal(byName.steps.max, 100);
  assert.equal(byName.checkpoint.role, 'model');

  const w = { params };
  const checked = checkValues(w, { steps: 500, sampler: 'bogus', image: 'x.png', unknown: 1, cfg: '6.5' }, { aiOnly: true });
  assert.equal(checked.values.steps, 100, '超出范围被收紧');
  assert.equal(checked.values.cfg, 6.5);
  assert.ok(checked.errors.some((e) => e.includes('sampler')));
  assert.ok(checked.errors.some((e) => e.includes('unknown')));
});

test('经过 WanImageToVideo 等带极性的中间节点时，正负提示词仍能区分', () => {
  const wf = {
    1: { class_type: 'CLIPTextEncode', inputs: { text: 'dancing', clip: ['9', 0] } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: 'static, blurry', clip: ['9', 0] } },
    3: { class_type: 'WanImageToVideo', inputs: { positive: ['1', 0], negative: ['2', 0], width: 832, height: 480, length: 81 } },
    4: { class_type: 'KSampler', inputs: { positive: ['3', 0], negative: ['3', 1], seed: 1, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
  };
  const names = Object.fromEntries(extractParams(wf, info).map((p) => [p.name, p.default]));
  assert.equal(names.prompt, 'dancing');
  assert.equal(names.negative_prompt, 'static, blurry');
  assert.equal(names.frames, 81);
});

test('缺少的模型文件会被识别', () => {
  const wf = { 1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'missing.safetensors' } } };
  assert.deepEqual(missingValues(wf, info).map((m) => m.value), ['missing.safetensors']);
});

test('分镜提示词：镜头语言在前，风格句收尾，人物外观只在有人物时出现', () => {
  const style = { clause: 'cinematic film still', character: 'a woman with short black hair' };
  const p = buildShotPrompt({ lens: '85mm', dof: 'shallow', shotSize: 'close_up', subject: 'the woman smiles', lighting: 'neon' }, style);
  assert.ok(p.startsWith('85mm portrait lens'));
  assert.ok(p.endsWith('cinematic film still'));
  assert.ok(p.includes('short black hair'));
  assert.ok(!buildShotPrompt({ shotSize: 'wide', subject: 'an empty street' }, style).includes('short black hair'));
});
