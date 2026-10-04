$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidPath = Join-Path $root ".whatschat-server.pid"
$tunnelPidPath = Join-Path $root ".whatschat-tunnel.pid"
$tunnelPath = Join-Path $root "tunnel\cloudflared.exe"
$publicAddressPath = Join-Path $root "PUBLIC_GATEWAY_ADDRESS.txt"
$publicProjectPath = Join-Path $root "WhatsChat_Public_TurboWarp.sb3"
$healthUrl = "http://127.0.0.1:8080/health"
$candidatePids = @()
$healthPid = 0
$expectedNodePath = Join-Path $root "runtime\node.exe"

if (Test-Path -LiteralPath $tunnelPidPath) {
  $tunnelPid = 0
  [void][int]::TryParse((Get-Content -LiteralPath $tunnelPidPath -Raw).Trim(), [ref]$tunnelPid)
  $tunnelProcess = if ($tunnelPid -gt 0) { Get-Process -Id $tunnelPid -ErrorAction SilentlyContinue } else { $null }
  if ($tunnelProcess -and $tunnelProcess.Path -eq $tunnelPath) {
    Stop-Process -Id $tunnelPid -ErrorAction SilentlyContinue
    Wait-Process -Id $tunnelPid -Timeout 5 -ErrorAction SilentlyContinue
    if (Get-Process -Id $tunnelPid -ErrorAction SilentlyContinue) {
      Stop-Process -Id $tunnelPid -Force -ErrorAction SilentlyContinue
    }
  }
}
Remove-Item -LiteralPath $tunnelPidPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $publicAddressPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $publicProjectPath -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $pidPath) {
  $serverPid = Get-Content -LiteralPath $pidPath | Select-Object -First 1
  if ($serverPid) { $candidatePids += [int]$serverPid }
}
try {
  $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
  if ($health.ok -eq $true -and $health.pid) {
    $healthPid = [int]$health.pid
    $candidatePids += $healthPid
  }
} catch {
}
foreach ($candidatePid in ($candidatePids | Select-Object -Unique)) {
  $processInfo = Get-Process -Id $candidatePid -ErrorAction SilentlyContinue
  if ($processInfo -and ($candidatePid -eq $healthPid -or $processInfo.Path -eq $expectedNodePath)) {
    Stop-Process -Id $candidatePid -ErrorAction SilentlyContinue
    Wait-Process -Id $candidatePid -Timeout 5 -ErrorAction SilentlyContinue
    if (Get-Process -Id $candidatePid -ErrorAction SilentlyContinue) {
      Stop-Process -Id $candidatePid -Force -ErrorAction SilentlyContinue
    }
  }
}
Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
Write-Host "WhatsChat Live server stopped."
