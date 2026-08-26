<#
.SYNOPSIS
  Installs the SOS POS Print Agent on this till.

.DESCRIPTION
  Run once per PC, as Administrator. Copies the agent into Program Files, registers it as a
  Windows service that starts with the machine, and starts it.

  There is deliberately nothing to configure. Which printer prints stickers, dockets, receipts,
  refurb stickers or reports is set once per store in SOS POS under Settings -> Printer Settings,
  and every till in that store follows it. This installer's whole job is to make this PC able to
  obey that.

.PARAMETER Uninstall
  Stops the service, removes it, and deletes the install directory. Logs in ProgramData are left
  alone — they are usually why you are uninstalling.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$ServiceId  = "SOSPrintAgent"
$InstallDir = Join-Path $env:ProgramFiles "SOS Print Agent"
$Source     = Split-Path -Parent $MyInvocation.MyCommand.Path

function Assert-Admin {
  $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this from an Administrator PowerShell — installing a service needs it."
  }
}

function Stop-Existing {
  $existing = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
  if (-not $existing) { return }
  Write-Host "Stopping the existing service..."
  if ($existing.Status -ne "Stopped") {
    Stop-Service -Name $ServiceId -Force -ErrorAction SilentlyContinue
    # The service host takes a moment to let go of the exe; copying over it too early fails with
    # a file-in-use error that reads like a permissions problem.
    $existing.WaitForStatus("Stopped", (New-TimeSpan -Seconds 30))
  }
  & (Join-Path $InstallDir "sos-print-agent-service.exe") uninstall | Out-Null
  Start-Sleep -Seconds 2
}

Assert-Admin

if ($Uninstall) {
  Stop-Existing
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  Write-Host "Removed. Printing in SOS POS falls back to the browser's print dialog."
  return
}

foreach ($file in @("sos-print-agent.exe", "sos-print-agent-service.exe", "sos-print-agent-service.xml")) {
  if (-not (Test-Path (Join-Path $Source $file))) {
    throw "Missing $file next to this script — unzip the whole release, don't copy one file out of it."
  }
}

Stop-Existing

Write-Host "Installing to $InstallDir..."
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item (Join-Path $Source "sos-print-agent.exe")         $InstallDir -Force
Copy-Item (Join-Path $Source "sos-print-agent-service.exe") $InstallDir -Force
Copy-Item (Join-Path $Source "sos-print-agent-service.xml") $InstallDir -Force

Write-Host "Registering the service..."
& (Join-Path $InstallDir "sos-print-agent-service.exe") install
& (Join-Path $InstallDir "sos-print-agent-service.exe") start

Write-Host "Checking it answers..."
$ok = $false
foreach ($attempt in 1..10) {
  Start-Sleep -Seconds 1
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:9110/health" -TimeoutSec 2
    if ($health.ok) {
      $ok = $true
      Write-Host "SOS Print Agent $($health.version) is running."
      # The one thing this installer cannot fix, so it is worth saying out loud rather than
      # letting the first print discover it.
      if (-not $health.renderer) {
        Write-Warning "No Edge or Chrome found on this PC. The agent will not be able to render documents."
      }
      break
    }
  } catch { }
}

if (-not $ok) {
  throw "The service was installed but is not answering on 127.0.0.1:9110. Check $env:ProgramData\SOSPrintAgent\agent.log."
}

Write-Host ""
Write-Host "Done. Open SOS POS -> Settings -> Printer Settings; the chip at the top should say"
Write-Host "'Print agent connected', and each tab can now choose a printer."
