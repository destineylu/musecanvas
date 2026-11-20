/*
 * ComfyUI 界面工作流（nodes/links/widgets_values）→ API 格式转换。
 * 移植自 dsh-comfyui 的 graph.ts 与 convert.ts（MIT License，
 * https://github.com/fandc520/dsh-comfyui），改写为 JavaScript 并按 musecanvas 需要精简。
 *
 * 连线变成 [节点id, 输出槽位]；widgets_values 按界面控件顺序对应到输入名
 * （种子后面的 control_after_generate 只占位、不进入 API）；Reroute 与已绕过（mode 4）
 * 的节点被跳过并重新接线；KJNodes Set/Get 无线连线、rgthree 模式中继被解析掉。
 */

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

export function normalizeLink(raw) {
  if (Array.isArray(raw)) {
    if (raw.length < 6) return undefined;
    const [id, origin, originSlot, target, targetSlot, type] = raw;
    if (![id, origin, originSlot, target, targetSlot].every((n) => typeof n === 'number')) return undefined;
    return [id, origin, originSlot, target, targetSlot, typeof type === 'string' ? type : ''];
  }
  if (isObject(raw)) {
    const { id, origin_id: origin, origin_slot: originSlot, target_id: target, target_slot: targetSlot, type } = raw;
    if (![id, origin, originSlot, target, targetSlot].every((n) => typeof n === 'number')) return undefined;
    return [id, origin, originSlot, target, targetSlot, typeof type === 'string' ? type : ''];
  }
  return undefined;
}

export function normalizeLinks(raw) {
  return Array.isArray(raw) ? raw.map(normalizeLink).filter(Boolean) : [];
}

const SET_NODE = 'SetNode';
const GET_NODE = 'GetNode';
const MODE_LINK_NODES = new Set(['Mute / Bypass Relay (rgthree)', 'Mute / Bypass Repeater (rgthree)']);
const isVirtualNodeType = (type) => type === SET_NODE || type === GET_NODE || MODE_LINK_NODES.has(type);

function virtualNodeFacts(raw) {
  if (!isObject(raw)) return undefined;
  const id = typeof raw.id === 'number' ? raw.id : Number(raw.id);
  if (!Number.isFinite(id)) return undefined;
  const values = Array.isArray(raw.widgets_values) ? raw.widgets_values : [];
  const inputs = Array.isArray(raw.inputs) ? raw.inputs : [];
  const wired = inputs.find((e) => isObject(e) && typeof e.link === 'number');
  return {
    id,
    type: typeof raw.type === 'string' ? raw.type : '',
    order: typeof raw.order === 'number' ? raw.order : Number.MAX_SAFE_INTEGER,
    name: typeof values[0] === 'string' && values[0].trim() ? values[0] : undefined,
    firstInputLink: wired?.link,
  };
}

/** 把 Set/Get 无线连线与模式中继从 links 中解析掉，保持 link id 不变。 */
export function resolveVirtualLinks(rawNodes, links) {
  const facts = new Map();
  for (const raw of Array.isArray(rawNodes) ? rawNodes : []) {
    const node = virtualNodeFacts(raw);
    if (node && isVirtualNodeType(node.type)) facts.set(node.id, node);
  }
  if (!facts.size) return links;
  const linkById = new Map(links.map((l) => [l[0], l]));
  const setters = new Map();
  for (const node of facts.values()) {
    if (node.type !== SET_NODE || node.name === undefined) continue;
    setters.set(node.name, [...(setters.get(node.name) || []), node]);
  }
  const setterFor = (getter) => {
    const candidates = getter.name === undefined ? [] : setters.get(getter.name) || [];
    const before = candidates.filter((n) => n.order < getter.order);
    const pool = before.length ? before : candidates;
    return pool.reduce((best, n) => (!best || n.order > best.order ? n : best), undefined);
  };
  const realOrigin = (originId, originSlot, seen) => {
    const node = facts.get(originId);
    if (!node) return [originId, originSlot];
    if (seen.has(originId)) return undefined;
    seen.add(originId);
    if (MODE_LINK_NODES.has(node.type)) return undefined;
    const source = node.type === GET_NODE ? setterFor(node) : node;
    const upstream = source?.firstInputLink === undefined ? undefined : linkById.get(source.firstInputLink);
    return upstream ? realOrigin(upstream[1], upstream[2], seen) : undefined;
  };
  const out = [];
  for (const link of links) {
    if (facts.has(link[3])) continue;
    const origin = realOrigin(link[1], link[2], new Set());
    if (!origin) continue;
    out.push(origin[0] === link[1] && origin[1] === link[2] ? link : [link[0], origin[0], origin[1], link[3], link[4], link[5]]);
  }
  return out;
}

const UI_ONLY = new Set(['Note', 'StickyNote', 'MarkdownNote', 'Reroute', 'Fast Groups Bypasser (rgthree)']);

