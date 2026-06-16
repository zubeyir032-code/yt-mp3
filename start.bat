@echo off
title YouTube MP3 Indirici
cd /d "%~dp0"
echo.
echo ============================================
echo   YouTube MP3 Indirici baslatiliyor...
echo ============================================
echo.
echo Bilgisayardan erisim: http://localhost:3000
echo.
"C:\Program Files\nodejs\node.exe" server.js
if errorlevel 1 (
    echo.
    echo Hata olustu! Yukaridaki mesaji kontrol edin.
    pause
)
