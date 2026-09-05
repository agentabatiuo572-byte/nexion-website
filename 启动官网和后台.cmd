@echo off
setlocal
chcp 65001 >nul
title NexGrid Website and Console
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-website.ps1" %*
exit /b %ERRORLEVEL%