function isWidgetSpec(typeSpec, options) {
  return (typeof typeSpec === 'string' && ['INT', 'FLOAT', 'STRING', 'BOOLEAN'].includes(typeSpec))
    || Array.isArray(typeSpec) || options?.widget?.name !== undefined;
}

function inputSpec(objectInfo, classType, name) {
  const def = objectInfo[classType];
  const input = isObject(def) && isObject(def.input) ? def.input : undefined;
  if (!input) return undefined;
  for (const group of ['required', 'optional']) {
    const fields = isObject(input[group]) ? input[group] : {};
    if (name in fields) return fields[name];
  }
  return undefined;
}

function dynamicComboKeys(spec) {
  const options = isObject(spec[1]) ? spec[1].options : undefined;
  if (!Array.isArray(options)) return undefined;
  const keys = options.map((o) => (isObject(o) ? o.key : undefined)).filter((k) => typeof k === 'string');
  return keys.length ? keys : undefined;
}

function widgetNamesFor(classType, objectInfo, node) {
  const names = [];
  const add = (n) => { if (!names.includes(n)) names.push(n); };
  for (const entry of node.inputs || []) {
    const name = entry.widget?.name;
    if (typeof name !== 'string' || !name) continue;
    add(name);
    const spec = inputSpec(objectInfo, classType, entry.name);
    const typeSpec = Array.isArray(spec) ? spec[0] : undefined;
    const options = Array.isArray(spec) && isObject(spec[1]) ? spec[1] : undefined;
    if (typeSpec === 'INT' && options?.control_after_generate !== false) {
      const seedLike = name === 'seed' || /(^|_|-)(seed|noise_seed)$/i.test(name);
      if (options?.control_after_generate === true || seedLike) add(`control_after_generate#${name}`);
    }
  }
  const dynamicCombos = (node.inputs || []).map((e) => e.widget?.name)
    .filter((n) => typeof n === 'string' && n && inputSpec(objectInfo, classType, n)?.[0] === 'COMFY_DYNAMICCOMBO_V3');
  if (dynamicCombos.length) {
    const reordered = [];
    for (const name of names) {
      const master = dynamicCombos.find((p) => name.startsWith(`${p}.`));
      if (master !== undefined) {
        if (!reordered.includes(master)) reordered.push(master);
        reordered.push(name);
        continue;
      }
      if (!dynamicCombos.includes(name) || !names.some((o) => o.startsWith(`${name}.`))) reordered.push(name);
    }
    names.splice(0, names.length, ...reordered);
  }
  const def = objectInfo[classType];
  const input = isObject(def) && isObject(def.input) ? def.input : undefined;
  if (input) {
    for (const group of ['required', 'optional']) {
      const fields = isObject(input[group]) ? input[group] : {};
      for (const [key, spec] of Object.entries(fields)) {
        if (spec == null) continue;
        const [typeSpec, options] = Array.isArray(spec) ? [spec[0], isObject(spec[1]) ? spec[1] : undefined] : [undefined, undefined];
        if (!isWidgetSpec(typeSpec, options)) continue;
        const name = options?.widget?.name ?? key;
        if (names.includes(name)) continue;
        add(name);
        // 旧版图里没有逐项列出控件时，种子后面的 control_after_generate 同样占一个位置
        const seedLike = name === 'seed' || /(^|_|-)(seed|noise_seed)$/i.test(name);
        if (typeSpec === 'INT' && options?.control_after_generate !== false && (options?.control_after_generate === true || seedLike)) add(`control_after_generate#${name}`);
      }
    }
  }
  return names;
}

function resolveOutput(linkId, links, nodesById, objectInfo, warnings) {
  const link = links.get(linkId);
  return link ? resolveOrigin(link[1], link[2], links, nodesById, objectInfo, warnings) : 'missing';
}

function resolveOrigin(nodeId, slot, links, nodesById, objectInfo, warnings) {
  const node = nodesById.get(nodeId);
  if (!node) return 'missing';
  if (node.type === 'Reroute' || node.mode === 4) {
    const inputLink = (node.inputs || []).find((e) => e.link !== null)?.link;
    return inputLink == null ? 'missing' : resolveOutput(inputLink, links, nodesById, objectInfo, warnings);
  }
  if (objectInfo[node.type] === undefined) {
    const value = Array.isArray(node.widgets_values) ? node.widgets_values[0] : undefined;
    return value === undefined ? 'missing' : value;
  }
  const outputs = objectInfo[node.type]?.output;
  if (Array.isArray(outputs) && slot >= outputs.length) {
    warnings.push(`节点 ${node.type} 的第 ${slot} 号输出在服务端不存在，已断开相关连线`);
    return 'missing';
  }
  return [String(nodeId), slot];
}

export function isUiGraph(json) {
  return isObject(json) && Array.isArray(json.nodes) && Array.isArray(json.links);
}

