# Command Code 代理搭建

本文说明如何在一台新电脑上把 Command Code 反代跑起来，并用它给 pi 提供 OpenAI 兼容接口。按顺序执行即可复现。

代理本体是第三方开源项目 [thaolaptrinh/commandcode-api-proxy](https://github.com/thaolaptrinh/commandcode-api-proxy)，它把 Command Code 订阅套餐的 `/alpha/generate` 协议转换成标准 OpenAI / Anthropic 接口。本文只补充上游没有的启动脚本和客户端配置。

## 1. 适用场景与前提

- 账号是 **Go / GOAT / Pro 订阅套餐**，只有 `/alpha/generate` 权限。
- 需要把 Command Code 的额度用于 pi、Claude Code、OpenCode 等外部客户端。
- 如果账号是 **Provider 套餐（$15/月）**，不需要这个代理：`https://api.commandcode.ai/provider/v1` 本身就是 OpenAI 兼容接口，直接在客户端填这个地址即可。

判断方式（把 `$KEY` 换成自己的 key）：

```bash
# 订阅套餐：返回 200 且带 user 信息
curl -sS https://api.commandcode.ai/alpha/whoami -H "Authorization: Bearer $KEY"

# Provider 套餐：返回 200 和模型列表
curl -sS https://api.commandcode.ai/provider/v1/models -H "Authorization: Bearer $KEY"
```

注意 `/alpha/whoami` 不校验 CLI 版本，所以它返回 200 不代表 `/alpha/generate` 能用。

## 2. 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | >= 24（上游 `engines` 字段要求） |
| pnpm | 10.32.1（`package.json` 的 `packageManager`） |
| curl、lsof | macOS 自带，脚本会用到 |
| 终端 shell | macOS 自带 bash 3.2 即可 |

首次准备 pnpm：

```bash
corepack enable
corepack prepare pnpm@10.32.1 --activate
```

## 3. 获取源码并构建

```bash
git clone https://github.com/thaolaptrinh/commandcode-api-proxy.git
cd commandcode-api-proxy
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` 执行 `tsc && tsc-alias`，产物在 `dist/`，入口是 `dist/proxy.js`。

## 4. 写入 API Key

Key 从 https://commandcode.ai/settings 获取，两种方式任选其一。

**方式一：保存到本地文件**（推荐，之后无需每次输入）

```bash
node dist/proxy.js auth login          # 交互式输入
node dist/proxy.js auth login --force  # 覆盖已有 key
node dist/proxy.js auth logout         # 删除
```

保存位置：`~/.config/commandcode-api-proxy/auth.json`，内容形如 `{"apiKey": "user_xxx"}`。

**方式二：环境变量**

```bash
export CC_API_KEY=user_xxx
```

优先级：`--api-key` 参数 > `CC_API_KEY` 环境变量 > `auth.json`。

## 5. 启动脚本

上游没有启动脚本，直接 `node dist/proxy.js` 会踩两个坑：依赖/构建需要手动处理，以及缺少 `CC_CLI_VERSION` 会返回 401（见第 8 节）。

在仓库根目录新建 `start.sh`，内容如下（`chmod +x start.sh`）：

```bash
#!/usr/bin/env bash
#
# Command Code API Proxy 启动脚本
#
# 用法：
#   ./start.sh                       # 按需安装依赖/构建后启动（默认 127.0.0.1:8787）
#   ./start.sh --port 9000           # 参数原样透传给 node dist/proxy.js
#   ./start.sh --rebuild             # 强制重新构建
#   ./start.sh --background          # 后台常驻启动，日志写入 proxy.log
#   ./start.sh --stop                # 停止后台常驻的代理进程
#   ./start.sh auth login            # 保存 API Key
#   ./start.sh --setup-claude-code   # 生成 Claude Code 配置
#
# 支持的环境变量（也可写在同目录的 .env 中）：
#   HOST PORT CC_API_KEY CC_API_BASE CC_CLI_VERSION LOG_LEVEL CORS_ORIGIN
#   CC_UPSTREAM_TIMEOUT_MS CC_IDLE_TIMEOUT_MS
#
# CC_CLI_VERSION 未设置时会自动查询 npm 上 command-code 的最新版本，查询失败则回退到
# 1.84.0。CC 服务端会拒绝版本过期的 CLI，缺这个变量通常表现为 /alpha/generate 返回
# 401 UNAUTHORIZED。
#
# 注意：本脚本兼容 macOS 自带的 bash 3.2，未使用关联数组等新特性。

set -euo pipefail

MIN_NODE_MAJOR=24
# CC 拒绝版本过期的 CLI；此值是在本机验证通过的兜底版本。
CC_FALLBACK_CLI_VERSION="1.84.0"
PID_FILE="proxy.pid"
LOG_FILE="proxy.log"
DEFAULT_PORT="8787"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SCRIPT_DIR"

die() {
  printf '错误：%s\n' "$1" >&2
  exit 1
}

# 收集脚本自身参数，其余原样透传给代理程序。
REBUILD=0
BACKGROUND=0
STOP=0
PASSTHROUGH=()

for arg in "$@"; do
  case "$arg" in
    --rebuild)
      REBUILD=1
      ;;
    --background|--bg)
      BACKGROUND=1
      ;;
    --stop)
      STOP=1
      ;;
    -h|--help)
      sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      PASSTHROUGH+=("$arg")
      ;;
  esac
done

# 运行代理时用；bash 3.2 在 set -u 下展开空数组会报错，故做保护。
run_proxy() {
  exec node dist/proxy.js ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
}

# 解析端口：--port 参数优先，其次 PORT 环境变量，最后默认值。
resolve_port() {
  local port="$DEFAULT_PORT"
  local i=0
  local n=${#PASSTHROUGH[@]}
  while [ "$i" -lt "$n" ]; do
    if [ "${PASSTHROUGH[$i]}" = "--port" ] && [ $((i + 1)) -lt "$n" ]; then
      port="${PASSTHROUGH[$((i + 1))]}"
    fi
    i=$((i + 1))
  done
  printf '%s' "${PORT:-$port}"
}

port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# ---- 1. 基础环境检查 -------------------------------------------------------
command -v node >/dev/null 2>&1 || die "未找到 node，请先安装 Node.js 24 或更高版本。"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  die "当前 Node 版本为 $(node -v)，本项目要求 Node >= ${MIN_NODE_MAJOR}。"
fi

command -v pnpm >/dev/null 2>&1 || die "未找到 pnpm，请先执行：corepack enable && corepack prepare pnpm@10.32.1 --activate"

# ---- 2. 加载 .env（已存在的同名环境变量优先） -------------------------------
if [ -f .env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      ''|\#*) continue ;;
      *=*) ;;
      *) continue ;;
    esac
    case "$line" in
      [A-Za-z_]*)
        key="${line%%=*}"
        # 键名必须合法，避免把奇怪内容 export 出去
        case "$key" in
          *[!A-Za-z0-9_]*) continue ;;
        esac
        val="${line#*=}"
        # 去掉成对的首尾引号
        case "$val" in
          \"*\") val="${val#\"}"; val="${val%\"}" ;;
          \'*\') val="${val#\'}"; val="${val%\'}" ;;
        esac
        if [ -z "$(printenv "$key" || true)" ]; then
          export "$key=$val"
        fi
        ;;
    esac
  done < .env
fi

# ---- 3. 依赖与构建 ---------------------------------------------------------
if [ ! -d node_modules ]; then
  echo "==> 未找到 node_modules，正在安装依赖..."
  pnpm install --frozen-lockfile
fi

NEED_BUILD=0
if [ "$REBUILD" -eq 1 ]; then
  NEED_BUILD=1
elif [ ! -f dist/proxy.js ]; then
  NEED_BUILD=1
elif [ -n "$(find src -name '*.ts' -newer dist/proxy.js -print -quit 2>/dev/null)" ]; then
  NEED_BUILD=1
elif [ package.json -nt dist/proxy.js ] || [ tsconfig.json -nt dist/proxy.js ]; then
  NEED_BUILD=1
fi

if [ "$NEED_BUILD" -eq 1 ]; then
  echo "==> 正在构建（tsc + tsc-alias）..."
  pnpm build
fi

# ---- 4. API Key 检查 -------------------------------------------------------
# 运行 auth / setup 子命令时无需检查 Key。
if [ "${PASSTHROUGH[0]-}" != "auth" ]; then
  AUTH_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/commandcode-api-proxy/auth.json"
  if [ -z "${CC_API_KEY:-}" ] && [ ! -s "$AUTH_FILE" ]; then
    if [ ! -t 0 ]; then
      die "未找到 API Key（CC_API_KEY 或 $AUTH_FILE），且当前不是交互终端，无法提示输入。"
    fi
    echo "==> 未找到 API Key，启动后将提示输入（可先在 https://commandcode.ai/settings 获取）。"
  fi
fi

# ---- 4.5 CLI 版本（CC 会拒绝过期的 x-command-code-version） -----------------
if [ "$STOP" -eq 0 ] && [ "${PASSTHROUGH[0]-}" != "auth" ]; then
  if [ -z "${CC_CLI_VERSION:-}" ]; then
    DETECTED=""
    if command -v curl >/dev/null 2>&1; then
      DETECTED="$(curl -fsS --max-time 5 https://registry.npmjs.org/command-code/latest 2>/dev/null \
        | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
    fi
    if [ -n "$DETECTED" ]; then
      CC_CLI_VERSION="$DETECTED"
    else
      CC_CLI_VERSION="$CC_FALLBACK_CLI_VERSION"
      echo "==> 无法查询 command-code 最新版本，回退到 $CC_CLI_VERSION" >&2
    fi
    export CC_CLI_VERSION
  fi
  echo "==> 使用 CC_CLI_VERSION=$CC_CLI_VERSION"
fi

# ---- 5. 停止 / 后台启动 / 前台启动 ------------------------------------------
if [ "$STOP" -eq 1 ]; then
  PORT_TO_CHECK="$(resolve_port)"
  STOPPED=0
  if [ -f "$PID_FILE" ]; then
    PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      kill -TERM "$PID" 2>/dev/null || true
      STOPPED=1
    fi
    rm -f "$PID_FILE"
  fi
  if [ "$STOPPED" -eq 0 ] && port_in_use "$PORT_TO_CHECK"; then
    PIDS="$(lsof -nP -t -iTCP:"$PORT_TO_CHECK" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$PIDS" ]; then
      for p in $PIDS; do kill -TERM "$p" 2>/dev/null || true; done
      STOPPED=1
    fi
  fi
  if [ "$STOPPED" -eq 1 ]; then
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      port_in_use "$PORT_TO_CHECK" || break
      sleep 1
    done
    if port_in_use "$PORT_TO_CHECK"; then
      die "端口 $PORT_TO_CHECK 仍被占用，请手动检查。"
    fi
    echo "==> 已停止代理（端口 $PORT_TO_CHECK 已释放）"
  else
    echo "==> 没有找到运行中的代理（端口 $PORT_TO_CHECK 未监听）"
  fi
  exit 0
fi

if [ "$BACKGROUND" -eq 1 ]; then
  PORT_TO_CHECK="$(resolve_port)"
  if port_in_use "$PORT_TO_CHECK"; then
    die "端口 $PORT_TO_CHECK 已被占用，先执行 ./start.sh --stop"
  fi
  nohup node dist/proxy.js ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"} > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 2
  if ! port_in_use "$PORT_TO_CHECK"; then
    echo "==> 启动失败，日志如下：" >&2
    tail -20 "$LOG_FILE" >&2 || true
    rm -f "$PID_FILE"
    exit 1
  fi
  echo "==> 已在后台启动，PID $(cat "$PID_FILE")，端口 $PORT_TO_CHECK"
  echo "==> 日志：$SCRIPT_DIR/$LOG_FILE（tail -f $LOG_FILE 跟踪）"
  echo "==> 停止：./start.sh --stop"
  exit 0
fi

run_proxy
```

脚本做四件事：

1. 检查 Node 版本与 pnpm 是否存在。
2. 有 `.env` 时逐行加载（不覆盖已存在的同名环境变量）。
3. `node_modules` 缺失时安装；`dist/proxy.js` 缺失、或 `src/**/*.ts` / `package.json` / `tsconfig.json` 比产物新时自动构建。
4. 注入 `CC_CLI_VERSION` 后启动，参数原样透传。

## 6. 日常用法

```bash
./start.sh                 # 前台启动，Ctrl+C 停止
./start.sh --background    # 后台常驻，日志 proxy.log，PID 写入 proxy.pid
./start.sh --stop          # 停止后台进程
./start.sh --rebuild       # 强制重新构建后启动
./start.sh --port 9000     # 换端口
./start.sh --help          # 查看帮助
```

后台模式日志：

```bash
tail -f proxy.log
```

## 7. 验证与客户端接入

### 7.1 验证代理

```bash
# 健康检查
curl -sS http://127.0.0.1:8787/health

# 模型列表
curl -sS http://127.0.0.1:8787/v1/models -H "Authorization: Bearer proxy-managed"

# 最小对话请求（返回 200 即通）
curl -sS -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer proxy-managed" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'
```

客户端传什么 token 都行：代理对 `proxy-managed`、`placeholder` 或空值会替换成自己配置的真实 key。

### 7.2 接入 pi

编辑 `~/.pi/agent/models.json`，在 `providers` 下新增一项（ID 可自取）：

```json
{
  "providers": {
    "commandcode-proxy": {
      "name": "Command Code (本地代理)",
      "baseUrl": "http://127.0.0.1:8787/v1",
      "api": "openai-completions",
      "apiKey": "proxy-managed",
      "models": [
        {
          "id": "deepseek/deepseek-v4.1-flash",
          "name": "DeepSeek V4.1 Flash",
          "contextWindow": 1000000,
          "maxTokens": 32000,
          "reasoning": true,
          "input": ["text"],
          "compat": {
            "thinkingFormat": "deepseek",
            "maxTokensField": "max_tokens",
            "supportsReasoningEffort": true,
            "supportsDeveloperRole": false,
            "supportsStore": false
          }
        }
      ]
    }
  }
}
```

之后在 pi 里 `/model` 选择该 provider 下的模型；手动改完 `models.json` 需重启 pi 或 `/reload`。

可选的模型 ID（来自上游 `src/models.json`，共 40 多个内置模型）：

| 类别 | 示例 ID |
| --- | --- |
| DeepSeek | `deepseek/deepseek-v4-pro`、`deepseek/deepseek-v4-flash`、`deepseek/deepseek-v4-flash-vision-exp` |
| GLM | `zai-org/GLM-5.3`、`z-ai/glm-5.3-flash` |
| Kimi | `moonshotai/Kimi-K3`、`moonshotai/Kimi-K2.7-Code` |
| Qwen | `Qwen/Qwen3.8-Max`、`Qwen/Qwen3.7-Plus` |
| MiniMax | `MiniMaxAI/MiniMax-M3`、`MiniMaxAI/MiniMax-M2.7` |
| xAI | `xai/grok-4.6`、`xai/grok-4.5` |

短别名同样可用（如 `deepseek-v4-pro`、`glm-5.3`、`kimi-k3`），代理侧会解析成完整 ID。真实的模型清单以 `src/models.json` 的 `builtin` 字段为准，它随上游仓库更新。

### 7.3 接入 OpenCode / Claude Code

```bash
./start.sh --setup-opencode       # 写 ~/.config/opencode/opencode.json
./start.sh --setup-claude-code    # 写 ~/.config/commandcode-api-proxy/claude-settings.json
claude --settings ~/.config/commandcode-api-proxy/claude-settings.json
```

Claude Code 只有 sonnet / opus / haiku 三档，通过 `ANTHROPIC_DEFAULT_SONNET_MODEL` 等环境变量映射到具体模型；如需整体强制某个模型，设 `ANTHROPIC_DEFAULT_MODEL`。

## 8. 关键约束

**`CC_CLI_VERSION` 必须是最新版本。** 代理源码里的兜底值是 `0.40.3`（`src/config.ts` 的 `DEFAULT_CC_VERSION`），启动时会尝试从 npm 拉取最新版覆盖；拉取失败就用这个旧版本，而 Command Code 服务端会拒绝版本过期的 CLI，表现为：

```
401: {"message":"CC API 401: {\"success\":false,\"error\":{\"code\":\"UNAUTHORIZED\",\"status\":401,\"message\":\"Invalid 'Authorization' header or token.\"}}"}
```

此时 `/alpha/whoami` 用同一把 key 仍是 200，容易误判成 key 失效。显式设置 `CC_CLI_VERSION`（本文写作时是 `1.84.0`）即可恢复。`start.sh` 已自动处理，手动启动时必须自己带上：

```bash
CC_CLI_VERSION=1.84.0 node dist/proxy.js
```

其他约束：

- 代理只在 localhost 安全：它转发你的付费 key，且对客户端不做鉴权。不要 `HOST=0.0.0.0` 暴露到不可信网络；确需暴露时至少限制 `CORS_ORIGIN` 并在前面加自己的鉴权。
- 上游超时默认 10 分钟（`CC_UPSTREAM_TIMEOUT_MS`），流式空闲超时 2 分钟（`CC_IDLE_TIMEOUT_MS`）。推理型模型首字节慢，必要时调大。
- 上游响应走 `reasoning_content` 字段携带思维链（DeepSeek 风格），客户端需要支持该字段才能看到思考过程。

## 9. 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 401 `UNAUTHORIZED` | `CC_CLI_VERSION` 过期 | 用最新版重设并重启，见第 8 节 |
| 401 且 `/alpha/whoami` 也失败 | key 错误或已轮换 | 重新 `auth login --force` |
| 403 `upgrade_required` | 账号是 Go 套餐却直接打了 `/provider/v1` | 改回代理地址 `127.0.0.1:8787/v1` |
| 400 `BAD_REQUEST` / schema 报错 | 上游 CLI 协议变更，代理未跟进 | 更新代理源码后 `./start.sh --rebuild` |
| 400 `insufficient credits` | 额度不足 | 检查账单或换模型 |
| 连接被拒 | 代理没启动或端口不符 | `./start.sh --background`，确认 `lsof -nP -iTCP:8787` |
| 端口被占用 | 旧进程残留 | `./start.sh --stop` 或 `lsof -nP -iTCP:8787 -t \| xargs kill` |
| 流式响应中途卡住 | 上游停滞触发空闲超时 | 检查网络后重试，或调大 `CC_IDLE_TIMEOUT_MS` |

排障时可开 debug 日志：

```bash
LOG_LEVEL=debug ./start.sh
```

日志会打印 key 来源、长度（不打印明文）与实际发出的版本号。

## 10. 风险与合规

- Command Code 的服务条款限定订阅套餐仅授权官方 CLI 使用，通过反代调用属于非官方方案，存在账号被限制的风险。
- 该接口是官方未公开的私有协议，可能随 CLI 更新随时变化，代理需要跟进上游仓库更新。
- 若需要长期稳定、受授权的调用，应改用 Provider 套餐的 `/provider/v1` 正式接口。
- `~/.config/commandcode-api-proxy/auth.json` 与 `models.json` 中的 key 均为明文，注意文件权限与备份范围。
