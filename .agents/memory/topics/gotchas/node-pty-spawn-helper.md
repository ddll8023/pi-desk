# node-pty 预编译助手

### 新建终端即报「启动终端失败：<shell 路径>」，根因是上游预编译助手缺执行位

现象：开发态与出包版新建终端都失败，提示「启动终端失败：<shell 路径>」；shell 本身存在且可执行，报错文案里没有任何权限线索，容易被当成 shell 或环境变量问题排查。

根因：上游 node-pty 的预编译产物 spawn-helper 以不可执行的权限发布，而 node-pty 直接 posix_spawn 该文件；缺执行位时启动必然失败，错误被归一成与 shell 相关的文案。开发态与出包版各用自己那份 `node_modules`，两处都要修。

处置：执行 `scripts/fix-node-pty-permissions.mjs`（`npm run fix:pty-permissions`），它把当前平台与架构的 spawn-helper 置为可执行；开发启动与出包链路已各自覆盖。不为此升级到上游 beta 线。

排除：shell 缺失或不可执行、pty 原生模块未加载、架构不匹配、`pty.node` 与 Electron ABI 不符——都不是该现象的原因。