/**
 * 用 ComfyUI 当前的节点定义（/object_info）把界面图转换成 API 格式。
 * 返回 { ok, workflow, warnings } 或 { ok: false, error }。
 */
export function convertGraphToApi(graph, objectInfo) {
  if (!isUiGraph(graph)) return { ok: false, error: '不是 ComfyUI 界面工作流（缺少 nodes / links）' };
  const nodes = graph.nodes.filter(isObject).map((raw) => ({
    id: typeof raw.id === 'number' ? raw.id : Number(raw.id),
    type: typeof raw.type === 'string' ? raw.type : '',
    mode: typeof raw.mode === 'number' ? raw.mode : 0,
    inputs: Array.isArray(raw.inputs) ? raw.inputs.filter(isObject).map((e) => ({
      name: typeof e.name === 'string' ? e.name : '',
      link: typeof e.link === 'number' ? e.link : null,
      widget: isObject(e.widget) ? e.widget : undefined,
    })) : [],
    outputs: Array.isArray(raw.outputs) ? raw.outputs.filter(isObject).map((e) => ({
      links: Array.isArray(e.links) ? e.links.filter((l) => typeof l === 'number') : [],
    })) : [],
    widgets_values: Array.isArray(raw.widgets_values) || isObject(raw.widgets_values) ? raw.widgets_values : undefined,
    title: typeof raw.title === 'string' ? raw.title : undefined,
  }));
  const links = new Map();
  for (const link of resolveVirtualLinks(graph.nodes, normalizeLinks(graph.links))) links.set(link[0], link);
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const hasUsedOutput = (node) => (node.outputs || []).some((o) => o.links.some((id) => {
    const link = links.get(id);
    return link && nodesById.get(link[3]);
  }));

  const workflow = {};
  const warnings = [];
  for (const node of nodes) {
    if (!node.type || UI_ONLY.has(node.type) || isVirtualNodeType(node.type) || node.mode === 4 || node.mode === 2) continue;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(node.type) || node.type.startsWith('workflow')) {
      return { ok: false, error: `包含子图节点「${node.title || node.type}」，请在 ComfyUI 中把子图展开后再导入` };
    }
    if (objectInfo[node.type] === undefined) {
      if (!hasUsedOutput(node) || node.type.startsWith('Primitive')) continue;
      return { ok: false, error: `ComfyUI 中没有节点「${node.type}」（未安装该自定义节点？）` };
    }
    const inputs = {};
    for (const entry of node.inputs || []) {
      if (entry.link == null) continue;
      const resolved = resolveOutput(entry.link, links, nodesById, objectInfo, warnings);
      if (resolved !== 'missing') inputs[entry.name] = resolved;
    }
    const values = node.widgets_values;
    if (Array.isArray(values)) {
      let i = 0;
      for (const name of widgetNamesFor(node.type, objectInfo, node)) {
        if (i >= values.length) break;
        if (name.startsWith('control_after_generate')) { i++; continue; }
        if (!(name in inputs)) inputs[name] = values[i];
        i++;
      }
    } else if (isObject(values)) {
      for (const [name, value] of Object.entries(values)) {
        if (name === 'videopreview' || (isObject(value) && value.hidden === true)) continue;
        if (!(name in inputs)) inputs[name] = value;
      }
    }
    for (const [name, value] of Object.entries(inputs)) {
      const spec = inputSpec(objectInfo, node.type, name);
      if (!Array.isArray(spec) || spec[0] !== 'COMFY_DYNAMICCOMBO_V3') continue;
      const keys = dynamicComboKeys(spec);
      if (keys && !Array.isArray(value) && (typeof value !== 'string' || !keys.includes(value))) {
        return { ok: false, error: `节点 ${node.type}（${node.id}）的 ${name} 取值不在可选项中，请在 ComfyUI 中重新选择后再导出` };
      }
    }
    workflow[String(node.id)] = { class_type: node.type, inputs, ...(node.title ? { _meta: { title: node.title } } : {}) };
  }
  if (!Object.keys(workflow).length) return { ok: false, error: '转换结果为空（图中没有可执行的节点）' };
  for (const [id, node] of Object.entries(workflow)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number' && !workflow[value[0]]) {
        return { ok: false, error: `节点 ${node.class_type}（${id}）的输入 ${name} 引用了不存在的节点 ${value[0]}` };
      }
    }
    const def = objectInfo[node.class_type];
    const required = isObject(def?.input?.required) ? Object.keys(def.input.required) : [];
    const missing = required.filter((name) => {
      if (name in node.inputs) return false;
      const spec = inputSpec(objectInfo, node.class_type, name);
      const options = Array.isArray(spec) && isObject(spec[1]) ? spec[1] : undefined;
      return options?.lazy !== true && options?.template === undefined;
    });
    if (missing.length) return { ok: false, error: `节点 ${node.class_type}（${id}）缺少必需输入：${missing.join('、')}（源工作流里这些输入没有连线）` };
  }
  return { ok: true, workflow, warnings };
}
