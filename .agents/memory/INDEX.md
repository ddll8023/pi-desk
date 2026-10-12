# 项目记忆

## 项目范围
Pi Desktop：Electron + Vue 3 + TypeScript 桌面客户端，会话后端处于迁移期：固定版本的 Pi standalone sidecar（RPC）继续服务页面，官方 SDK 宿主为迁移目标；已覆盖项目与会话、消息投影、Project Trust、Provider 认证、Pi 资源（Skill、模板、扩展命令、MCP 配置与连接状态）、自定义供应商（models.json 的读写）与 Pi 默认模型（settings.json 的读写）。

## 主题导航
- 约定：`topics/conventions/platform-neutral.md`——在编写文档、命令示例、记忆或任何生成内容，需要提及平台、路径或命令时读取。
- 约定：`topics/conventions/doc-maintenance.md`——在新增或修改 `docs/` 文档、判断某条事实该写在哪里时读取。
- 坑：`topics/gotchas/npm-lifecycle-scripts.md`——在准备二进制或资源、考虑用 npm 生命周期脚本自动执行时读取。
- 坑：`topics/gotchas/gui-verification.md`——在做真机 GUI 验证、需要驱动或截取应用窗口、或清理 dev 进程残留时读取。
- 坑：`topics/gotchas/sidecar-console-windows.md`——在排查对话启动后出现额外控制台窗口时读取。
- 约定：`topics/conventions/renderer-bridge-calls.md`——在新增或修改渲染端桥接方法、处理桥接失败文案时读取。
- 约定：`topics/conventions/desktop-config-storage.md`——在新增配置字段或写配置路径、考虑多实例与多窗口时读取。
- 约定：`topics/conventions/models-config-write.md`——在新增写 Pi models.json 的路径、或判断桌面端是否会改 Pi 配置时读取。
- 约定：`topics/conventions/pi-settings-write.md`——在新增写 Pi `settings.json` 的路径、或判断桌面端是否会改 Pi 配置时读取。
- 约定：`topics/conventions/pi-config-reload.md`——在新增写 Pi 配置文件的入口时读取。
- 约定：`topics/conventions/settings-page.md`——在新增或调整设置页入口时读取。
- 坑：`topics/gotchas/project-trust-probe.md`——在添加项目、准备验证用目录或遇到意外信任提示时读取。
