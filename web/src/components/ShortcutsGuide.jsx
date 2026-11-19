import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  BookOpen, Brush, ClipboardPaste, Grid2x2, Hand, ImagePlus, Keyboard, MousePointer2, MousePointerClick,
  Clapperboard, RectangleHorizontal, Spline, SquareDashedMousePointer, Sun, SwitchCamera, Wand2, X, ZoomIn, Sparkles, Settings, Trash2,
} from 'lucide-react';
import { clsx } from 'clsx';
import './shortcuts.css';

const BASICS = [
  { icon: MousePointerClick, title: '选择与移动', desc: '左键点击节点即可选中，拖动可移动。右键点击也能选中，右键拖动不会移动节点。' },
  { icon: SquareDashedMousePointer, title: '框选', desc: '在空白处按住左键拖动进行框选；按住 Shift 可追加或取消选择。' },
  { icon: Hand, title: '平移画布', desc: '按住空格加左键，或按住鼠标中键拖动。普通滚轮上下移动画布。' },
  { icon: ZoomIn, title: '缩放', desc: '在画布内按住 Ctrl 滚动滚轮，以鼠标位置为中心缩放。' },
  { icon: Spline, title: '连线', desc: '拖动节点两侧的圆点连接节点；拖到空白处可新建节点并自动连线。' },
  { icon: MousePointer2, title: '添加和执行节点', desc: '双击空白处打开添加菜单，或使用底部工具栏。图片和视频节点内点击「编辑并生成」打开提示词和参数，修改后点击发送箭头或按 Ctrl+Enter 生成；整组被选中时也可直接点这个按钮。' },
  { icon: ImagePlus, title: '导入素材', desc: '把图片或视频拖进画布，或直接从剪贴板粘贴。' },
  { icon: ClipboardPaste, title: '跨画布复用', desc: '选中节点后复制，切换到其他画布再粘贴。' },
  { icon: Trash2, title: '删除节点', desc: '点击节点标题旁的「删除」，或选中后使用底部「删除」按钮。也可按 Delete；删除节点会移除相关连线，已归档素材仍保留。' },
  { icon: Settings, title: '设置与接入方式', desc: '侧栏底部或画布右上角打开「设置」。可切换 API Bridge / muse2api，立即用于新任务并自动保存。主题支持浅色、深色和跟随系统。本机打开无需注册登录。' },
];

