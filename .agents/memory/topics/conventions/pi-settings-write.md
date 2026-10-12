# Pi settings.json 写入

### settings.json 由 PiSettingsManager 独占写入

约定：桌面端写 Pi 的 `<agent-dir>/settings.json` 只走 `src/main/pi-settings-manager.ts` 的 `PiSettingsManager`，且只改顶层 `defaultProvider` 与 `defaultModel` 两个键；其余键（主题、包声明、思考等级、changelog 版本等）原样保留；写入前比对读盘时记录的文件标识，不一致就放弃本次保存；文件无法解析时拒绝写入；写入用同目录临时文件加改名替换，新文件沿用原文件权限位。页面侧经 `shared/pi-settings-api.ts` 的契约往返，不接受任意键名或任意内容。

适用：新增任何写 `<agent-dir>/settings.json` 的路径、调整顶栏 Pi 默认模型选择，或判断「桌面端会不会改 Pi 配置」时。

原因：除 models.json（见 `models-config-write.md`）之外，settings.json 是桌面端写入的又一份 Pi 配置文件；它同时会被 Pi 进程自己写入，不看文件标识就会互相覆盖。规则细节以该模块的文件头注释为准，不在此复制常量与字段清单。
