// 图片节点工具共用的提示词与图像处理函数。
// Bridge 每个任务只接受一张参考图，所以局部重绘把涂抹标注合成进同一张参考图。

export const IMAGE_SIZES = ['1:1', '3:4', '4:3', '2:3', '3:2', '4:5', '5:4', '9:16', '16:9', '21:9', '2:1', '4:1'];

export function nearestImageSize(width, height) {
  const ratio = width > 0 && height > 0 ? width / height : 1;
  let best = '1:1';
  let bestDiff = Infinity;
  for (const size of IMAGE_SIZES) {
    const [w, h] = size.split(':').map(Number);
    const diff = Math.abs(Math.log(ratio) - Math.log(w / h));
    if (diff < bestDiff) { best = size; bestDiff = diff; }
  }
  return best;
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

export function canvasToFile(canvas, name, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob || !blob.size) return reject(new Error('图片导出失败'));
      resolve(new File([blob], name, { type }));
    }, type, quality);
  });
}

/* ------------------------------ 全景图 ------------------------------ */
export function panoramaPrompt(mode) {
  const shape = mode === 'sphere'
    ? '输出一张 720° 等距柱状投影（equirectangular）全景图，严格 2:1 比例：水平覆盖完整 360°，垂直覆盖 180°，包含完整的天空顶部和脚下地面，地平线位于画面垂直中央，左右两侧边缘必须无缝衔接，可直接贴到球体内侧。'
    : '输出一张 360° 水平环绕的圆柱全景图，严格 4:1 比例：水平覆盖完整一圈，地平线保持水平并位于画面垂直中央，左右两侧边缘必须无缝衔接，可直接贴到圆柱内侧。';
  return [
    '以参考图为起点，站在同一个固定机位，向四周重建并延展同一个场景。保持场景身份、主体、材质、色彩、光线和画风一致，合理推断画面外没有出现的环境。',
    shape,
    '画面必须是一张连续的平面全景纹理：不要分格、边框、接缝、文字、水印、相机或界面元素，不要小行星视角、鱼眼视角，也不要画出全景查看器本身。',
  ].join('\n');
}

/* ------------------------------ 打光 ------------------------------ */
export const LIGHT_PRESETS = [
  { id: 'natural', label: '自然日光', prompt: '柔和自然的日光，真实的环境反射与天空补光' },
  { id: 'studio', label: '棚拍柔光', prompt: '干净的影棚柔光，大面积柔和光源，阴影过渡细腻' },
  { id: 'rembrandt', label: '伦勃朗', prompt: '伦勃朗式布光，主光从侧上方照射，暗侧脸颊出现三角形光斑，明暗对比清晰' },
  { id: 'golden', label: '黄金时刻', prompt: '日落前的黄金时刻暖光，低角度金色阳光，拉长而柔和的阴影' },
  { id: 'cinematic', label: '电影冷暖', prompt: '电影感冷暖对比布光，暖色主光配合冷色环境光，带少量体积光' },
  { id: 'neon', label: '夜景霓虹', prompt: '夜晚城市霓虹氛围，品红与青色的彩色光在主体上交织，环境偏暗' },
  { id: 'moon', label: '月光', prompt: '清冷的蓝色月光，低照度的夜间氛围，高光克制' },
  { id: 'top', label: '顶光', prompt: '强烈的顶部硬光，眼窝与下巴下方形成浓重阴影，戏剧感强' },
  { id: 'custom', label: '自定义', prompt: '' },
];

export const DEFAULT_LIGHT = {
  preset: 'natural', azimuth: 45, elevation: 30, brightness: 55, color: '',
  rim: false, rimAzimuth: -140, rimElevation: 20, rimBrightness: 70, rimColor: '', desc: '',
};

export const LIGHT_DIRECTIONS = [
  { id: 'front', label: '前光', azimuth: 0, elevation: 15 },
  { id: 'left', label: '左光', azimuth: -90, elevation: 15 },
  { id: 'right', label: '右光', azimuth: 90, elevation: 15 },
  { id: 'back', label: '背光', azimuth: 180, elevation: 15 },
  { id: 'top', label: '顶光', azimuth: 0, elevation: 85 },
  { id: 'bottom', label: '底光', azimuth: 0, elevation: -40 },
];

