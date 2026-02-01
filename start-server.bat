@echo off
title Ponzu_Server
cd /d %~dp0

REM Check for Node.js
node -v >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo Node.js is not found. Attempting to install using winget...
    echo.
    winget install OpenJS.NodeJS
    if %errorlevel% neq 0 (
        echo.
        echo Error: Node.js installation via winget failed.
        echo Please install Node.js manually and try again.
        echo.
        pause
        exit /b 1
    )
)

REM Check for node_modules directory
if not exist node_modules (
    echo.
    echo Installing required npm packages...
    echo.
    npm install
    if %errorlevel% neq 0 (
        echo.
        echo Error: "npm install" failed.
        echo Please run "npm install" manually in the command prompt and try again.
        echo.
        pause
        exit /b 1
    )
)

echo.
echo Starting OBS Overlay Tool server...
echo.
node server.js

pause