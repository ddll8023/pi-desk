#!/usr/bin/env bash
# 以开发模式启动 Pi Desktop（macOS 主机）：只做前置检查，不安装依赖、不下载 Electron。
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

if [ ! -f "node_modules/electron/package.json" ]; then
  echo "[错误] 依赖未安装，请先在项目根目录运行 npm install。"
  exit 1
fi

if [ ! -d "node_modules/electron/dist" ]; then
  echo "[提示] 尚未安装 Electron 二进制，无法启动。"
  echo "       请先在本目录运行：node node_modules/electron/install.js"
  echo "       该命令会从 GitHub Releases 下载约 120MB 的 Electron 到 node_modules/electron/dist。"
  exit 1
fi

npm run dev
