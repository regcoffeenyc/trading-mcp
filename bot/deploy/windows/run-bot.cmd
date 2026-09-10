@echo off
REM Runs the bot and restarts it if it ever exits.
REM Node itself survives most errors; this covers the rest (OOM, a fatal crash).
setlocal

cd /d "%~dp0..\.."

:loop
echo [%date% %time%] starting bot
node dist\index.js
echo [%date% %time%] bot exited with code %errorlevel%, restarting in 15s
timeout /t 15 /nobreak >nul
goto loop
