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
  # The file stays locked for a moment after the process goes; copying over it too early fails
  # with an error that reads like a permissions problem.
  Start-Sleep -Seconds 2
}

Assert-Admin

if ($Uninstall) {
  Stop-Agent
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

Write-Host "Starting it..."
Start-Process -FilePath (Join-Path $InstallDir "sos-print-agent.exe")

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
