#!/usr/bin/env bash
# Official musecanvas single-container installer. Requires Docker + Compose.
set -euo pipefail
umask 077
repo=destineylu/musecanvas
version=latest
name=owner
email=
port=8787
bind=127.0.0.1
url=
build=0
target="${HOME}/musecanvas"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --build) build=1; shift; continue;;
    --dir) target="$2";; --name) name="$2";; --email) email="$2";;
    --port) port="$2";; --bind) bind="$2";; --url) url="$2";; --version) version="$2";;
    --help) printf '%s\n' 'Usage: bash install.sh --email you@example.com [--name owner] [--port 8787] [--bind NAS-IP] [--url https://canvas.example.com] [--dir ~/musecanvas] [--version v1.0.0]'; exit 0;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 1;;
  esac
  [ "$#" -ge 2 ] || { printf 'Missing value\n' >&2; exit 1; }
  shift 2
done
for command in docker curl tar gzip sha256sum; do command -v "$command" >/dev/null || { printf 'Required command missing: %s\n' "$command" >&2; exit 1; }; done
docker info >/dev/null 2>&1 || { printf 'Docker is not running, or this user cannot access it.\n' >&2; exit 1; }
docker compose version >/dev/null
if [ -z "$email" ]; then
  if [ -r /dev/tty ]; then read -r -p 'Workspace login email: ' email </dev/tty; else printf 'Specify --email you@example.com\n' >&2; exit 1; fi
fi
[ ! -e "$target" ] || { printf 'Target exists; refusing to overwrite credentials or data: %s\n' "$target" >&2; exit 1; }
case "$version" in latest) download="https://github.com/$repo/releases/latest/download";; v[0-9]*) download="https://github.com/$repo/releases/download/$version";; *) printf 'Invalid release version\n' >&2; exit 1;; esac
tmp=$(mktemp -d)
cleanup() { rm -f "$tmp/musecanvas-install.tar.gz" "$tmp/musecanvas-image-amd64.tar.gz" "$tmp/SHA256SUMS"; rmdir "$tmp" 2>/dev/null || true; }
trap cleanup EXIT
curl -fL --retry 3 "$download/musecanvas-install.tar.gz" -o "$tmp/musecanvas-install.tar.gz"
curl -fL --retry 3 "$download/SHA256SUMS" -o "$tmp/SHA256SUMS"
(cd "$tmp" && grep -E '^[a-f0-9]{64}  musecanvas-install\.tar\.gz$' SHA256SUMS | sha256sum -c -)
mkdir -p "$target"
target=$(cd "$target" && pwd)
tar -xzf "$tmp/musecanvas-install.tar.gz" -C "$target" --strip-components=1
case "$(uname -m)" in x86_64|amd64) ;; *) build=1;; esac
if [ "$build" = "0" ]; then
  curl -fL --retry 3 "$download/musecanvas-image-amd64.tar.gz" -o "$tmp/musecanvas-image-amd64.tar.gz"
  (cd "$tmp" && grep -E '^[a-f0-9]{64}  musecanvas-image-amd64\.tar\.gz$' SHA256SUMS | sha256sum -c -)
  gzip -dc "$tmp/musecanvas-image-amd64.tar.gz" | docker load
fi
if command -v node >/dev/null && node -e 'process.exit(Number(process.versions.node.split(".")[0])>=18?0:1)' ; then
  node "$target/deploy/nas/create-instance.mjs" --name "$name" --email "$email" --port "$port" --bind "$bind" --url "$url"
else
  generator_image=musecanvas:1.0
  if [ "$build" = "1" ]; then generator_image=node:24-bookworm-slim; fi
  docker run --rm --entrypoint node --user "$(id -u):$(id -g)" -v "$target:/src" -w /src "$generator_image" deploy/nas/create-instance.mjs --name "$name" --email "$email" --port "$port" --bind "$bind" --url "$url"
fi
instance="$target/deploy/nas/instances/$name"
if [ "$build" = "1" ]; then (cd "$instance" && docker compose up -d --build); else (cd "$instance" && docker compose up -d --no-build --pull never); fi
printf '\nInstalled musecanvas.\nWorkspace: %s\nLogin email: %s\n' "$instance" "$email"
printf 'Initial password is stored privately in %s/.env (ADMIN_PASSWORD).\n' "$instance"
printf 'Open %s or your configured reverse proxy.\n' "${url:-http://$bind:$port}"
