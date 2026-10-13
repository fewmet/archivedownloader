@echo off
title archivedownloader
cd /d "%~dp0"

rem Use the Node.js already on this PC if it is new enough (18+)
set "NODE="
set "NODEMAJOR=0"
where node >nul 2>nul && for /f "usebackq delims=" %%v in (`node -p "process.versions.node.split('.')[0]"`) do set "NODEMAJOR=%%v"
if %NODEMAJOR% GEQ 18 set "NODE=node"
if defined NODE goto run

rem Otherwise use the private copy in this folder, downloading it the first time
if exist "runtime\node.exe" set "NODE=runtime\node.exe"
if defined NODE goto run

echo.
echo  First run: downloading Node.js into this folder - about 30 MB, only once.
echo  Nothing gets installed on your PC.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol='Tls12'; $v='v22.23.3'; $name='node-'+$v+'-win-x64'; $zip=Join-Path $env:TEMP 'archivedownloader-node.zip'; $out=Join-Path $env:TEMP 'archivedownloader-node'; Invoke-WebRequest -UseBasicParsing ('https://nodejs.org/dist/'+$v+'/'+$name+'.zip') -OutFile $zip; Expand-Archive -Force $zip $out; New-Item -ItemType Directory -Force 'runtime' | Out-Null; Copy-Item (Join-Path $out ($name+'\node.exe')) 'runtime\node.exe'; Remove-Item -Recurse -Force $zip, $out"
if not exist "runtime\node.exe" goto failed
set "NODE=runtime\node.exe"

:run
set "OPEN_BROWSER=1"
"%NODE%" server.js
echo.
echo  archivedownloader stopped.
pause
exit /b 0

:failed
echo.
echo  Couldn't download Node.js. Check your internet connection and try again,
echo  or install Node.js yourself from https://nodejs.org and run this again.
echo.
pause
exit /b 1
