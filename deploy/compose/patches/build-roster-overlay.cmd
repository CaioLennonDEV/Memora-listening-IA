@echo off
REM Thin wrapper — real work is Node (no pnpm install required).
cd /d "%~dp0" || exit /b 1
node build-roster-overlay.mjs
exit /b %ERRORLEVEL%
