# Mua web and API server. Connect to a separately running API Bridge.

# ---------- 1. 构建前端 ----------
FROM node:24-bookworm AS web-build
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY web/ ./
COPY shared/ /src/shared/
RUN npm run build

# ---------- 2. 运行时 ----------
FROM node:24-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    TZ=Asia/Shanghai

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/ /app/server/
COPY shared/ /app/shared/
COPY deploy/docker/entrypoint.sh /app/deploy/docker/entrypoint.sh
COPY --from=web-build /src/web/dist /app/web/dist

# Windows 上 COPY 不保留执行位，必须显式 chmod，否则入口脚本 permission denied
RUN chmod +x /app/deploy/docker/entrypoint.sh

# 平台后端依赖
RUN cd /app/server && (npm ci --omit=dev --no-fund --no-audit || npm install --omit=dev --no-fund --no-audit)

ENV HOST=0.0.0.0 PORT=8787
VOLUME ["/app/server/data"]

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/deploy/docker/entrypoint.sh"]
