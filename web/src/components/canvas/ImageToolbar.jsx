import { useEffect, useRef, useState } from 'react';
import {
  Brush, ChevronDown, Download, Expand, Grid2x2, RectangleHorizontal, RefreshCw, Sun, SwitchCamera,
} from 'lucide-react';
import { clsx } from 'clsx';

const PANO_ITEMS = [
  { id: 'generate:sphere', label: '生成 720° 全景图', hint: '2:1 球面，可环视上下' },
  { id: 'generate:cylinder', label: '生成 360° 环绕图', hint: '4:1 水平一圈' },
  { id: 'preview:sphere', label: '预览为 720° 全景', divided: true },
  { id: 'preview:cylinder', label: '预览为 360° 环绕' },
];

/** 选中图片节点时浮在节点上方的工具条（屏幕坐标，不随缩放变形）。 */
export default function ImageToolbar({ style, active, disabled, onTool, onPreview, onReplace, downloadHref, downloadName }) {
  const [panoOpen, setPanoOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!panoOpen) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setPanoOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [panoOpen]);

  const Btn = ({ id, icon: Icon, label, onClick }) => (
    <button type="button" className={clsx('mf-tb-btn', active === id && 'is-on')} disabled={disabled}
      onClick={onClick || (() => onTool(id))} title={label}>
      <Icon size={15} /><span>{label}</span>
    </button>
  );

  return (
    <div ref={ref} className="mf-image-toolbar" style={style} role="toolbar" aria-label="图片工具"
      onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <div className="mf-tb-group">
        <button type="button" className={clsx('mf-tb-btn', (panoOpen || active === 'panorama') && 'is-on')} disabled={disabled}
          aria-haspopup="menu" aria-expanded={panoOpen} onClick={() => setPanoOpen((v) => !v)} title="全景图">
          <RectangleHorizontal size={15} /><span>全景图</span><ChevronDown size={13} className="mf-tb-chevron" />
        </button>
        {panoOpen && (
          <div className="mf-menu mf-tb-menu" role="menu">
            {PANO_ITEMS.map((item) => (
              <button key={item.id} type="button" role="menuitem" className={clsx(item.divided && 'is-divided')}
                onClick={() => { setPanoOpen(false); onTool('panorama', item.id); }}>
                <span>{item.label}</span>
                {item.hint && <small>{item.hint}</small>}
              </button>
            ))}
          </div>
        )}
      </div>
      <Btn id="inpaint" icon={Brush} label="局部重绘" />
      <Btn id="light" icon={Sun} label="打光" />
      <Btn id="angle" icon={SwitchCamera} label="多角度" />
      <Btn id="grid" icon={Grid2x2} label="宫格切分" />
      <span className="mf-tb-sep" />
      <button type="button" className="mf-tb-btn is-icon" onClick={onPreview} title="放大预览" aria-label="放大预览"><Expand size={15} /></button>
      <button type="button" className="mf-tb-btn is-icon" onClick={onReplace} disabled={disabled} title="替换图片" aria-label="替换图片"><RefreshCw size={15} /></button>
      <a className="mf-tb-btn is-icon" href={downloadHref} download={downloadName} title="下载" aria-label="下载图片"><Download size={15} /></a>
    </div>
  );
}
