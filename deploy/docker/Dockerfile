# musecanvas web, API and private Muse browser engine in one container.

# ---------- 1. 构建前端 ----------
ARG NODE_BUILD_IMAGE=node:24-bookworm-slim
ARG NODE_RUNTIME_IMAGE=node:24-bookworm-slim
FROM ${NODE_BUILD_IMAGE} AS web-build
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY web/ ./
COPY shared/ /src/shared/
RUN npm run build

# ---------- 2. 运行时 ----------
FROM ${NODE_RUNTIME_IMAGE}
ARG DEBIAN_MIRROR=deb.debian.org

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    TZ=Asia/Shanghai

RUN node -e "const fs=require('fs');fs.mkdirSync('/etc/ssl/certs',{recursive:true});fs.writeFileSync('/etc/ssl/certs/ca-certificates.crt',require('tls').rootCertificates.join('\n'))" \
    && sed -i "s|http://deb.debian.org|https://${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o APT::Update::Error-Mode=any -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 install -y --no-install-recommends ca-certificates curl tini python3 python3-venv chromium fonts-wqy-zenhei fonts-freefont-ttf \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/ /app/server/
COPY shared/ /app/shared/
COPY upstream/muse2api/ /app/upstream/muse2api/
COPY deploy/docker/entrypoint.sh /app/deploy/docker/entrypoint.sh
COPY --from=web-build /src/web/dist /app/web/dist

# Windows 上 COPY 不保留执行位，必须显式 chmod，否则入口脚本 permission denied
RUN sed -i 's/\r$//' /app/deploy/docker/entrypoint.sh && chmod +x /app/deploy/docker/entrypoint.sh
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN python3 -m venv /opt/musecanvas-engine \
    && /opt/musecanvas-engine/bin/pip install --no-cache-dir -r /app/upstream/muse2api/requirements.txt

# 平台后端依赖
RUN cd /app/server && (npm ci --omit=dev --no-fund --no-audit || npm install --omit=dev --no-fund --no-audit)

ENV HOST=0.0.0.0 PORT=8787 \
    MUSE2API_HOME=/app/engine \
    MUSE2API_PROFILE_ROOT=/app/engine/profiles \
    MUSE2API_CHROMIUM=/usr/bin/chromium \
    MUSE2API_CONCURRENCY=1
VOLUME ["/app/server/data"]

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/deploy/docker/entrypoint.sh"]
