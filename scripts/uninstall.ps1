param(
  [switch]$DeleteProfile,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "lib\deploy-app.ps1")

function Write-PublicStatus([string]$Message) {
  Write-Host $Message
}

$root = Get-MajSoulRoot
$allowedRoot = [IO.Path]::GetFullPath($root).TrimEnd("\") + "\"

function Remove-AppDirectory([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }
  $resolved = [IO.Path]::GetFullPath($Path)
  if (-not $resolved.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to delete outside MajSoulDaily."
  }
  # Extra containment: only known subfolders.
  $name = Split-Path -Leaf $resolved
  $allowed = @(
    "app", "state", "logs", "edge-profile", "config.json",
    "lobby-fingerprint.json", "acceptance-receipt.json", "run.lock"
  )
  $leafOk = $allowed -contains $name
  $isRootFile = $resolved.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)
  if (-not $leafOk -and $resolved -ne [IO.Path]::GetFullPath($root)) {
    # Allow nested paths under known directories.
    $relative = $resolved.Substring($allowedRoot.Length)
    $top = ($relative -split "[\\/]")[0]
    if ($allowed -notcontains $top) {
      throw "Refusing to delete unexpected path under MajSoulDaily."
    }
  }
  if (Test-Path -LiteralPath $resolved -PathType Container) {
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Remove-Item -LiteralPath $resolved -Force -ErrorAction SilentlyContinue
  }
}

Write-PublicStatus "Unregistering MajSoulDaily scheduled tasks..."
@("MajSoulDaily-Primary", "MajSoulDaily-Catchup") | ForEach-Object {
  Unregister-ScheduledTask -TaskName $_ -Confirm:$false -ErrorAction SilentlyContinue
}

Write-PublicStatus "Clearing local secrets from Credential Manager..."
$deleteSecret = Join-Path $PSScriptRoot "..\src\cli\delete-gmail-secret.mjs"
if (Test-Path -LiteralPath $deleteSecret) {
  & node $deleteSecret
} else {
  $installedDelete = Join-Path (Get-InstalledAppDir) "src\cli\delete-gmail-secret.mjs"
  $installedNode = Join-Path (Get-InstalledAppDir) "node.exe"
  if ((Test-Path -LiteralPath $installedDelete) -and (Test-Path -LiteralPath $installedNode)) {
    & $installedNode $installedDelete
  }
}

Write-PublicStatus "Removing installed app, state, logs, config, fingerprint, and acceptance receipt..."
Remove-AppDirectory (Join-Path $root "app")
Remove-AppDirectory (Join-Path $root "state")
Remove-AppDirectory (Join-Path $root "logs")
Remove-AppDirectory (Join-Path $root "config.json")
Remove-AppDirectory (Join-Path $root "lobby-fingerprint.json")
Remove-AppDirectory (Join-Path $root "acceptance-receipt.json")
Remove-AppDirectory (Join-Path $root "run.lock")

$shouldDeleteProfile = $false
if ($DeleteProfile) {
  $shouldDeleteProfile = $true
} elseif (-not $Yes) {
  $answer = Read-Host "Delete Edge profile under MajSoulDaily as well? [y/N]"
  if ($answer -match '^(y|yes)$') {
    $shouldDeleteProfile = $true
  }
}

if ($shouldDeleteProfile) {
  Write-PublicStatus "Deleting edge-profile..."
  Remove-AppDirectory (Join-Path $root "edge-profile")
} else {
  Write-PublicStatus "Preserved edge-profile (if present)."
}

Write-PublicStatus "Uninstall complete."
