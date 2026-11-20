// 分镜提示词的分层组装：镜头（焦段、景深）→ 景别 → 主体 → 光线 → 风格。
// 风格只作为最后一句短语，镜头语言才是每一格画面的变化主体，
// 这样一组画面既统一又不雷同（思路参考 dsh-openreelbench 的五层分镜提示词）。

export const SHOT_SIZES = {
  establishing: { label: '定场', en: 'establishing shot that sets up the location' },
  extreme_wide: { label: '大远景', en: 'extreme wide shot, small figures in a vast environment' },
  wide: { label: '远景', en: 'wide shot showing the whole scene' },
  medium_wide: { label: '中远景', en: 'medium-wide shot, full body with surroundings' },
  medium: { label: '中景', en: 'medium shot from the waist up' },
  medium_close: { label: '中近景', en: 'medium close-up from the chest up' },
  close_up: { label: '近景特写', en: 'close-up on the face or key detail' },
  extreme_close_up: { label: '大特写', en: 'extreme close-up on a fine detail' },
  over_shoulder: { label: '过肩', en: 'over-the-shoulder shot' },
  insert: { label: '插入镜头', en: 'insert shot of a specific object' },
};

export const MOVEMENTS = {
  static: { label: '固定', en: 'static locked-off camera' },
  push_in: { label: '推镜', en: 'slow push in toward the subject' },
  pull_out: { label: '拉镜', en: 'slow pull back from the subject' },
  pan_left: { label: '左摇', en: 'smooth pan to the left' },
  pan_right: { label: '右摇', en: 'smooth pan to the right' },
  tilt_up: { label: '上摇', en: 'gentle tilt upward' },
  tilt_down: { label: '下摇', en: 'gentle tilt downward' },
  track: { label: '跟拍', en: 'tracking shot following the subject' },
  orbit: { label: '环绕', en: 'camera orbiting around the subject' },
  crane_up: { label: '升镜', en: 'crane shot rising up' },
  crane_down: { label: '降镜', en: 'crane shot descending' },
  handheld: { label: '手持', en: 'handheld camera with natural sway' },
};

export const LIGHTS = {
  natural: { label: '自然光', en: 'natural ambient light' },
  soft: { label: '柔光', en: 'soft diffused light' },
  golden_hour: { label: '黄金时刻', en: 'warm golden-hour sunlight' },
  blue_hour: { label: '蓝调时刻', en: 'cool blue-hour twilight' },
  high_key: { label: '高调', en: 'bright high-key lighting with few shadows' },
  low_key: { label: '低调', en: 'moody low-key lighting with deep shadows' },
  backlight: { label: '逆光', en: 'strong backlight with glowing rim' },
  neon: { label: '霓虹', en: 'neon light with saturated color spill' },
  tungsten: { label: '暖色室内', en: 'warm tungsten interior light' },
  volumetric: { label: '体积光', en: 'volumetric light beams through haze' },
};

export const DOF = {
  shallow: { label: '浅景深', en: 'shallow depth of field, creamy bokeh' },
  medium: { label: '中景深', en: 'moderate depth of field' },
  deep: { label: '深景深', en: 'deep focus, everything sharp' },
};

export const LENSES = ['18mm', '24mm', '35mm', '50mm', '85mm', '135mm'];
const LENS_WORDS = { '18mm': 'ultra-wide 18mm lens', '24mm': 'wide 24mm lens', '35mm': '35mm lens', '50mm': '50mm lens', '85mm': '85mm portrait lens', '135mm': '135mm telephoto lens' };

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().replace(/[,，。.]+$/, '');

/** 关键帧提示词。 */
export function buildShotPrompt(shot, style = {}) {
  return [
    LENS_WORDS[shot.lens],
    DOF[shot.dof]?.en,
    SHOT_SIZES[shot.shotSize]?.en,
    clean(shot.subject),
    style.character && /\b(he|she|they|man|woman|girl|boy|character|person|people|protagonist)\b/i.test(shot.subject || '') ? clean(style.character) : '',
    LIGHTS[shot.lighting]?.en,
    clean(style.clause),
  ].filter(Boolean).join(', ');
}

/** 图生视频提示词：运镜与动作在前，画面描述精简。 */
export function buildMotionPrompt(shot, style = {}) {
  return [
    MOVEMENTS[shot.movement]?.en,
    clean(shot.motion),
    clean(shot.subject),
    LIGHTS[shot.lighting]?.en,
    clean(style.clause),
  ].filter(Boolean).join(', ');
}
