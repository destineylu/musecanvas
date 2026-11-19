param([Parameter(Mandatory=$true)][string]$PackageZip)
$ErrorActionPreference='Stop'
$zip=(Resolve-Path -LiteralPath $PackageZip).Path
$sandbox=Join-Path ([IO.Path]::GetTempPath()) ('musecanvas-win-smoke-'+[guid]::NewGuid().ToString('N').Substring(0,8))
Expand-Archive -LiteralPath $zip -DestinationPath $sandbox
$app=Join-Path $sandbox 'musecanvas'
function Read-EnvFile($path) {
  $result=@{}
  Get-Content -LiteralPath $path | ForEach-Object {
    if ($_ -match '^([^#=]+)=(.*)$') { $result[$matches[1]]=$matches[2] }
  }
  return $result
}
function Invoke-LocalJson($uri, $method='GET', $headers=@{}, $body=$null) {
  $config=@('url = '+($uri | ConvertTo-Json -Compress), 'request = "'+$method+'"', 'header = "Content-Type: application/json"')
  foreach ($key in $headers.Keys) { $config += 'header = '+(($key+': '+$headers[$key]) | ConvertTo-Json -Compress) }
  if ($null -ne $body) { $config += 'data = '+($body | ConvertTo-Json -Compress) }
  $result=($config -join "`n") | & curl.exe --noproxy '*' --silent --show-error --fail --max-time 20 --config -
  if ($LASTEXITCODE -ne 0) { throw 'Local HTTP verification failed' }
  return ($result | ConvertFrom-Json)
}
try {
  if (Test-Path -LiteralPath (Join-Path $app 'server\.env')) { throw 'Archive contains credentials' }
  if (Test-Path -LiteralPath (Join-Path $app 'server\data')) { throw 'Archive contains user data' }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app 'deploy\windows\launch.ps1') -NoBrowser
  if ($LASTEXITCODE -ne 0) { throw 'Fresh portable launch failed' }
  $envs=Read-EnvFile (Join-Path $app 'server\.env')
  $engine=Read-EnvFile (Join-Path $app 'upstream\muse2api\.env')
  if ($envs.MUSE_KEY -ne $engine.MUSE2API_KEY) { throw 'Generated engine keys do not match' }
  if ($envs.ACCESS_MODE -ne 'local') { throw 'Download is not local desktop mode' }
  $base='http://127.0.0.1:'+$envs.PORT
  $health=Invoke-LocalJson "$base/api/health"
  if ($health.service -ne 'musecanvas' -or $health.upstreamMode -ne 'muse2api') { throw 'Wrong service' }
  foreach ($pair in @(@('server\server.log.pid','runtime\node\node.exe'),@('upstream\muse2api\server.log.pid','runtime\python\python.exe'))) {
    $ownedId=[int](Get-Content -Raw -LiteralPath (Join-Path $app $pair[0])).Trim()
    $owned=Get-CimInstance Win32_Process -Filter "ProcessId = $ownedId"
    if ($owned.ExecutablePath -ne (Join-Path $app $pair[1])) { throw 'Started a system runtime instead of the bundled runtime' }
  }
  $session=Invoke-LocalJson "$base/api/auth/local-session" 'POST' @{} '{}'
  $headers=@{Authorization=('Bearer '+$session.token)}
  $accounts=Invoke-LocalJson "$base/api/accounts" 'GET' $headers
  if (@($accounts.accounts).Count -ne 0) { throw 'Fresh package contains accounts' }
  $engineHeaders=@{Authorization=('Bearer '+$envs.MUSE_KEY)}
  $models=Invoke-LocalJson ($envs.MUSE_BASE+'/v1/models') 'GET' $engineHeaders
  if (-not @($models.data | Where-Object {$_.id -eq 'muse-spark'}).Count) { throw 'Private Python engine unavailable' }
  $before=$envs.JWT_SECRET
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app 'deploy\windows\launch.ps1') -NoBrowser
  if ($LASTEXITCODE -ne 0) { throw 'Repeat launch failed' }
  if ((Read-EnvFile (Join-Path $app 'server\.env')).JWT_SECRET -ne $before) { throw 'Repeated launch replaced credentials' }
  Write-Output 'PASS Windows ZIP: bundled runtimes, private engine, local no-login session, empty accounts, repeat launch preserves credentials'
} finally {
  if (Test-Path -LiteralPath (Join-Path $app 'stop.ps1')) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app 'stop.ps1')
  }
  Write-Output "Smoke-test workspace: $sandbox"
}
