@echo off
rem palamedes2-like first edition RC: start a local HTTP server and open the browser (Node.js 18+ required).
rem If port 8080 is busy, the next free port (8081-8090) is used automatically.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install the LTS version from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
echo Starting the game server. Keep this window open while playing. Close it to stop.
node serve.mjs . 8080 --open
pause
