// AI 深度参与 ComfyUI：挑工作流并填参数、看结果自检并提出修改、规划分镜。
// Bridge 没有原生工具调用，统一用「一次回复一个 JSON」的协议；所有取值在提交前校验。
import fs from 'node:fs';
import path from 'node:path';
import { MEDIA_DIR } from './config.js';
import { completeTextWith } from './museText.js';
import { extractJson } from './routes/director.js';
import { listWorkflows, getWorkflow, checkValues, readSkill } from './comfy-lib.js';
import { getJob } from './db.js';
import { SHOT_SIZES, MOVEMENTS, LIGHTS, DOF, LENSES, buildShotPrompt, buildMotionPrompt } from '../../shared/shot-prompt.js';

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

async function askJson(model, content, validate) {
  const first = await completeTextWith(model, [{ role: 'user', content }]);
  try {
    return validate(extractJson(first));
  } catch (error) {
    const retry = await completeTextWith(model, [
      { role: 'user', content },
      { role: 'assistant', content: String(first).slice(0, 12_000) },
      { role: 'user', content: `上面的输出无法使用（${error.message}）。请只输出一个符合要求的完整 JSON 对象，不要任何其他文字。` },
    ]);
    return validate(extractJson(retry));
  }
}

function paramLines(w) {
  return w.params.filter((p) => p.enabled).map((p) => {
    const bits = [`${p.name}（${p.label}）`, `默认 ${JSON.stringify(typeof p.default === 'string' ? p.default.slice(0, 300) : p.default)}`];
    if (!p.ai) bits.push('只读，不要修改');
    if (p.options?.length) bits.push(`可选：${p.options.slice(0, 60).map((o) => JSON.stringify(o)).join(' / ')}${p.options.length > 60 ? ` 等 ${p.options.length} 项` : ''}`);
    if (p.min !== undefined || p.max !== undefined) bits.push(`范围 ${p.min ?? '-∞'} ~ ${p.max ?? '∞'}`);
    if (p.description) bits.push(p.description);
    return '  - ' + bits.join('；');
  }).join('\n');
}

function workflowBlock(w, skillLimit) {
  const skill = readSkill(w.id).trim();
  return [
    `### 工作流 ${w.id}`,
    `名称：${w.name}（${w.kind === 'video' ? '视频' : '图片'}${w.requiresImage ? '，需要参考图' : ''}）`,
    w.description ? `说明：${w.description}` : '',
    w.tags?.length ? `标签：${w.tags.join('、')}` : '',
    '参数：',
    paramLines(w),
    skill ? `技能包（使用说明与经验，必须遵守）：\n${skill.slice(0, skillLimit)}` : '',
  ].filter(Boolean).join('\n');
}

/* ------------------------------ 参数规划 ------------------------------ */
export async function planRun({ intent, kind = 'image', refCount = 0, ratio = '', seconds = 0, workflowId, model, notes = '' }) {
  const text = String(intent || '').trim();
  if (text.length < 2) throw bad('请描述要生成的内容');
  let candidates;
  if (workflowId) {
    const w = getWorkflow(workflowId);
    if (!w) throw bad('所选工作流不存在');
    candidates = [w];
  } else {
    candidates = listWorkflows().map((s) => getWorkflow(s.id)).filter((w) => w.kind === kind && !(w.missing?.length) && (refCount ? true : !w.requiresImage));
    if (refCount) candidates.sort((a, b) => Number(b.requiresImage) - Number(a.requiresImage));
  }
  if (!candidates.length) throw bad(`工作流库里没有可用的${kind === 'video' ? '视频' : '图片'}工作流${refCount ? '' : '（不需要参考图的）'}，请先在设置中导入`);
  candidates = candidates.slice(0, 6);
  const skillLimit = candidates.length > 2 ? 2500 : 6000;
  const content = [
    '你是 ComfyUI 生成参数专家。根据用户意图，从下面的工作流里选一个，并给出要修改的参数值。',
    '只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。',
    '',
    '格式：{ "workflowId": "所选工作流 id", "values": { "参数名": 值 }, "reason": "为什么这样选和这样调（2~3 句中文）", "expect": "预期画面要点（中文，用于生成后自检）" }',
    '',
    '规则：',
    '- values 只写需要改的参数，没写的保持默认；只能用列出的参数名，带「只读」的不要写。',
    '- 有可选项的参数必须从可选项里原样挑选；数值在范围内。',
    '- 提示词按该工作流模型擅长的写法改写：没有技能包特别说明时，用详细的英文描述（主体、动作、构图、光线、风格、画质），负面提示词写常见瑕疵。',
    '- 参考图会自动接入图片参数，不要写图片文件名。',
    '- 采样参数只在有明确理由时调整（如需要更多细节、减少过曝、图生图保留原图程度等），理由写进 reason。',
    '- 技能包里的注意事项和经验优先于通用经验。',
    '',
    `用户意图：${text}`,
    `生成类型：${kind === 'video' ? '视频' : '图片'}；参考图：${refCount} 张${ratio ? `；画幅比例：${ratio}（宽高会自动换算，除非意图要求特定尺寸）` : ''}${seconds ? `；时长：${seconds} 秒（帧数会自动换算）` : ''}`,
    notes ? `补充要求：${notes}` : '',
    '',
    ...candidates.map((w) => workflowBlock(w, skillLimit)),
  ].filter((x) => x !== undefined).join('\n');

  return askJson(model, content, (raw) => {
    const w = candidates.find((c) => c.id === raw.workflowId) || (candidates.length === 1 ? candidates[0] : null);
    if (!w) throw new Error('workflowId 不在候选列表中');
    const { values, errors } = checkValues(w, raw.values || {}, { aiOnly: true });
    return {
      workflowId: w.id,
      workflowName: w.name,
      kind: w.kind,
      values,
      reason: String(raw.reason || '').slice(0, 600),
      expect: String(raw.expect || '').slice(0, 600),
      issues: errors,
    };
  });
}

