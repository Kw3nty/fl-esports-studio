@echo off
chcp 65001 >nul
taskkill /F /IM "iot_driver*" >nul 2>&1
echo Служба iot_driver остановлена.
timeout /t 2 >nul
