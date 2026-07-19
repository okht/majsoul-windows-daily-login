param(
  [ValidateSet("DryRun", "Deploy", "Register", "Full")]
  [string]$Mode = "DryRun",

  [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "lib\deploy-app.ps1")

function Write-PublicStatus([string]$Message) {
  # Never print absolute user paths, emails, or secrets.
  Write-Host $Message
}

function Assert-WindowsHost {
  if ($PSVersionTable.PSVersion.Major -lt 5) {
    throw "PowerShell 5.1 or newer is required."
  }
  $onWindows = $env:OS -match "Windows" -or $PSVersionTable.Platform -eq "Win32NT"
  if (-not $onWindows) {
    throw "Windows is required."
  }
}

function Assert-Prerequisites {
  $null = Get-Command node.exe -ErrorAction Stop
  $edgeCandidates = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  )
  $edge = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $edge) {
    throw "Microsoft Edge (msedge.exe) was not found."
  }
}

function Invoke-RepoVerify {
  param([string]$RepoRoot)
  Push-Location $RepoRoot
  try {
    if (-not $SkipVerify) {
      if (Test-Path -LiteralPath (Join-Path $RepoRoot "package-lock.json")) {
        & npm ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
      } else {
        & npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
      }
      & npm run verify
      if ($LASTEXITCODE -ne 0) { throw "npm run verify failed." }
    }
  } finally {
    Pop-Location
  }
}

function Render-BothTasks {
  param(
    [Parameter(Mandatory = $true)][string]$LauncherPath,
    [Parameter(Mandatory = $true)][string]$UserId
  )
  $renderer = Join-Path $PSScriptRoot "render-task-xml.ps1"
  $primary = & $renderer -Mode Primary -LauncherPath $LauncherPath -UserId $UserId
  $catchup = & $renderer -Mode Catchup -LauncherPath $LauncherPath -UserId $UserId
  return @{
    Primary = $primary
    Catchup = $catchup
  }
}

function Assert-TaskXmlContract([string]$Xml, [string]$ExpectedTrigger) {
  $required = @(
    "<StartWhenAvailable>true</StartWhenAvailable>",
    "<RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>",
    "<WakeToRun>false</WakeToRun>",
    "<Priority>8</Priority>",
    "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "<ExecutionTimeLimit>PT10M</ExecutionTimeLimit>",
    "<Hidden>true</Hidden>",
    "<LogonType>InteractiveToken</LogonType>",
    "<Arguments>$ExpectedTrigger</Arguments>"
  )
  foreach ($item in $required) {
    if ($Xml -notlike "*$item*") {
      throw "Registered task XML failed contract check for: $item"
    }
  }
  if ($Xml -match "accept|acceptance|verify-session|setup-session|run\.mjs|node\.exe") {
    throw "Registered task XML contains a forbidden command fragment."
  }
}

function Register-MajSoulTasks {
  param(
    [Parameter(Mandatory = $true)][string]$LauncherPath
  )

  Assert-ChinaStandardTime

  $appDir = Get-InstalledAppDir
  if (-not (Test-AcceptanceReceipt -AppDir $appDir)) {
    throw "Registration refused: missing or stale local acceptance receipt. Complete acceptance first (Task 8)."
  }
  if (-not (Test-Path -LiteralPath $LauncherPath)) {
    throw "Installed launcher is missing. Run Deploy first."
  }

  $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $rendered = Render-BothTasks -LauncherPath $LauncherPath -UserId $user

  Register-ScheduledTask -TaskName "MajSoulDaily-Primary" -Xml $rendered.Primary -Force | Out-Null
  Register-ScheduledTask -TaskName "MajSoulDaily-Catchup" -Xml $rendered.Catchup -Force | Out-Null

  $exportedPrimary = Export-ScheduledTask -TaskName "MajSoulDaily-Primary"
  $exportedCatchup = Export-ScheduledTask -TaskName "MajSoulDaily-Catchup"
  Assert-TaskXmlContract -Xml $exportedPrimary -ExpectedTrigger "primary"
  Assert-TaskXmlContract -Xml $exportedCatchup -ExpectedTrigger "catchup"

  Write-PublicStatus "Registered tasks: MajSoulDaily-Primary, MajSoulDaily-Catchup"
  Write-PublicStatus "Primary window: Beijing 10:00-12:30 with PT2H30M random delay"
  Write-PublicStatus "Catch-up: logon, unlock, and 12:30-23:45 every 15 minutes"
}

# --- main ---
Assert-WindowsHost
Assert-Prerequisites

$repoRoot = Split-Path -Parent $PSScriptRoot
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$placeholderLauncher = Join-Path (Get-InstalledAppDir) "MajSoulDaily.exe"

switch ($Mode) {
  "DryRun" {
    Write-PublicStatus "Mode=DryRun (no deploy, no registration, no credential writes)"
    $launcherForRender = if (Test-Path -LiteralPath $placeholderLauncher) {
      $placeholderLauncher
    } else {
      # Deterministic non-user path for dry-run rendering only.
      "C:\ProgramData\MajSoulDaily\app\MajSoulDaily.exe"
    }
    $rendered = Render-BothTasks -LauncherPath $launcherForRender -UserId $user
    Assert-TaskXmlContract -Xml $rendered.Primary -ExpectedTrigger "primary"
    Assert-TaskXmlContract -Xml $rendered.Catchup -ExpectedTrigger "catchup"
    Write-PublicStatus "Validated task XML contracts: MajSoulDaily-Primary, MajSoulDaily-Catchup"
    Write-PublicStatus "DryRun complete: no scheduled task was registered."
  }
  "Deploy" {
    Write-PublicStatus "Mode=Deploy"
    Invoke-RepoVerify -RepoRoot $repoRoot
    $appDir = Invoke-DeployAppBundle -RepoRoot $repoRoot
    Write-PublicStatus "Deployed installed app bundle under LOCALAPPDATA\\MajSoulDaily\\app"
    Write-PublicStatus "Launcher ready: MajSoulDaily.exe"
  }
  "Register" {
    Write-PublicStatus "Mode=Register"
    $launcher = Join-Path (Get-InstalledAppDir) "MajSoulDaily.exe"
    Register-MajSoulTasks -LauncherPath $launcher
  }
  "Full" {
    Write-PublicStatus "Mode=Full (verify + deploy; registration still requires acceptance receipt)"
    Invoke-RepoVerify -RepoRoot $repoRoot
    $null = Invoke-DeployAppBundle -RepoRoot $repoRoot
    Write-PublicStatus "Deploy complete."
    try {
      Register-MajSoulTasks -LauncherPath (Join-Path (Get-InstalledAppDir) "MajSoulDaily.exe")
    } catch {
      Write-PublicStatus "Registration skipped or failed: $($_.Exception.Message)"
      Write-PublicStatus "Complete local acceptance (Task 8), then re-run with -Mode Register."
      exit 2
    }
  }
  default {
    throw "Unknown mode: $Mode"
  }
}