/* ------------------------------ 结果自检 ------------------------------ */
function mediaDataUrl(job, frame) {
  if (job.type === 'video') {
    if (typeof frame === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(frame) && frame.length < 12 * 1024 * 1024) return frame;
    throw bad('视频自检需要一帧截图');
  }
  const file = path.join(MEDIA_DIR, path.basename(job.mediaFile || ''));
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext];
  if (!mime || !fs.existsSync(file)) throw bad('找不到生成结果文件');
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

export async function reviewRun({ jobId, userId, isAdmin, intent, expect = '', frame, model, round = 1, maxRounds = 3 }) {
  const job = getJob(jobId);
  if (!job || (!isAdmin && job.userId !== userId)) throw bad('任务不存在', 404);
  if (job.status !== 'completed') throw bad('任务还没有完成');
  const spec = job.params.comfyLib;
  if (!spec) throw bad('只有工作流库任务可以自检');
  const w = getWorkflow(spec.workflowId);
  if (!w) throw bad('工作流已删除');
  const used = job.result?.used || spec.values;
  const image = mediaDataUrl(job, frame);
  const text = [
    '你是严格的出图审片师。请看附带的生成结果，对照用户意图判断是否合格，并给出下一轮可以直接使用的参数修改。',
    '只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。',
    '',
    '格式：{ "score": 0~10 的整数, "verdict": "accept" 或 "retry", "issues": ["具体问题（中文）"], "changes": { "参数名": 新值 }, "lesson": "一条以后用这个工作流时值得记住的经验（中文，没有就留空）" }',
    '',
    '规则：',
    '- score ≥ 7 且没有明显违背意图的问题时 verdict 用 accept；否则 retry，并在 changes 里给出针对问题的修改（改提示词措辞、负面提示词、步数、CFG、重绘幅度、尺寸等）。',
    '- changes 只能用下面列出的参数名，带「只读」的不能改；可选项必须原样挑选。想换构图可以改 seed。',
    `- 这是第 ${round} 轮，最多 ${maxRounds} 轮${round >= maxRounds ? '；这是最后一轮，只评价，changes 可留空' : ''}。`,
    '- lesson 写具体可复用的经验（例如「这个模型写 holding 会出多余的手，改用 hands resting on」），不要写空话。',
    '',
    `用户意图：${intent || job.prompt}`,
    expect ? `预期要点：${expect}` : '',
    `本次实际使用的参数：${JSON.stringify(used).slice(0, 6000)}`,
    job.type === 'video' ? '附图是生成视频中间的一帧。' : '',
    '',
    workflowBlock(w, 4000),
  ].filter(Boolean).join('\n');
  const content = [{ type: 'text', text }, { type: 'image_url', image_url: { url: image } }];
  return askJson(model, content, (raw) => {
    const score = Math.max(0, Math.min(10, Math.round(Number(raw.score)) || 0));
    const { values, errors } = checkValues(w, raw.changes || {}, { aiOnly: true });
    const verdict = raw.verdict === 'accept' || score >= 8 ? 'accept' : 'retry';
    return {
      score,
      verdict,
      issues: (Array.isArray(raw.issues) ? raw.issues : []).map((s) => String(s).slice(0, 200)).slice(0, 8),
      changes: values,
      lesson: String(raw.lesson || '').slice(0, 300),
      invalid: errors,
    };
  });
}

