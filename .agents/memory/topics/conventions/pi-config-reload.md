# Pi 配置生效

### Pi 配置改动只靠重启 Runtime 生效

约定：写 Pi 配置（models.json、mcp.json 等）的界面只提示「需要重启 Runtime 才会生效」，不提供就地重载按钮；需要重载时复用会话重开链路（`sessionStore.reloadCurrent()`）。

适用：新增任何写 Pi 配置文件的入口时。

原因：Pi 只在启动时读取这些文件，运行中的 Runtime 不会重新加载；在配置界面里加「重载」要引入运行中会话的停止/恢复编排，范围和风险都大于收益。
