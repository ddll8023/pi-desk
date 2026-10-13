#!/usr/bin/env bash
# 在 macOS 主机上产出便携包：只做前置检查，不安装依赖、不下载 Electron。
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

if [ ! -f "node_modules/electron-builder/package.json" ]; then
  echo "[错误] 缺少打包依赖，请先在项目根目录运行 npm install。"
  exit 1
fi

npm run package:mac