export const LIGHT_COLORS = [
  { value: '', label: '白光' },
  { value: '#ffb066', label: '暖橙' },
  { value: '#ffe0a8', label: '暖黄' },
  { value: '#8fb8ff', label: '冷蓝' },
  { value: '#ff6fae', label: '品红' },
  { value: '#6ee7c8', label: '青绿' },
  { value: '#b48cff', label: '紫光' },
];

function horizontalSide(azimuth) {
  const a = Math.abs(azimuth);
  const side = azimuth < 0 ? '左' : '右';
  if (a <= 15) return '正面（与镜头同一侧）';
  if (a <= 65) return `画面${side}前方`;
  if (a <= 115) return `画面${side}侧`;
  if (a < 165) return `画面${side}后方（侧逆光）`;
  return '主体正后方（逆光）';
}

function verticalSide(elevation) {
  if (elevation >= 60) return '几乎垂直的顶部';
  if (elevation >= 25) return '较高的位置向下';
  if (elevation >= -10) return '与主体齐平的高度';
  return '低处向上（底光）';
}

export function lightDirection(azimuth, elevation) {
  return `光源来自${horizontalSide(azimuth)}、${verticalSide(elevation)}照射`;
}

export function lightingPrompt(s) {
  const preset = LIGHT_PRESETS.find((p) => p.id === s.preset);
  const level = ['非常暗，深沉的阴影，只有微弱高光', '偏暗，柔和高光，暗部仍可辨认', '曝光均衡，中间调自然，高光保留细节', '明亮，阴影通透，中间调发亮', '高调强曝光，高光明亮，整体色调轻盈'][Math.min(4, Math.floor(s.brightness / 20))];
  return [
    '对参考图重新打光，只改变光照。保持原图的场景、构图、机位和背景几何完全不变；保留每个人物的身份、五官、发型、服装、姿势和动作；人物和物体的数量、位置、关系都不变，不新增也不删除任何内容。',
    '光照描述只是照明效果，不要在画面里画出灯具、聚光灯、柔光箱、反光板、蜡烛等任何照明设备。只调整光线方向、强度、颜色、阴影、对比度和氛围。',
    preset?.prompt ? `光线风格：${preset.prompt}。` : '',
    `主光方向：${lightDirection(s.azimuth, s.elevation)}。`,
    `整体亮度：${level}。`,
    s.color ? `主光色调偏向 ${s.color}，但主体本身的固有色仍可辨认。` : '',
    s.rim ? `另加一盏独立的轮廓光：${lightDirection(s.rimAzimuth, s.rimElevation ?? 20)}，强度约 ${Math.round(s.rimBrightness ?? 70)}%${s.rimColor ? `，色调偏向 ${s.rimColor}` : ''}，只勾勒主体边缘高光；不要把它挪到另一侧。` : '',
    s.desc?.trim() ? `补充要求：${s.desc.trim()}` : '',
    `[打光 方位 ${Math.round(s.azimuth)}° 俯仰 ${Math.round(s.elevation)}° 亮度 ${Math.round(s.brightness)}%]`,
  ].filter(Boolean).join('\n');
}

/* ------------------------------ 多角度 ------------------------------ */
export const ANGLE_PRESETS = [
  { id: 'front', label: '正面', azimuth: 0, elevation: 0 },
  { id: 'leftFront', label: '左前', azimuth: -45, elevation: 0 },
  { id: 'rightFront', label: '右前', azimuth: 45, elevation: 0 },
  { id: 'left', label: '左侧', azimuth: -90, elevation: 0 },
  { id: 'right', label: '右侧', azimuth: 90, elevation: 0 },
  { id: 'leftBack', label: '左后', azimuth: -135, elevation: 0 },
  { id: 'rightBack', label: '右后', azimuth: 135, elevation: 0 },
  { id: 'back', label: '背面', azimuth: 180, elevation: 0 },
  { id: 'high', label: '俯拍', azimuth: 0, elevation: 60 },
  { id: 'low', label: '仰拍', azimuth: 0, elevation: -45 },
];

