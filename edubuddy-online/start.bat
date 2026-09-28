@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
if exist .env goto run
set KEY=
set /p KEY="Paste your Gemini API key (or press Enter to skip): "
if "%KEY%"=="" goto run
>.env echo GEMINI_API_KEY=%KEY%

:run
start "" http://localhost:8888
node server.mjs
pause
exit /b 0

:nonode
echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
pause
exit /b 1
