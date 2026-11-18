# Compatibility entry point.
# The real launcher lives in the handbook folder next to the project root
# (the folder that also contains the .bat shortcuts). Keep this file so that
# anyone who opens scripts\ still finds a working start script.
#
# This file is intentionally ASCII-only: Windows PowerShell 5.1 would read a
# UTF-8 file without BOM as ANSI and garble a hard-coded non-ASCII path.
$root = Split-Path -Parent $PSScriptRoot

$candidates = @()
$candidates += (Join-Path $root 'start-openbridge.ps1')
Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -ne $PSScriptRoot } |
  ForEach-Object { $candidates += (Join-Path $_.FullName 'start-openbridge.ps1') }

foreach ($candidate in $candidates) {
  if (Test-Path -LiteralPath $candidate) {
    & $candidate @args
    exit $LASTEXITCODE
  }
}

Write-Error 'start-openbridge.ps1 not found (expected in the handbook folder next to the project root).'
exit 1