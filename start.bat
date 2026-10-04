@echo off
title CrewPane Local
cd /d "%~dp0"
echo ========================================================
echo       CrewPane Local - Developer Launcher
echo ========================================================
echo.
echo Supabase URL : http://127.0.0.1:54321
echo Supabase UI  : http://127.0.0.1:54323
echo Mode         : Dev / Local App DB (Unified Local Target)
echo.
set CREWPANE_MODE=prod
set CREWPANE_INSTANCE=dev
set CREWPANE_ALLOW_LOCAL_APP_DB=1
set CREWPANE_ALLOW_MIXED_TARGETS=1
npx electron .
pause
