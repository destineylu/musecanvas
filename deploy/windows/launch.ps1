param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location -LiteralPath $root
$env:PATH = (Join-Path $root 'runtime\node') + ';' + $env:PATH
function New-Secret {
  $bytes = New-Object byte[] 36
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}
$serverEnv = Join-Path $root 'server\.env'
$engineEnv = Join-Path $root 'upstream\muse2api\.env'
$utf8 = New-Object System.Text.UTF8Encoding($false)
if (-not (Test-Path -LiteralPath $serverEnv)) {
  $port = $null
  foreach ($candidate in @(8787,8788,18787,18788)) {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $candidate)
    try { $listener.Start(); $port = $candidate; break } catch {} finally { $listener.Stop() }
  }
  if (-not $port) { throw 'No available local port. Close conflicting programs and retry.' }
  $enginePort = $null
  foreach ($candidate in @(18610,18611,18612,28610)) {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $candidate)
    try { $listener.Start(); $enginePort = $candidate; break } catch {} finally { $listener.Stop() }
  }
  if (-not $enginePort) { throw 'No available engine port.' }
  $debugPort = $null
  foreach ($candidate in @(19210,19211,19212,29210)) {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $candidate)
    try { $listener.Start(); $debugPort = $candidate; break } catch {} finally { $listener.Stop() }
  }
  if (-not $debugPort) { throw 'No available browser debugging port.' }
  $key = New-Secret
  [IO.File]::WriteAllText($serverEnv, (@(
    'HOST=127.0.0.1', "PORT=$port", 'ACCESS_MODE=local', 'ALLOW_REGISTER=0',
    'ADMIN_EMAIL=owner@musecanvas.local', ('ADMIN_PASSWORD=' + (New-Secret)),
    ('JWT_SECRET=' + (New-Secret)), 'MUSECANVAS_UPSTREAM=muse2api',
    "MUSE_BASE=http://127.0.0.1:$enginePort", "MUSE_KEY=$key", 'MUSECANVAS_MANAGED_ENGINE=1'
  ) -join "`n") + "`n", $utf8)
  if (-not (Test-Path -LiteralPath $engineEnv)) {
    [IO.File]::WriteAllText($engineEnv, (@(
      "MUSE2API_KEY=$key", 'MUSE2API_HOST=127.0.0.1', "MUSE2API_PORT=$enginePort",
      "MUSE2API_CDP_PORT=$debugPort", ('MUSE2API_PROFILE_ROOT=' + (Join-Path $root 'upstream\muse2api\profiles')),
      'MUSE2API_CONCURRENCY=1', 'MUSE2API_IMAGE_TIMEOUT=600', 'MUSE2API_VIDEO_TIMEOUT=600'
    ) -join "`n") + "`n", $utf8)
  }
}
if (-not (Test-Path -LiteralPath $engineEnv)) { throw 'Missing engine configuration. Restore upstream/muse2api/.env from your backup.' }
& (Join-Path $root 'start.ps1')
if (-not $NoBrowser) {
  $line = Get-Content -LiteralPath $serverEnv | Where-Object { $_ -match '^PORT=' } | Select-Object -Last 1
  $port = if ($line) { ($line -split '=',2)[1].Trim() } else { '8787' }
  Start-Process "http://127.0.0.1:$port"
}
