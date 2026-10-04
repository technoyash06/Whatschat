@echo off
title WhatsChat V15 - Stop
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0STOP_WHATSCHAT_LIVE.ps1"
pause
