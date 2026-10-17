# 右侧栏文件树自动刷新方案调研

> 目标：右侧栏文件树在新增、删除、重命名后不必手动刷新，做法参考成熟项目。
> 本文先拆 Orca 与 VS Code 的实现（带代码出处），再对照 pi-desk 现状给出落地方案与边界。
> 调研对象：本机 `/Applications/Orca.app`（Electron 应用，`app.asar.unpacked` 与解包后的 `out/` 可读）、
> VS Code 主干源码（`src/vs/platform/files/**`、`src/vs/workbench/contrib/files/**`）。

---

## 0. 结论先行

1. **两边都不用「定时轮询」当主方案**：都靠操作系统级文件监听（macOS FSEvents、Windows
   ReadDirectoryChangesW、Linux inotify），轮询只作为拿不到原生事件时的降级。
2. **都在主进程集中管理监听**：渲染端只声明「我想看哪里」，主进程负责按路径去重、引用计数、
   失败重试与批量推送；页面拿不到任意 channel，也拿不到绝对路径的监听权。
3. **事件必须批量**：Orca 是「尾随 150ms、自首个事件起最多 500ms 必发」，VS Code 的事件合并
   与 Explorer 500ms 反应延迟是同一个思路——一次 `npm install` 会产生成千上万条事件。
4. **变化要落到「哪一层变了」，而不是整树重读**：Orca 把事件路径映射到已加载目录、逐目录重读
   （本地并发 16）；VS Code 的 `doesFileEventAffect` 只刷新受影响的可见子树。
5. **一定要有兜底**：Orca 在 WSL 上退化为每 2s 的 `find` 快照 diff；VS Code 明确说明「操作系统可能
   丢事件」，并在窗口重新聚焦时补刷一次（issue #126817）。
6. **对 pi-desk 的适配**：树是按层懒加载的，只需要监听「已加载的那几层」，用**非递归** `fs.watch`
   逐目录监听即可，天然避开 `node_modules` 与 `.git`，也不需要引入原生依赖。

---

## 1. Orca 的做法（有代码出处）

### 1.1 通道与订阅

- IPC 面只有两条：`fs:watchWorktree`、`fs:unwatchWorktree`；推送通道是 `fs:changed`
  （`out/main/index.js` 中 `F_a` 里的 `ipcMain.handle`）。
- preload 暴露 `window.api.fs.onFsChanged(cb)`，返回取消函数；渲染端 hook 在
  `out/renderer/assets/useEditorExternalWatch-*.js`。
- 主进程按「根路径」维护监听，多个监听者共享同一个 watcher（引用计数）；最后一个订阅者离开后
  **延迟 30s** 才真正 unwatch，避免面板开合抖动造成反复重建。

### 1.2 底层实现

- 用 `@parcel/watcher 2.5.6`，跑在**独立子进程**（`app.asar.unpacked/out/main/parcel-watcher-process-entry.js`）。
- 子进程带 canary 自愈：每 10s 往临时目录写一个文件、5s 后检查是否收到事件；连续 2 次收不到就
  `process.exit(2)`，由父进程重启 watcher（处理 FSEvents 卡死）。
- 忽略目录表固定为 `.git node_modules dist build .next .cache target .venv __pycache__`，编译成
  一条正则 `^(?:[^/]+/)*(?:...)(?:/[^/]*)?$`。因为 parcel 在 darwin 上 `ignore` 只接受相对路径且数量有限，
  mac 额外传 `ignore: 前 8 项` + `ignoreGlobs`（`Iga()`）。
- 事件整形（`n_a` / `a_a` / `o_a`）：
  - 批量窗口：尾随 150ms，自首个事件起最多 500ms；
  - 同一路径连续事件去重，`create + delete` 互相抵消；
  - 每批用 8 并发 `stat` 补 `isDirectory`；
  - 单批超过 5000 条或监听溢出 → 只发一条 `{ kind: 'overflow', absolutePath: root }`；
  - `Maximum number of file watchers reached`（EMFILE）识别为容量拒绝，走退避重试。

