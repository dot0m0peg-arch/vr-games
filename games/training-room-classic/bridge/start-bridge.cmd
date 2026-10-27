@echo off
rem Training Room laptop bridge: double-click to start. Needs Node.js 20+ (https://nodejs.org).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20 or newer is required: https://nodejs.org & pause & exit /b 1)
node server.mjs %*
pause
