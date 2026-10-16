# 项目记忆

## 项目范围
Pi Desktop：Electron + Vue 3 + TypeScript 桌面客户端。会话执行主链由官方 SDK 宿主（`utilityProcess`）承担，独立 Pi 二进制已退役；已覆盖项目与会话、消息投影、内置终端（PTY，与对话同处按项目分组的工作区标签组）、Project Trust、Provider 认证、Pi 资源（Skill、模板、扩展命令、MCP 配置与连接状态）、自定义供应商（models.json 的读写）、Pi 默认模型（settings.json 的读写）与 Pi 版本检查（应用与 Pi 包版本、启动提示）。

## 主题导航
- 约定：`topics/conventions/platform-neutral.md`——在编写文档、命令示例、记忆或任何生成内容，需要提及平台、路径或命令时读取。
- 约定：`topics/conventions/doc-maintenance.md`——在新增或修改 `.agents/memory/` 条目、判断某条事实该写在哪里时读取。
- 坑：`topics/gotchas/npm-lifecycle-scripts.md`——在新增依赖安装或构建准备步骤、考虑用 npm 生命周期脚本自动执行时读取。
- 坑：`topics/gotchas/electron-binary-install.md`——在重装依赖、搭建开发环境或准备出包时读取。
- 坑：`topics/gotchas/gui-verification.md`——在做真机 GUI 验证、需要驱动或截取应用窗口、或清理 dev 进程残留时读取。
- 约定：`topics/conventions/renderer-bridge-calls.md`——在新增或修改渲染端桥接方法、处理桥接失败文案时读取。
- 约定：`topics/conventions/desktop-config-storage.md`——在新增配置字段或写配置路径、考虑多实例与多窗口时读取。
- 约定：`topics/conventions/models-config-write.md`——在新增写 Pi models.json 的路径、或判断桌面端是否会改 Pi 配置时读取。
- 约定：`topics/conventions/pi-settings-write.md`——在新增写 Pi `settings.json` 的路径、或判断桌面端是否会改 Pi 配置时读取。
- 约定：`topics/conventions/pi-config-reload.md`——在新增写 Pi 配置文件的入口时读取。
- 约定：`topics/conventions/settings-page.md`——在新增或调整设置页入口时读取。
- 约定：`topics/conventions/multi-session-scope.md`——在调整侧栏、会话列表、工作区标签、宿主生命周期或输入区，或考虑给多会话加新能力时读取。
- 坑：`topics/gotchas/project-trust-probe.md`——在添加项目、准备验证用目录或遇到意外信任提示时读取。
- 坑：`topics/gotchas/dev-server-header-cache.md`——在调整开发态页面的响应头（CSP 等）或遇到 dev 下页面行为不随配置变化时读取。
- 坑：`topics/gotchas/dev-main-process-restart.md`——在 dev 会话中判断主进程改动是否已生效、准备重启 dev 进程时读取。
- 坑：`topics/gotchas/portable-package-lock.md`——在打包便携版、遇到 electron-builder 失败或 `release/` 下出现 `.tmp` 残留时读取。
- 坑：`topics/gotchas/gui-launch-path.md`——在让主进程或检查类功能调用外部 CLI（npm、git 等）时读取。
- 坑：`topics/gotchas/windows-cmd-spawn.md`——在受管脚本里启动 npm、git 等外部命令，或遇到「找不到可用的依赖命令」时读取。
- 坑：`topics/gotchas/titlebar-interaction-area.md`——在调整顶部栏、窗口拖动区或标题栏右端控件时读取。
