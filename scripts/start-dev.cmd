@echo off
for /f "tokens=2 delims=:" %%c in ('chcp') do set "oldcp=%%c"
chcp 65001 >nul
rem 以开发模式启动 Pi Desktop：缺少的依赖、Electron 二进制与受管记忆运行环境由预检脚本自行补齐。
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

rem 环境预检：幂等；任一资源无法获取时明确报错并停止，不继续启动。
call node scripts\ensure-environment.mjs
if errorlevel 1 (
  if defined oldcp chcp %oldcp% >nul
  endlocal & exit /b 1
)

rem 开发端口与出包构建内嵌的默认端口（41730）区分开，避免开发版与出包版同时运行时抢端口。
set "PI_DESK_DEV_SERVER_PORT=42730"

call npm run dev
set "code=%errorlevel%"

if defined oldcp chcp %oldcp% >nul
endlocal & exit /b %code%
