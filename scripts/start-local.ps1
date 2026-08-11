$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location -LiteralPath $projectRoot

function Invoke-Pnpm {
  param([string[]]$PnpmArgs)
  if ($script:UseCorepack) {
    & $script:PnpmExecutable pnpm @PnpmArgs
  } else {
    & $script:PnpmExecutable @PnpmArgs
  }
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm command failed: $($PnpmArgs -join ' ')"
  }
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  throw "Node.js was not found. Install Node.js 20.9 or newer."
}
$nodeVersionText = (& $nodeCommand.Source --version).Trim().TrimStart("v")
$nodeVersion = [version]$nodeVersionText
if ($nodeVersion -lt [version]"20.9.0") {
  throw "Node.js $nodeVersionText is too old. Version 20.9.0 or newer is required."
}

$pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if (-not $pnpmCommand) { $pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue }
if ($pnpmCommand) {
  $script:PnpmExecutable = $pnpmCommand.Source
  $script:UseCorepack = $false
} else {
  $corepackCommand = Get-Command corepack -ErrorAction SilentlyContinue
  if (-not $corepackCommand) {
    throw "pnpm/corepack was not found. Install pnpm 11 or enable corepack."
  }
  $script:PnpmExecutable = $corepackCommand.Source
  $script:UseCorepack = $true
}

$envPath = Join-Path $projectRoot ".env"
if (-not (Test-Path -LiteralPath $envPath)) {
  Copy-Item -LiteralPath (Join-Path $projectRoot ".env.example") -Destination $envPath
  throw ".env was created. Set ADMIN_PASSWORD to at least 10 characters, then run this script again."
}
$envContent = Get-Content -LiteralPath $envPath -Raw
if ($envContent -notmatch '(?m)^ADMIN_PASSWORD=.+$') {
  throw "ADMIN_PASSWORD in .env must not be empty. Never commit the real password to Git."
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "node_modules"))) {
  Invoke-Pnpm -PnpmArgs @("install", "--frozen-lockfile")
}

Invoke-Pnpm -PnpmArgs @("db:ensure")
Invoke-Pnpm -PnpmArgs @("db:generate")
Invoke-Pnpm -PnpmArgs @("db:migrate")
Invoke-Pnpm -PnpmArgs @("db:seed")

$guideMarker = Join-Path $projectRoot "storage\private\guide-source-renders\shanghai\page-1.png"
if (Test-Path -LiteralPath $guideMarker) {
  Invoke-Pnpm -PnpmArgs @("guides:import")
}

Write-Host "Local Demo initialized. Starting at http://localhost:3000" -ForegroundColor Cyan
Invoke-Pnpm -PnpmArgs @("dev")
