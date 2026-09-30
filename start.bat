@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode

if exist .env goto checkgroq
set KEY=
set /p KEY="Paste your Gemini API key (or press Enter to skip): "
if not "%KEY%"=="" >>.env echo GEMINI_API_KEY=%KEY%

:checkgroq
findstr /b /c:"GROQ_API_KEY=" .env >nul 2>nul
if not errorlevel 1 goto run
set GKEY=
set /p GKEY="Paste your Groq API key for the backup AI (or press Enter to skip): "
if "%GKEY%"=="" goto run
>>.env echo.
>>.env echo GROQ_API_KEY=%GKEY%

:run
start "" http://localhost:8888
node server.mjs
pause
exit /b 0

:nonode
echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
pause
exit /b 1
