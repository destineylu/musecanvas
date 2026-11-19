// 配置读写：data/config.json（含 token，切勿提交到 git）
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const DEFAULT_SETTINGS = {
  host: "127.0.0.1", // 监听地址；改成 0.0.0.0 前务必设置 gatewayKey
  port: 8090,
  gatewayKey: "", // Toonflow 调用网关时用的 Bearer key；留空 = 不校验（仅建议本机）
  adminKey: "", // 管理界面密码；留空 = 仅允许本机访问管理界面
  publicBaseUrl: "", // 媒体代理链接的对外地址，留空按请求 Host 推断
  requestTimeoutSec: 1900, // 给 1800 秒的 Bridge 超时留出传输余量
  queueTimeoutSec: 1800, // 排队等待空闲 Bridge 的最长时间
  retryDelaySec: 60, // 5xx/超时/网络错后的重试等待
  maxRetries: 1, // 重试次数（不含首次）
  healthIntervalSec: 30,
  failThreshold: 2, // 连续失败几次进入冷却
  cooldownSec: 120,
  proxyMedia: false, // 把 Bridge 的 8081 链接改写成网关 /files/... 代理链接
  validateMedia: true, // 图片/视频模型必须返回对应类型的媒体链接，否则按失败处理
};

const DEFAULT_MODELS = [
  { id: "muse", label: "Muse 对话", type: "chat", upstreamModel: "muse", bridges: [], enabled: true },
  { id: "muse-image", label: "Muse 图片", type: "image", upstreamModel: "muse", bridges: [], enabled: true },
  { id: "muse-video", label: "Muse 视频", type: "video", upstreamModel: "muse", bridges: [], enabled: true },
];

const DEFAULT_BRIDGES = [];

const MODEL_TYPES = new Set(["chat", "image", "video"]);
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function httpUrl(value, field) {
  const s = String(value ?? "").trim().replace(/\/+$/, "");
  let u;
  try {
    u = new URL(s);
  } catch {
    throw badInput(`${field} 不是合法地址`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw badInput(`${field} 必须是 http/https`);
  if (u.username || u.password || u.search || u.hash) throw badInput(`${field} 请使用不含账号、查询参数和锚点的基础地址`);
  return s;
}

export function badInput(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** 由 baseUrl 推出默认文件服务地址：同主机 8081 端口。 */
export function defaultFileBase(baseUrl) {
  const u = new URL(baseUrl);
  u.port = "8081";
  u.pathname = "/";
  return u.origin;
}

export function normalizeBridge(input, existing) {
  const out = { ...(existing || {}) };
  if (!existing) out.id = input.id && ID_RE.test(input.id) ? input.id : crypto.randomUUID().slice(0, 8);
  if (input.name !== undefined || !existing) out.name = String(input.name ?? "").trim() || out.id;
  if (input.baseUrl !== undefined || !existing) {
    let base = httpUrl(input.baseUrl, "接口地址");
    if (!/\/v1$/.test(base)) base += "/v1";
    out.baseUrl = base;
  }
  if (input.fileBaseUrl !== undefined) {
    out.fileBaseUrl = String(input.fileBaseUrl).trim() ? httpUrl(input.fileBaseUrl, "文件地址") : "";
  }
  if (!out.fileBaseUrl) out.fileBaseUrl = defaultFileBase(out.baseUrl);
  // fileFetchUrl：网关实际下载文件用的地址（例如本机端口转发 http://127.0.0.1:18082）；留空 = 用 fileBaseUrl
  if (input.fileFetchUrl !== undefined) {
    out.fileFetchUrl = String(input.fileFetchUrl).trim() ? httpUrl(input.fileFetchUrl, "文件下载地址") : "";
  }
  if (out.fileFetchUrl === undefined) out.fileFetchUrl = "";
  // token：空字符串 = 保持原值；clearToken = 清除
  if (input.clearToken) out.token = "";
  else if (typeof input.token === "string" && input.token.trim()) out.token = input.token.trim();
  else if (!existing) out.token = "";
  if (input.enabled !== undefined || !existing) out.enabled = input.enabled !== false;
  if (input.maxConcurrency !== undefined || !existing) {
    const n = Number(input.maxConcurrency ?? 1);
    out.maxConcurrency = Number.isInteger(n) && n >= 1 && n <= 16 ? n : 1;
  }
  return out;
}

export function normalizeModel(input, existing, bridgeIds) {
  const out = { ...(existing || {}) };
  if (!existing) {
    if (!ID_RE.test(String(input.id ?? ""))) throw badInput("模型 ID 只能用字母、数字、点、下划线、横线（1–64 位）");
    out.id = input.id;
  }
  if (input.label !== undefined || !existing) out.label = String(input.label ?? "").trim() || out.id;
  if (input.type !== undefined || !existing) {
    if (!MODEL_TYPES.has(input.type)) throw badInput("模型类型必须是 chat / image / video");
    out.type = input.type;
  }
  if (input.upstreamModel !== undefined || !existing) out.upstreamModel = String(input.upstreamModel ?? "").trim() || "muse";
  if (input.bridges !== undefined || !existing) {
    const list = Array.isArray(input.bridges) ? input.bridges.map(String) : [];
    out.bridges = list.filter((id) => bridgeIds.includes(id));
  }
  if (input.enabled !== undefined || !existing) out.enabled = input.enabled !== false;
  return out;
}

export function normalizeSettings(input, current) {
  const out = { ...current };
  const num = (k, min, max) => {
    if (input[k] === undefined) return;
    const n = Number(input[k]);
    if (!Number.isFinite(n) || n < min || n > max) throw badInput(`${k} 必须在 ${min}–${max} 之间`);
    out[k] = n;
  };
  if (input.host !== undefined) out.host = String(input.host).trim() || "127.0.0.1";
  num("port", 1, 65535);
  num("requestTimeoutSec", 30, 7200);
  num("queueTimeoutSec", 10, 7200);
  num("retryDelaySec", 0, 600);
  num("maxRetries", 0, 5);
  num("healthIntervalSec", 5, 3600);
  num("failThreshold", 1, 20);
  num("cooldownSec", 0, 3600);
  for (const k of ["gatewayKey", "adminKey"]) {
    if (input[`clear_${k}`]) out[k] = "";
    else if (typeof input[k] === "string" && input[k].trim()) out[k] = input[k].trim();
  }
  if (input.publicBaseUrl !== undefined) {
    out.publicBaseUrl = String(input.publicBaseUrl).trim() ? httpUrl(input.publicBaseUrl, "对外地址") : "";
  }
  if (input.proxyMedia !== undefined) out.proxyMedia = !!input.proxyMedia;
  if (input.validateMedia !== undefined) out.validateMedia = !!input.validateMedia;
  return out;
}

export class Store {
  constructor(file) {
    this.file = file;
    this.data = null;
  }

  load() {
    if (fs.existsSync(this.file)) {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.data = {
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
        bridges: Array.isArray(raw.bridges) ? raw.bridges : [],
        models: Array.isArray(raw.models) ? raw.models : structuredClone(DEFAULT_MODELS),
      };
    } else {
      this.data = {
        settings: { ...DEFAULT_SETTINGS },
        bridges: structuredClone(DEFAULT_BRIDGES),
        models: structuredClone(DEFAULT_MODELS),
      };
      this.save();
    }
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  bridge(id) {
    return this.data.bridges.find((b) => b.id === id);
  }

  model(id) {
    return this.data.models.find((m) => m.id === id);
  }
}