### 1.3 渲染端如何用这批事件

- 事件路径先折算成项目内相对路径，再映射到**已加载的目录**；展开集合里没有的目录直接跳过。
- 命中目录逐个重读（本地并发 16，SSH 4），**不整树刷新**；删除的路径同时清目录缓存、展开状态与选中项。
- 只有 `overflow` 才退回整树刷新。
- 拖动、内联重命名等交互进行中先挂起刷新，结束后补一次，避免用户正在操作时列表跳动。
- 只在右侧栏打开且页签是 explorer/files 或 source-control 时才安装监听；挂起/恢复时重订阅并补一条 overflow。

### 1.4 兜底

- WSL 等拿不到原生事件的路径，退化为每 2s 跑一次
  `find "$root" -mindepth 1 -maxdepth 2 -printf '%y\t%T@\t%p\0'`，diff 前后快照产出 create/update/delete。
- 网络盘与第三方文件系统不保证事件，因此 Orca 保留了「切项目 / 页面可见 / 手动刷新」的刷新入口。

---

## 2. VS Code 的做法（有代码出处）

### 2.1 watch request 抽象

`src/vs/platform/files/common/watcher.ts`：

- 每个请求是 `{ path, recursive, excludes, includes?, correlationId?, filter? }`；`excludes` 是相对 watch root
  的 glob，`includes` 用来显式加符号链接目录（默认**不跟随**符号链接）。
- 事件先合并（`coalesceEvents`）：ADD+DELETE 互相抵消、DELETE+ADD 归一成 CHANGE、目录被删时丢弃
  其子项的 DELETE，避免一个 `rm -rf` 产生海量事件。
- watcher 崩溃最多重启 5 次；`EMFILE`/`No space left on device` 明确**不重启**，因为这需要用户改系统限制。

### 2.2 递归监听与默认排除

- 打开文件夹时用 `@parcel/watcher` 递归监听整个工作区；只打开编辑器（没有工作区）时用 Node `fs.watch`
  监听单个文件（`File-Watcher-Issues` wiki）。
- 默认 `files.watcherExclude`（`src/vs/workbench/contrib/files/browser/files.contribution.ts`）：
  `.git/objects/**`、`.git/subtree-cache/**`、`.hg/store/**` 及其 `*/` 变体。
  源码注释明确说明**刻意不写 `**` 通配**，避免生成过于复杂的正则拖慢大仓库；`node_modules` 也没有默认排除。
- Linux 上递归监听大目录可能耗尽 inotify 句柄，此时给出提示引导用户加排除项。

### 2.3 Explorer 如何消费事件

`src/vs/workbench/contrib/files/browser/explorerService.ts`：

- `EXPLORER_FILE_CHANGES_REACT_DELAY = 500`：收到文件事件后延迟 500ms 再反应，「给内部事件先落地」。
- `doesFileEventAffect(...)`：只有当事件影响当前可见子树，或影响尚未展开但已知的部分时才刷新；
  已知不影响的直接跳过。
- 窗口重新获得焦点时补一次刷新（注释指向 issue #126817），专门兜底丢事件；自动保存期间则标记
  `shouldRefreshAfterEditing`，在保存结束后再刷。

---

## 3. 三种可选路线对比

| 路线 | 覆盖范围 | 依赖 | 风险 |
| --- | --- | --- | --- |
| 逐目录非递归 `fs.watch`（本方案） | 已加载的目录层 | 无新增依赖 | 未展开的层感知不到（本来也没显示）；网络盘可能无事件 |
| 递归 `fs.watch({ recursive: true })` | 整仓库 | 无新增依赖 | 无排除能力，`node_modules`/`.git` 事件全量进入 JS，必须自己过滤 |
| `@parcel/watcher`（Orca / VS Code） | 整仓库 + glob 排除 | 原生依赖 + 子进程 + canary | electron-rebuild、asarUnpack、便携包体积与跨平台构建成本 |

