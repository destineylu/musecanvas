# 停止由本项目启动脚本启动的 musecanvas 服务
$targets = @(
  @{ File = 'server\server.log.pid'; Pattern = '\bsrc[/\\]index\.js(?:["\s]|$)' },
  @{ File = 'web\dev.log.pid'; Pattern = '\bnode_modules[/\\]vite[/\\]bin[/\\]vite\.js(?:["\s]|$)' }
)
foreach ($target in $targets) {
  $record = Join-Path $PSScriptRoot $target.File
  if (-not (Test-Path -LiteralPath $record)) { continue }
  $processId = 0
  if ([int]::TryParse((Get-Content -Raw -LiteralPath $record).Trim(), [ref]$processId)) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    if ($process.Name -eq 'node.exe' -and $process.CommandLine -match $target.Pattern) {
      Stop-Process -Id $processId
      Write-Output "Stopped musecanvas process $processId"
    }
  }
  Remove-Item -LiteralPath $record
}

# Portable downloads own a private engine and browser profile. Leave source installs alone.
$portablePython = Join-Path $PSScriptRoot 'runtime\python\python.exe'
$enginePid = Join-Path $PSScriptRoot 'upstream\muse2api\server.log.pid'
if ((Test-Path -LiteralPath $portablePython) -and (Test-Path -LiteralPath $enginePid)) {
  $engineProcessId = 0
  if ([int]::TryParse((Get-Content -Raw -LiteralPath $enginePid).Trim(), [ref]$engineProcessId)) {
    $engineProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $engineProcessId" -ErrorAction SilentlyContinue
    if ($engineProcess.ExecutablePath -eq $portablePython -and $engineProcess.CommandLine -match '\buvicorn\s+app:app\b') {
      Stop-Process -Id $engineProcessId
      $profile = Join-Path $PSScriptRoot 'upstream\muse2api\profiles'
      Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' OR Name = 'msedge.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profile) -and $_.CommandLine.Contains('--user-data-dir=') } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
      Write-Output "Stopped private Muse engine $engineProcessId"
    }
  }
  Remove-Item -LiteralPath $enginePid
}
