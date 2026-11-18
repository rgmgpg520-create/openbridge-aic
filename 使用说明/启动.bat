@echo off
chcp 65001 >nul
cd /d "%~dp0.."
title OpenBridge - full demo (web + local Qwen model)

if not exist "%~dp0..\server.mjs" (
  echo [!] server.mjs not found in the parent folder. Keep this folder inside the project folder and unzip everything.
  pause
  exit /b 1
)

where powershell >nul 2>nul
if errorlevel 1 (
  echo [!] Windows PowerShell not found. You can still run: node server.mjs
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-openbridge.ps1" %*
if errorlevel 1 (
  echo.
  echo [!] Startup failed. Please send a screenshot of the message above.
  pause
)