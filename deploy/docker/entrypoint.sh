#!/usr/bin/env bash
# musecanvas 服务启动前检查运行配置。
set -euo pipefail

log() { echo "[entrypoint] $*"; }

# ---- 启动前自检：密钥不合格就别启动，避免半个服务在跑 ----
if [ -z "${JWT_SECRET:-}" ] || [ "${#JWT_SECRET}" -lt 32 ]; then
    log "错误：JWT_SECRET 未设置或不足 32 个字符（见 deploy/docker/.env.example）"
    exit 1
fi
if [ -z "${ADMIN_PASSWORD:-}" ] || [ "${#ADMIN_PASSWORD}" -lt 12 ]; then
    log "错误：ADMIN_PASSWORD 未设置或不足 12 个字符（仅首次创建管理员时使用）"
    exit 1
fi

case "${MUSECANVAS_UPSTREAM:-bridge}" in
    bridge) ;;
    muse2api) : "${MUSE_BASE:?请设置容器可访问的 MUSE_BASE}" ;;
    *) log "错误：MUSECANVAS_UPSTREAM 必须是 bridge 或 muse2api"; exit 1 ;;
esac

mkdir -p /app/server/data
# Embedded engine is private to this instance; only the canvas port is exposed.
if [ "${EMBEDDED_ENGINE:-1}" = "1" ]; then
    : "${MUSE_KEY:?请设置此工作区专属 MUSE_KEY}"
    export MUSE2API_KEY="$MUSE_KEY"
    export MUSE_BASE=http://127.0.0.1:18610
    mkdir -p /app/engine/data /app/engine/profiles
    cd /app/upstream/muse2api
    /opt/musecanvas-engine/bin/python -m uvicorn app:app --host 127.0.0.1 --port 18610 &
    engine_pid=$!
    engine_ready=0
    for attempt in $(seq 1 90); do
        if curl -fsS http://127.0.0.1:18610/healthz >/dev/null 2>&1; then engine_ready=1; break; fi
        if ! kill -0 "$engine_pid" 2>/dev/null; then log "内置 Muse 引擎退出"; exit 1; fi
        sleep 1
    done
    if [ "$engine_ready" != "1" ]; then kill "$engine_pid"; log "内置引擎启动超时"; exit 1; fi
    cd /app/server
    node src/index.js &
    app_pid=$!
    cleanup() { kill "$app_pid" "$engine_pid" 2>/dev/null || true; wait || true; }
    trap cleanup EXIT
    trap 'exit 143' TERM
    trap 'exit 130' INT
    set +e
    wait -n "$app_pid" "$engine_pid"
    result=$?
    # A child exiting cleanly is still unexpected for a long-running service.
    if [ "$result" = "0" ]; then result=1; fi
    exit "$result"
fi
cd /app/server
exec node src/index.js
