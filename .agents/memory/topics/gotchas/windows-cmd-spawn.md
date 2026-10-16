# 受管脚本里的外部命令启动

### Windows 上 npm 这类 `.cmd` 命令不能用 Node 自带的 spawn 启动

现象：内置 Pi agent 安装在 Windows 打包版上失败，报「找不到可用的依赖命令：npm」，而同一台机器的终端里 npm 正常可用。识别特征：`data/pi-runtime/releases` 已创建但没有 `staging`，说明流程走到依赖命令探测这一步就停了。

根因：Windows 上 npm 只有 `.cmd`（没有 `.exe`），Node 自带的 `spawn` 不能直接执行批处理，探测 `npm --version` 因底层启动失败而判定命令不可用。与 PATH 缺失无关。

处置：受管脚本里启动外部命令（npm、git 等）统一经 cross-spawn（项目依赖），win32 上它会解析 `.cmd` 并经 cmd.exe 启动，其他平台行为与自带 spawn 相同；这与官方 SDK 的 `spawnProcess` 处理一致。探测失败时把底层错误带进失败文案，才能归类成「缺少命令」而不是「原因未知」。

排除：不是 PATH 问题（那是另一类原因，见 `topics/gotchas/gui-launch-path.md`），也不是 npm 未安装；macOS 侧的登录 shell PATH 补齐对 Windows 不生效。
