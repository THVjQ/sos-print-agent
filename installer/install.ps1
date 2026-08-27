<#
.SYNOPSIS
  Installs the SOS POS Print Agent on this till, without clicking anything.

.DESCRIPTION
  For MDM, GPO, or a technician doing a row of counters. Most people should run
  SOS-Print-Agent-Setup.exe instead.

  Copies the agent into Program Files, registers it to start for whoever logs in, and starts it
  now. It runs in the logged-in user's session on purpose — Chromium will not launch under
  LocalSystem, and a service running as LocalSystem cannot see printers a person added, which are
  per-user connections.

.PARAMETER Uninstall
  Stops the agent, removes the autostart entry, and deletes the install directory. Logs in
  ProgramData are left alone — they are usually why you are uninstalling.
#>
[CmdletBinding()]
param([switch]$Uninstall)

$ErrorActionPreference = "Stop"

$InstallDir = Join-Path $env:ProgramFiles "SOS Print Agent"
$RunKey     = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run"
$RunName    = "SOS Print Agent"
$Source     = Split-Path -Parent $MyInvocation.MyCommand.Path

function Assert-Admin {
  $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this from an Administrator PowerShell — writing to Program Files needs it."
  }
}

function Stop-Agent {
  Get-Process -Name "sos-print-agent" -ErrorAction SilentlyContinue | Stop-Process -Force

  # And the headless Edge it was driving. Killing the agent does not take it with it: the browser
  # is a child process, and the SIGINT/SIGTERM the agent shuts down cleanly on is not what
  # Stop-Process sends. Left alive it holds the lock on the browser profile, and the next launch
  # fails with "Failed to launch the browser process!" and nothing after it.
  #
  # Matched on the command line, never on the image name alone — a shop's own Edge windows are
  # msedge.exe too, and closing somebody's browser mid-sale is a worse bug than the one being
  # fixed here. Only a process whose --user-data-dir is ours is touched.
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -eq "msedge.exe" -and
      ($_.CommandLine -like "*SOSPrintAgent*" -or $_.CommandLine -like "*sos-print-agent*")
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  # The file stays locked for a moment after the process goes; copying over it too early fails
  # with an error that reads like a permissions problem.
  Start-Sleep -Seconds 2
}

<#
  What earlier versions left behind, cleared before anything is copied.

  1.0.0 registered a Windows *service*. Left registered it goes on trying to start an exe that has
  moved or gone — or, worse, starts the new one as LocalSystem, where Chromium will not launch at
  all and printers a person added are invisible.

  1.1.0 and earlier kept the browser profile under ProgramData. That folder was created by an
  elevated install or by LocalSystem, so it belongs to Administrators or SYSTEM, and the standard
  user the agent runs as can create folders inside it but not files — Chromium cannot write its
  profile and dies without saying why. From 1.1.1 the profile lives in the user's own LOCALAPPDATA
  and this copy is only in the way. The logs beside it are kept: they are usually why somebody is
  reinstalling.
#>
function Remove-Legacy {
  $service = Get-Service -Name "SOSPrintAgent" -ErrorAction SilentlyContinue
  if ($service) {
    Write-Host "Removing the old Windows service..."
    if ($service.Status -ne "Stopped") { Stop-Service -Name "SOSPrintAgent" -Force -ErrorAction SilentlyContinue }
    & sc.exe delete "SOSPrintAgent" | Out-Null
  }
  foreach ($leftover in @("sos-print-agent-service.exe", "sos-print-agent-service.xml")) {
    $file = Join-Path $InstallDir $leftover
    if (Test-Path $file) { Remove-Item -Force $file -ErrorAction SilentlyContinue }
  }

  $stale = Join-Path $env:ProgramData "SOSPrintAgent\browser-profile"
  if (Test-Path $stale) {
    Write-Host "Removing the old browser profile in ProgramData..."
    Remove-Item -Recurse -Force $stale -ErrorAction SilentlyContinue
  }
}

Assert-Admin

if ($Uninstall) {
  Stop-Agent
  Remove-Legacy
  Remove-ItemProperty -Path $RunKey -Name $RunName -ErrorAction SilentlyContinue
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  Write-Host "Removed. Printing in SOS POS falls back to the browser's print dialog."
  return
}

foreach ($file in @("sos-print-agent.exe", "SumatraPDF.exe")) {
  if (-not (Test-Path (Join-Path $Source $file))) {
    throw "Missing $file next to this script — unzip the whole release, don't copy one file out of it."
  }
}

Stop-Agent
Remove-Legacy

Write-Host "Installing to $InstallDir..."
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item (Join-Path $Source "sos-print-agent.exe") $InstallDir -Force
Copy-Item (Join-Path $Source "SumatraPDF.exe")      $InstallDir -Force
if (Test-Path (Join-Path $Source "SumatraPDF-LICENSE")) {
  Copy-Item (Join-Path $Source "SumatraPDF-LICENSE") $InstallDir -Force
}

Write-Host "Registering it to start at logon..."
New-ItemProperty -Path $RunKey -Name $RunName -PropertyType String `
  -Value ('"{0}\sos-print-agent.exe"' -f $InstallDir) -Force | Out-Null

# Started through Explorer, and that is not a flourish.
#
# This script runs elevated, and a child of it inherits that. An elevated agent answers /health
# and lists printers and looks entirely well — and then cannot print anything, because **Edge
# refuses to run as administrator**: it re-launches itself de-elevated and the process the agent
# is holding exits 0 immediately, with no output. The log fills with "Failed to launch the browser
# process!" and nothing after it, on every job.
#
# Explorer already runs at medium integrity, so handing it the path starts the agent de-elevated
# and returns straight away. On a machine with no interactive session — an MDM push — nothing
# starts here, which is correct: the HKLM Run entry covers the next logon.
Write-Host "Starting it..."
Start-Process -FilePath (Join-Path $env:WINDIR "explorer.exe") `
  -ArgumentList ('"{0}\sos-print-agent.exe"' -f $InstallDir)

$ok = $false
foreach ($attempt in 1..15) {
  Start-Sleep -Seconds 1
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:9110/health" -TimeoutSec 2
    if ($health.ok) {
      $ok = $true
      Write-Host "SOS Print Agent $($health.version) is running."
      if (-not $health.renderer) { Write-Warning "No Edge or Chrome on this PC — the agent cannot render documents." }
      if (-not $health.spooler)  { Write-Warning "SumatraPDF.exe is missing — the agent cannot send jobs to a printer." }
      # Answers, lists printers, prints nothing: Edge will not launch from an elevated process.
      # A sign-out and back in starts it properly from the Run entry.
      if ($health.elevated) {
        Write-Warning "The agent is running as administrator and cannot print that way. Sign out of Windows and back in — it will start correctly by itself."
      }
      break
    }
  } catch { }
}

if (-not $ok) {
  throw "Installed, but nothing is answering on 127.0.0.1:9110. Check $env:ProgramData\SOSPrintAgent\agent.log."
}

Write-Host ""
Write-Host "Done. In SOS POS: Settings -> Printer Settings. The banner should say"
Write-Host "'Print agent connected', and each tab can now choose a printer."
