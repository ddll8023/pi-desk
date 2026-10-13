@echo off
for /f "tokens=2 delims=:" %%c in ('chcp') do set "oldcp=%%c"
chcp 65001 >nul
rem 在 Windows 主机上产出便携包：只做前置检查，不安装依赖、不下载 Electron。
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

if not exist "node_modules\electron-builder\package.json" (
  echo [错误] 缺少打包依赖，请先在项目根目录运行 npm install。
  exit /b 1
)

call npm run package:win
set "code=%errorlevel%"

if defined oldcp chcp %oldcp% >nul
endlocal & exit /b %code%