/* ------------------------------ 分镜规划 ------------------------------ */
const keysOf = (o) => Object.keys(o).join('|');

export async function planShots({ script, count = 6, ratio = '16:9', styleHint = '', imageWorkflowId, model }) {
  const text = String(script || '').trim();
  if (text.length < 4) throw bad('请提供故事、脚本或分镜描述');
  const n = Math.max(1, Math.min(16, Math.round(Number(count)) || 6));
  const w = imageWorkflowId ? getWorkflow(imageWorkflowId) : null;
  const content = [
    '你是电影分镜师。把下面的内容拆成连续的镜头，并定一份全片共用的风格契约，保证每一格画面来自同一个世界、但构图和镜头语言各不相同。',
    '只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。',
    '',
    `格式：{
  "title": "片名（中文，10 字以内）",
  "style": { "clause": "全片统一的风格短句（英文，20 词以内，如 cinematic film still, muted teal and orange palette, 35mm film grain）", "negative": "负面提示词（英文）", "character": "主要角色的固定外观描述（英文，发型、服装、年龄等；没有人物就留空）" },
  "shots": [ {
    "title": "镜头标题（中文）",
    "subject": "这一格画面里有什么、在做什么（英文，具体可见的内容，不写形容词堆砌）",
    "shotSize": "${keysOf(SHOT_SIZES)}",
    "lens": "${LENSES.join('|')}",
    "dof": "${keysOf(DOF)}",
    "lighting": "${keysOf(LIGHTS)}",
    "movement": "${keysOf(MOVEMENTS)}",
    "motion": "这个镜头动起来时发生的动作（英文，用于图生视频）",
    "seconds": 2~10
  } ]
}`,
    '',
    `要求：大约 ${n} 个镜头；画幅 ${ratio}；相邻镜头的景别和角度要有变化；人物外观只写在 style.character，subject 里用 the woman / the boy 等指代；风格只写在 style.clause，不要在 subject 里重复。`,
    styleHint ? `风格要求：${styleHint}` : '',
    w ? `出图工作流「${w.name}」的使用说明（提示词写法以此为准）：\n${readSkill(w.id).slice(0, 3000) || '（无）'}` : '',
    '',
    `内容：${text.slice(0, 12_000)}`,
  ].filter(Boolean).join('\n');

  return askJson(model, content, (raw) => {
    const style = {
      clause: String(raw.style?.clause || '').slice(0, 300),
      negative: String(raw.style?.negative || '').slice(0, 600),
      character: String(raw.style?.character || '').slice(0, 400),
    };
    const pick = (table, v, d) => (Object.hasOwn(table, v) ? v : d);
    const shots = (Array.isArray(raw.shots) ? raw.shots : []).slice(0, 16).map((s, i) => {
      const shot = {
        id: `shot_${i + 1}`,
        title: String(s?.title || `镜头 ${i + 1}`).slice(0, 30),
        subject: String(s?.subject || '').slice(0, 600),
        shotSize: pick(SHOT_SIZES, s?.shotSize, 'medium'),
        lens: LENSES.includes(s?.lens) ? s.lens : '35mm',
        dof: pick(DOF, s?.dof, 'medium'),
        lighting: pick(LIGHTS, s?.lighting, 'natural'),
        movement: pick(MOVEMENTS, s?.movement, 'static'),
        motion: String(s?.motion || '').slice(0, 400),
        seconds: Math.max(2, Math.min(10, Math.round(Number(s?.seconds)) || 4)),
      };
      return { ...shot, prompt: buildShotPrompt(shot, style), motionPrompt: buildMotionPrompt(shot, style) };
    }).filter((s) => s.subject);
    if (!shots.length) throw new Error('没有可用的镜头');
    return { title: String(raw.title || '分镜').slice(0, 30), style, shots };
  });
}
