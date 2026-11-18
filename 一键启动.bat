@echo off
chcp 65001 >nul
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-ChildItem -Path . -Directory | ForEach-Object { Join-Path $_.FullName 'start-openbridge.ps1' } | Where-Object { Test-Path $_ } | Select-Object -First 1; if (-not $p) { Write-Host '[!] start-openbridge.ps1 not found.'; exit 1 }; & $p"

if errorlevel 1 (
  echo.
  echo [!] Startup failed. Please send a screenshot of the message above.
  pause
)
