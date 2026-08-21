@echo off
setlocal
cd /d "%~dp0"
title ��������Ű� 1.7

where node >nul 2>&1
if errorlevel 1 (
  echo δ�ҵ� Node.js�����Ȱ�װ Node.js 18 ����߰汾����˫�����ű���
  echo ���أ�https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo ���ڰ�װ���������Ժ�...
  call npm install
  if errorlevel 1 (
    echo ������װʧ�ܡ�
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
  echo �����и��£����ڴ��...
  call npx --yes vite build
  if errorlevel 1 (
    echo ���ʧ�ܡ�
    pause
    exit /b 1
  )
)

curl.exe -s -o nul -w "%%{http_code}" http://127.0.0.1:8787/api/health | findstr /c:"200" >nul
if %errorlevel%==0 (
  echo �����������У����ڴ������...
  start "" "http://127.0.0.1:8787/"
  exit /b 0
)

echo ����������������Ű�...
echo �رձ����ڼ�ֹͣ����
start /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 2; Start-Process 'http://127.0.0.1:8787/'"
call npx --yes tsx server/index.ts
pause