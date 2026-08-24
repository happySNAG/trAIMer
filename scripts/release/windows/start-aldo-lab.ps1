# --------------------------------------------------------------------
# Aldo Aim Lab — Windows launcher (start)
#
# Starts, in order:
#   1. aldo_capture_helper.exe  (loopback-only Raw Input capture,
#      authenticated with a fresh random token)
#   2. a minimal local static web server for the app/ folder
#      (HttpListener bound to http://127.0.0.1:<webPort>/ ONLY)
#   3. your default browser at the local app URL (?token=...)
#
# Everything stays on 127.0.0.1. No telemetry, no remote endpoints.
# Keep this window open while playing; closing it (or running
# stop-aldo-lab.ps1) tears the helper down deterministically.
# --------------------------------------------------------------------
param(
  # Static-server port. The CAPTURE helper always uses 48765 (the app's
  # default ws://127.0.0.1:48765); this is the web server's port.
  [int]$port = 48800
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$helperPath = Join-Path $root "aldo_capture_helper.exe"
$appDir = Join-Path $root "app"
$manifestPath = Join-Path $root "manifest.json"
$stateDir = Join-Path $root ".aldo-lab"
$helperPort = 48765

function Fail([string]$message) {
  Write-Host ""
  Write-Host "  ERROR: $message" -ForegroundColor Red
  Write-Host ""
  exit 1
}

Write-Host ""
Write-Host "  Aldo Aim Lab — starting..." -ForegroundColor White

# ---- 1. sanity-check the installation -------------------------------------

if (-not (Test-Path $helperPath)) {
  Write-Host ""
  Write-Host "  Native capture helper not found: aldo_capture_helper.exe" -ForegroundColor Yellow
  Write-Host "  You can still run the app in BROWSER capture mode (works, but"
  Write-Host "  samples at frame rate instead of your mouse's polling rate)."
  Write-Host "  For full-fidelity measurement, rebuild/re-download the release"
  Write-Host "  so the helper sits next to this script."
  Write-Host ""
  $answer = Read-Host "  Continue in browser-capture mode? [y/N]"
  if ($answer -notmatch '^[Yy]') { exit 1 }
}

if (Test-Path $manifestPath) {
  try {
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    if (-not $manifest.nativeProtocolVersion -or -not $manifest.expectedHelperVersion) {
      Fail "manifest.json is missing version metadata — this looks like an incomplete install. Re-download the release zip."
    }
    if (-not $manifest.helperBinaryIsPlaceholder -and $manifest.helperSha256 -and (Test-Path $helperPath)) {
      $actual = (Get-FileHash -Algorithm SHA256 $helperPath).Hash.ToLower()
      if ($actual -ne $manifest.helperSha256) {
        Write-Host ""
        Write-Host "  WARNING: helper binary does not match this build's manifest." -ForegroundColor Yellow
        Write-Host "  The app verifies protocol compatibility itself at connect time;"
        Write-Host "  continuing. If capture fails, re-download the matching release."
      }
    }
  } catch {
    Fail "manifest.json exists but cannot be parsed — reinstall the release zip."
  }
} else {
  Write-Host "  note: manifest.json not found (dev layout?) — skipping version cross-check."
}

# ---- 2. refuse to fight a running instance ---------------------------------

$probe = New-Object System.Net.Sockets.TcpClient
try {
  $probe.Connect("127.0.0.1", $helperPort) | Out-Null
  Fail ("capture port ${helperPort} is already in use — an Aim Lab helper (or another instance) appears to be running. Run .\stop-aldo-lab.ps1 first, then start again.")
} catch {
  # port free — this is what we want
} finally {
  $probe.Close()
}

# ---- 3. generate a fresh session token --------------------------------------

$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$tokenBytes = New-Object byte[] 16
$rng.GetBytes($tokenBytes)
$rng.Dispose()
$token = (($tokenBytes | ForEach-Object { $_.ToString("x2") }) -join "")
if ($token -notmatch "^[0-9a-f]{32}$") {
  Fail "internal error: generated session token failed its shape check."
}

# ---- 4. pick a free static-server port (48800-48809) ------------------------

function Test-PortBusy([int]$candidate) {
  $p = New-Object System.Net.Sockets.TcpClient
  try {
    $p.Connect("127.0.0.1", $candidate) | Out-Null
    return $true
  } catch {
    return $false
  } finally {
    $p.Close()
  }
}

$chosenPort = 0
for ($candidate = 48800; $candidate -le 48809; $candidate++) {
  if (-not (Test-PortBusy $candidate)) { $chosenPort = $candidate; break }
}
if ($chosenPort -eq 0) {
  Fail "no free local port in 48800-48809 for the local app server."
}
$port = $chosenPort

# ---- 5. start the capture helper --------------------------------------------

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

if (Test-Path $helperPath) {
  $helperArgs = @(
    "--port", "$helperPort",
    "--token", $token
  )
  $helperProc = Start-Process -FilePath $helperPath `
    -ArgumentList $helperArgs -WindowStyle Hidden -PassThru
  $helperProc.Id | Set-Content (Join-Path $stateDir "helper.pid")

  $helperUp = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (-not (Test-PortBusy $helperPort)) { continue }
    $helperUp = $true
    break
  }
  if (-not $helperUp) {
    try { Stop-Process -Id $helperProc.Id -Force -ErrorAction SilentlyContinue } catch {}
    Remove-Item (Join-Path $stateDir "helper.pid") -ErrorAction SilentlyContinue
    Fail "the capture helper did not start listening on 127.0.0.1:${helperPort}. Check Windows Defender/antivirus prompts, then run this script again."
  }
  Write-Host "  capture helper : ws://127.0.0.1:$helperPort (token-authenticated)" -ForegroundColor DarkGray
} else {
  Write-Host "  capture helper : not installed — running in browser-capture mode" -ForegroundColor DarkGray
}

# ---- 6. open the app ----------------------------------------------------------

$appUrl = "http://127.0.0.1:$port/index.html?token=$token"

# ---- 7. serve app/ on loopback until this window closes ----------------------

$fullAppDir = [System.IO.Path]::GetFullPath($appDir)
$pidFile = Join-Path $stateDir "server.pid"
$PID | Set-Content $pidFile

$mimeByExtension = @{
  ".html"  = "text/html; charset=utf-8"
  ".js"    = "text/javascript; charset=utf-8"
  ".css"   = "text/css; charset=utf-8"
  ".json"  = "application/json; charset=utf-8"
  ".svg"   = "image/svg+xml"
  ".png"   = "image/png"
  ".ico"   = "image/x-icon"
  ".woff2" = "font/woff2"
}

$listener = New-Object System.Net.HttpListener
# Loopback-only binding: http.sys refuses anything that is not this exact host.
$listener.Prefixes.Add("http://127.0.0.1:$port/")
try {
  try {
    $listener.Start()
  } catch [System.Net.HttpListenerException] {
    if ($_.Exception.ErrorCode -eq 5) {
      Write-Host ""
      Write-Host "  Windows needs a one-time permission so this user can serve the" -ForegroundColor Yellow
      Write-Host "  app locally on port $port (an 'http.sys' URL reservation)."
      Write-Host "  Approve the next UAC prompt to register it once for all future runs,"
      Write-Host "  or decline to continue without the local server."
      $doAcl = Read-Host "  Register now? [Y/n]"
      if ($doAcl -notmatch '^[Nn]') {
        $aclArgs = @(
          "http", "add", "urlacl",
          "url=http://127.0.0.1:$port/",
          "user=$env:USERDOMAIN\$env:USERNAME"
        )
        $aclProc = Start-Process -FilePath "netsh.exe" -ArgumentList $aclArgs `
          -Verb RunAs -Wait -PassThru -ErrorAction SilentlyContinue
        if ($aclProc -and $aclProc.ExitCode -eq 0) {
          $listener.Start()
        } else {
          Fail "the permission was not registered (UAC declined or failed). You can still open app\index.html directly in a browser — see FIRST-RUN.md."
        }
      } else {
        Fail "running without the local server is not supported by this launcher. You can open app\index.html directly in a browser — see FIRST-RUN.md."
      }
    } else {
      throw
    }
  }

  Write-Host ""
  Write-Host "  Ready. Opening $appUrl" -ForegroundColor Green
  Write-Host "  Leave this window open while you play. Stop everything with"
  Write-Host "  .\stop-aldo-lab.ps1 or by closing this window."
  Write-Host ""
  Start-Process $appUrl

  while ($true) {
    $context = $listener.GetContext()
    try {
      $request = $context.Request
      $response = $context.Response
      if ($request.HttpMethod -ne "GET") {
        $response.StatusCode = 405
        $response.Close()
        continue
      }
      $rawPath = [Uri]::UnescapeDataString($request.Url.AbsolutePath)
      if ($rawPath -eq "/" -or $rawPath -eq "") { $rawPath = "/index.html" }
      if ($rawPath -notmatch "^/[A-Za-z0-9._/-]+$" -or $rawPath.Contains("..")) {
        $response.StatusCode = 400
        $response.Close()
        continue
      }
      $relative = $rawPath.TrimStart("/")
      $full = [System.IO.Path]::GetFullPath((Join-Path $fullAppDir $relative))
      if (-not $full.StartsWith($fullAppDir, [StringComparison]::OrdinalIgnoreCase)) {
        $response.StatusCode = 403
        $response.Close()
        continue
      }
      if (-not (Test-Path $full -PathType Leaf)) {
        $response.StatusCode = 404
        $response.Close()
        continue
      }
      $extension = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
      if (-not $mimeByExtension.ContainsKey($extension)) {
        $response.StatusCode = 403
        $response.Close()
        continue
      }
      $body = [System.IO.File]::ReadAllBytes($full)
      $response.ContentType = $mimeByExtension[$extension]
      $response.ContentLength64 = $body.Length
      $response.Headers["Cache-Control"] = "no-store"
      $response.OutputStream.Write($body, 0, $body.Length)
      $response.Close()
    } catch {
      # serve-loop hiccups (aborted connections etc.) must never kill the server
      try { $context.Response.Close() } catch {}
    }
  }
} finally {
  # ---- deterministic teardown -------------------------------------------------
  try { $listener.Close() } catch {}
  if (Test-Path (Join-Path $stateDir "helper.pid")) {
    $raw = (Get-Content (Join-Path $stateDir "helper.pid") -Raw).Trim()
    $procIdAsInt = 0
    if ([int]::TryParse($raw, [ref]$procIdAsInt)) {
      try { Stop-Process -Id $procIdAsInt -Force -ErrorAction SilentlyContinue } catch {}
    }
    Remove-Item (Join-Path $stateDir "helper.pid") -ErrorAction SilentlyContinue
  }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  Write-Host "  Stopped. Capture helper shut down; data stays on this PC."
}
