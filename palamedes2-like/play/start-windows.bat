@echo off
rem palamedes2-like test build: start local HTTP server and open browser (Node.js 20+ required)
cd /d "%~dp0"
start "" http://127.0.0.1:8080/
node serve.mjs . 8080
pause
