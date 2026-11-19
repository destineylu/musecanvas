# musecanvas 一键启动
# 用法：
#   .\start.ps1          启动 musecanvas 和本机网关（生产模式，需先有 web\dist）
#   .\start.ps1 -Upstream muse2api  使用原本的账号池
#   .\start.ps1 -Build   先构建前端再启动
#   .\start.ps1 -Dev     额外启动前端 dev server (vite, 5173)
param(
  [switch]$Dev,
  [switch]$Build,
  [ValidateSet("bridge", "muse2api")][string]$Upstream
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $root 'server'
$web = Join-Path $root 'web'

function Test-Port($port) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  return [bool]$c
}

function Wait-Http($url, $seconds = 40) {
  for ($i = 0; $i -lt $seconds; $i++) {
    try {
      & curl.exe --noproxy '*' --silent --fail --max-time 2 -o NUL $url
      if ($LASTEXITCODE -eq 0) { return $true }
    } catch { }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Start-Detached($exe, $argLine, $workDir, $logFile) {
  $process = Start-Process -FilePath $exe -ArgumentList $argLine -WorkingDirectory $workDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $logFile -RedirectStandardError ($logFile -replace '\.log$', '.err.log')
  if (-not $process.HasExited) { Set-Content -LiteralPath "$logFile.pid" -Value $process.Id }
  return -not $process.HasExited
}

Write-Host ""
Write-Host "=== musecanvas 启动 ===" -ForegroundColor Cyan
Write-Host ""

# ---------- 2. 后端依赖 ----------
if (-not (Test-Path (Join-Path $server 'node_modules'))) {
  Write-Host "[2/4] 安装后端依赖…" -ForegroundColor Yellow
  Push-Location $server; npm install --no-fund --no-audit; Pop-Location
} else {
  Write-Host "[2/4] 后端依赖就绪" -ForegroundColor DarkGray
}
if (-not (Test-Path (Join-Path $server '.env'))) {
  Copy-Item (Join-Path $server '.env.example') (Join-Path $server '.env')
  Write-Host "  已从 .env.example 生成 .env，建议改掉 ADMIN_PASSWORD / JWT_SECRET" -ForegroundColor Yellow
}

# ---------- 3. 前端产物 ----------
if ($Build -or -not (Test-Path (Join-Path $web 'dist\index.html'))) {
  if (-not (Test-Path (Join-Path $web 'node_modules'))) {
    Write-Host "[3/4] 安装前端依赖…" -ForegroundColor Yellow
    Push-Location $web; npm install --no-fund --no-audit; Pop-Location
  }
  Write-Host "[3/4] 构建前端…" -ForegroundColor Yellow
  Push-Location $web; npm run build; Pop-Location
} else {
  Write-Host "[3/4] 前端产物已存在（加 -Build 可重新构建）" -ForegroundColor DarkGray
}

function Read-Setting($name, $fallback) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($value) { return $value }
  $line = Get-Content -LiteralPath (Join-Path $server '.env') |
    Where-Object { $_ -match "^\s*$name\s*=" } | Select-Object -Last 1
  if ($line) {
    $value = ($line -split '=', 2)[1].Trim().Trim('"', "'")
    if ($value) { return $value }
  }
  return $fallback
}

$upstreamDataDir = Read-Setting 'DATA_DIR' (Join-Path $server 'data')
$upstreamChoiceFile = Join-Path $upstreamDataDir 'upstream.json'
$upstreamChoice = if (Test-Path -LiteralPath $upstreamChoiceFile) { Get-Content -Raw -LiteralPath $upstreamChoiceFile | ConvertFrom-Json } else { $null }
$mode = if ($Upstream) { $Upstream.ToLowerInvariant() } elseif ($upstreamChoice.mode) { $upstreamChoice.mode } else { (Read-Setting 'MUSECANVAS_UPSTREAM' 'bridge').ToLowerInvariant() }
if ($mode -notin 'bridge','muse2api') { throw 'MUSECANVAS_UPSTREAM 必须是 bridge 或 muse2api' }
if ($mode -eq 'bridge') {
  $url = 'embedded'
} else {
  $legacyConfigPath = Join-Path $upstreamDataDir 'muse2api.json'
  $savedLegacy = if (Test-Path -LiteralPath $legacyConfigPath) { Get-Content -Raw -LiteralPath $legacyConfigPath | ConvertFrom-Json } else { $null }
  $url = if ($savedLegacy.baseUrl) { $savedLegacy.baseUrl } else { (Read-Setting 'MUSE_BASE' 'http://127.0.0.1:18610').TrimEnd('/') -replace '/v1$','' }
  $upstreamUri = [uri]$url
  if ($upstreamUri.Scheme -eq 'http' -and $upstreamUri.Host -in '127.0.0.1','localhost' -and
      $upstreamUri.Port -eq 18610 -and $upstreamUri.AbsolutePath -eq '/') {
    if (-not (Test-Port 18610)) {
      $legacyDir = Join-Path $root 'upstream\muse2api'
      $python = Join-Path $legacyDir '.venv\Scripts\python.exe'
      if (-not (Test-Path $python)) {
        & python -m venv (Join-Path $legacyDir '.venv')
        if ($LASTEXITCODE -ne 0) { throw 'muse2api Python 环境创建失败' }
        & $python -m pip install -r (Join-Path $legacyDir 'requirements.txt')
        if ($LASTEXITCODE -ne 0) { throw 'muse2api 依赖安装失败' }
      }
      if (-not (Test-Path (Join-Path $legacyDir '.env'))) { throw '请先配置 upstream\muse2api\.env' }
      $previousHome = $env:MUSE2API_HOME
      $previousKey = $env:MUSE2API_KEY
      try {
        $env:MUSE2API_HOME = $legacyDir
        $env:MUSE2API_KEY = $null
        $ok = Start-Detached $python '-m uvicorn app:app --host 127.0.0.1 --port 18610' $legacyDir (Join-Path $legacyDir 'server.log')
      } finally {
        $env:MUSE2API_HOME = $previousHome
        $env:MUSE2API_KEY = $previousKey
      }
      if (-not $ok) { throw 'muse2api 启动失败，查看 upstream\muse2api\server.err.log' }
    }
    if (-not (Wait-Http 'http://127.0.0.1:18610/healthz' 30)) { throw 'muse2api 健康检查失败' }
  }
}

# ---------- 5. 平台后端 ----------
if (Test-Port 8787) {
  $current = & curl.exe --noproxy '*' --silent --fail --max-time 3 'http://127.0.0.1:8787/api/health' | ConvertFrom-Json
  if ($current.service -ne 'musecanvas' -or $current.upstream -ne $url -or $current.upstreamMode -ne $mode) {
    throw '8787 上的服务配置不同，请先停止该服务再启动 musecanvas。'
  }
  Write-Host "平台后端已在运行 (8787)" -ForegroundColor DarkGray
} else {
  Write-Host "启动平台后端 (8787)…" -ForegroundColor Yellow
  $nodeExe = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
  $previousMode = $env:MUSECANVAS_UPSTREAM
  $previousOverride = $env:MUSECANVAS_UPSTREAM_OVERRIDE
  try {
    $env:MUSECANVAS_UPSTREAM = $mode
    $env:MUSECANVAS_UPSTREAM_OVERRIDE = if ($Upstream) { $mode } else { $null }
    $ok = Start-Detached $nodeExe "src/index.js" $server (Join-Path $server 'server.log')
  } finally {
    $env:MUSECANVAS_UPSTREAM = $previousMode
    $env:MUSECANVAS_UPSTREAM_OVERRIDE = $previousOverride
  }
  if ($ok -and (Wait-Http 'http://127.0.0.1:8787/api/health' 30)) {
    Write-Host "  平台就绪" -ForegroundColor Green
  } else {
    throw "平台启动失败，看 server\server.err.log"
  }
}

# ---------- 6. 前端 dev ----------
if ($Dev) {
  if (Test-Port 5173) {
    Write-Host "前端 dev 已在运行 (5173)" -ForegroundColor DarkGray
  } else {
    Write-Host "启动前端 dev server (5173)…" -ForegroundColor Yellow
    $nodeExe = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    Start-Detached $nodeExe 'node_modules/vite/bin/vite.js --host 127.0.0.1' $web (Join-Path $web 'dev.log') | Out-Null
    Start-Sleep -Seconds 3
  }
}

Write-Host ""
Write-Host "---------------------------------------------" -ForegroundColor Cyan
Write-Host " 平台入口   http://127.0.0.1:8787" -ForegroundColor White
if ($Dev) { Write-Host " 前端调试   http://127.0.0.1:5173" -ForegroundColor White }
Write-Host " 上游模式   $mode  $url" -ForegroundColor DarkGray
Write-Host " 管理员凭据由 server\.env 配置" -ForegroundColor DarkGray
Write-Host " 停止服务   .\stop.ps1" -ForegroundColor DarkGray
Write-Host "---------------------------------------------" -ForegroundColor Cyan
Write-Host ""
