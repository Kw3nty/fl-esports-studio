@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title FL Esports Studio
cd /d "%~dp0"

rem ---- 1. Служба уже запущена? ----
tasklist /FI "IMAGENAME eq iot_driver*" 2>nul | find /I "iot_driver" >nul
if not errorlevel 1 goto open

rem ---- 2. Ищем iot_driver.exe ----
set "DRV="
for %%P in (
  "%~dp0iot_driver.exe"
  "%~dp0F. L Driver\resources\app\iot_driver.exe"
  "%LOCALAPPDATA%\Programs\F. L Driver\resources\app\iot_driver.exe"
  "%ProgramFiles%\F. L Driver\resources\app\iot_driver.exe"
  "%ProgramFiles(x86)%\F. L Driver\resources\app\iot_driver.exe"
) do if not defined DRV if exist "%%~P" set "DRV=%%~P"
if not defined DRV for %%F in ("%APPDATA%\F. L Driver\iot_driver_*.exe") do set "DRV=%%~fF"

if not defined DRV (
  echo.
  echo  Не найден iot_driver.exe - служба доступа к клавиатуре.
  echo.
  echo  Скопируйте файл iot_driver.exe из папки оригинального драйвера
  echo  "F. L Driver\resources\app\" в эту папку:
  echo     "%~dp0"
  echo  и запустите этот файл ещё раз.
  echo.
  pause
  exit /b 1
)

echo Запуск службы: !DRV!
for %%D in ("!DRV!") do start "" /D "%%~dpD" "%%~fD"
timeout /t 2 /nobreak >nul

:open
rem ---- 3. Открываем интерфейс (Edge в режиме приложения, иначе браузер по умолчанию) ----
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe" >nul 2>&1
if not errorlevel 1 (
  start "" msedge --app="%~dp0FLEsportsStudio.html" --window-size=1400,900
) else (
  start "" "%~dp0FLEsportsStudio.html"
)
exit /b 0
