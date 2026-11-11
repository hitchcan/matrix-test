@echo off
chcp 65001 >nul
cd /d "%~dp0"
node scripts/build-editor.mjs
if errorlevel 1 goto end
node server.mjs
:end
pause
