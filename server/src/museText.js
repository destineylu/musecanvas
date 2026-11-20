import { CFG, usesMuse2api } from './config.js';
import { complete as completeBridge } from './muse.js';
import { complete as completeLegacy } from './muse2api.js';
import { selectedModel, modelById } from './model-config.js';
import { externalText } from './external-models.js';

export const textModel = () => selectedModel('chat')?.model || (usesMuse2api ? 'muse-spark' : CFG.bridgeModels.chat);

export function completeText(messages) {
  const external = selectedModel('chat');
  if (external) return externalText(external, messages);
  return completeMuse(messages);
}

/** 指定对话模型：'muse' 使用当前 Muse 接入方式，其它为模型设置里的对话模型 id，留空用默认。 */
export function completeTextWith(modelId, messages) {
  if (!modelId || modelId === 'default') return completeText(messages);
  if (modelId === 'muse') return completeMuse(messages);
  const p = modelById(modelId);
  if (!p || p.kind !== 'chat') throw Object.assign(new Error('所选对话模型不存在，请重新选择'), { status: 400 });
  return externalText(p, messages);
}

function completeMuse(messages) {
  if (!usesMuse2api) return completeBridge(CFG.bridgeModels.chat, messages);
  const attachments = new Set();
  const textMessages = messages.map(message => {
    if (!Array.isArray(message.content)) return message;
    const text = [];
    for (const part of message.content) {
      if (part.type === 'text') text.push(part.text);
      if (part.type === 'image_url' && part.image_url?.url) attachments.add(part.image_url.url);
    }
    return { ...message, content: text.join('\n') };
  });
  return completeLegacy(textMessages, [...attachments]);
}
