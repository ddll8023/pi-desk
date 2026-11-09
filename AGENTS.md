# 项目级工作规则 (pi-desk)

1. 本仓库需兼容 macOS (zsh) 与 Windows (cmd/PowerShell)，路径处理兼容 POSIX 与 Windows 反斜杠。Python 命令按以下顺序选择环境，且仍受执行权限限制：
   - 优先使用项目虚拟环境：macOS/Linux 为 `.venv/bin/python`，Windows 为 `.venv/Scripts/python.exe`；
   - 存在环境变量 `PYTHON` 或 `PI_PYTHON` 时按指定路径使用；
   - 不存在项目虚拟环境时使用系统 PATH 中的 `python3` 或 `python`。
2. pi-desk 前端基于 Vue 3 + TypeScript，采用 `vue-ts-spec`。
3. 修改全局 `~/.pi/agent/AGENTS.md` 或产品内置提示前，按 `docs/agent-instruction-layers.md` 判定归属；pi-desk 专有规则不得写入全局文件。
4. 使用 pi-setup（`/skill:pi-skill-setup`）同步 `~/.pi/agent` 时的约束与排障：
   - 同步前退出 pi-desk（或结束该项目的会话运行实例），同步后重启应用再开会话。SDK 宿主不热切换 agentDir，运行中改写 `AGENTS.md`／`extensions`／`skills` 会触发 `SESSION_RECOVERY_REQUIRED`（「SDK 上下文不可继续复用」）。
   - 报 `SESSION_BIND_FAILED`（「SDK 会话或必要交互绑定失败」，点「重新打开」反复失败）时，看失败区的资源诊断（同样写入主进程 stderr；`lastErrorDetail` 带原始一句）：`copy-outdated` / `copy-modified` 表示 `~/.pi/agent` 下的部署副本与本机产品版本不同，桌面已排除该副本并改用产品内置扩展，副本继续给终端 CLI 用，**不要改名或删除任何文件**；只有 `tool-conflict` 会阻止建立会话，表示某个非产品扩展注册了产品的必需工具名。身份按组件形状判定（`extensions/pi-memory/index.ts` 这类同名目录与同名入口即认定为同一组件）：组成文件缺失、内容不同或部署登记缺失都按 `copy-outdated` / `copy-modified` 排除并给出诊断，不会阻止建立会话；`config.json` 等本地配置不参与判定。部署标记 `~/.pi/agent/.pi-desk-deployments.json` 只用于区分「版本不同」与「部署后被改过」，缺失或损坏时按内容比对降级。
