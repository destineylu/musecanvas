import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Type, Image as ImageIcon, Video, Trash2, ZoomIn, ZoomOut, Maximize, Loader2, Sparkles,
  MousePointer2, Map as MapIcon, Expand, Upload, Send, X, ListChecks, Crosshair, MessageSquare, Settings, Hand, Link2, CircleHelp, Clapperboard, GripVertical, FolderOpen, History, BookOpen, LayoutGrid,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api.js';
import { useAuth } from '../store/auth.jsx';
import { useToast } from '../components/ui.jsx';
import ChatDrawer from '../components/ChatDrawer.jsx';
import ShortcutsGuide from '../components/ShortcutsGuide.jsx';
import DirectorStage from '../components/director/DirectorStage.jsx';
import CanvasWorkbench from '../components/CanvasWorkbench.jsx';
import { arrangeNodes, cleanShots } from '../../../shared/canvas-workflow.js';
import ImageToolbar from '../components/canvas/ImageToolbar.jsx';
import InpaintEditor from '../components/canvas/InpaintEditor.jsx';
import PanoramaViewer from '../components/canvas/PanoramaViewer.jsx';
import { GridSplitPanel } from '../components/canvas/ToolPanels.jsx';
import { AngleStudio, LightingStudio } from '../components/canvas/Panels3D.jsx';
import { IMAGE_SIZES, nearestImageSize, panoramaPrompt, splitImage } from '../components/canvas/imageTools.js';
import '../canvas.css';

const NODE_W = 280;
const TEXT_H = 200;
const CARD_PAD = 6;
const HEAD_H = 30;
const MINIMAP_W = 176;
const MINIMAP_H = 116;
const VIDEO_SIZES = ['9:16', '16:9', '1:1', '3:4', '4:3', '21:9'];
const VIDEO_DURATIONS = [5, 6, 8, 10];

const TASK_STAGES = { queued: '排队中', generating: '生成中', paused: '等待切回原上游', downloading: '下载素材', done: '已完成', failed: '生成失败' };
const taskStage = (node) => node.status === 'running' ? (node.phase || 'generating') : node.status;

function parseRatio(value) {
  const matched = String(value || '').match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (!matched) return null;
  const width = Number(matched[1]);
  const height = Number(matched[2]);
  return width > 0 && height > 0 ? width / height : null;
}

function frameRatio(n) {
  if (!n) return 1;
  if (n.type === 'director') return parseRatio(n.director?.settings?.ratio?.replace('2.39:1', '239:100')) || 16 / 9;
  if (n.mediaUrl && n.mediaW && n.mediaH) return n.mediaW / n.mediaH;
  if (sends(n)) return parseRatio(n.size) || (n.type === 'video' ? 16 / 9 : 1);
  return parseRatio(n.size) || 3 / 4;
}

function previewBox(n) {
  const ratio = frameRatio(n);
  const width = ratio >= 3 ? 420 : ratio >= 1.7 ? 360 : ratio <= 0.72 ? 230 : 280;
  const height = Math.round(Math.min(600, Math.max(96, width / ratio)));
  return { width, height, ratio };
}

function nodeW(n) {
  if (!n) return NODE_W;
  if (n.type === 'text') return n.width || NODE_W;
  return previewBox(n).width + CARD_PAD * 2;
}

function sends(n) {
  if (!n || n.type === 'text' || n.type === 'director') return false;
  if (n.intent === 'asset') return false;
  if (n.intent === 'generate') return true;
  return !n.mediaUrl || !!n.jobId;
}

const nodeH = (n) => {
  if (!n) return TEXT_H;
  if (n.type === 'text') return n.height || TEXT_H;
  return previewBox(n).height + CARD_PAD * 2;
};

