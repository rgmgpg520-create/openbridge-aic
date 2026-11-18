@echo off
chcp 65001 >nul
cd /d "%~dp0.."
title OpenBridge - environment check

if not exist "%~dp0..\server.mjs" (
  echo [!] server.mjs not found in the parent folder. Keep this folder inside the project folder and unzip everything.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-openbridge.ps1" -Diagnose

echo.
pause