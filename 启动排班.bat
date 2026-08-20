@echo off
setlocal
chcp 65001 >nul
title 入网审核排班 1.5
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

set NEED_BUILD=0
if not exist "dist\index.html" set NEED_BUILD=1
if "%NEED_BUILD%"=="0" (
  powershell -NoProfile -WindowStyle Hidden -Command "$d=(Get-Item 'dist\index.html').LastWriteTime; $n=@(Get-ChildItem 'src','shared','index.html','vite.config.ts' -Recurse -File -EA SilentlyContinue | Where-Object { $_.LastWriteTime -gt $d } | Select-Object -First 1); if ($n.Count) { exit 1 } else { exit 0 }"
  if errorlevel 1 set NEED_BUILD=1
)

if "%NEED_BUILD%"=="1" (
  echo 界面有更新，正在打包...
  call npx --yes vite build
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
start /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 2; Start-Process 'http://127.0.0.1:8787/'"
call npx --yes tsx server/index.ts
pause
