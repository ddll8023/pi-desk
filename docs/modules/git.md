# Git

模块 ID：`git`。返回 [总览](../项目结构文档.md)。

## 职责与入口

负责当前项目对应仓库的状态、工作区／暂存区差异、提交历史、提交详情与差异、暂存／取消暂存／恢复、提交、拉取和推送。入口为右侧“源代码管理”页签、文件动作和历史视图。

不自行实现 Git 存储，不创建隔离工作树，不替 Agent 的 Git 操作做事务管理。项目目录与仓库根可能不同，路径折算由主进程完成。

## 专属文件

| 文件 | 用途 |
| --- | --- |
| `src/main/git/git-service.ts` | 仓库操作用例、路径折算、状态／差异／历史及写动作结果 |
| `src/main/git/git-command.ts` | 固定命令参数、外部 git 执行、输出限制、超时与错误 |
| `src/main/git/git-repository.ts` | 仓库根与上下文、仓库状态和项目路径边界 |
| `src/main/git/git-status-parser.ts` | porcelain v2 增量状态解析 |
| `src/main/git-status-parser.test.ts` | 现有分块、重命名、冲突与路径解析用例 |
| `src/main/git/git-history-parser.ts` | 提交历史及提交文件清单解析 |
| `src/main/git-history-parser.test.ts` | 现有历史字段、重命名和二进制记录用例 |
| `src/shared/git-api.ts` | 状态、差异、历史、写操作请求及校验 |
| `src/renderer/src/stores/git-status.ts` | 状态跟踪、差异、写动作及待信任重试 |
| `src/renderer/src/stores/git-history.ts` | 历史分页、提交详情与提交内差异 |
| `src/renderer/src/services/git.ts` | Git 固定桥接方法 |
| `src/renderer/src/git-diff.ts` | 前端行级差异展示模型 |
| `src/renderer/src/git-diff.test.ts` | 现有行差异与大文件退化用例 |
| `src/renderer/src/components/GitPanel.vue` | 状态分组、差异入口与源代码管理主体 |
| `src/renderer/src/components/GitCommitActions.vue` | 提交、拉取、推送及操作反馈 |
| `src/renderer/src/components/GitDiffView.vue` | 文件差异展示 |
| `src/renderer/src/components/GitHistoryView.vue` | 提交列表与详情入口 |

状态解析与现有用例、模块注册、Store 调用及主进程职责由读取和静态引用建立；仓库实际状态和外部 git 的行为不是文档映射结果。

## 公共与跨模块引用

- [F-assembly](shared.md#f-assembly进程与页面组装混合)：`registerGitHandlers` 的调用者／请求校验及 `requireGitWriteTrust`；preload 固定方法与 App 信任回路。
- [应用外壳](app-shell.md)：`RightPanel.vue` 启动状态跟踪并切换文件／Git 页签，角标不依赖当前页签是否展示。
- [文件](files-editor.md)：目录变化事件触发状态重读，文件内容与打开编辑仍归文件模块。
- [项目与信任](projects-trust.md)：当前项目决定仓库上下文；写动作复核项目信任。
- [F-ui](shared.md#f-ui前端共享展示共享)、[F-style](shared.md#f-style全局主题与业务样式混合)：公共确认、按钮、菜单、差异和状态样式。

## 调用链与状态

1. 右侧面板初始化 Git Store，按项目和目录变化跟踪状态；页面只持有展示副本。
2. 服务传递项目内相对路径、差异区域或受限提交标识，主进程定位仓库并折算路径，页面不提交任意 git 参数。
3. 读取状态／差异／历史走各自解析和展示模型；写动作成功返回新的状态，页面不自行拼凑仓库真相。
4. 写动作遇到信任拦截时保留意图，通过统一信任交互决定后重试；错误通过动作状态展示。

## 数据与安全边界

状态缓存和差异模型在内存；真源是项目所在仓库。暂存、恢复、提交、拉取和推送可以改变索引、工作区、引用或远端，不能视作普通展示刷新。

写操作可能执行仓库 filter、hook 或 merge driver，因此在主进程做信任拦截。信任不提供并发隔离，同项目的 Agent、其他会话和外部程序仍可同时修改仓库。未安装 Git、非仓库和命令失败由契约区分，不把空态伪装成成功仓库状态。
