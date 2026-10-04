param([switch]$NoBrowser)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$localStarter = Join-Path $root "START_WHATSCHAT_LIVE.ps1"
$tunnelDirectory = Join-Path $root "tunnel"
$tunnelPath = Join-Path $tunnelDirectory "cloudflared.exe"
$tunnelLogPath = Join-Path $tunnelDirectory "cloudflared.log"
$tunnelPidPath = Join-Path $root ".whatschat-tunnel.pid"
$addressPath = Join-Path $root "PUBLIC_GATEWAY_ADDRESS.txt"
$sourceProjectPath = Join-Path $root "WhatsChat_Live_TurboWarp.sb3"
$publicProjectPath = Join-Path $root "WhatsChat_Public_TurboWarp.sb3"
$expectedVersion = "call-relay-fix-v15"

function Get-SavedTunnelProcess {
  if (-not (Test-Path -LiteralPath $tunnelPidPath)) { return $null }
  $savedPid = 0
  [void][int]::TryParse((Get-Content -LiteralPath $tunnelPidPath -Raw).Trim(), [ref]$savedPid)
  if ($savedPid -le 0) { return $null }
  $candidate = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
  if ($candidate -and $candidate.Path -eq $tunnelPath) { return $candidate }
  return $null
}

function Stop-SavedTunnel {
  $candidate = Get-SavedTunnelProcess
  if ($candidate) {
    Stop-Process -Id $candidate.Id -ErrorAction SilentlyContinue
    Wait-Process -Id $candidate.Id -Timeout 5 -ErrorAction SilentlyContinue
    if (Get-Process -Id $candidate.Id -ErrorAction SilentlyContinue) {
      Stop-Process -Id $candidate.Id -Force -ErrorAction SilentlyContinue
    }
  }
  Remove-Item -LiteralPath $tunnelPidPath -Force -ErrorAction SilentlyContinue
}

