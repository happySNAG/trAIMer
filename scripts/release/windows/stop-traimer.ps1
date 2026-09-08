# --------------------------------------------------------------------
# trAIMer — Windows launcher (stop)
#
# Stops the local static server and the capture helper started by
# start-traimer.ps1. Only acts on PIDs recorded by this install in
# .traimer/*.pid, parsed strictly as integers before any kill.
# --------------------------------------------------------------------

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$stateDir = Join-Path $root ".traimer"

$stoppedAnything = $false

foreach ($name in @("server.pid", "helper.pid")) {
  $file = Join-Path $stateDir $name
  if (-not (Test-Path $file)) { continue }
  $raw = (Get-Content $file -Raw).Trim()
  $procIdAsInt = 0
  if ([int]::TryParse($raw, [ref]$procIdAsInt)) {
    try {
      Stop-Process -Id $procIdAsInt -Force -ErrorAction SilentlyContinue
      Write-Host "  stopped $name -> process $procIdAsInt"
      $stoppedAnything = $true
    } catch {
      Write-Host "  could not stop process $procIdAsInt ($($_.Exception.Message))"
    }
  } else {
    Write-Host "  ignoring malformed pid file: $name"
  }
  Remove-Item $file -ErrorAction SilentlyContinue
}

if (-not $stoppedAnything) {
  Write-Host ""
  Write-Host "  Nothing to stop — no Aim Lab processes were recorded as running."
  Write-Host ""
  Write-Host "  If a helper window/process is still visible, close it manually."
  Write-Host "  (This script never kills processes by name.)"
}
