@echo off
for /f "tokens=2 delims=:" %%c in ('chcp') do set "oldcp=%%c"
chcp 65001 >nul
rem 以开发模式启动 Pi Desktop：只做前置检查，不安装依赖、不下载 Electron。
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 node 命令，请先安装 Node.js。
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 npm 命令。
  exit /b 1
)

if not exist "node_modules\electron\package.json" (
  echo [错误] 依赖未安装，请先在项目根目录运行 npm install。
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [提示] 尚未安装 Electron 二进制，无法启动。
  echo        请先在本目录运行：node node_modules\electron\install.js
  echo        该命令会从 GitHub Releases 下载约 120MB 的 Electron 到 node_modules\electron\dist。
  exit /b 1
)

call npm run dev
set "code=%errorlevel%"

if defined oldcp chcp %oldcp% >nul
endlocal & exit /b %code%
