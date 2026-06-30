@echo off
chcp 65001 >nul
title Bot WhatsApp - Backend
color 0A
cd /d "%~dp0"
echo.
echo ========================================
echo     BOT WHATSAPP - BACKEND
echo ========================================
echo.
echo Iniciando backend...
echo.
node server.js
echo.
pause
