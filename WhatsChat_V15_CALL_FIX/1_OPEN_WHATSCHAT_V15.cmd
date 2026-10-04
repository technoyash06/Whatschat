@echo off
title WhatsChat V15 - Reliable Voice and Video Calls
cd /d "%~dp0"
echo Starting WhatsChat V15...
echo Please wait. Cloudflare usually needs up to two minutes; bad addresses are retried automatically.
echo Do not open an old trycloudflare.com tab. This launcher will open the fresh page for you.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0START_PUBLIC_WHATSCHAT.ps1"
if errorlevel 1 (
  echo.
  echo WhatsChat V15 could not start.
  if exist "%~dp0WhatsChat_Live_Server\server-error.log" type "%~dp0WhatsChat_Live_Server\server-error.log"
  echo.
  pause
  exit /b 1
)
echo.
echo WhatsChat V15 is ready. Keep this computer on.
pause
