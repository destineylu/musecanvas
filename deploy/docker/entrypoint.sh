#!/usr/bin/env bash
# Mua 服务启动前检查运行配置。
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

case "${MUA_UPSTREAM:-bridge}" in
    bridge) ;;
    muse2api) : "${MUSE_BASE:?请设置容器可访问的 MUSE_BASE}" ;;
    *) log "错误：MUA_UPSTREAM 必须是 bridge 或 muse2api"; exit 1 ;;
esac

mkdir -p /app/server/data
cd /app/server
exec node src/index.js
