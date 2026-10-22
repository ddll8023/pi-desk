# 图形界面启动的 PATH

### 需要外部 CLI 的能力不能假定 npm、git 这类工具在 PATH 里

现象：在终端里能跑通的 `npm view`、`npm root -g`，在打包后由图形界面启动的应用里找不到 npm；依赖它的检查会把「命令失败」当成「没有更新」。

根因：图形界面启动的应用只拿到系统最小 PATH，不含 shell 配置里的用户路径（开发机上 npm 与 git 的安装位置就分属这两类）；从终端启动则继承 shell 环境，两种启动方式表现不同。

处置：需要外部工具的能力不要依赖 CLI 直接可用——改走 HTTP，或在结果里区分「检查失败」与「没有变化」。版本检查的取舍写在 `src/entries/update-check/index.ts` 的文件注释里。

排除：不要用终端里能跑通来推断打包后的应用也能跑通。

相关：Windows 上 npm 是 `.cmd`，Node 自带的 spawn 无法直接启动，表现为同一类「找不到命令」，见 `topics/gotchas/windows-cmd-spawn.md`。
