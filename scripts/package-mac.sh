#!/usr/bin/env bash
# 在 macOS 主机上产出便携包：缺少的依赖与受管记忆运行环境由预检脚本自行补齐。
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

# 环境预检：幂等；任一资源无法获取时明确报错并停止，不继续出包。
if ! node scripts/ensure-environment.mjs; then
  exit 1
fi

npm run package:mac
