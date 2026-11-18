$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "Starting OpenBridge at http://127.0.0.1:4173"
node (Join-Path $root 'server.mjs')
