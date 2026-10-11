# models.json 写入

### models.json 由 ModelsConfigManager 独占写入

约定：桌面端写 Pi 的 `<agent-dir>/models.json` 只走 `src/main/models-config-manager.ts` 的 `ModelsConfigManager`，一次只改 `providers` 下被编辑的那一个条目；写入前比对读盘时记录的文件标识，不一致就放弃本次保存；文件无法解析时拒绝写入；`apiKey` 与 `headers` 的值以哨兵文本在 IPC 上往返，真实密钥不进渲染端。

适用：新增任何写 models.json 的路径、扩展自定义供应商页面，或判断「桌面端会不会改 Pi 配置」时。

原因：models.json 是除 auth.json（由官方 SDK 在认证辅助进程内写）之外第二个被桌面端写入的 Pi 配置文件，而仓库多处注释写着「不写 Pi 配置」，没有这条约定容易被误读；两个写入者共用一份配置文件在本仓库已有一次实际数据丢失先例（见 `desktop-config-storage.md`）。规则细节以该模块的文件头注释为准，不在此复制常量与字段清单。

### 自定义供应商页只做常用字段表单，高级字段交给原始 JSON

约定：自定义供应商页用表单覆盖 ID、显示名、baseUrl、api、apiKey、headers 与模型的 id/name/上下文/输出上限/推理/图片输入；compat、thinkingLevelMap、cost、modelOverrides 等字段只通过原始 JSON 编辑区维护，不为它们建全量表单控件；未托管字段在保存时原样保留。

适用：调整自定义供应商页的字段范围时。

原因：Pi 的 models.json 字段层级很深，全量表单的工作量与维护成本都过高；原始 JSON 兜底能覆盖表单之外的字段，又不必在表单里重复维护同一份 schema。