const WORKFLOWS = [
  {title:'外部模型设置',steps:['打开「设置 → 模型配置」，分别点击「添加语言模型 / 图片模型 / 视频模型」。填写名称、Base URL（包含 /v1 等版本前缀）、模型 ID 和 API Key，选择匹配的协议后保存。','在各类别的默认模型下拉框中选择，自动保存，立即用于新任务。语言模型负责对话与 AI 搭建，图片和视频分别使用自己的模型。选择 Muse 则继续使用接入方式中的 API Bridge 或 muse2api。','「测试连接」仅读取模型列表，不代表已完成真实生成。图片接口支持 generations / edits；视频支持 OpenAI multipart 和兼容 JSON 任务。可在高级设置修改路径、附加参数、比例尺寸映射和可选时长，不同厂商协议需核对。密钥留空保留，不会返回浏览器。']},
  {title:'一键生成与并发',steps:['AI 搭建应用后，检查每个生成节点的提示词和连线，在右上角选择并发 1–3（默认 2），点击「一键生成」。这会实际提交生成任务。已完成素材会跳过，素材库节点不会重新生成。','流程按依赖执行：角色参考图完成后生成各镜头图片；某镜头图片完成后即可制作其视频。独立分支可并发，仍受全局任务槽位及模型 / Bridge 的并发上限限制。','暂停会停止派发新任务，已提交的继续执行；继续会恢复派发。停止会取消尚未提交的步骤，已提交的任务继续完成。浏览器关闭不影响后台；程序重启后，已取得任务 ID 的视频可继续查询，提交中断且结果未知的任务会报错，不会自动重发。','某步骤失败时，它的下游标为失败，独立分支继续。核对供应商任务与错误、修正配置后，再点击「一键生成」可补齐未完成部分，已完成素材保留。不要对结果未知的收费任务反复重试。流程启动时固定模型与提示词，修改设置仅影响新流程。']},
  {title:'素材库',steps:['画布右上角点「素材库」，或从侧栏打开独立素材库。上传、导演台导出和已完成的生成结果会自动归档。','使用名称、提示词或标签搜索，按图片 / 视频筛选；点击星标收藏，点「名称与标签」整理素材。','在画布内打开素材库，点「加入画布」即可插入参考素材；连接图片节点到生成节点，可在生成时使用参考图。']},
  {title:'生成历史与结果复用',steps:['画布右上角点「历史」→「生成历史」，查看当前画布每次生成的提示词、参数、结果和失败原因。','「复用提示词」会建立一个待生成节点；「加入画布」把旧结果作为独立素材插入。','先选中一个未在生成的同类型节点，再点击「应用到选中节点」，即可把它替换为旧结果。替换前会备份画布。']},
  {title:'画布版本与回退',steps:['打开「历史」→「画布版本」，也可先点「保存当前版本」建立手动检查点。','选择版本，检查节点预览后点击「恢复此版本」。恢复前会保存「回退前备份」，可以再次选择该备份恢复。','生成、应用流程和自动整理前都会保留版本；普通编辑分段自动记录。每张画布最多保留 80 个版本，旧版本从本次更新后开始积累。画布有生成任务时，请等任务完成再回退。']},
  {title:'AI 自动搭建画布',steps:['点右上角「AI 搭建」，描述内容、镜头数、角色和风格。例如：小猫游花园，3 个镜头，先生成角色参考，再制作镜头图片和视频，列出分镜表。','点击「生成画布方案」，等待当前所选语言模型返回方案。检查节点提示词、数量和连线；需要调整可修改描述重新生成。','点击「应用方案到画布」追加节点并导入分镜。已有内容保留，应用前先备份。也可点「仅导入分镜表」先编辑镜头。','应用方案只搭建节点，不会自动出图出视频。关闭工作台，点击节点内「编辑并生成」打开编辑器。可逐个生成，也可点右上角「一键生成」，自动按角色参考图、镜头图片、对应视频的依赖顺序执行。角色参考图会分支到各镜头图片，视频不会连到下个镜头文本。']},
  {title:'分镜表',steps:['点右上角「分镜表」→「添加镜头」。填写场景、角色、动作、景别 / 运镜、对白和生成提示词，选择时长及比例，编辑自动保存。','CSV 支持追加导入与导出。表头为：镜头、场景、角色、动作、景别 / 运镜、对白、生成提示词、时长、比例。可先导出一份作为模板。','点击「生成画布节点」，每个有效镜头建立「文本 → 图片 → 视频」连线。先完成图片，再生成视频。再次点击会追加一组新节点。']},
  {title:'自动整理画布',steps:['点画布右上角「整理」。有连线时按依赖从左到右排列；没有连线时按网格排列。','整理会保留节点内容、素材和连线，并适配视口。如果不满意，到「历史 → 画布版本」恢复「自动整理前」。']},
  {title:'导演台到视频',steps:['底部「导演台」添加节点，拖动卡片或标题旁手柄移动位置；点击「打开导演台」编辑。','在 0 秒摆好姿势并点「记录」；移动时间轴，修改动作后再次记录。点击播放预览，再点「导出视频」，得到人偶预演动画。','要制作最终画面，在取景后添加关键帧，点「全部导出到画布」。把图片连接到图片 / 视频生成节点，描述角色、动作和风格后生成。导演台时间轴不会自动传给 Muse。','右上角「保存」或关闭按钮保存场景；导演台内「使用说明」提供取景快捷键及详细步骤。']},
];

const KEYS = [
  { keys: [['Ctrl', 'C'], ['Ctrl', 'V']], label: '复制 / 粘贴选中节点' },
  { keys: [['Ctrl', 'Enter']], label: '在提示词编辑器中生成' },
  { keys: [['Ctrl', '滚轮']], label: '画布内缩放' },
  { keys: [['空格', '拖动']], label: '平移画布' },
  { keys: [['Delete'], ['Backspace']], label: '删除选中节点或连线' },
  { keys: [['Shift', '左键']], label: '追加选择或框选' },
  { keys: [['Esc']], label: '清除选择，关闭菜单和工具面板' },
  { keys: [['Ctrl', 'Z']], label: '局部重绘中撤销一笔' },
];