function Get-SavedPublicPage {
  if (-not (Test-Path -LiteralPath $addressPath)) { return $null }
  $savedText = Get-Content -LiteralPath $addressPath -Raw
  $matches = [regex]::Matches($savedText, 'https://[a-z0-9-]+\.trycloudflare\.com', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if ($matches.Count -gt 0) { return $matches[$matches.Count - 1].Value }
  return $null
}

function Test-PublicDns([string]$pageUrl) {
  if (-not $pageUrl) { return $false }
  $hostName = ([uri]$pageUrl).DnsSafeHost
  $escapedHost = [uri]::EscapeDataString($hostName)
  $dnsChecks = @(
    "https://cloudflare-dns.com/dns-query?name=$escapedHost&type=A",
    "https://dns.google/resolve?name=$escapedHost&type=A"
  )
  foreach ($dnsCheck in $dnsChecks) {
    try {
      $dnsResult = Invoke-RestMethod -Uri $dnsCheck -Headers @{ Accept = "application/dns-json" } -TimeoutSec 6
      if ($dnsResult.Status -eq 0 -and @($dnsResult.Answer).Count -gt 0) { return $true }
    } catch {
    }
  }
  return $false
}

function Test-PublicPage([string]$pageUrl) {
  if (-not $pageUrl) { return $false }
  try {
    if (-not (Test-PublicDns $pageUrl)) { return $false }
    $health = Invoke-RestMethod -Uri ($pageUrl.TrimEnd('/') + '/health') -TimeoutSec 4
    return $health.ok -eq $true -and $health.version -eq $expectedVersion
  } catch {
    return $false
  }
}

function Get-TunnelAddressFromLog {
  if (-not (Test-Path -LiteralPath $tunnelLogPath)) { return $null }
  $logText = Get-Content -LiteralPath $tunnelLogPath -Raw -ErrorAction SilentlyContinue
  $matches = [regex]::Matches($logText, 'https://[a-z0-9-]+\.trycloudflare\.com', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if ($matches.Count -gt 0) { return $matches[$matches.Count - 1].Value }
  return $null
}

function Build-PublicProject([string]$gatewayAddress) {
  if (-not (Test-Path -LiteralPath $sourceProjectPath)) {
    throw "WhatsChat_Live_TurboWarp.sb3 is missing. Keep it beside this launcher."
  }
  $temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("WhatsChatPublic-" + [guid]::NewGuid().ToString("N"))
  $extractPath = Join-Path $temporaryRoot "project"
  $sourceZipPath = Join-Path $temporaryRoot "source.zip"
  $outputZipPath = Join-Path $temporaryRoot "public.zip"
  try {
    New-Item -ItemType Directory -Path $extractPath -Force | Out-Null
    Copy-Item -LiteralPath $sourceProjectPath -Destination $sourceZipPath -Force
    Expand-Archive -LiteralPath $sourceZipPath -DestinationPath $extractPath
    $projectJsonPath = Join-Path $extractPath "project.json"
    $project = Get-Content -LiteralPath $projectJsonPath -Raw | ConvertFrom-Json
    if (-not $project.targets[0].variables.serverUrl) {
      throw "The server URL variable was not found in the Scratch project."
    }
    $project.targets[0].variables.serverUrl[1] = $gatewayAddress
    if (-not $project.extensionURLs.whatschatcalls) {
      throw "The WhatsChat Calls extension URL was not found in the Scratch project."
    }
    $publicOrigin = ($gatewayAddress -replace '^wss://', 'https://') -replace '^ws://', 'http://'
    $publicOrigin = $publicOrigin -replace '/ws$', ''
    $project.extensionURLs.whatschatcalls = $publicOrigin.TrimEnd('/') + '/whatschat-call-launcher.js'
    $json = $project | ConvertTo-Json -Depth 100 -Compress
    [System.IO.File]::WriteAllText($projectJsonPath, $json, [System.Text.UTF8Encoding]::new($false))
    Compress-Archive -Path (Join-Path $extractPath "*") -DestinationPath $outputZipPath -CompressionLevel Optimal
    Copy-Item -LiteralPath $outputZipPath -Destination $publicProjectPath -Force
  } finally {
    $resolvedTemp = [System.IO.Path]::GetFullPath($temporaryRoot)
    $systemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ((Test-Path -LiteralPath $resolvedTemp) -and $resolvedTemp.StartsWith($systemTemp, [System.StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolvedTemp -Leaf).StartsWith("WhatsChatPublic-")) {
      [System.IO.Directory]::Delete($resolvedTemp, $true)
    }
  }
}

if (-not (Test-Path -LiteralPath $localStarter)) {
  throw "START_WHATSCHAT_LIVE.ps1 is missing. Extract the complete WhatsChat ZIP."
}
if (-not (Test-Path -LiteralPath $tunnelPath)) {
  throw "The bundled public tunnel program is missing. Extract the complete WhatsChat ZIP."
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $localStarter -NoBrowser
if ($LASTEXITCODE -ne 0) { throw "The local WhatsChat gateway could not start." }

Write-Host "Use only the new page that this window opens. Old trycloudflare links expire." -ForegroundColor Yellow

$publicPage = Get-SavedPublicPage
$tunnelProcess = Get-SavedTunnelProcess
$publicReady = $false
if ($tunnelProcess -and $publicPage) {
  Write-Host "Checking the saved public gateway..." -ForegroundColor Cyan
  $publicReady = Test-PublicPage $publicPage
}

if (-not $publicReady) {
  Stop-SavedTunnel
  Remove-Item -LiteralPath $addressPath -Force -ErrorAction SilentlyContinue

  for ($gatewayAttempt = 1; $gatewayAttempt -le 5 -and -not $publicReady; $gatewayAttempt += 1) {
    Set-Content -LiteralPath $tunnelLogPath -Value "" -Encoding UTF8
    $processStart = [System.Diagnostics.ProcessStartInfo]::new()
    $processStart.FileName = $tunnelPath
    $processStart.Arguments = "tunnel --url http://127.0.0.1:8080 --protocol http2 --no-autoupdate --loglevel info --logfile `"$tunnelLogPath`""
    $processStart.WorkingDirectory = $tunnelDirectory
    $processStart.UseShellExecute = $true
    $processStart.CreateNoWindow = $true
    $processStart.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $tunnelProcess = [System.Diagnostics.Process]::Start($processStart)
    Set-Content -LiteralPath $tunnelPidPath -Value $tunnelProcess.Id

    Write-Host "Creating public gateway (attempt $gatewayAttempt of 5)..." -ForegroundColor Cyan
    $publicPage = $null
    for ($addressAttempt = 0; $addressAttempt -lt 120; $addressAttempt += 1) {
      Start-Sleep -Milliseconds 500
      $publicPage = Get-TunnelAddressFromLog
      if ($publicPage) { break }
      if ($tunnelProcess.HasExited) { break }
    }

    if ($publicPage) {
      Write-Host "Address received. Waiting until it is reachable..." -ForegroundColor Cyan
      for ($readyAttempt = 0; $readyAttempt -lt 120; $readyAttempt += 1) {
        if (Test-PublicPage $publicPage) {
          $publicReady = $true
          break
        }
        if ($tunnelProcess.HasExited) { break }
        if (($readyAttempt + 1) % 10 -eq 0) {
          Write-Host "Still waiting for Cloudflare DNS..." -ForegroundColor DarkCyan
        }
        Start-Sleep -Seconds 1
      }
    }

    if (-not $publicReady) {
      Write-Host "That temporary address did not become reachable. Requesting a new one..." -ForegroundColor Yellow
      Stop-SavedTunnel
    }
  }
}

if (-not ($publicPage -and $publicReady)) {
  Stop-SavedTunnel
  throw "Cloudflare returned five unusable temporary addresses. Its free DNS service is temporarily unavailable; wait a minute, then run this launcher again."
}

$publicWss = $publicPage.Replace("https://", "wss://").TrimEnd('/') + "/ws"
Build-PublicProject $publicWss

$addressText = @"
WhatsChat public gateway is ready.

SHARE THIS PAGE WITH THE OTHER PERSON:
$publicPage

The public Scratch project from that page is already configured to use:
$publicWss

Keep this computer on and keep the gateway running.
The address changes if the public tunnel is stopped and started again.
Offline messages appear after login. Voice and video calls require both people to be online.
Messages are not end-to-end encrypted.
"@
[System.IO.File]::WriteAllText($addressPath, $addressText, [System.Text.UTF8Encoding]::new($false))
try { Set-Clipboard -Value $publicPage -ErrorAction Stop } catch { }

Write-Host "" 
Write-Host "WhatsChat PUBLIC WSS gateway is ready" -ForegroundColor Green
Write-Host $publicPage -ForegroundColor Cyan
Write-Host "The public page address was copied to your clipboard." -ForegroundColor Green

if (-not $NoBrowser) {
  $browserStart = [System.Diagnostics.ProcessStartInfo]::new()
  $browserStart.FileName = $publicPage
  $browserStart.UseShellExecute = $true
  [void][System.Diagnostics.Process]::Start($browserStart)
}