function mediaFilesFromList(list) {
  return Array.from(list || []).filter((f) => /^(image|video)\//.test(f.type || ''));
}

function mediaFilesFromClipboard(data) {
  if (!data) return [];
  const direct = mediaFilesFromList(data.files);
  if (direct.length) return direct;
  const out = [];
  for (const item of data.items || []) {
    if (item.kind === 'file' && /^(image|video)\//.test(item.type || '')) {
      const file = item.getAsFile();
      if (file) out.push(file);
    }
  }
  return out;
}

function isVideoFile(meta) {
  return (meta?.mime || '').startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(meta?.name || meta?.url || '');
}

let seq = 1;
const newId = () => `n_${Date.now().toString(36)}_${seq++}`;

const defaultDoc = () => ({
  nodes: [
    {
      id: newId(),
      type: 'text',
      x: 360,
      y: 240,
      text: '写下提示词，再从右侧圆点拖到图片或视频节点。',
      label: '文本1',
    },
  ],
  links: [],
});

function pruneLinks(d) {
  const ids = new Set(d.nodes.map((n) => n.id));
  return { ...d, links: (d.links || []).filter((l) => ids.has(l.from) && ids.has(l.to)) };
}

function addLink(doc, from, to) {
  if (!from || !to || from === to) return doc;
  const links = doc.links || [];
  if (links.some((l) => l.from === from && l.to === to)) return doc;
  return { ...doc, links: [...links, { from, to }] };
}

function portPoint(node, side) {
  return {
    x: side === 'out' ? node.x + nodeW(node) : node.x,
    y: node.y + nodeH(node) / 2,
  };
}

function bezier(x1, y1, x2, y2) {
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

function splitShotReply(text) {
  const lines = String(text || '').split(/\r?\n/);
  const sections = [];
  let current = null;
  let intro = [];
  const heading = /^(?:#{1,4}\s*)?(?:镜头|分镜|shot)\s*(?:[\d一二三四五六七八九十百零〇两]+)?\s*[:：.、|｜-]?.*$/i;
  for (const line of lines) {
    if (heading.test(line.trim())) {
      if (current) sections.push(current);
      else if (intro.some((item) => item.trim())) sections.push({ label: '分镜说明', text: intro.join('\n').trim() });
      current = { label: line.trim().replace(/^#+\s*/, '').slice(0, 40) || `镜头 ${sections.length + 1}`, text: line };
    } else if (current) {
      current.text += `\n${line}`;
    } else {
      intro.push(line);
    }
  }
  if (current) sections.push(current);
  return sections.length > 1 && sections.length <= 60 ? sections.map((section) => ({ ...section, text: section.text.trim() })) : [];
}

export default function Canvas() {
  const { canvasId } = useParams();
  const nav = useNavigate();
  const { user, refresh } = useAuth();
  const toast = useToast();

  const [doc, setDoc] = useState(defaultDoc);
  const [canvasInfo, setCanvasInfo] = useState(null);
  const [canvasLoaded, setCanvasLoaded] = useState(false);

  const [view, setView] = useState({ x: 0, y: 0, z: 1 });
  const [selected, setSelected] = useState([]);
  const [selectedLink, setSelectedLink] = useState(null);
  const [previewMedia, setPreviewMedia] = useState(null);
  const [previewScale, setPreviewScale] = useState(1);
  const [busy, setBusy] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [upstream, setUpstream] = useState(null);
  useEffect(() => {
    let active = true;
    const sync = () => api.upstream().then(data => { if (active) setUpstream(data); }).catch(() => {});
    sync();
    window.addEventListener('focus', sync);
    window.addEventListener('muse-upstream-changed', sync);
    return () => { active = false; window.removeEventListener('focus', sync); window.removeEventListener('muse-upstream-changed', sync); };
  }, []);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panTool, setPanTool] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saved, setSaved] = useState(true);
  const [saveError, setSaveError] = useState(false);
  const [vpSize, setVpSize] = useState({ w: 800, h: 500 });
  const [draft, setDraft] = useState(null);
  const [menu, setMenu] = useState(null);
  const [selectionRect, setSelectionRect] = useState(null);
  const [canvasGesture, setCanvasGesture] = useState('idle');
  const [tool, setTool] = useState(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [directorId, setDirectorId] = useState(null);
  const [workbench, setWorkbench] = useState(null);
  const [minimapOpen, setMinimapOpen] = useState(() => { try { return localStorage.getItem('mua_minimap') !== '0'; } catch { return true; } });
  const clipboardKey = `mua_canvas_clipboard_${user?.id || user?.email || 'account'}`;

  const viewportRef = useRef(null);
  const dragRef = useRef(null);
  const viewRef = useRef(view);
  const docRef = useRef(doc);
  const fileRef = useRef(null);
  const uploadTarget = useRef(null);
  const uploadPoint = useRef(null);
  const hoverRef = useRef(null);
  viewRef.current = view;
  docRef.current = doc;

  useEffect(() => {
    if (!previewMedia) return undefined;
    const onKeyDown = (event) => { if (event.key === 'Escape') setPreviewMedia(null); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewMedia]);

  useEffect(() => {
    let active = true;
    setCanvasLoaded(false);
    setCanvasInfo(null);
    setSelected([]);
    setSelectedLink(null);
    const loadCanvas = canvasId === 'scratch'
      ? api.scratchProject().then(({ project }) => api.canvas(project.canvases[0].id))
      : api.canvas(canvasId);
    loadCanvas.then(({ canvas }) => {
      if (!active) return;
      const document = canvas.document;
      const loadedDoc = Array.isArray(document?.nodes) && Array.isArray(document?.links)
        ? document
        : defaultDoc();
      setDoc(loadedDoc);
      setView(document?.view && Number.isFinite(document.view.z) ? document.view : { x: 0, y: 0, z: 1 });
      setCanvasInfo(canvas);
      setSelected(loadedDoc.nodes.length ? [loadedDoc.nodes[0].id] : []);
      setCanvasLoaded(true);
    }).catch((error) => {
      if (!active) return;
      toast(error.message, 'error');
      nav('/projects', { replace: true });
    });
    return () => { active = false; };
  }, [canvasId, nav, toast]);

  useEffect(() => {
    if (!canvasLoaded) return undefined;
    setSaved(false);
    setSaveError(false);
    const t = setTimeout(() => {
      api.saveCanvas(canvasInfo.id, { document: { ...doc, view } })
        .then(() => setSaved(true))
        .catch((error) => {
          setSaveError(true);
          toast(`画布保存失败：${error.message}`, 'error');
        });
    }, 400);
    return () => clearTimeout(t);
  }, [canvasId, canvasInfo, canvasLoaded, doc, view, toast]);

  const screenToCanvas = (clientX, clientY) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - v.x) / v.z,
      y: (clientY - rect.top - v.y) / v.z,
    };
  };

  const zoomBy = (factor, cx, cy) => {
    setView((v) => {
      const z = Math.min(2.5, Math.max(0.08, v.z * factor));
      const rect = viewportRef.current?.getBoundingClientRect();
      const px = cx ?? (rect ? rect.width / 2 : 0);
      const py = cy ?? (rect ? rect.height / 2 : 0);
      const nx = px - ((px - v.x) / v.z) * z;
      const ny = py - ((py - v.y) / v.z) * z;
      return { x: nx, y: ny, z };
    });
  };

  const onWheel = (e) => {
    e.preventDefault();
    const rect = viewportRef.current?.getBoundingClientRect();
    const cx = rect ? e.clientX - rect.left : undefined;
    const cy = rect ? e.clientY - rect.top : undefined;
    zoomBy(Math.exp(-e.deltaY * 0.002), cx, cy);
  };

  useEffect(() => {
    const handleWheel = (event) => {
      const viewport = viewportRef.current;
      const studio = viewport?.closest('.mua-viewport');
      if (!viewport || !studio?.contains(event.target)) return;
      // 面板、对话框、菜单内部保留自身滚动；其余位置（含节点、工具条、提示词编辑器）滚轮缩放画布。
      if (event.target.closest?.('.mf-tool-panel, .muse-assistant, .mf-task-panel, .mf-menu, .muse-minimap')) {
        if (event.ctrlKey) event.preventDefault();
        return;
      }
      const textarea = event.target.closest?.('textarea');
      if (textarea && !event.ctrlKey) {
        const maxScrollTop = textarea.scrollHeight - textarea.clientHeight;
        const canScrollTextarea = event.deltaY < 0
          ? textarea.scrollTop > 0
          : event.deltaY > 0 && textarea.scrollTop < maxScrollTop;
        if (maxScrollTop > 1 && canScrollTextarea) return;
      }
      onWheel(event);
      event.stopPropagation();
    };
    window.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    return () => window.removeEventListener('wheel', handleWheel, true);
  }, []);

  useEffect(() => {
    const down = (event) => {
      if (event.code !== 'Space' || event.altKey || event.ctrlKey || event.metaKey ||
          event.target.closest?.('textarea, input, button, select, a, [contenteditable]')) return;
      event.preventDefault();
      setSpaceHeld(true);
    };
    const release = (event) => { if (event.type === 'blur' || event.code === 'Space') setSpaceHeld(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', release);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', release);
      window.removeEventListener('blur', release);
    };
  }, []);

  const onBackgroundDown = (e) => {
    if (e.button === 2) return;
    if (e.button === 1 || (e.button === 0 && (spaceHeld || panTool))) {
      e.preventDefault();
      setCanvasGesture('pan');
      setMenu(null);
      dragRef.current = {
        mode: 'pan',
        startX: e.clientX,
        startY: e.clientY,
        ox: viewRef.current.x,
        oy: viewRef.current.y,
      };
      return;
    }
    if (e.button !== 0 || e.detail > 1 || (e.target !== e.currentTarget && !e.target.dataset.canvasbg)) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const baseSelection = e.shiftKey ? selected : [];
    setCanvasGesture('select');
    setSelectionRect({ x1: x, y1: y, x2: x, y2: y });
    setSelected(baseSelection);
    setSelectedLink(null);
    setMenu(null);
    dragRef.current = { mode: 'marquee', startX: x, startY: y, baseSelection };
  };

  const onNodeDown = (e, node) => {
    if (e.button === 2) {
      e.preventDefault();
      e.stopPropagation();
      setSelected((current) => e.shiftKey
        ? (current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id])
        : [node.id]);
      setSelectedLink(null);
      setMenu(null);
      return;
    }
    if (e.button !== 0) return;
    if (!e.target.closest('[data-drag-handle]') && e.target.closest('[data-port], textarea, button, input, select')) return;
    if (spaceHeld || panTool) {
      e.stopPropagation();
      onBackgroundDown(e);
      return;
    }
    e.stopPropagation();
    setSelectedLink(null);
    const alreadySelected = selected.includes(node.id);
    if (e.shiftKey && alreadySelected) {
      setSelected((sel) => sel.filter((id) => id !== node.id));
      return;
    }
    const group = e.shiftKey
      ? [...new Set([...selected, node.id])]
      : alreadySelected ? selected : [node.id];
    setSelected(group);
    const origins = {};
    for (const n of doc.nodes) {
      if (group.includes(n.id)) origins[n.id] = { x: n.x, y: n.y };
    }
    dragRef.current = {
      mode: 'node',
      id: node.id,
      startX: e.clientX,
      startY: e.clientY,
      nodeX: node.x,
      nodeY: node.y,
      origins,
    };
  };

  const onPortDown = (e, node, side) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const p = screenToCanvas(e.clientX, e.clientY);
    dragRef.current = { mode: 'link', from: node.id, side, x: p.x, y: p.y };
    setDraft({ from: node.id, side, x: p.x, y: p.y });
  };

  const onResizeDown = (e, node) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      mode: 'resize',
      id: node.id,
      startX: e.clientX,
      startY: e.clientY,
      width: nodeW(node),
      height: nodeH(node),
    };
  };

  useEffect(() => {
    const toCanvas = (clientX, clientY) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      const v = viewRef.current;
      if (!rect) return { x: 0, y: 0 };
      return {
        x: (clientX - rect.left - v.x) / v.z,
        y: (clientY - rect.top - v.y) / v.z,
      };
    };
    const finishLink = (e, d) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const marked = el?.closest?.('[data-node-id]');
      const targetId = marked?.getAttribute('data-node-id');
      if (!targetId) {
        const rect = viewportRef.current?.getBoundingClientRect();
        if (!rect || e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
        const x = Math.min(Math.max(8, e.clientX - rect.left), rect.width - 188);
        const y = Math.min(Math.max(8, e.clientY - rect.top), rect.height - 196);
        setMenu({ x, y, point: toCanvas(e.clientX, e.clientY), link: { from: d.from, side: d.side } });
        setSelected([]);
        setSelectedLink(null);
        return;
      }
      if (targetId === d.from) return;
      const from = d.side === 'in' ? targetId : d.from;
      const to = d.side === 'in' ? d.from : targetId;
      if (from === to) return;
      setDoc((prev) => addLink(prev, from, to));
      setSelectedLink({ from, to });
      setSelected([to]);
    };
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.mode === 'pan') {
        setView((v) => ({ ...v, x: d.ox + (e.clientX - d.startX), y: d.oy + (e.clientY - d.startY) }));
        return;
      }
      if (d.mode === 'marquee') {
        const rect = viewportRef.current?.getBoundingClientRect();
        if (!rect) return;
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const bounds = {
          left: Math.min(d.startX, x),
          top: Math.min(d.startY, y),
          right: Math.max(d.startX, x),
          bottom: Math.max(d.startY, y),
        };
        setSelectionRect({ x1: d.startX, y1: d.startY, x2: x, y2: y });
        const v = viewRef.current;
        const hits = docRef.current.nodes.filter((node) => {
          const left = v.x + node.x * v.z;
          const top = v.y + node.y * v.z;
          const right = left + nodeW(node) * v.z;
          const bottom = top + nodeH(node) * v.z;
          return left <= bounds.right && right >= bounds.left && top <= bounds.bottom && bottom >= bounds.top;
        }).map((node) => node.id);
        setSelected([...new Set([...d.baseSelection, ...hits])]);
        return;
      }
      if (d.mode === 'link') {
        const p = toCanvas(e.clientX, e.clientY);
        setDraft({ from: d.from, side: d.side, x: p.x, y: p.y });
        return;
      }
      if (d.mode === 'resize') {
        const z = viewRef.current.z || 1;
        const width = Math.min(720, Math.max(220, d.width + (e.clientX - d.startX) / z));
        const height = Math.min(720, Math.max(184, d.height + (e.clientY - d.startY) / z));
        setDoc((prev) => ({
          ...prev,
          nodes: prev.nodes.map((n) => n.id === d.id ? { ...n, width, height } : n),
        }));
        return;
      }
      if (d.mode === 'node') {
        const z = viewRef.current.z || 1;
        const cdx = (e.clientX - d.startX) / z;
        const cdy = (e.clientY - d.startY) / z;
        setDoc((prev) => ({
          ...prev,
          nodes: prev.nodes.map((n) => {
            if (d.origins?.[n.id]) return { ...n, x: d.origins[n.id].x + cdx, y: d.origins[n.id].y + cdy };
            if (n.id === d.id) return { ...n, x: d.nodeX + cdx, y: d.nodeY + cdy };
            return n;
          }),
        }));
      }
    };
    const onUp = (e) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d?.mode === 'link') finishLink(e, d);
      if (d?.mode === 'marquee') setSelectionRect(null);
      setCanvasGesture('idle');
      setDraft(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (workbench) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'c') {
        const nodes = doc.nodes.filter((node) => selected.includes(node.id));
        if (!nodes.length) return;
        e.preventDefault();
        const ids = new Set(nodes.map((node) => node.id));
        const links = (doc.links || []).filter((link) => ids.has(link.from) && ids.has(link.to));
        try {
          localStorage.setItem(clipboardKey, JSON.stringify({ version: 1, nodes, links }));
          toast(`已复制 ${nodes.length} 个节点，可切换画布粘贴`, 'ok');
        } catch {
          toast('复制失败，浏览器本地存储空间不足', 'error');
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedLink && !selected.length) {
          e.preventDefault();
          setDoc((d) => ({
            ...d,
            links: (d.links || []).filter((l) => !(l.from === selectedLink.from && l.to === selectedLink.to)),
          }));
          setSelectedLink(null);
          return;
        }
        if (!selected.length) return;
        e.preventDefault();
        setDoc((d) => pruneLinks({ ...d, nodes: d.nodes.filter((n) => !selected.includes(n.id)) }));
        setSelected([]);
        setSelectedLink(null);
      }
      if (e.key === 'Escape') {
        setTool(null);
        setSelected([]);
        setSelectedLink(null);
        setMenu(null);
        setSelectionRect(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, selectedLink, doc, clipboardKey, toast, workbench]);

  const centerPoint = () => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return screenToCanvas(
      (rect?.left ?? 0) + (viewportRef.current?.clientWidth ?? 400) / 2,
      (rect?.top ?? 0) + (viewportRef.current?.clientHeight ?? 300) / 2
    );
  };

  const pasteCopiedNodes = () => {
    let copied;
    try { copied = JSON.parse(localStorage.getItem(clipboardKey) || 'null'); } catch { copied = null; }
    if (!Array.isArray(copied?.nodes) || !copied.nodes.length) return false;
    const idMap = new Map(copied.nodes.map((node) => [node.id, newId()]));
    const bounds = copied.nodes.reduce((box, node) => ({
      minX: Math.min(box.minX, node.x || 0),
      minY: Math.min(box.minY, node.y || 0),
      maxX: Math.max(box.maxX, (node.x || 0) + nodeW(node)),
      maxY: Math.max(box.maxY, (node.y || 0) + nodeH(node)),
    }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    const center = centerPoint();
    const offsetX = center.x - (bounds.maxX - bounds.minX) / 2 - bounds.minX;
    const offsetY = center.y - (bounds.maxY - bounds.minY) / 2 - bounds.minY;
    const nodes = copied.nodes.map((node) => ({
      ...node,
      id: idMap.get(node.id),
      x: Math.round((node.x || 0) + offsetX),
      y: Math.round((node.y || 0) + offsetY),
    }));
    const links = (copied.links || [])
      .filter((link) => idMap.has(link.from) && idMap.has(link.to))
      .map((link) => ({ ...link, from: idMap.get(link.from), to: idMap.get(link.to) }));
    setDoc((current) => ({ ...current, nodes: [...current.nodes, ...nodes], links: [...(current.links || []), ...links] }));
    setSelected(nodes.map((node) => node.id));
    setSelectedLink(null);
    setMenu(null);
    toast(`已粘贴 ${nodes.length} 个节点`, 'ok');
    return true;
  };

  const addNode = (type, extra = {}, point) => {
    const center = point || centerPoint();
    const n = {
      id: newId(),
      type,
      intent: extra.intent || (type === 'text' ? 'input' : 'generate'),
      x: Math.round(center.x - nodeW({ type, intent: extra.intent || (type === 'text' ? 'input' : 'generate'), size: type === 'video' ? '16:9' : '1:1' }) / 2),
      y: Math.round(center.y - 36),
      text: type === 'text' ? (extra.text || '在这里写下提示词') : '',
      label: extra.label || (type === 'text' ? '文本' : type === 'image' ? '图片生成' : '视频生成'),
      ...(type === 'text' && extra.width ? { width: extra.width } : {}),
      ...(type === 'text' && extra.height ? { height: extra.height } : {}),
      size: type === 'video' ? '16:9' : '1:1',
      duration: 5,
      status: 'idle',
    };
    if (type === 'director' && !point) {
      const anchor = doc.nodes.find(item => selected.includes(item.id));
      n.x = anchor ? anchor.x + nodeW(anchor) + 64 : Math.round(center.x + 48);
      n.y = anchor ? anchor.y : Math.round(center.y - nodeH(n) / 2);
      const overlaps = () => doc.nodes.some(item => n.x < item.x + nodeW(item) + 24 && n.x + nodeW(n) + 24 > item.x && n.y < item.y + nodeH(item) + 36 && n.y + nodeH(n) + 36 > item.y);
      for (let attempt = 0; attempt <= doc.nodes.length && overlaps(); attempt++) n.y += nodeH(n) + 52;
      setView(v => {
        const rect = viewportRef.current?.getBoundingClientRect();
        if (!rect) return v;
        const left = v.x + n.x * v.z, top = v.y + n.y * v.z;
        const right = left + nodeW(n) * v.z, bottom = top + nodeH(n) * v.z;
        const dx = left < 40 ? 40 - left : right > rect.width - 40 ? rect.width - 40 - right : 0;
        const dy = top < 64 ? 64 - top : bottom > rect.height - 96 ? rect.height - 96 - bottom : 0;
        return dx || dy ? { ...v, x: v.x + dx, y: v.y + dy } : v;
      });
    }
    setDoc((d) => ({ ...d, nodes: [...d.nodes, n] }));
    setSelected([n.id]);
    setSelectedLink(null);
    setMenu(null);
    return n.id;
  };

  const insertAgentReply = (text, splitShots = false) => {
    if (!splitShots) {
      addNode('text', { label: /分镜|镜头|shot\s*\d/i.test(text) ? 'Muse 分镜' : 'Muse 回复', text, width: 440, height: 420 }, centerPoint());
      toast('Muse 回复已放入画布', 'ok');
      return;
    }
    const sections = splitShotReply(text);
    if (!sections.length) {
      toast('没有识别到多个镜头标题，请让 Muse 按“镜头 1、镜头 2”分段输出', 'error');
      return;
    }
    const center = centerPoint();
    const columns = Math.min(3, sections.length);
    const gapX = 380;
    const gapY = 330;
    const rows = Math.ceil(sections.length / columns);
    const nodes = sections.map((section, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      return {
        id: newId(), type: 'text', intent: 'input',
        x: Math.round(center.x + column * gapX - ((columns - 1) * gapX) / 2 - 170),
        y: Math.round(center.y + row * gapY - ((rows - 1) * gapY) / 2 - 140),
        width: 340, height: 280, text: section.text,
        label: section.label, size: '1:1', duration: 5, status: 'idle',
      };
    });
    setDoc((current) => ({ ...current, nodes: [...current.nodes, ...nodes] }));
    setSelected(nodes.map((node) => node.id));
    setSelectedLink(null);
    toast(`已将 ${nodes.length} 个分镜放入画布`, 'ok');
  };

  const connectCreatedNode = (nodeId, link) => {
    if (!link) return;
    const from = link.side === 'in' ? nodeId : link.from;
    const to = link.side === 'in' ? link.from : nodeId;
    setDoc((d) => addLink(d, from, to));
    setSelectedLink({ from, to });
    setSelected([nodeId]);
  };

  const removeSelected = () => {
    if (selectedLink && !selected.length) {
      setDoc((d) => ({
        ...d,
        links: (d.links || []).filter((l) => !(l.from === selectedLink.from && l.to === selectedLink.to)),
      }));
      setSelectedLink(null);
      return;
    }
    setDoc((d) => pruneLinks({ ...d, nodes: d.nodes.filter((n) => !selected.includes(n.id)) }));
    setSelected([]);
    setSelectedLink(null);
  };

  const removeNode = id => {
    setDoc(d => pruneLinks({ ...d, nodes: d.nodes.filter(n => n.id !== id) }));
    setSelected(current => current.filter(nodeId => nodeId !== id));
    setSelectedLink(null);
    setTool(current => current?.nodeId === id ? null : current);
    setDirectorId(current => current === id ? null : current);
    setMenu(null);
  };

  const fitView = () => {
    if (!doc.nodes.length) return setView({ x: 0, y: 0, z: 1 });
    const minX = Math.min(...doc.nodes.map((n) => n.x));
    const minY = Math.min(...doc.nodes.map((n) => n.y));
    const maxX = Math.max(...doc.nodes.map((n) => n.x + nodeW(n)));
    const maxY = Math.max(...doc.nodes.map((n) => n.y + nodeH(n)));
    const rect = viewportRef.current?.getBoundingClientRect();
    const w = rect?.width ?? 800;
    const h = rect?.height ?? 500;
    const z = Math.min(1.4, Math.max(0.08, Math.min(w / (maxX - minX + 160), h / (maxY - minY + 160))));
    setView({
      x: w / 2 - ((minX + maxX) / 2) * z,
      y: h / 2 - ((minY + maxY) / 2) * z,
      z,
    });
  };

  const uploadMedia = async (fileList, point, targetId) => {
    const files = mediaFilesFromList(fileList).slice(0, 6);
    if (!files.length) return toast('请粘贴或选择图片、视频文件', 'error');
    setUploading(true);
    try {
      const out = await api.upload(files);
      const created = out.files || [];
      if (!created.length) throw new Error('没有收到文件');
      const base = point || hoverRef.current || centerPoint();
      const makeAsset = (f, i, origin) => {
        const video = isVideoFile(f);
        return {
          id: newId(),
          type: video ? 'video' : 'image',
          intent: 'asset',
          x: Math.round((origin?.x ?? base.x) - NODE_W / 2),
          y: Math.round((origin?.y ?? base.y) - 40 + i * 230),
          text: f.name || '',
          label: video ? '视频素材' : '图片素材',
          mediaUrl: f.url,
          status: 'done',
        };
      };
      if (targetId) {
        const [first, ...rest] = created;
        const host = doc.nodes.find((n) => n.id === targetId);
        const firstVideo = isVideoFile(first);
        const extras = rest.map((f, i) => makeAsset(f, i + 1, host || base));
        setDoc((d) => ({
          ...d,
          nodes: [
            ...d.nodes.map((n) => n.id === targetId ? {
              ...n,
              type: firstVideo ? 'video' : 'image',
              intent: 'asset',
              mediaUrl: first.url,
              mediaW: 0,
              mediaH: 0,
              text: first.name || n.text,
              status: 'done',
              label: firstVideo ? '视频素材' : '图片素材',
            } : n),
            ...extras,
          ],
        }));
      } else {
        const nodes = created.map((f, i) => makeAsset(f, i, base));
        setDoc((d) => ({
          ...d,
          nodes: [...d.nodes, ...nodes],
        }));
        setSelected(nodes.map((n) => n.id));
      }
      toast('素材已放上画布', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setUploading(false);
      uploadTarget.current = null;
      uploadPoint.current = null;
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const openPicker = (accept, point, targetId) => {
    uploadTarget.current = targetId || null;
    uploadPoint.current = point || null;
    if (fileRef.current) {
      fileRef.current.accept = accept;
      fileRef.current.click();
    }
    setMenu(null);
  };

  useEffect(() => {
    const onPaste = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) return;
      const files = mediaFilesFromClipboard(e.clipboardData);
      if (files.length) {
        e.preventDefault();
        uploadMedia(files, hoverRef.current || centerPoint(), null);
        return;
      }
      if (pasteCopiedNodes()) e.preventDefault();
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  const generateNode = async (nodeId) => {
    const node = doc.nodes.find((n) => n.id === nodeId);
    if (!node || !sends(node) || busy || node.status === 'running') return;
    const mode = node.type === 'video' ? 'video' : 'image';
    const sizes = mode === 'video' ? VIDEO_SIZES : IMAGE_SIZES;
    const size = sizes.includes(node.size) ? node.size : (mode === 'video' ? '16:9' : '1:1');
    const duration = VIDEO_DURATIONS.includes(Number(node.duration)) ? Number(node.duration) : 5;
    const incoming = doc.nodes.filter((n) => (doc.links || []).some((l) => l.from === n.id && l.to === nodeId));
    const own = (node.text || '').trim();
    const fromText = incoming.filter((n) => n.type === 'text' && n.text?.trim()).map((n) => n.text.trim());
    const finalPrompt = [own, ...fromText.filter((t) => t !== own)].filter(Boolean).join('\n');
    if (finalPrompt.length < 2) return toast('先在节点里写提示词，或连入一个文本节点', 'error');
    const images = node.refImage ? [node.refImage] : [];
    if (!node.refImage) {
      for (const n of incoming) {
        if (n.type === 'image' && n.mediaUrl && !images.includes(n.mediaUrl)) images.push(n.mediaUrl);
      }
    }

    const maxReferences = upstream?.maxReferences;
    if (maxReferences && images.length > maxReferences) return toast('当前接入方式最多支持 ' + maxReferences + ' 张参考图', 'error');
    setBusy(true);
    try {
      await checkpoint('生成前备份');
      const body = {
        prompt: finalPrompt,
        size,
        images,
        projectId: canvasInfo.projectId,
        canvasId: canvasInfo.id,
        sourceNodeId: nodeId,
      };
      const { job } = mode === 'image'
        ? await api.createImage(body)
        : await api.createVideo({ ...body, duration });
      setDoc((d) => ({
        ...d,
        nodes: d.nodes.map((n) => n.id === nodeId ? {
          ...n,
          intent: 'generate',
          text: own || n.text,
          size,
          duration,
          jobId: job.id,
          status: 'running',
          progress: job.progress || 0,
          phase: job.phase,
          error: null,
          mediaUrl: null,
        } : n),
      }));
      setSelected([nodeId]);
      toast(mode === 'image' ? '图片任务已提交' : '视频任务已提交', 'ok');
      refresh();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const patchNode = (id, patch) => {
    setDoc((d) => ({ ...d, nodes: d.nodes.map((n) => n.id === id ? { ...n, ...patch } : n) }));
  };

  const openMenuAt = (e) => {
    if (e.target.closest('[data-node-id], button, textarea, input, select')) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.min(Math.max(8, e.clientX - rect.left), rect.width - 188);
    const y = Math.min(Math.max(8, e.clientY - rect.top), rect.height - 196);
    setMenu({ x, y, point: screenToCanvas(e.clientX, e.clientY) });
    setSelected([]);
    setSelectedLink(null);
  };

  const syncJobs = useCallback(async () => {
    const running = docRef.current.nodes.filter(n => n.jobId && n.status === 'running');
    if (!running.length) return;
    const results = await Promise.all(running.map(async n => {
      try { return [n.jobId, (await api.job(n.jobId)).job]; }
      catch { return [n.jobId, null]; }
    }));
    const jobs = new Map(results);
    setDoc(current => {
      let changed = false;
      const nodes = current.nodes.map(node => {
        if (node.status !== 'running') return node;
        const job = jobs.get(node.jobId);
        if (!job) return node;
        if (job.status === 'completed') {
          changed = true;
          return { ...node, status: 'done', phase: 'done', mediaUrl: job.mediaUrl || job.result?.localUrl || job.result?.url };
        }
        if (job.status === 'failed') {
          changed = true;
          return { ...node, status: 'failed', phase: 'failed', error: job.error };
        }
        if (node.phase === job.phase && node.progress === job.progress) return node;
        changed = true;
        return { ...node, phase: job.phase, progress: job.progress };
      });
      return changed ? { ...current, nodes } : current;
    });
    if (results.some(([, job]) => job?.status === 'failed')) refresh();
  }, [refresh]);

  const runningCount = doc.nodes.filter(n => n.jobId && n.status === 'running').length;
  useEffect(() => {
    if (!runningCount) return;
    const timer = setInterval(syncJobs, 2500);
    return () => clearInterval(timer);
  }, [runningCount, syncJobs]);

  const focusNode = (node) => {
    const v = viewRef.current;
    setSelectedLink(null);
    setSelected([node.id]);
    setView({ ...v, x: vpSize.w / 2 - (node.x + nodeW(node) / 2) * v.z, y: vpSize.h / 2 - (node.y + nodeH(node) / 2) * v.z });
    setActivityOpen(false);
  };

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setVpSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [canvasLoaded]);

  /* ------------------------- 图片工具：派生节点 ------------------------- */

  const freeSpotBeside = (source, w, h, index = 0) => {
    const nodes = docRef.current.nodes;
    const x = Math.round(source.x + nodeW(source) + 120);
    let y = Math.round(source.y + index * (h + 70));
    const hit = (yy) => nodes.some((n) => n.x < x + w && n.x + nodeW(n) > x && n.y - HEAD_H < yy + h && n.y + nodeH(n) > yy - HEAD_H);
    for (let i = 0; i < 40 && hit(y); i++) y += 90;
    return { x, y };
  };

  const createDerived = async (source, { label, prompt, size, refImage }) => {
    const finalSize = IMAGE_SIZES.includes(size) ? size : nearestImageSize(source.mediaW, source.mediaH);
    try {
      const { job } = await api.createImage({
        prompt, size: finalSize, images: [refImage || source.mediaUrl], projectId: canvasInfo.projectId, canvasId: canvasInfo.id,
      });
      const draftNode = { type: 'image', intent: 'generate', size: finalSize };
      const spot = freeSpotBeside(source, nodeW(draftNode), nodeH(draftNode));
      const node = {
        id: newId(), type: 'image', intent: 'generate', label, text: prompt, size: finalSize, duration: 5,
        ...(refImage ? { refImage } : {}),
        jobId: job.id, status: 'running', progress: job.progress || 0, phase: job.phase, error: null, mediaUrl: null, ...spot,
      };
      setDoc((d) => addLink({ ...d, nodes: [...d.nodes, node] }, source.id, node.id));
      setSelected([node.id]);
      setSelectedLink(null);
      toast(`${label}任务已提交`, 'ok');
      refresh();
      return node;
    } catch (error) {
      toast(error.message, 'error');
      throw error;
    }
  };

  const uploadAll = async (files) => {
    const out = [];
    for (let i = 0; i < files.length; i += 10) {
      const { files: saved = [] } = await api.upload(files.slice(i, i + 10));
      out.push(...saved);
    }
    if (out.length !== files.length) throw new Error('部分图片上传失败');
    return out;
  };

  const placeAssets = (source, items, cols) => {
    const sample = { type: items[0].type || 'image', intent: 'asset', mediaUrl: 'x', mediaW: items[0].w, mediaH: items[0].h };
    const w = nodeW(sample);
    const h = nodeH(sample);
    const origin = freeSpotBeside(source, w * cols + 40 * (cols - 1), h);
    const nodes = items.map((item, i) => ({
      id: newId(), type: item.type || 'image', intent: 'asset', label: item.label, text: item.name || '', mediaUrl: item.url,
      mediaW: item.w, mediaH: item.h, status: 'done', size: '1:1', duration: 5,
      x: origin.x + (i % cols) * (w + 40), y: origin.y + Math.floor(i / cols) * (h + HEAD_H + 40),
    }));
    setDoc((d) => nodes.reduce((acc, n) => addLink(acc, source.id, n.id), { ...d, nodes: [...d.nodes, ...nodes] }));
    setSelected(nodes.map((n) => n.id));
    setSelectedLink(null);
  };

  const checkpoint = label => api.checkpoint(canvasInfo.id,{label,document:{...docRef.current,view:viewRef.current}});

  const fitDocument = document => {
    if(!document.nodes.length)return;
    const rect=viewportRef.current?.getBoundingClientRect();if(!rect)return;
    const minX=Math.min(...document.nodes.map(n=>n.x)),minY=Math.min(...document.nodes.map(n=>n.y));
    const maxX=Math.max(...document.nodes.map(n=>n.x+nodeW(n))),maxY=Math.max(...document.nodes.map(n=>n.y+nodeH(n)));
    const z=Math.max(.08,Math.min(1,(rect.width-140)/Math.max(1,maxX-minX),(rect.height-180)/Math.max(1,maxY-minY)));
    setView({z,x:(rect.width-(maxX-minX)*z)/2-minX*z,y:90-minY*z});
  };

  const restoreDocument = async (document,label) => {
    const {jobs}=await api.generationHistory(canvasInfo.id);
    if(jobs.some(j=>['queued','processing'].includes(j.status)))throw Error('当前画布还有生成任务，请完成后再回退');
    await checkpoint('回退前备份');
    const restored=structuredClone(document);
    restored.nodes=restored.nodes.map(n=>{
      const job=jobs.find(j=>j.id===n.jobId);
      if(!job)return n.status==='running'?{...n,status:'failed',error:'此历史任务已不可恢复'}:n;
      return {...n,status:job.status==='completed'?'done':job.status==='failed'?'failed':n.status,phase:job.phase,mediaUrl:job.mediaUrl||n.mediaUrl,error:job.error||null};
    });
    setDoc(restored);setSelected([]);setSelectedLink(null);setTool(null);
    fitDocument(restored);toast(label||'已恢复画布版本');
  };

  const insertLibraryAssets = async assets => {
    try{
      await checkpoint('插入素材前');
      const point=centerPoint(),current=docRef.current;
      const right=current.nodes.length?Math.max(...current.nodes.map(n=>n.x+nodeW(n)))+80:point.x;
      const nodes=assets.slice(0,30).map((a,i)=>({id:newId(),type:a.type==='video'?'video':'image',intent:'asset',label:(a.label||a.name||'素材').slice(0,80),mediaUrl:a.url,text:a.prompt||'',status:'done',size:'16:9',duration:5,x:right,y:point.y+i*350}));
      setDoc(d=>({...d,nodes:[...d.nodes,...nodes]}));setSelected(nodes.map(n=>n.id));setSelectedLink(null);setWorkbench(null);
      if(nodes.length)fitDocument({nodes,links:[]});toast('素材已加入画布');
    }catch(e){toast(e.message,'error');}
  };

  const applyWorkflow = async plan => {
    if(docRef.current.nodes.length+plan.nodes.length>2000)throw Error('画布最多支持 2000 个节点');
    if(!plan.nodes.length)throw Error('方案没有可应用的节点');
    const mergedShots=plan.fromStoryboard?cleanShots(docRef.current.storyboard||[]):cleanShots([...(docRef.current.storyboard||[]),...(plan.storyboard||[]).map(s=>({...s,id:newId()}))]);
    await checkpoint('应用流程前备份');
    const current=docRef.current,ids=new Map(plan.nodes.map(n=>[n.id,newId()]));
    const offset=current.nodes.length?Math.max(...current.nodes.map(n=>n.x+nodeW(n)))+120:0;
    const nodes=arrangeNodes(plan.nodes,plan.links,n=>({width:nodeW(n),height:nodeH(n)})).map(n=>({...n,id:ids.get(n.id),x:n.x+offset}));
    const links=plan.links.map(l=>({from:ids.get(l.from),to:ids.get(l.to)}));
    setDoc(d=>({...d,nodes:[...d.nodes,...nodes],links:[...(d.links||[]),...links],storyboard:mergedShots}));
    setSelected([nodes.find(n=>sends(n))?.id||nodes[0].id]);setSelectedLink(null);fitDocument({nodes,links});toast('已添加 '+nodes.length+' 个节点，可关闭工作台查看');
  };

  const setStoryboard = rows => {const cleaned=cleanShots(rows);setDoc(d=>({...d,storyboard:cleaned}));};

  const applyHistoricalResult = async job => {
    const target=docRef.current.nodes.find(n=>selected.includes(n.id)&&n.type===job.type);
    if(!target||target.status==='running')throw Error('请先选择一个未在生成的同类型节点');
    await checkpoint('替换历史生成结果前');
    patchNode(target.id,{mediaUrl:job.mediaUrl,jobId:job.id,status:'done',phase:'done',error:null,text:job.prompt,size:job.params.size||target.size,duration:job.params.duration||target.duration});
    toast('已应用历史结果');
  };

  const reuseHistoricalPrompt = job => applyWorkflow({title:'复用生成参数',nodes:[{id:'reuse',type:job.type,intent:'generate',label:'复用历史提示词',text:job.prompt,size:job.params.size||'16:9',duration:job.params.duration||5,status:'idle',x:0,y:0}],links:[]});

  const autoArrange = async () => {
    try{await checkpoint('自动整理前');const current=docRef.current;const next={...current,nodes:arrangeNodes(current.nodes,current.links,n=>({width:nodeW(n),height:nodeH(n)}))};setDoc(next);fitDocument(next);toast('画布已按连线整理，可在历史中回退');}catch(e){toast(e.message,'error');}
  };

  const runGridSplit = async (source, { rows, cols }) => {
    try {
      const { files, width, height } = await splitImage(source.mediaUrl, rows, cols);
      const saved = await uploadAll(files);
      placeAssets(source, saved.map((f, i) => ({
        ...f, label: `${source.label || '图片'} · ${Math.floor(i / cols) + 1}-${(i % cols) + 1}`,
        w: Math.round(width / cols), h: Math.round(height / rows),
      })), cols);
      toast(`已切分为 ${files.length} 个图片节点`, 'ok');
    } catch (error) {
      toast(`宫格切分失败：${error.message}`, 'error');
      throw error;
    }
  };

  const runShotsExport = async (source, shots, kind = '全景截图') => {
    try {
      const saved = await uploadAll(shots.map((s) => s.file));
      placeAssets(source, saved.map((f, i) => ({ ...f, label: shots[i].label, w: shots[i].width || 1280, h: shots[i].height || 720 })), Math.min(kind === '关键帧' ? 4 : 2, saved.length));
      toast(saved.length > 1 ? `已创建 ${saved.length} 张${kind}` : `已创建${kind}`, 'ok');
    } catch (error) {
      toast(`${kind}保存失败：${error.message}`, 'error');
      throw error;
    }
  };

  const runInpaint = async (source, { file, prompt }) => {
    let guide;
    try {
      [guide] = await uploadAll([file]);
    } catch (error) {
      toast(`标注图上传失败：${error.message}`, 'error');
      throw error;
    }
    await createDerived(source, { label: '局部重绘', prompt, size: nearestImageSize(source.mediaW, source.mediaH), refImage: guide.url });
  };

  const openTool = (node, kind, option) => {
    if (kind === 'panorama') {
      const [action, mode] = String(option).split(':');
      if (action === 'preview') return setTool({ kind: 'panorama', nodeId: node.id, mode });
      createDerived(node, {
        label: mode === 'sphere' ? '720° 全景图' : '360° 环绕图',
        prompt: panoramaPrompt(mode),
        size: mode === 'sphere' ? '2:1' : '4:1',
      }).catch(() => {});
      return undefined;
    }
    setTool((t) => (t?.kind === kind && t.nodeId === node.id ? null : { kind, nodeId: node.id }));
    return undefined;
  };

  useEffect(() => {
    if (tool && !doc.nodes.some((n) => n.id === tool.nodeId && n.mediaUrl)) setTool(null);
  }, [doc.nodes, tool]);

  useEffect(() => {
    if (tool && !['inpaint', 'panorama', 'light', 'angle'].includes(tool.kind) && !selected.includes(tool.nodeId)) setTool(null);
  }, [selected, tool]);

  useEffect(() => {
    try { localStorage.setItem('mua_minimap', minimapOpen ? '1' : '0'); } catch { /* 仅影响本机偏好 */ }
  }, [minimapOpen]);

  const nodeById = Object.fromEntries(doc.nodes.map((n) => [n.id, n]));
  const links = (doc.links || []).filter((l) => nodeById[l.from] && nodeById[l.to]);

  const draftPath = (() => {
    if (!draft) return null;
    const n = nodeById[draft.from];
    if (!n) return null;
    const p = portPoint(n, draft.side);
    return draft.side === 'in'
      ? bezier(draft.x, draft.y, p.x, p.y)
      : bezier(p.x, p.y, draft.x, draft.y);
  })();

  if (!canvasLoaded || !canvasInfo) {
    return <div className="grid h-full min-h-64 place-items-center"><Loader2 size={24} className="animate-spin text-brand-500" /></div>;
  }

  /* ------------------------- 屏幕坐标的浮层 ------------------------- */
  const screenRect = (n) => ({
    left: view.x + n.x * view.z,
    top: view.y + n.y * view.z,
    width: nodeW(n) * view.z,
    height: nodeH(n) * view.z,
  });
  const focused = selected.length === 1 ? nodeById[selected[0]] : null;
  const gestureIdle = canvasGesture === 'idle' && !draft;
  const showToolbar = focused && focused.type === 'image' && focused.mediaUrl && focused.status !== 'running' && gestureIdle;
  const showComposer = focused && sends(focused) && gestureIdle;
  const focusedRect = focused ? screenRect(focused) : null;
  const clampX = (center, half) => Math.min(Math.max(center, half + 8), Math.max(half + 8, vpSize.w - half - 8));
  const toolbarStyle = focusedRect && {
    left: clampX(focusedRect.left + focusedRect.width / 2, 300),
    top: Math.max(62, focusedRect.top - 28 * Math.max(view.z, Math.min(1, 2.2 * view.z)) - 52),
  };
  const composerWidth = focusedRect ? Math.min(560, Math.max(420, focusedRect.width), Math.max(200,vpSize.w-24)) : 0;
  const composerStyle = focusedRect && {
    left: clampX(focusedRect.left + focusedRect.width / 2, composerWidth / 2),
    top: Math.max(70,Math.min(focusedRect.top + focusedRect.height + 14,vpSize.h-240)),
    width: composerWidth,
  };
  const toolNode = tool ? nodeById[tool.nodeId] : null;
  const toolRect = toolNode ? screenRect(toolNode) : null;
  const panelStyle = (() => {
    if (!toolRect) return undefined;
    const W = 372;
    let left = toolRect.left + toolRect.width + 18;
    if (left + W > vpSize.w - 8) left = toolRect.left - W - 18;
    left = Math.min(Math.max(8, left), Math.max(8, vpSize.w - W - 8));
    const floor = showToolbar && toolbarStyle ? toolbarStyle.top + 56 : 70;
    const top = Math.min(Math.max(floor, toolRect.top - HEAD_H * view.z), Math.max(floor, vpSize.h - 420));
    return { left, top, maxHeight: vpSize.h - top - 12 };
  })();
  const focusedIncoming = focused
    ? doc.nodes.filter((n) => links.some((l) => l.from === n.id && l.to === focused.id))
    : [];

  return (
    <div className="mua-studio mf-studio relative h-full min-h-0">
      <div className="muse-workbench relative h-full min-h-0 min-w-0">
      <div className="mua-viewport relative h-full min-h-0 min-w-0 overflow-hidden">
        <div
          ref={viewportRef}
          data-canvasbg="1"
          onMouseDown={onBackgroundDown}
          onDoubleClick={(event) => { if (!panTool && !spaceHeld) openMenuAt(event); }}
          onMouseMove={(e) => { hoverRef.current = screenToCanvas(e.clientX, e.clientY); }}
          onDragOver={(e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); }}
          onDrop={(e) => {
            e.preventDefault();
            uploadMedia(e.dataTransfer.files, screenToCanvas(e.clientX, e.clientY), null);
          }}
          onDragStartCapture={(e) => {
            if (e.target.closest?.('.canvas-media')) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          onContextMenu={(e) => e.preventDefault()}
          className={clsx('dot-grid absolute inset-0 select-none', canvasGesture === 'pan' ? 'cursor-grabbing' : canvasGesture === 'select' ? 'cursor-crosshair' : (spaceHeld || panTool) ? 'cursor-grab' : 'cursor-default')}
          style={{
            backgroundSize: `${22 * view.z}px ${22 * view.z}px`,
            backgroundPosition: `${view.x}px ${view.y}px`,
          }}
        >
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}
          >
            <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1">
              {links.map((l) => {
                const a = nodeById[l.from];
                const b = nodeById[l.to];
                const p1 = portPoint(a, 'out');
                const p2 = portPoint(b, 'in');
                const d = bezier(p1.x, p1.y, p2.x, p2.y);
                const on = selectedLink && selectedLink.from === l.from && selectedLink.to === l.to;
                const related = focused && (l.from === focused.id || l.to === focused.id);
                return (
                  <g key={`${l.from}-${l.to}`}>
                    <path
                      d={d}
                      fill="none"
                      stroke="transparent"
                      strokeWidth="14"
                      className="pointer-events-auto cursor-pointer"
                      onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        setSelected([]);
                        setSelectedLink(l);
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setDoc((prev) => ({
                          ...prev,
                          links: (prev.links || []).filter((x) => !(x.from === l.from && x.to === l.to)),
                        }));
                        setSelectedLink(null);
                      }}
                    />
                    <path
                      d={d}
                      fill="none"
                      className={clsx('mf-link', b.status === 'running' && 'is-flow', (on || related) && 'is-on')}
                    />
                  </g>
                );
              })}
              {draftPath && <path d={draftPath} fill="none" className="mf-link is-on is-flow" />}
            </svg>

            {doc.nodes.map((n) => (
              <CanvasNode
                key={n.id}
                node={n}
                active={selected.includes(n.id)}
                zoom={view.z}
                onMouseDown={(e) => onNodeDown(e, n)}
                onPortDown={onPortDown}
                onResizeDown={onResizeDown}
                onText={(text) => patchNode(n.id, { text })}
                onPatch={(patch) => patchNode(n.id, patch)}
                onUpload={() => openPicker('image/*,video/*', { x: n.x + nodeW(n) / 2, y: n.y + nodeH(n) / 2 }, n.id)}
                onPreview={(media) => { setPreviewScale(1); setPreviewMedia(media); }}
                onOpenDirector={() => setDirectorId(n.id)}
                onDelete={() => removeNode(n.id)}
                onEditGenerate={() => focusNode(n)}
              />
            ))}
          </div>
          {selectionRect && (
            <div
              className="mf-marquee pointer-events-none absolute z-10"
              style={{
                left: Math.min(selectionRect.x1, selectionRect.x2),
                top: Math.min(selectionRect.y1, selectionRect.y2),
                width: Math.abs(selectionRect.x2 - selectionRect.x1),
                height: Math.abs(selectionRect.y2 - selectionRect.y1),
              }}
            />
          )}
        </div>

        {showToolbar && (
          <ImageToolbar
            style={toolbarStyle}
            active={tool?.nodeId === focused.id ? tool.kind : null}
            disabled={busy}
            onTool={(kind, option) => openTool(focused, kind, option)}
            onPreview={() => { setPreviewScale(1); setPreviewMedia({ type: 'image', src: focused.mediaUrl }); }}
            onReplace={() => openPicker('image/*', { x: focused.x + nodeW(focused) / 2, y: focused.y + nodeH(focused) / 2 }, focused.id)}
            downloadHref={focused.mediaUrl}
            downloadName={`musecanvas-${focused.label || '图片'}${focused.mediaUrl.split(/[?#]/)[0].match(/\.(png|jpe?g|webp|gif)$/i)?.[0] || '.png'}`}
          />
        )}

        {showComposer && (
          <Composer
            node={focused}
            incoming={focusedIncoming}
            style={composerStyle}
            busy={busy}
            onPatch={(patch) => patchNode(focused.id, patch)}
            onSend={() => generateNode(focused.id)}
          />
        )}

        {toolNode && tool.kind === 'light' && (
          <LightingStudio src={toolNode.mediaUrl} onClose={() => setTool(null)}
            onSubmit={({ label, prompt }) => createDerived(toolNode, { label, prompt })} />
        )}
        {toolNode && tool.kind === 'angle' && (
          <AngleStudio src={toolNode.mediaUrl} onClose={() => setTool(null)}
            onSubmit={({ label, prompt }) => createDerived(toolNode, { label, prompt })} />
        )}
        {toolNode && tool.kind === 'grid' && (
          <GridSplitPanel style={panelStyle} src={toolNode.mediaUrl} onClose={() => setTool(null)}
            onSubmit={(grid) => runGridSplit(toolNode, grid)} />
        )}
        {toolNode && tool.kind === 'inpaint' && (
          <InpaintEditor src={toolNode.mediaUrl} onClose={() => setTool(null)}
            onSubmit={(payload) => runInpaint(toolNode, payload)} />
        )}
        {toolNode && tool.kind === 'panorama' && (
          <PanoramaViewer src={toolNode.mediaUrl} initialMode={tool.mode} onClose={() => setTool(null)}
            onCapture={(shots) => runShotsExport(toolNode, shots)} />
        )}

        <header className="mf-topbar" onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <div className="mf-pill mf-crumb">
            <button type="button" className="mf-icon-btn"
              onClick={() => nav(canvasInfo.isScratch ? '/scratch' : '/projects/' + canvasInfo.projectId)}
              aria-label={canvasInfo.isScratch ? '返回画布列表' : '返回项目'} title={canvasInfo.isScratch ? '返回画布列表' : '返回项目'}>
              <ArrowLeft size={16} />
            </button>
            <span className="mf-crumb-parent">{canvasInfo.isScratch ? '独立画布' : canvasInfo.projectName}</span>
            <span className="mf-crumb-sep" aria-hidden="true">/</span>
            <h1>{canvasInfo.name}</h1>
            <span role="status" className={clsx('mf-save', saveError ? 'is-error' : saved ? 'is-saved' : 'is-saving')} title={saveError ? '保存失败' : saved ? '已保存' : '保存中'}>
              <i />{saveError ? '保存失败' : saved ? '已保存' : '保存中'}
            </span>
          </div>
          <div className="mf-pill mf-actions">
            <button type="button" className="mf-pill-btn" aria-label="素材库" onClick={()=>setWorkbench('library')}><FolderOpen size={15}/><span className="muse-action-label">素材库</span></button>
            <button type="button" className="mf-pill-btn" aria-label="生成历史与版本" onClick={()=>setWorkbench('history')}><History size={15}/><span className="muse-action-label">历史</span></button>
            <button type="button" className="mf-pill-btn" aria-label="AI 搭建画布" onClick={()=>setWorkbench('ai')}><Sparkles size={15}/><span className="muse-action-label">AI 搭建</span></button>
            <button type="button" className="mf-pill-btn" aria-label="分镜表" onClick={()=>setWorkbench('storyboard')}><BookOpen size={15}/><span className="muse-action-label">分镜表</span></button>
            <button type="button" className="mf-pill-btn" aria-label="自动整理画布" onClick={autoArrange}><LayoutGrid size={15}/><span className="muse-action-label">整理</span></button>
            <button type="button" className={clsx('mf-pill-btn', activityOpen && 'is-on')} aria-label="画布任务" aria-expanded={activityOpen}
              aria-controls={activityOpen ? 'canvasTasks' : undefined} onClick={() => setActivityOpen((open) => !open)}>
              <ListChecks size={15} /><span className="muse-action-label">任务</span>{runningCount > 0 && <span className="mf-badge">{runningCount}</span>}
            </button>
            <button type="button" className={clsx('mf-pill-btn', assistantOpen && 'is-on')} aria-label="Muse 对话" aria-expanded={assistantOpen}
              aria-controls={assistantOpen ? 'canvasAssistant' : undefined} onClick={() => setAssistantOpen((open) => !open)}>
              <MessageSquare size={15} /><span className="muse-action-label">Muse 对话</span>
            </button>
            <button type="button" className="mf-pill-btn" aria-label="设置" onClick={() => nav('/settings')}><Settings size={15}/></button>
          </div>
        </header>

        <div className="mf-dock" role="toolbar" aria-label="画布工具" onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <ToolBtn icon={MousePointer2} onClick={() => setPanTool(false)} active={!panTool} title="选择与框选" />
          <ToolBtn icon={Hand} onClick={() => setPanTool(true)} active={panTool} title="平移画布（或按住空格拖动）" />
          <Sep />
          <ToolBtn icon={Type} label="文本" onClick={() => addNode('text')} title="添加文本节点" />
          <ToolBtn icon={ImageIcon} label="图片" onClick={() => addNode('image', { intent: 'generate', label: '图片生成' })} title="添加图片生成节点" />
          <ToolBtn icon={Video} label="视频" onClick={() => addNode('video', { intent: 'generate', label: '视频生成' })} title="添加视频生成节点" />
          <ToolBtn icon={Clapperboard} label="导演台" onClick={() => addNode('director', { intent: 'director', label: '3D 导演台' })} title="添加 3D 导演台：布景、摆姿势、取景并导出关键帧" />
          <ToolBtn icon={Upload} label="导入" onClick={() => openPicker('image/*,video/*', centerPoint(), null)} title="导入图片或视频" disabled={uploading} />
          <Sep />
          <ToolBtn icon={Trash2} label="删除" onClick={removeSelected} disabled={!selected.length && !selectedLink} danger title="删除选中（Delete）" />
          <ToolBtn icon={CircleHelp} onClick={() => setGuideOpen(true)} title="使用说明与快捷键" />
        </div>
        <ShortcutsGuide open={guideOpen} onClose={() => setGuideOpen(false)} />
        {workbench&&<CanvasWorkbench tab={workbench} onTab={setWorkbench} onClose={()=>setWorkbench(null)} canvasId={canvasInfo.id} shots={doc.storyboard||[]} selected={selected.length===1?doc.nodes.find(n=>n.id===selected[0]):null} onInsert={insertLibraryAssets} onRestore={restoreDocument} onCheckpoint={checkpoint} onApplyResult={applyHistoricalResult} onReuseJob={reuseHistoricalPrompt} onApply={applyWorkflow} onSetShots={setStoryboard}/>}
        {directorId && nodeById[directorId] && (
          <DirectorStage
            key={directorId}
            title={nodeById[directorId].label}
            canvasId={canvasInfo.id}
            initial={nodeById[directorId].director}
            images={[...new Map(doc.nodes.filter((n) => n.type === 'image' && n.mediaUrl).map((n) => [n.mediaUrl, { url: n.mediaUrl, label: n.label || '图片' }])).values()]}
            onSave={(director, preview) => patchNode(directorId, { director, preview })}
            onExport={(shots) => runShotsExport(nodeById[directorId], shots, '关键帧')}
            onExportVideo={async (clip) => {
              try {
                const [saved] = await uploadAll([clip.file]);
                placeAssets(nodeById[directorId], [{ ...saved, type: 'video', label: clip.label, w: clip.width, h: clip.height }], 1);
                toast('动画视频已放入画布', 'ok');
              } catch (error) {
                toast(`动画视频保存失败：${error.message}`, 'error');
                throw error;
              }
            }}
            onClose={() => setDirectorId(null)}
          />
        )}

        <div className="mf-view-tools" role="toolbar" aria-label="视图" onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <ToolBtn icon={MapIcon} onClick={() => setMinimapOpen((v) => !v)} active={minimapOpen} title="小地图" />
          <Sep />
          <ToolBtn icon={ZoomOut} onClick={() => zoomBy(1 / 1.15)} title="缩小" />
          <button type="button" className="muse-zoom-value" onClick={() => setView((v) => ({ ...v, z: 1 }))} title="重置为 100%">
            {Math.round(view.z * 100)}%
          </button>
          <ToolBtn icon={ZoomIn} onClick={() => zoomBy(1.15)} title="放大" />
          <ToolBtn icon={Maximize} onClick={fitView} title="适应画布" />
        </div>

        {activityOpen && (
          <section className="mua-task-panel mf-task-panel" id="canvasTasks" aria-label="画布任务" onMouseDown={(e) => e.stopPropagation()}>
            <header><h2>画布任务</h2><button type="button" aria-label="关闭任务面板" onClick={() => setActivityOpen(false)}><X size={17} /></button></header>
            {doc.nodes.some((node) => node.jobId) ? (
              <ul>
                {doc.nodes.filter((node) => node.jobId).slice().reverse().map((node) => (
                  <li key={node.id}>
                    <button type="button" onClick={() => focusNode(node)} title="定位到节点">
                      {node.mediaUrl && node.type === 'image'
                        ? <img src={node.mediaUrl} alt="" className="mf-task-thumb" />
                        : <span className="mf-task-thumb">{node.type === 'video' ? <Video size={14} /> : <ImageIcon size={14} />}</span>}
                      <div>
                        <strong>{node.label || (node.type === 'video' ? '视频节点' : '图片节点')}</strong>
                        <span data-stage={taskStage(node)}>{TASK_STAGES[taskStage(node)] || '已提交'}</span>
                      </div>
                      <Crosshair size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p>暂无生成任务</p>}
          </section>
        )}

        {menu && (
          <div className="mf-menu mf-add-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
            <p>{menu.link ? '新建并连接' : '添加节点'}</p>
            {[
              ['文本', Type, () => connectCreatedNode(addNode('text', { intent: 'input', label: '文本' }, menu.point), menu.link)],
              ['图片生成', ImageIcon, () => connectCreatedNode(addNode('image', { intent: 'generate', label: '图片生成' }, menu.point), menu.link)],
              ['视频生成', Video, () => connectCreatedNode(addNode('video', { intent: 'generate', label: '视频生成' }, menu.point), menu.link)],
              ['3D 导演台', Clapperboard, () => connectCreatedNode(addNode('director', { intent: 'director', label: '3D 导演台' }, menu.point), menu.link)],
              ['上传图片', Upload, () => {
                if (!menu.link) return openPicker('image/*', menu.point, null);
                const nodeId = addNode('image', { intent: 'asset', label: '图片素材' }, menu.point);
                connectCreatedNode(nodeId, menu.link);
                openPicker('image/*', menu.point, nodeId);
                return undefined;
              }],
            ].map(([label, Icon, run]) => (
              <button key={label} type="button" onClick={run}>
                <Icon size={15} /> {label}
              </button>
            ))}
          </div>
        )}

        {minimapOpen && (
          <Minimap
            nodes={doc.nodes}
            links={links}
            view={view}
            vp={vpSize}
            onNavigate={(worldX, worldY) => setView((current) => ({ ...current, x: -worldX * current.z, y: -worldY * current.z }))}
          />
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*"
          multiple
          hidden
          onChange={(e) => uploadMedia(e.target.files, uploadPoint.current, uploadTarget.current)}
        />
        <ChatDrawer canvasId={canvasInfo.id} canvasName={canvasInfo.name} documentAttachments={!!upstream?.documentAttachments} open={assistantOpen} onClose={() => setAssistantOpen(false)} onInsert={insertAgentReply} />
      </div>
      </div>
      {previewMedia && createPortal((
        <div
          role="presentation"
          onClick={() => setPreviewMedia(null)}
          onWheel={(event) => {
            event.preventDefault();
            setPreviewScale((scale) => Math.min(4, Math.max(0.35, scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12))));
          }}
          className="fixed inset-0 z-[100] grid place-items-center overflow-hidden bg-[#0b0c0f]/88 p-5 backdrop-blur-sm"
        >
          <button
            type="button"
            onClick={() => setPreviewMedia(null)}
            aria-label="关闭预览"
            className="absolute right-5 top-5 z-10 grid h-10 w-10 place-items-center rounded-full bg-white/15 text-white transition hover:bg-white/25"
          >
            <X size={20} />
          </button>
          <img
            src={previewMedia.src}
            alt="图片预览"
            onClick={(e) => e.stopPropagation()}
            style={{ transform: `scale(${previewScale})` }}
            className="max-h-[80vh] max-w-[80vw] rounded-xl object-contain shadow-2xl transition-transform duration-100"
          />
          <span className="pointer-events-none absolute bottom-5 rounded-full bg-black/35 px-3 py-1.5 text-[11px] text-white/80">滚轮缩放 {Math.round(previewScale * 100)}%</span>
        </div>
      ), document.body)}
    </div>
  );
}

function Sep() {
  return <span className="mf-sep" aria-hidden="true" />;
}

function ToolBtn({ icon: Icon, onClick, active, disabled, danger, title, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={clsx('mf-tool', label && 'has-label', active && 'is-on', danger && 'is-danger')}
    >
      <Icon size={16} />
      {label && <span>{label}</span>}
    </button>
  );
}

/** 选中生成节点时贴在节点下方的提示词编辑器。 */
function Composer({ node, incoming, style, busy, onPatch, onSend }) {
  const isVideo = node.type === 'video';
  const sizes = isVideo ? VIDEO_SIZES : IMAGE_SIZES;
  const size = sizes.includes(node.size) ? node.size : (isVideo ? '16:9' : '1:1');
  const duration = VIDEO_DURATIONS.includes(Number(node.duration)) ? Number(node.duration) : 5;
  const running = node.status === 'running';
  const texts = incoming.filter((n) => n.type === 'text' && n.text?.trim());
  const refs = node.refImage ? [{ id: 'ref', mediaUrl: node.refImage }] : incoming.filter((n) => n.type === 'image' && n.mediaUrl);
  return (
    <div className="mf-composer" style={style} onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {(texts.length > 0 || refs.length > 0) && (
        <div className="mf-composer-refs">
          {refs.map((r) => <img key={r.id} src={r.mediaUrl} alt="参考图" title={node.refImage ? '局部重绘标注图' : '参考图'} />)}
          {texts.length > 0 && <span className="mf-ref-chip"><Link2 size={12} /> 已连入 {texts.length} 段文本</span>}
          {refs.length > 1 && <span className="mf-ref-chip is-warn">只能使用一张参考图</span>}
        </div>
      )}
      <textarea
        value={node.text || ''}
        onChange={(e) => onPatch({ text: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSend(); } }}
        placeholder={texts.length ? '补充提示词（会与连入的文本合并）' : `描述你想生成的${isVideo ? '视频' : '画面'}，Ctrl+Enter 生成`}
        rows={3}
      />
      <div className="mf-composer-bar">
        <span className="mf-model"><Sparkles size={14} /> Muse {isVideo ? '视频' : '图片'}</span>
        <label className="mf-select" title="画面比例">
          <select value={size} onChange={(e) => onPatch({ size: e.target.value })}>
            {sizes.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        {isVideo && (
          <label className="mf-select" title="时长，最高 10 秒">
            <select value={duration} onChange={(e) => onPatch({ duration: Number(e.target.value) })}>
              {VIDEO_DURATIONS.map((d) => <option key={d} value={d}>{d} 秒</option>)}
            </select>
          </label>
        )}
        <span className="mf-grow" />
        <button type="button" className="mf-send" disabled={busy || running} onClick={onSend}
          title={running ? '生成中' : node.status === 'failed' ? '重试' : '生成（Ctrl+Enter）'} aria-label="生成">
          {running || busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
        </button>
      </div>
    </div>
  );
}

function CanvasNode({ node, active, zoom, onMouseDown, onPortDown, onResizeDown, onText, onPatch, onUpload, onPreview, onOpenDirector, onDelete, onEditGenerate }) {
  const [renaming, setRenaming] = useState(false);
  const running = node.status === 'running';
  const failed = node.status === 'failed';
  const isText = node.type === 'text';
  const canSend = sends(node);
  const isDirector = node.type === 'director';
  const Icon = isText ? Type : isDirector ? Clapperboard : node.type === 'image' ? ImageIcon : Video;
  const title = node.label || (isText ? '文本' : isDirector ? '3D 导演台' : node.type === 'image' ? '图片' : '视频');
  const box = previewBox(node);
  const stage = taskStage(node);
  const rememberMedia = (el) => {
    const width = el?.videoWidth || el?.naturalWidth;
    const height = el?.videoHeight || el?.naturalHeight;
    if (!width || !height) return;
    if (node.mediaW === width && node.mediaH === height) return;
    onPatch?.({ mediaW: width, mediaH: height });
  };
  const headScale = Math.max(1, Math.min(2.2, 1 / zoom));

  return (
    <div
      data-node-id={node.id}
      onMouseDown={onMouseDown}
      style={{ left: node.x, top: node.y, width: nodeW(node), height: nodeH(node) }}
      className={clsx('mf-node absolute', `is-${node.type}`, active && 'is-active', running && 'is-running', failed && 'is-failed')}
    >
      <div className="mf-node-head" style={{ transform: `scale(${headScale})`, width: `calc(${100 / headScale}% - 4px)` }}>
        {isDirector && <button type="button" data-drag-handle aria-label="拖动导演台节点" className="mf-director-drag" title="按住拖动导演台节点，位置自动保存"><GripVertical size={14}/></button>}
        <Icon size={14} />
        {renaming ? (
          <input
            autoFocus
            defaultValue={title}
            onMouseDown={(e) => e.stopPropagation()}
            onBlur={(e) => { onPatch({ label: e.target.value.trim().slice(0, 40) || title }); setRenaming(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(false); }}
          />
        ) : (
          <span className="mf-node-title" title="双击重命名" onDoubleClick={(e) => { e.stopPropagation(); setRenaming(true); }}>{title}</span>
        )}
        {isDirector && <span className="mf-node-state">{node.director?.keyframes?.length || 0} 个关键帧</span>}
        {canSend && !running && <button type="button" className="mf-node-edit" aria-label={'编辑并生成'+title} title="打开提示词、参数与生成按钮" onMouseDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();onEditGenerate();}}><Sparkles size={12}/><span>编辑</span></button>}
        {!isText && !isDirector && (canSend || node.mediaUrl) && (
          <span className={clsx('mf-node-state', `is-${stage || 'idle'}`)}>
            {running ? TASK_STAGES[stage] : failed ? '失败' : node.mediaUrl ? (canSend ? '已生成' : '素材') : '待生成'}
          </span>
        )}
        <button type="button" className="mf-node-delete" aria-label={'删除'+title+'节点'} title="删除此节点" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onDelete(); }}><Trash2 size={12}/><span>删除</span></button>
      </div>

      {['in', 'out'].map((side) => (
        <button
          key={side}
          type="button"
          data-port={side}
          data-node-id={node.id}
          title={side === 'out' ? '从这里拖到另一个节点' : '把另一个节点拖到这里'}
          aria-label={side === 'out' ? '输出连接点' : '输入连接点'}
          onMouseDown={(e) => onPortDown(e, node, side)}
          className={clsx('mf-port', side === 'in' ? 'is-in' : 'is-out')}
        />
      ))}

      <div className="mf-node-card">
        {isDirector ? (
          <div className="mf-media mf-director-card" title="拖动卡片移动位置，双击或点击按钮打开导演台" style={{ height: box.height }} onDoubleClick={(e) => { e.stopPropagation(); onOpenDirector(); }}>
            {node.preview ? <img src={node.preview} alt="导演台关键帧" draggable={false} className="canvas-media" /> : (
              <div className="mf-media-empty"><Clapperboard size={26} strokeWidth={1.4} /><span>布景 · 摆姿势 · 取景 · 导出参考图</span><span>拖动卡片可移动位置</span></div>
            )}
            <button type="button" className="mf-director-open" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onOpenDirector(); }}>
              <Clapperboard size={14} /> 打开导演台
            </button>
          </div>
        ) : isText ? (
          <textarea
            value={node.text || ''}
            onChange={(e) => onText(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            placeholder="写下提示词、剧本或分镜，再连到图片或视频节点"
            className="mf-node-text"
          />
        ) : (
          <div className="mf-media" style={{ height: box.height }}>
            {node.mediaUrl ? (
              node.type === 'video' ? (
                <video src={node.mediaUrl} controls loop playsInline draggable={false} onMouseDown={(e) => e.stopPropagation()} onLoadedMetadata={(e) => rememberMedia(e.currentTarget)} className="canvas-media" />
              ) : (
                <img src={node.mediaUrl} alt={title} draggable={false} onLoad={(e) => rememberMedia(e.currentTarget)}
                  onDoubleClick={(e) => { e.stopPropagation(); onPreview?.({ type: 'image', src: node.mediaUrl }); }} className="canvas-media" />
              )
            ) : running ? (
              <div className="mf-media-empty is-running" role="status">
                <Loader2 size={18} className="animate-spin" />
                <span>{TASK_STAGES[stage]}</span>
                {node.progress > 0 && <i className="mf-progress"><b style={{ width: `${node.progress}%` }} /></i>}
              </div>
            ) : failed ? (
              <div className="mf-media-empty is-failed"><span>{node.error || '生成失败'}</span><button type="button" className="mf-ghost" onMouseDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();onEditGenerate();}}>编辑并重试</button></div>
            ) : canSend ? (
              <div className="mf-media-empty"><Icon size={26} strokeWidth={1.4}/><span>{node.text?'提示词已就绪':'填写提示词后生成'}</span><button type="button" className="mf-ghost" onMouseDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();onEditGenerate();}}><Sparkles size={13}/>编辑并生成</button></div>
            ) : (
              <div className="mf-media-empty">
                <button type="button" className="mf-ghost" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onUpload(); }}>
                  <Upload size={13} /> 上传{node.type === 'video' ? '视频' : '图片'}
                </button>
              </div>
            )}
            {running && node.mediaUrl && <div className="mf-media-veil"><Loader2 size={18} className="animate-spin" /></div>}
          </div>
        )}
      </div>

      {isText && (
        <button
          type="button"
          aria-label="调整文本节点大小"
          title="拖动调整节点大小"
          onMouseDown={(e) => onResizeDown(e, node)}
          className="mf-resize"
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M10.5 3.5v7h-7M7.5 7.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      )}
    </div>
  );
}

function Minimap({ nodes, links, view, vp, onNavigate }) {
  const W = MINIMAP_W;
  const H = MINIMAP_H;
  const gestureRef = useRef(null);
  if (!nodes.length) return null;
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const vx0 = -view.x / view.z;
  const vy0 = -view.y / view.z;
  const vw = vp.w / view.z;
  const vh = vp.h / view.z;
  const minX = Math.min(vx0, ...nodes.map((n) => n.x)) - 40;
  const minY = Math.min(vy0, ...nodes.map((n) => n.y)) - 40;
  const maxX = Math.max(vx0 + vw, ...nodes.map((n) => n.x + nodeW(n))) + 40;
  const maxY = Math.max(vy0 + vh, ...nodes.map((n) => n.y + nodeH(n))) + 40;
  const currentMap = { minX, minY, k: Math.min(W / (maxX - minX), H / (maxY - minY)) };
  const map = gestureRef.current?.map || currentMap;
  const tx = (x) => (x - map.minX) * map.k;
  const ty = (y) => (y - map.minY) * map.k;
  const mapViewWidth = vw * map.k;
  const mapViewHeight = vh * map.k;
  const mapViewX = tx(vx0);
  const mapViewY = ty(vy0);
  const pointerPosition = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(W, event.clientX - rect.left)), y: Math.max(0, Math.min(H, event.clientY - rect.top)) };
  };
  const navigateFromPointer = (event, gesture) => {
    const point = pointerPosition(event);
    const left = Math.max(0, Math.min(W - vw * gesture.map.k, point.x - gesture.grabX));
    const top = Math.max(0, Math.min(H - vh * gesture.map.k, point.y - gesture.grabY));
    onNavigate(gesture.map.minX + left / gesture.map.k, gesture.map.minY + top / gesture.map.k);
  };
  const startNavigation = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const point = pointerPosition(event);
    const insideView = point.x >= mapViewX && point.x <= mapViewX + mapViewWidth
      && point.y >= mapViewY && point.y <= mapViewY + mapViewHeight;
    const gesture = {
      pointerId: event.pointerId,
      map: currentMap,
      grabX: insideView ? point.x - mapViewX : mapViewWidth / 2,
      grabY: insideView ? point.y - mapViewY : mapViewHeight / 2,
    };
    gestureRef.current = gesture;
    event.currentTarget.setPointerCapture(event.pointerId);
    navigateFromPointer(event, gesture);
  };

  return (
    <div className="muse-minimap absolute bottom-4 right-4 z-20 hidden rounded-xl border border-ink-600 bg-ink-800 p-2 md:block">
      <div className="mb-2 flex items-center justify-between px-0.5">
        <span className="flex items-center gap-1.5 text-[11.5px] text-mist-200">
          <MapIcon size={12} className="text-mist-400" /> 小地图
        </span>
        <Expand size={11} className="text-mist-400" />
      </div>
      <div
        className="dot-grid relative cursor-grab touch-none overflow-hidden rounded-xl active:cursor-grabbing"
        style={{ width: W, height: H, backgroundSize: '10px 10px' }}
        onPointerDown={startNavigation}
        onPointerMove={(event) => {
          const gesture = gestureRef.current;
          if (gesture?.pointerId === event.pointerId) navigateFromPointer(event, gesture);
        }}
        onPointerUp={(event) => {
          if (gestureRef.current?.pointerId === event.pointerId) gestureRef.current = null;
        }}
        onPointerCancel={() => { gestureRef.current = null; }}
        aria-label="小地图，拖动视口框移动画布"
      >
        <svg className="absolute inset-0" width={W} height={H}>
          {links.map((l) => {
            const a = byId[l.from];
            const b = byId[l.to];
            if (!a || !b) return null;
            return (
              <line
                key={`${l.from}-${l.to}`}
                x1={tx(a.x + nodeW(a))}
                y1={ty(a.y + nodeH(a) / 2)}
                x2={tx(b.x)}
                y2={ty(b.y + nodeH(b) / 2)}
                stroke="#8b7cff"
                strokeWidth="1"
              />
            );
          })}
        </svg>
        {nodes.map((n) => (
          <span
            key={n.id}
            className="absolute rounded-[3px] border border-mist-300/40 bg-mist-300/25"
            style={{ left: tx(n.x), top: ty(n.y), width: Math.max(4, nodeW(n) * map.k), height: Math.max(3, nodeH(n) * map.k) }}
          />
        ))}
        <span
          className="absolute rounded-[4px] border border-brand-400/70 bg-brand-400/5"
          style={{ left: mapViewX, top: mapViewY, width: mapViewWidth, height: mapViewHeight, pointerEvents: 'none' }}
        />
      </div>
    </div>
  );
}
