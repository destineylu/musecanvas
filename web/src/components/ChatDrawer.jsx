import { useEffect, useRef, useState } from 'react';
import {
  Bot, ChevronDown, Copy, Expand, FileText, Image as ImageIcon, Loader2, MessageSquare,
  Minimize2, Paperclip, Send, Sparkles, Trash2, X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api.js';
import { useToast } from './ui.jsx';

const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const MAX_TEXT_FILE_CHARS = 50_000;
const MAX_CONTEXT_CHARS = 120_000;
const MAX_FILES = 10;
const SHOT_HEADING = /^(?:#{1,4}\s*)?(?:镜头|分镜|shot)\s*(?:[\d一二三四五六七八九十百零〇两]+)?\s*[:：.、|｜-]?.*$/i;

function extensionOf(name) {
  return String(name || '').toLowerCase().match(/\.[^.]+$/)?.[0] || '';
}

function attachmentIcon(file) {
  return file?.mime?.startsWith('image/') ? ImageIcon : FileText;
}

export default function ChatDrawer({ canvasId, canvasName, documentAttachments, open, onClose, onInsert }) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [pendingFiles, setPendingFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const listRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    let active = true;
    setMessages([]);
    setPendingFiles([]);
    setInput('');
    api.canvasChat(canvasId)
      .then((data) => { if (active) setMessages(Array.isArray(data.messages) ? data.messages : []); })
      .catch((error) => { if (active) toast(`读取 Muse 对话失败：${error.message}`, 'error'); });
    return () => { active = false; };
  }, [canvasId, toast]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, busy, open]);

  const attachmentCount = messages.reduce((total, message) => total + (message.attachments?.length || 0), 0)
    + pendingFiles.length;

  const addFiles = async (fileList) => {
    const files = Array.from(fileList || []).map((file, index) => {
      if (file.name) return file;
      const ext = file.type === 'image/jpeg' ? 'jpg' : file.type.split('/')[1] || 'bin';
      return new File([file], `粘贴素材-${index + 1}.${ext}`, { type: file.type });
    });
    if (!files.length) return;
    if (attachmentCount + files.length > MAX_FILES) {
      toast(`一段 Muse 对话最多附加 ${MAX_FILES} 个文件，清空对话后可以重新开始`, 'error');
      return;
    }
    setUploading(true);
    const added = [];
    try {
      for (const file of files) {
        if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} 超过 25 MB`);
        const ext = extensionOf(file.name);
        if (TEXT_EXTENSIONS.has(ext)) {
          const text = await file.text();
          if (!text.trim()) throw new Error(`${file.name} 没有可读取的文字`);
          if (text.length > MAX_TEXT_FILE_CHARS) {
            throw new Error(`${file.name} 超过 ${MAX_TEXT_FILE_CHARS.toLocaleString()} 字，请拆分后再附加`);
          }
          added.push({ name: file.name, mime: file.type || 'text/plain', text });
          continue;
        }

        const supportedImage = /^image\/(png|jpeg|gif|webp|heic|heif|avif)$/i.test(file.type)
          || /\.(png|jpe?g|gif|webp|heic|heif|avif)$/i.test(file.name);
        const supportedDoc = documentAttachments && /\.(pdf|docx?)$/i.test(file.name);
        if (!supportedImage && !supportedDoc) {
          throw new Error(`暂不支持 ${file.name}，可附加图片、MD 或 TXT`);
        }
        const result = await api.upload([file]);
        const uploaded = result.files?.[0];
        if (!uploaded) throw new Error(`${file.name} 上传失败`);
        added.push({ name: file.name, mime: uploaded.mime, url: uploaded.url, bytes: uploaded.bytes });
      }
      setPendingFiles((current) => [...current, ...added]);
    } catch (error) {
      toast(error.message || '附件读取失败', 'error');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const send = async () => {
    const text = input.trim();
    if ((!text && !pendingFiles.length) || busy || uploading) return;
    const totalText = messages.reduce((sum, message) => sum
      + (message.attachments || []).reduce((n, file) => n + (file.text?.length || 0), 0), 0)
      + pendingFiles.reduce((sum, file) => sum + (file.text?.length || 0), 0);
    if (totalText > MAX_CONTEXT_CHARS) {
      toast(`文档文字总量超过 ${MAX_CONTEXT_CHARS.toLocaleString()} 字，请清空对话后分段处理`, 'error');
      return;
    }

    const next = [...messages, {
      role: 'user', content: text, ...(pendingFiles.length ? { attachments: pendingFiles } : {}),
    }];
    setMessages(next);
    setInput('');
    setPendingFiles([]);
    setBusy(true);
    try {
      const out = await api.chat({ canvasId, messages: next });
      setMessages(Array.isArray(out.messages) ? out.messages : [...next, { role: 'assistant', content: out.content || '（空响应）' }]);
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制到剪贴板', 'ok');
    } catch {
      toast('复制失败', 'error');
    }
  };

  const clear = async () => {
    if (!messages.length && !pendingFiles.length) return;
    if (!window.confirm('清空这张画布的 Muse 对话记录？')) return;
    try {
      await api.clearCanvasChat(canvasId);
      setMessages([]);
      setPendingFiles([]);
      toast('对话记录已清空', 'ok');
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  if (!open) return null;

  return (
    <aside id="canvasAssistant" aria-label="Muse 对话" className={clsx('muse-assistant', expanded && 'is-expanded')}>
      <header className="muse-assistant-header flex shrink-0 items-center justify-between px-3.5 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-500/10 text-brand-600"><Bot size={17} /></span>
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold text-[#171a24]">Muse 对话</h2>
            <p className="truncate text-[11px] text-mist-400">{canvasName || '当前画布'} · 对话按画布保存</p>
          </div>
        </div>
        <div className="flex cursor-default items-center gap-1">
          <button type="button" onClick={clear} title="清空本画布对话" aria-label="清空本画布对话" className="grid h-8 w-8 place-items-center rounded-lg text-mist-400 transition hover:bg-rose-50 hover:text-rose-500"><Trash2 size={14} /></button>
          <button type="button" onClick={() => setExpanded((value) => !value)} title={expanded ? '缩窄面板' : '展开面板'} aria-label={expanded ? '缩窄面板' : '展开面板'} className="grid h-8 w-8 place-items-center rounded-lg text-mist-400 transition hover:bg-[#f2f4f9] hover:text-[#171a24]">{expanded ? <Minimize2 size={14} /> : <Expand size={14} />}</button>
          <button type="button" onClick={onClose} title="收起对话" aria-label="收起 Muse 对话" className="grid h-8 w-8 place-items-center rounded-lg text-mist-400 transition hover:bg-[#f2f4f9] hover:text-[#171a24]"><ChevronDown size={16} /></button>
        </div>
      </header>

      <div ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-[#fafbfe] p-4">
        {messages.length === 0 ? (
          <div className="flex h-full min-h-64 flex-col items-center justify-center px-6 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-xl bg-brand-500/10 text-brand-500"><Sparkles size={22} /></span>
            <p className="mt-3 max-w-64 text-[12px] leading-5 text-mist-300">让 Muse 整理提示词或拆分镜头，再把回复放入画布。</p>
          </div>
        ) : messages.map((message, index) => {
          const isAssistant = message.role === 'assistant';
          return (
            <article key={`${index}-${message.role}`} className={clsx('flex gap-2.5', !isAssistant && 'justify-end')}>
              {isAssistant && <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand-500/10 text-brand-600"><Sparkles size={14} /></span>}
              <div className={clsx('min-w-0 max-w-[88%] rounded-xl px-3 py-2.5', isAssistant ? 'border border-ink-600 bg-ink-800 text-ink-950' : 'muse-send')}>
                {message.attachments?.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {message.attachments.map((file, fileIndex) => {
                      const FileIcon = attachmentIcon(file);
                      return (
                        <span key={`${file.name}-${fileIndex}`} title={file.name} className={clsx('inline-flex max-w-full items-center gap-1.5 rounded-lg px-2 py-1 text-[10.5px]', isAssistant ? 'bg-[#f3f5fa] text-[#5c6477]' : 'bg-white/15 text-white')}>
                          <FileIcon size={12} className="shrink-0" /><span className="max-w-48 truncate">{file.name}</span>
                        </span>
                      );
                    })}
                  </div>
                )}
                {message.content && <p className="whitespace-pre-wrap break-words text-[12.5px] leading-[1.65]">{message.content}</p>}
                {isAssistant && message.content && (
                  <div className="mt-2 flex flex-wrap gap-3 border-t border-[#f0f2f7] pt-2">
                    <button type="button" onClick={() => copy(message.content)} className="inline-flex items-center gap-1 text-[10.5px] text-mist-400 transition hover:text-brand-600"><Copy size={11} />复制</button>
                    {message.content.split(/\r?\n/).filter((line) => SHOT_HEADING.test(line.trim())).length > 1 && (
                      <button type="button" onClick={() => onInsert(message.content, true)} className="inline-flex items-center gap-1 text-[10.5px] text-brand-600 transition hover:text-brand-700"><MessageSquare size={11} />拆分为镜头节点</button>
                    )}
                    <button type="button" onClick={() => onInsert(message.content, false)} className="inline-flex items-center gap-1 text-[10.5px] text-brand-600 transition hover:text-brand-700"><MessageSquare size={11} />放入一个节点</button>
                  </div>
                )}
              </div>
            </article>
          );
        })}
        {busy && <div className="flex items-center gap-2 pl-9 text-[11.5px] text-mist-400"><Loader2 size={13} className="animate-spin text-brand-500" />Muse 正在思考…</div>}
      </div>

      <div className="shrink-0 border-t border-[#edf0f6] bg-white p-3">
        {pendingFiles.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {pendingFiles.map((file, index) => {
              const FileIcon = attachmentIcon(file);
              return <span key={`${file.name}-${index}`} title={file.name} className="inline-flex max-w-[48%] items-center gap-1.5 rounded-lg border border-[#e6eaf2] bg-[#f7f8fc] py-1 pl-2 pr-1 text-[10.5px] text-[#596176]"><FileIcon size={12} className="shrink-0 text-brand-500" /><span className="max-w-36 truncate">{file.name}</span><button type="button" onClick={() => setPendingFiles((current) => current.filter((_, i) => i !== index))} aria-label={`移除${file.name}`} className="ml-0.5 grid h-5 w-5 place-items-center rounded-md hover:bg-white hover:text-rose-500"><X size={11} /></button></span>;
            })}
          </div>
        )}
        <div className="flex items-end gap-2 muse-chat-composer rounded-xl border p-2 focus-within:border-brand-400/60">
          <input ref={fileRef} type="file" multiple accept={"image/png,image/jpeg,image/webp,image/gif,image/heic,image/avif,.md,.markdown,.txt" + (documentAttachments ? ",.pdf,.doc,.docx" : "")} className="hidden" onChange={(event) => addFiles(event.target.files)} />
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy || uploading} title="添加图片或文档" aria-label="添加图片或文档" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-mist-400 transition hover:bg-white hover:text-brand-600 disabled:opacity-50">{uploading ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />}</button>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.items || [])
                .filter((item) => item.kind === 'file')
                .map((item) => item.getAsFile())
                .filter(Boolean);
              if (!files.length) return;
              event.preventDefault();
              addFiles(files);
            }}
            maxLength={20_000}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }}
            rows={2}
            placeholder="发消息给 Muse，Enter 发送"
            className="max-h-32 min-h-[42px] min-w-0 flex-1 resize-y bg-transparent px-1 py-2 text-[12.5px] leading-relaxed text-ink-950 outline-none placeholder:text-mist-400"
          />
          <button type="button" onClick={send} disabled={busy || uploading || (!input.trim() && !pendingFiles.length)} title="发送给 Muse" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg muse-send transition hover:brightness-105 disabled:opacity-45">{busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}</button>
        </div>
        <p className="mt-1.5 px-1 text-[10px] text-mist-400">{documentAttachments ? '支持图片、PDF、Word、Markdown 和纯文本附件。' : '支持图片、Markdown 和纯文本附件。'}</p>
      </div>
    </aside>
  );
}
