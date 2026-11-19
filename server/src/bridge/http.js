// 用 node:http 而不是全局 fetch：Node 的 fetch(undici) 默认 300 秒收不到响应头就断，
// 而 Bridge 排队 + 生成经常超过 300 秒才回响应头。
import http from "node:http";
import https from "node:https";

export function httpRequest(url, { method = "GET", headers = {}, body, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (payload) headers = { ...headers, "Content-Length": payload.length };
    const req = mod.request(u, { method, headers }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on("data", (c) => {
        bytes += c.length;
        if (bytes > 48 * 1024 * 1024) {
          req.destroy(new Error("Bridge 响应超过 48 MB"));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      res.on("aborted", () => {
        clearTimeout(timer);
        reject(new Error("Bridge 响应中断"));
      });
    });
    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** 流式转发（媒体文件代理用）。 */
export function httpPipe(url, clientRes, { method = "GET", timeoutMs = 120_000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(u, { method, headers }, (res) => {
      const pass = {};
      for (const k of ["content-type", "content-length", "last-modified", "etag", "accept-ranges", "content-range"]) {
        if (res.headers[k]) pass[k] = res.headers[k];
      }
      clientRes.writeHead(res.statusCode || 502, pass);
      res.pipe(clientRes);
      res.on("end", resolve);
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("文件代理超时")));
    req.on("error", reject);
    clientRes.on("close", () => req.destroy());
    req.end();
  });
}
