# 项目级工作规则 (pi-desk)

1. 本仓库需兼容 macOS (zsh) 与 Windows (cmd/PowerShell)，路径处理兼容 POSIX 与 Windows 反斜杠。Python 命令按以下顺序选择环境，且仍受执行权限限制：
   - 优先使用项目虚拟环境：macOS/Linux 为 `.venv/bin/python`，Windows 为 `.venv/Scripts/python.exe`；
   - 存在环境变量 `PYTHON` 或 `PI_PYTHON` 时按指定路径使用；
   - 不存在项目虚拟环境时使用系统 PATH 中的 `python3` 或 `python`。
2. pi-desk 前端基于 Vue 3 + TypeScript，采用 `vue-ts-spec`。
3. 修改全局 `~/.pi/agent/AGENTS.md` 或产品内置提示前，按 `docs/agent-instruction-layers.md` 判定归属；pi-desk 专有规则不得写入全局文件。
4. pi-setup（`/skill:pi-skill-setup`）只部署全局用户规则 `AGENTS.md` 与用户级技能目录，不部署扩展或记忆组件：
   - 桌面端使用自己的 agent 目录（`<userData>/agent`，便携态 `data/agent`），只以只读方式加载共享目录（默认 `~/.pi/agent`）的 `AGENTS.md` 与 `skills/`；Skill 门禁、记忆扩展与 `memory` Skill 由随包资源提供。
   - 目标机的 `~/.pi/agent/extensions/pi-memory`、`extensions/skill-guard`、`skills/memory` 与 `.pi-desk-deployments.json` 属旧部署残留，桌面不读取，按清单删除；不要根据这些目录判断能力是否可用。
   - 两份规则模板由本仓库 `npm run skill-setup:sync` 从本机 `~/.pi/agent/AGENTS.md` 生成，`npm run skill-setup:sync -- --check` 只比对；产品 agent 目录与首启导入见设置页「Pi 资源 → Pi 运行目录」。
