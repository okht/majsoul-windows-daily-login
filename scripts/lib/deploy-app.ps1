# Shared deploy helpers for MajSoulDaily installed bundle.
$ErrorActionPreference = "Stop"

function Get-MajSoulRoot {
  if (-not $env:LOCALAPPDATA) {
    throw "LOCALAPPDATA is not set."
  }
  return (Join-Path $env:LOCALAPPDATA "MajSoulDaily")
}

function Get-InstalledAppDir {
  return (Join-Path (Get-MajSoulRoot) "app")
}

function Get-AcceptanceReceiptPath {
  return (Join-Path (Get-MajSoulRoot) "acceptance-receipt.json")
}

function Find-CscCompiler {
  $candidates = @(
    "${env:WINDIR}\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "${env:WINDIR}\Microsoft.NET\Framework\v4.0.30319\csc.exe"
  )
  foreach ($path in $candidates) {
    if (Test-Path -LiteralPath $path) {
      return $path
    }
  }
  throw "csc.exe not found. Install .NET Framework developer pack / Windows SDK build tools."
}

function Invoke-CompileLauncher {
  param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][string]$OutputPath
  )

  if (-not (Test-Path -LiteralPath $SourcePath)) {
    throw "Launcher source missing: $SourcePath"
  }

  $csc = Find-CscCompiler
  $args = @(
    "/nologo",
    "/target:winexe",
    "/optimize+",
    "/platform:anycpu",
    "/out:$OutputPath",
    $SourcePath
  )
  & $csc @args
  if ($LASTEXITCODE -ne 0) {
    throw "Launcher compilation failed with exit code $LASTEXITCODE."
  }
  if (-not (Test-Path -LiteralPath $OutputPath)) {
    throw "Launcher output was not created."
  }

  $info = Get-Item -LiteralPath $OutputPath
  if ($info.Length -lt 1024) {
    throw "Launcher binary is unexpectedly small."
  }
}

function Copy-NodeBinary {
  param(
    [Parameter(Mandatory = $true)][string]$DestinationDir
  )
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $target = Join-Path $DestinationDir "node.exe"
  Copy-Item -LiteralPath $node -Destination $target -Force
  if (-not (Test-Path -LiteralPath $target)) {
    throw "Failed to copy node.exe into the install bundle."
  }
  return $target
}

function Invoke-DeployAppBundle {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot
  )

  $appRoot = Get-MajSoulRoot
  $staging = Join-Path $appRoot ("app.staging." + [guid]::NewGuid().ToString("N"))
  $final = Get-InstalledAppDir
  $backup = Join-Path $appRoot ("app.backup." + [guid]::NewGuid().ToString("N"))

  New-Item -ItemType Directory -Path $staging -Force | Out-Null

  try {
    Copy-Item -LiteralPath (Join-Path $RepoRoot "package.json") -Destination $staging -Force
    if (Test-Path -LiteralPath (Join-Path $RepoRoot "package-lock.json")) {
      Copy-Item -LiteralPath (Join-Path $RepoRoot "package-lock.json") -Destination $staging -Force
    }

    Copy-Item -LiteralPath (Join-Path $RepoRoot "src") -Destination (Join-Path $staging "src") -Recurse -Force

    # Production install of dependencies inside staging.
    Push-Location $staging
    try {
      & npm ci --omit=dev
      if ($LASTEXITCODE -ne 0) {
        throw "npm ci --omit=dev failed in staging bundle."
      }
    } finally {
      Pop-Location
    }

    Copy-NodeBinary -DestinationDir $staging | Out-Null

    $launcherSource = Join-Path $RepoRoot "tools\launcher\MajSoulDailyLauncher.cs"
    $launcherOut = Join-Path $staging "MajSoulDaily.exe"
    Invoke-CompileLauncher -SourcePath $launcherSource -OutputPath $launcherOut

    # Atomic-ish replace: move old aside, move staging in.
    New-Item -ItemType Directory -Path $appRoot -Force | Out-Null
    if (Test-Path -LiteralPath $final) {
      Move-Item -LiteralPath $final -Destination $backup -Force
    }
    Move-Item -LiteralPath $staging -Destination $final -Force

    if (Test-Path -LiteralPath $backup) {
      Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
    }

    return $final
  } catch {
    if (Test-Path -LiteralPath $staging) {
      Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
    throw
  }
}

function Test-AcceptanceReceipt {
  param(
    [Parameter(Mandatory = $true)][string]$AppDir
  )
  $receiptPath = Get-AcceptanceReceiptPath
  if (-not (Test-Path -LiteralPath $receiptPath)) {
    return $false
  }

  try {
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
  } catch {
    return $false
  }

  if (-not $receipt.version -or -not $receipt.passed -or -not $receipt.createdAt) {
    return $false
  }
  if ($receipt.passed -ne $true) {
    return $false
  }

  $packagePath = Join-Path $AppDir "package.json"
  if (-not (Test-Path -LiteralPath $packagePath)) {
    return $false
  }
  $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
  if ($package.version -ne $receipt.version) {
    return $false
  }

  # Receipt must be recent (7 days) so registration cannot reuse a stale pass forever.
  $created = [datetime]::Parse($receipt.createdAt, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
  if (([datetime]::UtcNow - $created.ToUniversalTime()).TotalDays -gt 7) {
    return $false
  }

  return $true
}
