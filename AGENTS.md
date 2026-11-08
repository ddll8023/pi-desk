# 项目级工作规则 (pi-desk)

1. 本仓库需兼容 macOS (zsh) 与 Windows (cmd/PowerShell)，路径处理兼容 POSIX 与 Windows 反斜杠。Python 命令按以下顺序选择环境，且仍受执行权限限制：
   - 优先使用项目虚拟环境：macOS/Linux 为 `.venv/bin/python`，Windows 为 `.venv/Scripts/python.exe`；
   - 存在环境变量 `PYTHON` 或 `PI_PYTHON` 时按指定路径使用；
   - 不存在项目虚拟环境时使用系统 PATH 中的 `python3` 或 `python`。
2. pi-desk 前端基于 Vue 3 + TypeScript，采用 `vue-ts-spec`。
3. 修改全局 `~/.pi/agent/AGENTS.md` 或产品内置提示前，按 `docs/agent-instruction-layers.md` 判定归属；pi-desk 专有规则不得写入全局文件。
