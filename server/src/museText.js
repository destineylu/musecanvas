import { CFG, usesMuse2api } from './config.js';
import { complete as completeBridge } from './muse.js';
import { complete as completeLegacy } from './muse2api.js';

export const textModel = () => usesMuse2api ? 'muse-spark' : CFG.bridgeModels.chat;

export function completeText(messages) {
  if (!usesMuse2api) return completeBridge(textModel(), messages);
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