export const DEFAULT_ANGLE = { azimuth: 45, elevation: 0, distance: 'medium', lens: 'standard', note: '' };

export const DISTANCES = [
  { id: 'close', label: '近景', radius: 1.9, prompt: '近景，主体占据画面大部分' },
  { id: 'medium', label: '中景', radius: 2.5, prompt: '中景，保持与原图相近的取景范围' },
  { id: 'far', label: '远景', radius: 3.4, prompt: '远景，主体较小，展示更多周围环境' },
];

export const LENS_FOV = { standard: 40, wide: 72 };

export function anglePrompt(s) {
  const a = Math.max(-180, Math.min(180, Math.round(s.azimuth)));
  const e = Math.max(-80, Math.min(80, Math.round(s.elevation)));
  const side = a < 0 ? '左' : '右';
  const abs = Math.abs(a);
  let orbit;
  if (abs === 0) orbit = '摄像机保持在原图的水平视线方向上。';
  else if (abs >= 175) orbit = '反打视角：把摄像机绕主体移动 180°，到原机位的正对面，拍摄原图中背对镜头的一面。';
  else if (abs > 90) orbit = `后方视角：摄像机绕主体向原图${side}侧移动 ${abs}°，越过侧面进入主体后半圈，镜头回望主体中心，展示原图中被挡住的面，而不是重复正面或侧面。`;
  else orbit = `摄像机绕主体向原图${side}侧移动 ${abs}°，机位位于原图的${side}边一侧，镜头朝主体中心。`;
  const tilt = e === 0
    ? '保持原图的垂直拍摄角度。'
    : e > 0 ? `摄像机抬高到原视平面上方 ${e}°，镜头向下俯拍主体。` : `摄像机降低到原视平面下方 ${Math.abs(e)}°，镜头向上仰拍主体。`;
  const distance = DISTANCES.find((d) => d.id === s.distance) || DISTANCES[1];
  return [
    '以参考图里的同一场景、同一时刻为准，把摄像机移动到新的位置重新拍摄。',
    orbit,
    tilt,
    '以上是摄像机位置的变化，不是让主体转身，也不是让主体在画面中移动。',
    abs > 90 ? '合理重建原图中看不到的部分，并与参考图保持一致；从背后拍摄时人物脸部可以被头部和身体自然遮挡。' : '',
    '保持人物身份、服装、发型、道具、材质、光照方向、色彩和画风完全一致，不新增也不删除人物或物体。',
    `景别：${distance.prompt}；镜头：${s.lens === 'wide' ? '广角镜头，但不要鱼眼畸变' : '标准镜头'}。`,
    s.note?.trim() ? `补充要求：${s.note.trim()}` : '',
    `[机位 水平 ${a}° 俯仰 ${e}°]`,
  ].filter(Boolean).join('\n');
}

/* ------------------------------ 局部重绘 ------------------------------ */
export function inpaintPrompt(text) {
  return [
    '对参考图做局部重绘。参考图上半透明的红色涂抹只用来标出需要修改的区域，红色本身不是画面内容。',
    `在红色标记的区域内：${text.trim()}`,
    '只修改标记区域，红色区域以外的内容、构图、尺寸比例、光线和画风保持不变；结果中不能残留任何红色标记，返回完整的一张图片。',
  ].join('\n');
}

/* ------------------------------ 宫格切分 ------------------------------ */
export async function splitImage(src, rows, cols) {
  const img = await loadImage(src);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) throw new Error('图片尺寸无效');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const files = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.round((c * w) / cols);
      const y0 = Math.round((r * h) / rows);
      const x1 = Math.round(((c + 1) * w) / cols);
      const y1 = Math.round(((r + 1) * h) / rows);
      canvas.width = x1 - x0;
      canvas.height = y1 - y0;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, x0, y0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      files.push(await canvasToFile(canvas, `宫格-${r + 1}-${c + 1}.png`));
    }
  }
  canvas.width = canvas.height = 0;
  return { files, width: w, height: h };
}
