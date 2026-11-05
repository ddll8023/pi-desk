#!/usr/bin/env bash
# 以开发模式启动 Pi Desktop（macOS 主机）：缺少的依赖、Electron 二进制与受管记忆运行环境由预检脚本自行补齐。
set -u

cd "$(dirname "$0")/.." || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未找到 node 命令，请先安装 Node.js。"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[错误] 未找到 npm 命令。"
  exit 1
fi

# 环境预检：幂等；任一资源无法获取时明确报错并停止，不继续启动。
if ! node scripts/ensure-environment.mjs; then
  exit 1
fi

# 开发端口与出包构建内嵌的默认端口（41730）区分开，避免开发版与出包版同时运行时抢端口。
export PI_DESK_DEV_SERVER_PORT=42730

npm run dev