pi-desk 的树是**按层懒加载**的，需要感知的只有用户真正展开的那几层，因此第一条路线足够；
等以后需要「整仓库实时 git 状态」这类能力时再升级到第三条。

---

## 4. pi-desk 现状（改动前）

- 主进程没有任何 `fs.watch`，目录数据只有拉取式 IPC `desktop:project-directory-list`。
- 渲染端缓存永不失效：`stores/project-directory.ts` 的 `ensureLoaded` 在 `phase === 'ready'` 时直接返回，
  只有右侧面板刷新按钮与切项目会调 `refresh()`。
- 同一根因牵连三处：`@` 检索走 `project-file-index.ts`（TTL 10s，无失效钩子）、git 面板只在切项目/
  窗口聚焦/页面可见/手动时拉状态、已打开文件标签只在窗口聚焦时 `stat`。

---

## 5. 落地方案

### 5.1 主进程

`src/main/project-directory-watcher.ts`：

- 页面提交「根 + 已展开目录」的相对路径集合（上限见 `PROJECT_DIRECTORY_WATCH_LIMIT`），主进程按集合 diff
  增删非递归 `fs.watch`；相对路径一律经 `normalizeRelativeDirectory` 归一，绝对路径与越界路径直接丢弃。
- 批处理沿用 Orca 的窗口策略（`WATCH_TRAILING_MS` 尾随、`WATCH_MAX_WAIT_MS` 自首个事件起的上限）；
  同一目录只报一次；批内目录达到 `WATCH_BATCH_LIMIT` 或监听出错 → 一条 `overflow`。
- 发送前对每个目录 `stat`：目录已被删除或移走时改报最近的仍然存在的父目录，并顺手摘掉失效监听。
- `EMFILE`/`ENOSPC` 视为容量不足：本次登记周期内不再重试，改发 `overflow` 让页面整树重读。
- 项目切换时整体重建；窗口关闭与退出时全部释放。

### 5.2 契约与桥接

`src/shared/project-file-api.ts` 新增 `desktop:project-directory-watch`（登记集合）与
`desktop:project-directory-changed`（推送），沿用 `{ok,data}|{ok,error}` 信封与现有校验风格；
preload 暴露 `watchProjectDirectories` 与 `onProjectDirectoryChanged`（返回取消函数）。

### 5.3 渲染端

- `stores/project-directory.ts`：面板挂载时订阅、登记监听集合并静默重读一次（卸载期间监听已停，
  离开这段时间的变化只能靠这一读补上）；变化回来只重读命中的已加载层（保留已有条目，不闪加载态），
  随后剪掉已不存在的展开目录与选中行；`overflow` 退回 `refresh()`。每层带读取代号，迟到的旧响应按代号丢弃。
- 同一条事件流顺带修三处：`ProjectFileIndex.invalidate()`（`@` 检索立刻能看到新文件）、
  `git-status` 的静默刷新、已打开文件标签的 `checkExternal`（overflow 时改为全部已打开文件各比一次）。

### 5.4 边界与未做项

- **不做递归监听**：未展开目录里的变化不会推送，需要用户手动刷新（展开或切项目时会自然读到最新）；
  与 VS Code 的「操作系统可能丢事件」同一立场。
- **文件树不在窗口聚焦时自动重读**：`git` 面板与已打开文件标签有聚焦兼底，文件树只在面板重新挂载
  与手动刷新时重读，避免每次切窗都多一轮目录读取。
- **不做 mtime 过滤**：文件内容写入也会让所在目录产生事件，因此一次保存可能带来一次多余 readdir；
  量级可忽略，等真出现噪声再按「目录 mtime 未变则跳过」优化。
- **不做轮询降级**：网络盘拿不到事件时，手动刷新已经能兜住；引入轮询需要额外的开关与
  成本约束，留到有实际反馈时再加。
- **不做原生 watcher**：见第 3 节的取舍；真要升级时按 Orca 的「子进程 + canary + 忽略表」照搬。