const TOOLS = [
  { icon: RectangleHorizontal, title: '全景图', desc: '生成 720° 球面或 360° 环绕全景，可在预览中拖动取景并截图回画布。', tint: '#5b8def' },
  { icon: Brush, title: '局部重绘', desc: '用笔刷涂抹要修改的区域，描述想要的变化，只重绘涂抹部分。', tint: '#e0607e' },
  { icon: Sun, title: '打光', desc: '选择光线风格，拖动圆盘设置光源方位，调整高度、亮度和色调。', tint: '#e9a23b' },
  { icon: SwitchCamera, title: '多角度', desc: '移动机位重拍同一瞬间：正侧背、俯仰、景别和镜头都可调。', tint: '#8b6cf0' },
  { icon: Grid2x2, title: '宫格切分', desc: '把分镜宫格图切成单张图片节点，在本地完成。', tint: '#2fae8a' },
  { icon: Clapperboard, title: '3D 导演台', desc: '用关节人偶和道具布景摆姿势，WASD 飞行取景，用时间轴做动画，导出关键帧图片或动画视频；也可让 Muse 根据描述布景和编排动作。', tint: '#f07a3a' },
];

const TABS = [
  { id: 'basics', label: '基本操作', icon: MousePointer2 },
  { id: 'keys', label: '快捷键', icon: Keyboard },
  { id: 'tools', label: '图片工具', icon: Wand2 },
  { id: 'workflows', label: '创作流程', icon: Sparkles },
];

function KeyCombo({ combo }) {
  return (
    <span className="sg-combo">
      {combo.map((key, i) => (
        <span key={key} className="sg-combo-part">
          {i > 0 && <i>+</i>}
          <kbd>{key}</kbd>
        </span>
      ))}
    </span>
  );
}

/** 统一使用说明，包含工作台、版本回退、分镜及导演台流程。 */
export default function ShortcutsGuide({ open, onClose }) {
  const [tab, setTab] = useState('basics');
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);
  if (!open) return null;

  return createPortal((
    <div className="sg-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="sg-card" role="dialog" aria-modal="true" aria-label="画布使用说明" onMouseDown={(e) => e.stopPropagation()}>
        <header className="sg-head">
          <span className="sg-mark"><BookOpen size={20} /></span>
          <div>
            <h2>画布使用说明</h2>
            <p>基本操作、创作工作台、分镜与视频流程</p>
          </div>
          <button type="button" className="sg-close" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </header>

        <nav className="sg-tabs" role="tablist">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={clsx(tab === id && 'is-on')} onClick={() => setTab(id)}>
              <Icon size={15} /> {label}
            </button>
          ))}
        </nav>

        <div className="sg-body">
          {tab === 'workflows' && <div className="sg-workflows"><p className="sg-lead">推荐流程：AI 规划或填写分镜 → 建立节点 → 生成图片 → 生成视频 → 素材归档。需要重新选择结果时，使用生成历史和画布版本。</p>{WORKFLOWS.map(item=><article key={item.title}><h3>{item.title}</h3><ol>{item.steps.map(step=><li key={step}>{step}</li>)}</ol></article>)}</div>}
          {tab === 'basics' && (
            <div className="sg-grid">
              {BASICS.map(({ icon: Icon, title, desc }) => (
                <article key={title} className="sg-item">
                  <span className="sg-icon"><Icon size={18} /></span>
                  <div><h3>{title}</h3><p>{desc}</p></div>
                </article>
              ))}
            </div>
          )}
          {tab === 'keys' && (
            <ul className="sg-keys">
              {KEYS.map(({ keys, label }) => (
                <li key={label}>
                  <span className="sg-key-set">
                    {keys.map((combo, i) => (
                      <span key={combo.join()} className="sg-combo-part">
                        {i > 0 && <em>或</em>}
                        <KeyCombo combo={combo} />
                      </span>
                    ))}
                  </span>
                  <span className="sg-key-label">{label}</span>
                </li>
              ))}
            </ul>
          )}
          {tab === 'tools' && (
            <>
              <p className="sg-lead">选中一张图片，节点上方会出现工具条。生成类工具会在原图右侧新建节点并自动连线。</p>
              <div className="sg-tools">
                {TOOLS.map(({ icon: Icon, title, desc, tint }) => (
                  <article key={title} className="sg-tool" style={{ '--tint': tint }}>
                    <span className="sg-icon"><Icon size={18} /></span>
                    <h3>{title}</h3>
                    <p>{desc}</p>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  ), document.body);
}
