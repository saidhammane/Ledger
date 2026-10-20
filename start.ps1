$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$node = Join-Path $PSScriptRoot '.tools\node-v24.21.0-win-x64\node.exe'
$mysql = Join-Path $PSScriptRoot '.tools\mysql-8.4.11-winx64\bin\mysqld.exe'
if (-not (Test-Path $node) -or -not (Test-Path $mysql)) { throw 'Project tools are missing. See README.md.' }
if (-not (Test-Path '.env')) { throw 'Database configuration is missing. See README.md.' }
New-Item -ItemType Directory -Force .runtime | Out-Null
& $node --env-file=.env scripts/db-ready.js
if ($LASTEXITCODE -ne 0) {
  Start-Process -FilePath $mysql -ArgumentList "--defaults-file=$PSScriptRoot\.runtime\mysql.ini" -WindowStyle Hidden
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    & $node --env-file=.env scripts/db-ready.js
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw 'MySQL did not start. Check .runtime/mysql-error.log.' }
}
& $node --env-file=.env server/index.js
