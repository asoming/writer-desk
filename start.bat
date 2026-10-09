@echo off
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel% equ 0 (
  py -3 server.py --open %*
  goto finish
)
where python >nul 2>nul
if %errorlevel% equ 0 (
  python server.py --open %*
  goto finish
)
echo 作家工作台：请先安装 Python 3.9 或更新版本，并勾选 Add Python to PATH。桌面发行版无需安装 Python。
pause
exit /b 1
:finish
if errorlevel 1 pause
