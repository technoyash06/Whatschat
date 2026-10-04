param([switch]$NoBrowser)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDirectory = Join-Path $root "WhatsChat_Live_Server"
$serverPath = Join-Path $serverDirectory "server.js"
$pidPath = Join-Path $root ".whatschat-server.pid"
$healthUrl = "http://127.0.0.1:8080/health"
$homeUrl = "http://127.0.0.1:8080/"
$expectedVersion = "call-relay-fix-v15"

function Get-WhatsChatHealth {
  try {
    $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
    if ($response.ok -eq $true) { return $response }
  } catch {
  }
  return $null
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeCandidates = @()
$nodeCandidates += (Join-Path $root "runtime\node.exe")
if ($nodeCommand) { $nodeCandidates += $nodeCommand.Source }
$nodeCandidates += (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe")
$nodePath = $nodeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

if (-not $nodePath) {
  Write-Host "The portable WhatsChat runtime is missing." -ForegroundColor Yellow
  Write-Host "Extract the complete WhatsChat ZIP, then double-click START_WHATSCHAT_LIVE.cmd again."
  Write-Host "You do not need to install Node.js."
  exit 1
}

if (-not (Test-Path -LiteralPath $serverPath)) {
  Write-Host "The WhatsChat_Live_Server folder must stay beside this launcher." -ForegroundColor Red
  exit 1
}

function Import-PreviousWhatsChatData {
  $dataDirectory = Join-Path $serverDirectory "data"
  $dataPath = Join-Path $dataDirectory "whatschat-data.json"
  if (Test-Path -LiteralPath $dataPath) { return }
  $parentDirectory = Split-Path -Parent $root
  $previousData = Get-ChildItem -LiteralPath $parentDirectory -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "WhatsChat*" -and -not $_.FullName.Equals($root, [System.StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Filter "whatschat-data.json" -File -Recurse -ErrorAction SilentlyContinue } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $previousData) { return }
  New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
  Copy-Item -LiteralPath $previousData.FullName -Destination $dataPath -Force
  $previousUploads = Join-Path $previousData.Directory.FullName "uploads"
  $newUploads = Join-Path $dataDirectory "uploads"
  if (Test-Path -LiteralPath $previousUploads) {
    Copy-Item -LiteralPath $previousUploads -Destination $newUploads -Recurse -Force
  }
  Write-Host "Imported your existing WhatsChat accounts, contacts, groups, messages, and uploads." -ForegroundColor Green
}

$health = Get-WhatsChatHealth
if ($health -and $health.version -ne $expectedVersion) {
  Write-Host "An older WhatsChat server is using port 8080. Replacing it with V15..." -ForegroundColor Yellow
  $oldPid = 0
  [void][int]::TryParse([string]$health.pid, [ref]$oldPid)
  $oldProcess = if ($oldPid -gt 0) { Get-Process -Id $oldPid -ErrorAction SilentlyContinue } else { $null }
  if ($oldProcess -and $oldProcess.ProcessName -match '^node') {
    Stop-Process -Id $oldProcess.Id -ErrorAction SilentlyContinue
    Wait-Process -Id $oldProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
    if (Get-Process -Id $oldProcess.Id -ErrorAction SilentlyContinue) {
      Stop-Process -Id $oldProcess.Id -Force -ErrorAction SilentlyContinue
    }
    for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
      Start-Sleep -Milliseconds 150
      if (-not (Get-WhatsChatHealth)) { break }
    }
    $health = $null
  } else {
    Write-Host "Port 8080 is occupied by another program. Close it, then run this launcher again." -ForegroundColor Red
    exit 1
  }
}
if (-not $health) { Import-PreviousWhatsChatData }
if (-not $health -and (Test-Path -LiteralPath $pidPath)) {
  $savedPid = 0
  [void][int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$savedPid)
  $existingProcess = if ($savedPid -gt 0) { Get-Process -Id $savedPid -ErrorAction SilentlyContinue } else { $null }
  if ($existingProcess) {
    Write-Host "The gateway is still starting. Waiting for it..." -ForegroundColor Yellow
    for ($attempt = 0; $attempt -lt 24; $attempt += 1) {
      Start-Sleep -Milliseconds 250
      $health = Get-WhatsChatHealth
      if ($health -and $health.version -eq $expectedVersion) { break }
      if ($existingProcess.HasExited) { break }
    }
    if (-not $health -and -not $existingProcess.HasExited -and $existingProcess.Path -eq $nodePath) {
      Stop-Process -Id $existingProcess.Id -Force -ErrorAction SilentlyContinue
    }
  }
}

if (-not $health) {
  $processStart = [System.Diagnostics.ProcessStartInfo]::new()
  $processStart.FileName = $nodePath
  $processStart.Arguments = "`"$serverPath`""
  $processStart.WorkingDirectory = $serverDirectory
  $processStart.UseShellExecute = $true
  $processStart.CreateNoWindow = $true
  $processStart.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $process = [System.Diagnostics.Process]::Start($processStart)
  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    Start-Sleep -Milliseconds 200
    $health = Get-WhatsChatHealth
    if ($health -and $health.version -eq $expectedVersion) {
      $ready = $true
      break
    }
    if ($process.HasExited) { break }
  }
  if (-not $ready) {
    $health = Get-WhatsChatHealth
    $ready = $null -ne $health -and $health.version -eq $expectedVersion
  }
  if (-not $ready) {
    Write-Host "The gateway could not start. Close other WhatsChat copies and run this starter again." -ForegroundColor Red
    exit 1
  }
}

if (-not $health -or $health.version -ne $expectedVersion) {
  Write-Host "The wrong WhatsChat version answered on port 8080." -ForegroundColor Red
  exit 1
}

if ($health.pid) {
  Set-Content -LiteralPath $pidPath -Value $health.pid
}

Write-Host "WhatsChat messaging gateway is online at $homeUrl" -ForegroundColor Green
if (-not $NoBrowser) {
  $browserStart = [System.Diagnostics.ProcessStartInfo]::new()
  $browserStart.FileName = $homeUrl
  $browserStart.UseShellExecute = $true
  [void][System.Diagnostics.Process]::Start($browserStart)
}
