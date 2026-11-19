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
