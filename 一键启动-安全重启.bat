@echo off
setlocal

set "PROJECT_ROOT=%~dp0"
set "WYERP_TASKBOARD_ROOT=%PROJECT_ROOT%"
set "WYERP_TASKBOARD_HOST=127.0.0.1"
set "WYERP_TASKBOARD_PORT=47831"

title WyerpTaskboard - Start or Safe Restart

pushd "%PROJECT_ROOT%" >nul 2>&1
if errorlevel 1 goto :root_error

where node >nul 2>&1
if errorlevel 1 goto :node_error

echo [WyerpTaskboard] Starting or safely restarting...
echo.

node "cli\service.mjs" start-or-restart
if errorlevel 1 goto :service_error

echo.
echo [OK] WyerpTaskboard is running.
echo [URL] http://127.0.0.1:47831
start "" "http://127.0.0.1:47831"

popd
timeout /t 2 /nobreak >nul
exit /b 0

:root_error
echo [ERROR] Cannot enter project directory:
echo %PROJECT_ROOT%
pause
exit /b 1

:node_error
echo [ERROR] Node.js was not found in PATH.
echo Node.js 24 or newer is required.
popd
pause
exit /b 1

:service_error
echo.
echo [ERROR] WyerpTaskboard failed to start or restart.
echo Safe mode will not kill unknown processes.
echo Check data\runtime\system-events for details.
popd
pause
exit /b 1
