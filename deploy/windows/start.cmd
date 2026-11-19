@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\windows\launch.ps1"
if errorlevel 1 (
  echo.
  echo Startup failed. See server\server.err.log and upstream\muse2api\server.err.log.
  pause
)
