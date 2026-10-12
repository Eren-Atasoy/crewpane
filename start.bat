@echo off
title Crewpane
cd /d "%~dp0"
echo ========================================================
echo                 Crewpane - Eren Atasoy
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
call npm run build:preload
npx electron .
pause
