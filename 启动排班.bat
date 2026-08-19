@echo off
setlocal
chcp 65001 >nul
title 入网审核排班 1.2
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js 18 或更高版本后再双击本脚本。
  echo 下载：https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 正在安装依赖，请稍候...
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败。
    pause
    exit /b 1
  )
)

if not exist "dist\index.html" (
  echo 正在打包界面...
  call npm run build
  if errorlevel 1 (
    echo 打包失败。
    pause
    exit /b 1
  )
)

curl.exe -s -o nul -w "%%{http_code}" http://127.0.0.1:8787/api/health | findstr /c:"200" >nul
if %errorlevel%==0 (
  echo 服务已在运行，正在打开浏览器...
  start "" "http://127.0.0.1:8787/"
  exit /b 0
)

echo 正在启动入网审核排班...
echo 关闭本窗口即停止程序。
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:8787/"
call npx --yes tsx server/index.ts
pause
