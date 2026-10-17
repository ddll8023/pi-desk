# 右侧栏 Git（源代码管理）方案调研

> 目标：在 pi-desk 的右侧栏里增加 Git 能力（改动列表、暂存、提交、diff、分支与远端状态），做法参考 Orca。
> 本文先拆 Orca 的实现（有代码出处），再对照 pi-desk 现状给出可落地的分阶段方案。
> 调研对象：本机 `/Applications/Orca.app`（Electron 应用）。其 `app.asar` 内的 `out/shared`、`out/main`、`out/preload`、`out/renderer` 是可读的构建产物，`app.asar.unpacked/out/shared` 下的 Git 模块是未混淆的 CJS，可以直接当设计文档读。

---

## 0. 结论先行

Orca 的做法可以概括成七句话：

1. **位置**：Git 不是一个独立窗口，而是右侧栏的一个**页签**（`rightSidebarTab: 'explorer' | 'source-control'`），和文件树并列，共用同一套宽度/折叠状态。
2. **唯一入口在主进程**：渲染端只调 `window.api.git.*`，主进程有 37 个 `git:*` 通道（`git:status`、`git:diff`、`git:stage`、`git:commit`、`git:push`、`git:history`……），Git 的进程、超时、并发、缓存、路径校验全在主进程。
3. **状态读取用一条命令 + 流式解析**：`git -c core.quotePath=false status --porcelain=v2 --branch --untracked-files=all`，边读边解析（不是等整个 stdout），并**硬上限 1000 条**改动。
4. **把「读」当成昂贵的共享资源来调度**：同 key 并发读合并成一次（读租约）、全局准入调度（general/network/route 三档预算 + interactive 插队额度）、每个仓库一把操作锁（写操作串行）、读命令 120s 超时。
5. **行数统计（+/-）是二等公民**：先出状态列表，行数另算且**带身份校验的缓存**（head + 条目指纹，TTL 2 分钟），未跟踪文件按 2MB / 并发 8 上限数行。
6. **写操作全部走「路径校验 + 单文件/批量」两条 API**，丢弃未跟踪文件额外做 realpath 越界校验；提交前校验非空，提交信息可由 AI 流式生成并可取消。
7. **刷新靠文件监听 + 代际令牌**：`fs:watchWorktree` 推送批量 `fs:changed`，渲染端防抖后拉状态，并用 strict/automatic 两代计数丢弃过期响应；超大仓库直接降级（关监听、提示加 `.gitignore`）。

对 pi-desk 的适配结论（详见第 5 节）：

- 右侧栏加**两个页签**（文件 / 源代码管理），页签选择进 `UiPreferences`；
- 新增 `src/shared/git-api.ts` 契约 + `src/main/git-service.ts`（或 `git-*.ts` 一组）+ preload 的 `window.desktop.git*` 命名空间，风格与现有 `project-file-api` 完全一致（`{ok,data}|{ok,error}` 信封 + 可信调用者校验）；
- P0 只做**只读 + 暂存/取消暂存/提交/丢弃 + 单文件 diff**，命令用 `status --porcelain=v2 -z --branch`，解析器单独成模块并配单元测试（照抄 Orca 的 `git-status-porcelain-parser` 结构）；
- 并发上不需要 Orca 的准入调度（pi-desk 同时只有一个项目、没有远端 runtime），但**读租约（同 key 合并）+ 每仓库操作锁 + requestToken 取消 + 超时**这四件必须做，否则「轮询 + 用户点操作」会互相踩；
- 行数统计、分支比较、AI 提交信息、diff 内联批注是 P1/P2，按需增量；
- **信任边界**：`commit` / `checkout` / `pull` 会执行仓库里的 hook 与 filter，pi-desk 已有 `TRUST_REQUIRED` 与 TrustDialog，应在写操作上复用。

---

## 1. 调研方法（可复现）

```bash
# 1) 列出 asar 内文件（app.asar 头部是 JSON 清单）
#    偏移量 = 数据区起点(16 + header 长度) + 条目 offset
# 2) out/shared 与 out/main/chunks 是 unpacked 的，直接可读：
ls /Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/shared | grep '^git' | wc -l   # 82
# 3) preload 未混淆，API 面一目了然：
grep -n "const gitApi" -A 40 /tmp/orca-x/out/preload/index.js
# 4) 主进程 handler 与 Git 实现集中在 out/main/index.js（9.1MB，变量名压缩但逻辑可读）
# 5) UI 文案在 out/renderer/assets/zh-*.js 的 "SourceControl":{...} 命名空间
```

Orca 里与 Git 相关的模块规模：`out/shared/git-*.js` **82 个**，`git:*` IPC 通道 **37 个**，渲染端面板 `SourceControl-*.js` 单文件 335KB（压缩后）。这说明它的复杂度主要不在 UI，而在**主进程的 Git 运行时**。

---

## 2. Orca 的信息架构（右侧栏）

### 2.1 页签而不是独立面板

渲染端状态里直接能看到：

```
rightSidebarOpen / rightSidebarTab / rightSidebarEffectiveTab / rightSidebarExplorerView
```

`rightSidebarEffectiveTab` 的取值出现 `explorer` 与 `source-control`（见 `out/renderer/assets/useEditorExternalWatch-*.js` 中的 watcher 目标计算：只有当前页签是 `explorer`+`files` 或 `source-control` 时才装文件监听）。也就是说：

- 文件树与 Git 面板**共用一列**，切换页签即切换内容；
- 只有当前可见的面板才装监听/拉数据，避免后台浪费；
- 文件树内部还有二级视图（`rightSidebarExplorerView: 'files' | ...`），Git 面板内部也有「列表 / 树」两种展示（i18n: `以列表查看` / `以树形查看`）。

### 2.2 Git 面板的结构（从 i18n 反推，`zh-*.js` → `"SourceControl":{...}`）

| 区域 | 内容 |
| --- | --- |
| 分支头 | 当前分支（monospace 截断 + tooltip）、detached HEAD 徽标、`领先/落后 {{ref}} N 个提交`、`更改基础参考`、`刷新分支比较`、`比较` |
| 分组 | `冲突` / `已暂存的更改` / `更改` / `未跟踪文件`，分组顺序可配置（`sourceControlGroupOrderTitle`：更改优先 / 已暂存优先 / 未跟踪优先） |
| 行 | 文件名 + 状态色 + `+N −M` 行数 + 目录聚合（文件夹行的 `暂存文件夹` / `丢弃文件夹` / `删除文件夹中未跟踪的内容`） |
| 批量 | `暂存全部` / `全部取消暂存` / `全部丢弃` / `删除所有未跟踪的` |
| 提交框 | 提交信息输入、`使用 AI 生成提交信息`（生成中可 `停止生成`）、`提交`、`提交被阻止`（说明原因）、失败后 `使用 AI 修复提交失败`（选 agent 拉起） |
| 远端 | `推送` / `拉取` / `获取` / `推送到 fork` / `创建 PR`（含生成标题与描述）、`合并` / `变基` / `中止合并` / `中止变基` |
| 空态 | `源代码管理仅适用于 Git 存储库`、`选择一个工作区以查看更改` |
| 降级 | `检测到过多更改。仅显示前 {{value0}} 项。`、`此存储库的活动更改过多。是否将 "{{value0}}" 添加到 .gitignore？`、`已省略更多子模块更改` |
| 冲突 | 7 种冲突类型的文案（`双方都修改`、`双方都添加`、`我们删除`、`对方删除`、`我们添加`、`对方添加`、`双方都删除`）、`未解决` / `已在本地解决`、`评审冲突`、`用 AI 解决` |
| 历史/详情 | 提交历史图、提交详情、`提交哈希`/`提交信息`、`在浏览器中打开提交`、`复制所有笔记`、diff 内联批注（`将鼠标悬停在差异视图中的一行上，然后单击 + 添加注释`） |

注意两个设计取向：

- **空态/降级都有明确文案**，不出现「一片空白」；
- **AI 只做「提交信息」与「修失败」两件事**，且都能取消、都能看完整提示词再启动（`启动智能体前请查看并编辑完整提示词。`）。

---

## 3. 主进程：契约与运行时

### 3.1 IPC 面（`out/preload/index.js`，未混淆）

```js
const gitApi = {
  status, cancelStatus, setStatusUpstreamRefWatch, submoduleStatus,
  checkIgnored, findHugeFoldersToIgnore, appendGitignore,
  history, conflictOperation, abortMerge, abortRebase,
  diff, branchCompare, commitCompare, upstreamStatus,
  fetch, syncFork, push, pull, fastForward, rebaseFromBase,
  branchDiff, commitDiff,
  commit, generateCommitMessage, discoverCommitMessageModels, cancelGenerateCommitMessage,
  generatePullRequestFields, cancelGeneratePullRequestFields,
  stage, bulkStage, unstage, bulkUnstage, discard, bulkDiscard,
  remoteFileUrl, remoteCommitUrl
}
```

渲染端全部是 `invoke('git:xxx', args)`，**没有一条通道接受「任意 git 参数」**——每个操作都是语义化的窄接口。这是安全设计的关键：渲染端不能构造 `git -c ...`。

每个 handler 的形状都一样（`out/main/index.js`，`git:status` 附近）：

```js
ipcMain.handle('git:status', async (event, request) => {
  const lease = cancellations.begin(event.sender.id, request.requestToken)
  const options = {
    includeIgnored: request.includeIgnored ?? false,
    admissionTier: request.admissionTier ?? 'status',   // 'status' | 'interactive'
    includeLineStats: request.includeLineStats !== false,
    reuseLineStats: request.reuseLineStats === true,
    branchLineTotalMergeBase: request.branchLineTotalMergeBase,
    bypassEffectiveUpstreamNegativeCache: request.bypassEffectiveUpstreamNegativeCache === true,
    ...(lease ? { signal: lease.signal } : {})
  }
  try {
    // connectionId 分支 = 远端/SSH runtime 的 Git 提供者；本地则直接跑
    return await getGitStatus(worktreePath, options)
  } finally { lease?.finish() }
})
ipcMain.handle('git:cancelStatus', (event, req) => cancellations.cancel(event.sender.id, req.requestToken))
```

要点：**每个请求带 `requestToken`，可被下一条请求取消**（同一 sender 只保留最新一次状态读取）。

### 3.2 状态读取（整个方案的心脏）

`out/main/index.js` 里 `mBt()` 的实现（变量名压缩，逻辑完整）：

```js
const args = ['-c', 'core.quotePath=false', 'status', '--porcelain=v2', '--branch', '--untracked-files=all']
if (includeIgnored) args.push('--ignored=matching')

const parser = new StatusPorcelainParser()
await runGitStreaming(args, {
  cwd, admissionTier, signal,
  env: gitEnv(),
  onStdout: chunk => parser.update(chunk, limit)     // 流式；超过 limit 就停掉进程
})
```

解析器 `out/shared/git-status-porcelain-parser.js`（未混淆，可直接照抄结构）：

- `# branch.oid` → `head`；`# branch.head` → `refs/heads/<name>`（`(detached)` 时置空）；
- `# branch.upstream`、`# branch.ab +N -M` → upstream 名与 ahead/behind；
- `1 XY sub mH mI mW hH path` → 按 X/Y 拆成 **staged / unstaged 两条 entry**（`.` 表示该侧无改动）；
- `2 XY ... path\torigPath` → 重命名/复制，带 `oldPath`，同样可拆两条；
- `? path` → `area: 'untracked'`；
- `! path` → 只收集进 `ignoredPaths`，不进列表；
- `u XY ... path` → 冲突行，**不进 entries**，压入 `unmergedLines` 交给异步解析（因为需要读 worktree 判断文件是否还存在）；
- 子模块 `sub` 字段（`SCMU`）→ `commitChanged / trackedChanges / untrackedChanges`；
- 超过 `limit` 时返回 `{ didHitLimit: true, statusLength }`，由 UI 显示「仅显示前 N 项」。

冲突条目单独一个模块 `git-status-conflict-entries.js`：

```js
UU both_modified | AA both_added | DD both_deleted | AU added_by_us
UA added_by_them | DU deleted_by_us | UD deleted_by_them
```

子模块冲突（mode `160000`）直接返回 `null`（v1 明确不支持），并且用 porcelain 已经给出的 `mW` 判断文件是否存在（`000000` = 不在工作区），**避免为每条冲突再做一次 stat**（WSL/远端场景每次 stat 都是网络往返）。

`git:conflictOperation` 用来判断「当前仓库正处在什么操作中」，决定是否显示「中止合并/中止变基」：

```js
const dir = await gitCommonDir()  // 支持 worktree：用 --git-common-dir
merge    = exists(dir/MERGE_HEAD)
rebase   = exists(dir/rebase-merge) || exists(dir/rebase-apply)
cherry-pick = exists(dir/CHERRY_PICK_HEAD)
```

### 3.3 并发与稳定性（这部分最值得抄）

| 机制 | 文件 | 做了什么 |
| --- | --- | --- |
| 读租约 | `git-status-read-lease-owner.js` | 同一个 key（cwd+选项指纹）的并发读**合并成一次 git 调用**；最后一个租约释放时才 abort；有 `maxInFlightMs` 超时后「脱离」让后续重试 |
| 准入调度 | `git-admission-scheduler.js` + `git-admission-state.js` | `general` 预算 `clamp(parallelism-4, 2..4)`、`network` 3、每 route 2；各带 headroom（2/1/1）供 `interactive` 插队；等待超过 15s 的请求**按档位老化提升**；全局最多 10 个 git 子进程 |
| 命令分级 | `git-command-classification.js` | 判定 `read` / `network` / `write`，决定走直连还是登录 shell（WSL 下读命令不启 shell，避免 rc/motd 污染 stdout）、决定超时 |
| 操作锁 | `git-operation-lock.js` | 按 lane（仓库）串行，前一个失败也放行；signal 可中断排队 |
| 超时 | `git-command-timeout.js` | 读命令默认 **120s**；写/网络命令不设默认超时（可能等凭据） |
| diff 单飞+缓存 | `out/main/index.js` `PBt/FBt` | `qb.run(key, ...)` 同 key 单飞；`Jb` LRU 按（路径, staged, head）缓存可复用的 diff 结果 |
| 传输预算 | `git-diff-transport-budget.js` | 远端链路下 diff 的 `originalContent+modifiedContent` 序列化后超预算直接抛 `diff_too_large`，而不是把几十 MB 塞进 RPC |

### 3.4 行数统计（`+N −M`）与未跟踪文件

- staged / unstaged 分别跑 `git diff --numstat -M -z`（staged 加 `--cached`），用 `-z` 避免重命名路径的 `old => new` 歧义；
- 未跟踪文件**直接读文件数换行符**（`git diff --no-index` 太贵），限制单文件 **2MB**、并发 **8**；
- 缓存 `git-status-line-stats-cache.js`：key = `worktree + wslDistro`，value = 条目身份指纹 + stats 数组，**TTL 2 分钟**、最多 128 个仓库；身份指纹包含 `path/status/area/oldPath/conflictKind/...`，**但不含 added/removed**（否则永远不会命中）；
- 提供 `reuseLineStats: true` 让「轮询」复用上一次统计，只有 `head` 或条目身份变化才重算；
- 分支相对 base 的总行数（`branchLineTotal`）单独算并绑定 `mergeBase`，base 变了就不复用。

TTL 存在的理由写在注释里：**当文件内容变化但 porcelain 身份没变（仍是 `modified`）时，唯一的兜底就是 TTL**。

### 3.5 写操作与路径安全

```js
ipcMain.handle('git:stage',   (e, { worktreePath, filePath }) => stageFile(worktreePath, resolveInside(worktreePath, filePath), ctx))
ipcMain.handle('git:unstage', ...)
ipcMain.handle('git:discard', ...)
ipcMain.handle('git:bulkStage',   (e, { filePaths, scope }) => ...)  // scope: all | folder | 单文件列表
ipcMain.handle('git:bulkUnstage', ...)
ipcMain.handle('git:bulkDiscard', ...)
ipcMain.handle('git:commit', (e, { message }) => {
  if (typeof message !== 'string' || message.trim() === '') throw new Error('Commit message is required')
  ...
})
```

- 所有写操作 `admissionTier: 'interactive'`（可插队，但仍受 headroom 限制）；
- 丢弃未跟踪文件走 `git-discard-path-safety.js`：`realpath` 后必须仍在 worktree 内（含大小写/符号链接展开），最近的已存在父目录也要校验；并发 16；`ENOENT` 视为已删除而不报错；
- 暂存/取消暂存用 pathspec 从 stdin 传入（`git-pathspec-stdin.js`），避免命令行长度上限与特殊字符。

### 3.6 分支、远端、历史

- `git:upstreamStatus` 单独一条通道（不混在 status 里），有 **negative cache**（远端不可达时不要在每次轮询重试）；
- `git:setStatusUpstreamRefWatch` 用 `git for-each-ref` 盯着当前分支的 upstream ref，变了才推；
- `git:history`：`git log --no-show-signature --no-color --format=<多字段，%x1f 分隔> -z --topo-order --decorate=full -n<limit+1>`，`hasMore` 用多取一条判断；同时算 `mergeBase` 与 `hasIncomingChanges/hasOutgoingChanges`；
- `git:branchCompare` 走 base ref 选择（`compareAgainstUpstream` 设置：仓库默认 / 分支上游），`git:commitCompare` 走两个 oid 的 `--raw --numstat -z -M -C`（`git-change-list.js`）。

### 3.7 刷新策略（渲染端）

`out/renderer/assets/git-status-refresh-*.js` 里两个概念：

- **strictGeneration / automaticGeneration**：strict 用于「用户主动刷新」（优先级最高），automatic 用于轮询；每次刷新带上一代的 generation，回调里用 `isCurrent(order)` 判断，过期就丢弃（不会用旧数据覆盖新数据）；
- **admissionTier**：轮询用 `status` 档，用户点「刷新」/刚做完写操作用 `interactive` 档（可占用 headroom），并可 `bypassEffectiveUpstreamNegativeCache`。

文件变化 → 刷新的链路：`fs:watchWorktree` → 主进程批量 `fs:changed`（含 `overflow` 语义）→ 渲染端防抖（树刷新 150ms trailing / 500ms maxWait，见 `Le({refreshTree, refreshDir, trailingMs, maxWaitMs})`）→ 拉 `git:status`。

巨大仓库降级：`gitStatusHugeByWorktree` 为真时**不装监听、不轮询**（只在用户手动刷新时读），并给出「加入 .gitignore」的建议（`git:findHugeFoldersToIgnore` 只检查 `node_modules/.next/dist/build/target/vendor` 这类已知目录，且用 `git:checkIgnored` 排除已忽略的）。

---

## 4. pi-desk 现状与差距

### 4.1 现状

| 维度 | pi-desk 现状 |
| --- | --- |
| 右侧栏 | `RightPanel.vue` 只有「文件树」一种内容；头部是项目名 + 刷新按钮；宽度/折叠存 `UiPreferences`（`rightPanelOpen` / `rightPanelWidth`，240–720px） |
| 面板内容 | `FileTreeView.vue`（查找 + 懒加载目录树 + 拖到终端 + 右键菜单 `FileTreeMenu.vue`） |
| IPC 模式 | `src/shared/*-api.ts`（通道常量 + 类型 + `is*Result` 校验）→ `src/preload/index.ts`（`contextBridge` 暴露窄接口）→ `src/main/index.ts` 的 `handle(...)`（含 `isTrustedCaller` + 参数校验 + `{ok,data}\|{ok,error}` 信封）→ `src/renderer/src/services/*.ts`（桥接缺失/异常收敛）→ pinia store → 组件 |
| 已有 git 用法 | 只有 `src/main/project-file-index.ts` 的 `git ls-files -co --exclude-standard -z`（失败退化为遍历）；无 Git 服务、无状态、无 watcher |
| 进程 | `execFile`（`project-file-index`）、`cross-spawn`（受管脚本）；`shell-path.ts` 已在启动时把登录 shell 的 PATH 合并进 `process.env`，所以 `git` 一般可直接找到 |
| 信任 | `TrustManager` + `TRUST_REQUIRED` + `TrustDialog`（只针对 `.pi` 下的受保护资源） |
| 项目模型 | **一次只有当前一个项目**（无 worktree、无远端 runtime）→ 缓存 key 可以简化成项目路径 |

### 4.2 差距清单

1. 右侧栏没有页签容器 → 需要加 tab（并持久化选中页签）。
2. 没有 Git 运行时 → 需要新增主进程 Git 服务（命令封装、超时、锁、取消）。
3. 没有文件监听 → 刷新只能手动（`RightPanel.vue` 的刷新按钮）。
4. 没有 diff 组件 → `CodeMirrorEditor.vue` 是单文档编辑器，`@codemirror/merge` 未安装（依赖表里只有 `@codemirror/{commands,language,language-data,state,view}`）。
5. 错误码族没有 Git 语义（`DesktopErrorCode` 只有 `FORBIDDEN/INVALID_REQUEST/INTERNAL_ERROR/INVALID_RESPONSE/BRIDGE_*/TRUST_REQUIRED/CONFLICT`）。

---

## 5. 推荐方案

### 5.1 分层与文件落位（对齐现有约定）

```
src/shared/git-api.ts                 通道常量 + 请求/响应类型 + is*Result 校验 + 上限常量
src/main/git-command.ts               跑 git：execFile + 超时 + 环境 + abort + stderr 归错
src/main/git-status-parser.ts         porcelain v2 解析（纯函数，可单测）
src/main/git-repository.ts            仓库探测（rev-parse --show-toplevel / --git-common-dir）
src/main/git-service.ts               status/stage/unstage/discard/commit/diff/history/conflict
src/main/index.ts                     registerGitHandlers(pageUrl)
src/preload/index.ts                  window.desktop.git*（窄接口）
src/renderer/src/services/git.ts      桥接收敛（复用 unavailable/callFailed 写法）
src/renderer/src/stores/git-status.ts 状态、分组、刷新代际、选中项
src/renderer/src/components/GitPanel.vue        面板容器（页签内容）
src/renderer/src/components/GitChangeList.vue   分组 + 行 + 批量操作
src/renderer/src/components/GitCommitBox.vue    提交信息 + 提交
src/renderer/src/components/GitDiffView.vue     单文件 diff
src/renderer/src/components/RightPanelTabs.vue  文件 / 源代码管理 页签
```

**不要**引入 `simple-git` / `isomorphic-git`：前者只是 `execFile` 的薄包装（但会带一堆默认参数与事件），后者性能与行为都和真实 git 有差异。Orca 自己就是裸 `execFile` + 自写解析器，pi-desk 保持一致。

### 5.2 契约草案（`src/shared/git-api.ts`）

```ts
export const GIT_STATUS_CHANNEL = 'desktop:git-status'
export const GIT_DIFF_CHANNEL = 'desktop:git-diff'
export const GIT_STAGE_CHANNEL = 'desktop:git-stage'
export const GIT_UNSTAGE_CHANNEL = 'desktop:git-unstage'
export const GIT_DISCARD_CHANNEL = 'desktop:git-discard'
export const GIT_COMMIT_CHANNEL = 'desktop:git-commit'
// 冲突操作探测并入状态结果（GitStatus.conflictOperation），不单开通道。
export const GIT_HISTORY_CHANNEL = 'desktop:git-history'
export const GIT_BRANCH_COMPARE_CHANNEL = 'desktop:git-branch-compare' // P2

/** 改动条目上限：与 Orca 同口径，超出只显示前 N 条并明说。 */
export const GIT_STATUS_LIMIT = 1000
/** 提交信息长度上限，主进程与页面共用。 */
export const GIT_COMMIT_MESSAGE_MAX_CHARS = 5000
/** 单文件 diff 文本上限；超出按「过大」返回而不是截断。 */
export const GIT_DIFF_MAX_BYTES = 2 * 1024 * 1024

export type GitArea = 'staged' | 'unstaged' | 'untracked'
export type GitChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked'
export type GitConflictKind =
  | 'both_modified' | 'both_added' | 'both_deleted'
  | 'added_by_us' | 'added_by_them' | 'deleted_by_us' | 'deleted_by_them'

export interface GitChangeEntry {
  readonly path: string            // 项目内 POSIX 相对路径
  readonly area: GitArea
  readonly status: GitChangeStatus
  readonly oldPath?: string
  readonly conflictKind?: GitConflictKind
  readonly added?: number          // 行数统计；P0 可为 undefined
  readonly removed?: number
}

export interface GitStatus {
  readonly projectPath: string     // 与 project-file-api 同口径：迟到响应据此丢弃
  readonly isRepository: boolean
  readonly head: string | null     // oid
  readonly branch: string | null   // 'refs/heads/main'
  readonly detached: boolean
  readonly upstream: { readonly name: string; readonly ahead: number; readonly behind: number } | null
  readonly entries: readonly GitChangeEntry[]
  readonly truncated: boolean
  readonly totalCount: number
  readonly conflictOperation: 'merge' | 'rebase' | 'cherry-pick' | null
  readonly generatedAt: number
}

export type GitStatusResult = { ok: true; data: GitStatus } | { ok: false; error: DesktopError }
```

diff 用**结构化**返回，而不是让页面解析补丁文本：

```ts
export interface GitDiff {
  readonly path: string
  readonly area: GitArea
  readonly kind: 'text' | 'binary' | 'unsupported'
  readonly originalText: string | null   // 暂存区/HEAD 侧；新增文件为 null
  readonly modifiedText: string | null   // 工作区侧；删除文件为 null
  readonly eol: 'lf' | 'crlf'
  readonly truncated: boolean
}
```

（与 `project-file-api` 的 `ProjectFileTextContent` 保持同一套 `eol/bom` 约定，方便复用编辑器。）

### 5.3 命令与解析（P0 最小集）

| 操作 | 命令 | 备注 |
| --- | --- | --- |
| 是否仓库 | `git rev-parse --show-toplevel --git-common-dir` | 失败 → `isRepository: false`，UI 显示空态而不是报错 |
| 状态 | `git -c core.quotePath=false status --porcelain=v2 --branch --untracked-files=all` | 流式；超 `GIT_STATUS_LIMIT` 就 kill 子进程 |
| 冲突操作 | 读 `<git-common-dir>/MERGE_HEAD`、`rebase-merge`、`rebase-apply`、`CHERRY_PICK_HEAD` | 纯 fs 探测，便宜 |
| 单文件 diff（未暂存） | `git diff --no-color --no-ext-diff -- <path>` 或取两侧内容 | **推荐取两侧内容**（见 5.5） |
| 单文件 diff（已暂存） | `git show :<path>` vs 工作区 / `git show HEAD:<path>` | |
| 暂存 | `git add -A -- <path>` | 用 `--` 终止选项解析 |
| 取消暂存 | `git restore --staged -- <path>`（旧 git 退 `git reset -q HEAD -- <path>`） | |
| 丢弃（已跟踪） | `git restore --worktree -- <path>` | 需二次确认 |
| 丢弃（未跟踪） | 主进程 `rm`（**不**用 `git clean`），先做 realpath 越界校验 | 见 5.6 |
| 提交 | `git commit -F -`（消息走 stdin，避免引号/换行/长度问题） | 空消息拒绝 |

解析器照 Orca 的结构写（`update(chunk, limit)` 增量 + `carry` 处理跨块行），关键细节一个都不能省：

1. `-c core.quotePath=false` 让中文路径不被转义成 `\344\270\255`；
2. 仍然要处理 CRLF（`\r\n`）与 C-quoted 兜底解码；
3. `1`/`2` 记录用**空格**分字段，路径是**第 9 个字段之后剩下的全部**（路径里有空格）；`u` 记录路径在第 10 个字段之后；
4. `2` 记录 `path\torigPath` 用 **tab** 分；
5. `.` 表示该侧无改动，一条记录可能拆成 staged + unstaged 两条；
6. `!`（ignored）不进列表，只在需要时单独返回。

### 5.4 刷新策略（pi-desk 版）

分三步走，不要一上来就上文件监听：

- **P0（手动 + 触发点）**：面板可见时在「切到该页签 / 窗口 focus / 切项目 / 任一写操作成功 / 点刷新」时拉一次 `git:status`。请求带 `requestToken`，新请求取消旧请求。
- **P1（轻量轮询）**：面板可见且窗口聚焦时 `setInterval` 3s 轮询；不可见/失焦/最小化立即停（`document.visibilitychange` + `window.blur`）。轮询请求带 `reuseLineStats: true`，只有 `head`/条目身份变了才重算行数。
- **P2（文件监听）**：主进程 `fs.watch`（macOS 递归；Windows 逐目录）+ 忽略 `.git/`、`node_modules/`、`.pi/`，**250ms 防抖 + 1000ms 上限合并**，推 `desktop:git-changed` 事件；渲染端收到后仍走 P1 的防抖路径。**监听要能被「超大仓库」自动关闭**（条目数打到上限就降级为纯轮询/手动）。

代际令牌（照抄 Orca 的 strict/automatic）：

```ts
let strictGen = 0      // 用户主动刷新
let automaticGen = 0   // 轮询
function isCurrent(order: { strict: number; automatic: number }): boolean {
  return strictGen === order.strict && automaticGen >= order.automatic
}
```

### 5.5 Diff 展示（pi-desk 没有 Monaco）

三个选项，推荐 **B**：

- **A. 引入 `@codemirror/merge`**：最接近 VS Code/Orca 的体验（左右并排、行内高亮、可折叠未改动区）。代价：新依赖、要把 `CodeMirrorEditor.vue` 的主题/语言加载再抽一层、大文件需自己加上限。
- **B. 自渲染 unified diff（推荐 P0）**：主进程返回两侧文本 → 渲染端用 `diff` 算法（自写 LCS 或引入 `diff` 这个 4KB 包）算出行级差异 → 用现有的 CodeMirror 只读实例 + 装饰器上色（`added`/`removed` 背景），加「并排/统一」切换。好处：零新框架依赖、和现有编辑器主题一致、性能可控。
- **C. 只显示 `git diff` 原文**：最省事但体验差（无折叠、无语法高亮、配色难统一）。

无论哪种，都要有：二进制/图片提示（`kind: 'binary'`）、过大提示（`GIT_DIFF_MAX_BYTES`）、行号与「跳到文件」入口、`Cmd/Ctrl+S` 不误触发保存。

### 5.6 安全与正确性清单（必须做）

1. **路径只接受项目内相对路径**，主进程用 `resolveProjectEntryAbsolute` 同款校验（复用 `project-file-content.ts` 里的实现）；拒绝 `..`、绝对路径、盘符、NUL。
2. **丢弃未跟踪文件**：`realpath` 后必须仍在项目根内（符号链接展开后再判），最近的已存在父目录也要判；`ENOENT` 不报错。**不要**用 `git clean -fd`（范围过大且会连带忽略规则）。
3. **二次确认**：丢弃（尤其「全部丢弃」「删除所有未跟踪的」）用 `ConfirmDialog.vue`，文案写明不可恢复；提交前不做弹窗（Orca 也不做）。
4. **不拼接任意 git 参数**：每条通道对应固定 argv 模板，用户输入只作为 `--` 之后的 pathspec 或 stdin 内容。
5. **超时与杀进程**：读 120s、写/网络不设默认值但要有「取消」按钮；超时 kill 进程组（参考 `process-tree-termination.ts` 已有的做法）。
6. **信任边界**：`commit`（pre-commit hook）、`checkout`、`pull`（clean/smudge filter、merge driver）会执行仓库里的代码。pi-desk 已有 `TrustManager`，建议：**只读操作不需要信任**；写操作在项目有受保护资源且无信任决定时返回 `TRUST_REQUIRED`，复用 `TrustDialog`。
7. **git 缺失/版本过低**：`execFile('git')` 报 `ENOENT` → 明确文案「未找到 git，请先安装」；`restore --staged` 需要 git ≥ 2.23，探测失败退 `reset -q HEAD --`。
8. **不碰用户 git 配置**：只在单条命令上加 `-c`（`core.quotePath=false`、必要时 `-c core.pager=cat`），不改 `~/.gitconfig`。
9. **locale**：设 `LC_ALL=C`（或 `GIT_CONFIG_NOSYSTEM` 视需要），否则 `status`/`log` 的提示文本会随语言变化，错误映射失效（Orca 有 `git-output-locale.js` 专门处理）。
10. **子模块/符号链接**：P0 明确「不展开子模块改动、符号链接按普通文件处理并标注」，与 Orca 的 v1 边界一致，不要装作支持。

### 5.7 UI 细节（与现有组件保持一致）

- **页签条**：复用 `WorkspaceTabBar.vue` 的视觉语言（等宽、下划线/底色选中、右键菜单）；页签状态进 `UiPreferences.rightPanelTab: 'files' | 'source-control'`，`isUiPreferences` 的键白名单要同步加（现在是一串显式 `key === '...'` 判断，容易漏）。
- **分组顺序**：默认「更改 → 已暂存 → 未跟踪 → 冲突」，设置项放 `SettingsView`（Orca 也是设置项：`sourceControlGroupOrderTitle`）。
- **行交互**：单击选中并显示 diff（右侧面板内切换，不新开标签）；双击打开文件标签（复用 `workspaceTabsStore.openFileTab`）；右键菜单复用 `useAnchoredPopup` + `FileTreeMenu` 的样式类；行尾 `+N −M` 用 `tabular-nums`（Orca 的 `xi({stat})` 就是这么做的）。
- **空态**：`未选择项目` / `此项目不是 Git 仓库`（附「初始化仓库」按钮，P2）/ `没有改动` / `读取失败 + 重试`。
- **降级提示**：`仅显示前 1000 项改动`（点开说明如何加 `.gitignore`）。
- **提交框**：`textarea` + `Cmd/Ctrl+Enter` 提交 + 提交中禁用 + 失败原因就地展示（不要 toast 完就消失）。
- **与已有能力打通**：改动行可「插入到终端」（复用 `project-entry-drag.ts`）、可在会话里引用（`@path`）；提交成功后如果当前有对话标签，可以顺带把 `commit` 摘要喂给会话（P2，谨慎，避免噪音）。

### 5.8 分阶段计划

**P0（可用，约 1 个迭代）**
1. `shared/git-api.ts` + 错误码扩展（`GIT_UNAVAILABLE` / `NOT_A_REPOSITORY` / `GIT_FAILED`）；超过改动上限用 `GitStatus.truncated` 表达，不设独立错误码；
2. `main/git-command.ts`（execFile 封装、超时、abort、stderr→错误文本）+ `main/git-status-parser.ts`（纯函数 + 单测：普通改动、重命名、冲突、中文路径、CRLF、跨块）；
3. `git:status`（含冲突操作探测）/ `git:diff` / `git:stage` / `git:unstage` / `git:discard` / `git:commit`；
4. 右侧栏页签 + `GitPanel`（分组列表 + 批量暂存/取消 + 提交框 + diff 视图）；
5. 刷新：切页签 / focus / 写操作后 / 手动；`requestToken` 取消。

**P1（好用）**
6. 行数统计（numstat + 未跟踪数行，带身份缓存与 `reuseLineStats`）；
7. 轻量轮询 + 可见性/焦点门控；
8. 提交信息 AI 生成（复用 pi-desk 现有 runtime 调模型，流式 + 可取消）；
9. 历史视图（`git log` 自定义 format + 提交详情 + 提交 diff）；
10. 信任边界接入写操作。

**P2（完整）**
11. 分支操作（切换/新建）、fetch/pull/push、ahead/behind、分支比较；
12. 文件监听（防抖 + 超大仓库降级）；
13. 冲突处理（7 类冲突 + 中止 merge/rebase + 用编辑器解决）；
14. diff 内联批注 / 发送到会话；
15. 设置项：分组顺序、行数统计开关、默认 diff 布局。

### 5.9 验收清单（P0）

- [ ] 非 Git 目录：面板显示空态，不产生错误弹窗；`git` 不存在时给出可操作提示；
- [ ] 5000 个改动文件的仓库：3 秒内出前 1000 条并明确提示截断，UI 不卡（滚动流畅）；
- [ ] 中文/空格/emoji 路径：暂存、取消暂存、丢弃、diff 全部正确（无 `\344\270\255` 乱码）；
- [ ] 快速连点「刷新」10 次：只跑 1–2 次 git（读租约 + 取消生效），不出现旧结果覆盖新结果；
- [ ] 提交中同时点「丢弃」：写操作串行，互不打断，状态最终一致；
- [ ] 丢弃未跟踪的符号链接指向项目外：被拒绝并给出原因；
- [ ] 应用退出/项目切换时无残留 git 子进程（`ps` 验证）；
- [ ] `npm run typecheck` 通过，新增解析器有单测覆盖上述边界。

---

## 6. 风险与坑

| 风险 | 说明 | 对策 |
| --- | --- | --- |
| 大仓库卡死 | `status --untracked-files=all` 在 `node_modules` 未忽略时能跑几十秒 | 上限 1000 + 流式早停 + 提示加 `.gitignore`；Orca 的 `DEFAULT_GIT_STATUS_LIMIT` 注释就是为此写的 |
| 状态与磁盘不一致 | 用户改文件后未刷新，点「丢弃」把新改动丢了 | 丢弃前用 `stat` 比对 `mtime/size`（`project-file-content` 已有基线思路），不一致就要求确认 |
| CRLF/编码 | Windows 仓库、`core.autocrlf`、UTF-16 文件 | 统一按 `eol` 还原；非 UTF-8 文本按 `unsupported` 返回 |
| worktree | pi-desk 后续若支持 worktree，`.git` 是文件不是目录 | 从一开始就用 `--git-common-dir` 定位，别硬编码 `<root>/.git` |
| hooks | `commit` 会跑用户的 hook，可能很慢/交互式 | 不设默认超时 + 可取消 + 显示「正在提交」；`GIT_TERMINAL_PROMPT=0` 防卡在密码提示 |
| 网络命令 | `push/pull/fetch` 可能弹凭据或长时间无输出 | P2 再做；强制 `GIT_TERMINAL_PROMPT=0` + 明确的失败文案 + 单独的「网络」并发预算 |
| 渲染端体积 | diff 视图 + 历史 + 图标容易把首屏拖慢 | 面板与 diff 用 `defineAsyncComponent` 懒加载 |

---

## 7. 附：Orca 证据索引（便于复核）

| 主题 | 路径（相对 `/Applications/Orca.app/Contents/Resources/`） |
| --- | --- |
| 状态解析 | `app.asar.unpacked/out/shared/git-status-porcelain-parser.js` |
| 冲突条目 | `app.asar.unpacked/out/shared/git-status-conflict-entries.js` |
| 上限 | `app.asar.unpacked/out/shared/git-status-limit.js`（`DEFAULT_GIT_STATUS_LIMIT = 1000`） |
| 行数统计 | `app.asar.unpacked/out/shared/git-uncommitted-line-stats.js`、`git-status-line-stats-cache.js`（TTL 2min / 128 仓库） |
| 读租约 | `app.asar.unpacked/out/shared/git-status-read-lease-owner.js` |
| 准入调度 | `app.asar.unpacked/out/shared/git-admission-scheduler.js`、`git-admission-state.js`（general `clamp(parallelism-4,2..4)`、network 3、route 2、aging 15s、上限 10） |
| 操作锁 | `app.asar.unpacked/out/shared/git-operation-lock.js` |
| 命令分级/超时 | `app.asar.unpacked/out/shared/git-command-classification.js`、`git-command-timeout.js`（读 120s） |
| 丢弃安全 | `app.asar.unpacked/out/shared/git-discard-path-safety.js` |
| diff 预算 | `app.asar.unpacked/out/shared/git-diff-transport-budget.js` |
| 变更列表 | `app.asar.unpacked/out/shared/git-change-list.js`（`--raw --numstat -z -M -C`） |
| 历史 | `app.asar.unpacked/out/shared/git-history*.js` |
| 上游状态 | `app.asar.unpacked/out/shared/git-effective-upstream.js`、`git-upstream-status.js` |
| 主进程实现 | `app.asar/out/main/index.js`（`git:status` 的 `mBt`、diff 的 `PBt/FBt`、`conflictOperation` 的 `Fzt`） |
| preload API | `app.asar/out/preload/index.js`（`const gitApi = {...}`） |
| 渲染端刷新 | `app.asar/out/renderer/assets/git-status-refresh-*.js` |
| 面板 UI | `app.asar/out/renderer/assets/SourceControl-*.js`（335KB）+ `zh-*.js` 的 `"SourceControl":{...}` |
| 页签状态 | `app.asar/out/renderer/assets/useEditorExternalWatch-*.js`（`rightSidebarTab` / `rightSidebarEffectiveTab`） |
| 文件监听 | `app.asar/out/main/index.js`（`fs:watchWorktree` / `fs:changed`） |

---

## 8. 已实现范围（本仓库）

代码位置与设计一一对应：

| 层 | 文件 | 说明 |
| --- | --- | --- |
| 契约 | `src/shared/git-api.ts` | 9 条通道、状态/差异/历史/请求类型、响应校验，以及状态条数、diff 字节、提交信息长度、历史条数与提交文件数的上限常量 |
| 错误码 | `src/shared/desktop-api.ts` | 新增 `NOT_A_REPOSITORY`、`GIT_UNAVAILABLE`、`GIT_FAILED` |
| 命令 | `src/main/git-command.ts` | `execFile`/`spawn` 封装：固定环境（`GIT_TERMINAL_PROMPT=0`、`GIT_OPTIONAL_LOCKS=0`、`GIT_EDITOR=true`、`LC_ALL=C`）、读命令 120s 超时、中止、stderr→三类失败 |
| 解析 | `src/main/git-status-parser.ts` | porcelain v2 增量解析：分块、CRLF、C 风格转义路径、`1/2/u/?/!` 记录、上限早停 |
| 仓库 | `src/main/git-repository.ts` | `rev-parse --show-toplevel --absolute-git-dir`、`realpath` 规范化项目根、冲突操作探测、仓库↔项目路径换算 |
| 服务 | `src/main/git-service.ts` | status/diff/stage/unstage/discard/commit + history/commitDetail/commitDiff；读合并 + 写代际重读 + 每仓库写串行；丢弃走 realpath 校验后自行删除 |
| 历史解析 | `src/main/git-history-parser.ts` | `log -z`（0x1f 分字段、NUL 分记录，标题整体回拼）与 `diff-tree --raw --numstat -z`（先原始段后 numstat 段） |
| IPC | `src/main/index.ts` | `registerGitHandlers`：可信调用者校验 + 参数白名单 + 信封；写操作成功直接回传新状态 |
| 桥接 | `src/preload/index.ts`、`src/renderer/src/env.d.ts` | `window.desktop.git*` 窄接口 + 结果校验 |
| 渲染 | `services/git.ts`、`stores/git-status.ts`、`stores/git-history.ts`、`git-diff.ts` | 桥接收敛、状态/分组/选中/提交草稿、历史三层状态（列表/详情/文件差异）、行级差异计算 |
| UI | `components/RightPanelTabs.vue`、`GitPanel.vue`、`GitDiffView.vue`、`GitHistoryView.vue`、`RightPanel.vue` | 页签（持久化到 `UiPreferences.rightPanelTab`）、分支行、提交框、四组改动、行操作、就地差异视图、历史视图（列表 → 提交详情 → 文件差异） |
| 测试 | `src/main/git-status-parser.test.ts`、`src/main/git-history-parser.test.ts`、`src/renderer/src/git-diff.test.ts` | 23 个用例（分块、CRLF、重命名、冲突、中文与转义路径、上限截断、行级差异与大文件退化、日志字段与标题含分隔符、提交内文件与行数）；`npm test` |

三条与路径相关的约束：

1. **项目根必须 `realpath`**：macOS 上 `/var` 是 `/private/var` 的符号链接，git 报告的是解析后的顶层目录；不先解析，两边相减会得到一串 `..`，pathspec 直接被判成「在仓库之外」。
2. **项目是仓库子目录时**：状态命令要带 `-- <项目前缀>` 的 pathspec，条目路径再从仓库相对折算回项目相对；落在项目外的条目必须丢弃，否则界面会出现不属于本项目的文件。
3. **丢弃未跟踪文件不能只靠 `git ls-files`**：路径先经 `resolveProjectEntryAbsolute`（父目录 realpath + 包含性校验），再 `lstat` 确认不是目录，最后 `unlink` 链接本身。

### 8.1 历史与推送状态

用户能看到的「之前的提交」由 `git:history` / `git:commit-detail` / `git:commit-diff` 三条通道支撑：

- **列表**：`git log -z --topo-order --decorate=short --format=<7 个字段 + 标题> --skip=N -n<limit+1>`；
  多取一条判断 `hasMore`，翻页用 `skip`。标题放在最后一个字段并在解析时整体回拼，标题里出现任何字符都不会切错。
- **推送状态**：上游存在时用 `git rev-list --max-count=<limit> @{u}..HEAD` 得到未推送集合，逐条标 `pushed`；
  没有上游时整支分支都还没推过，`pushed` 一律为 false（页头只提示一次，不给每行挂角标）。
- **详情**：`diff-tree --root --no-commit-id -r --raw --numstat -z -M -C` 一次拿到改动文件与该次提交的行数增减；
  重命名记录的空路径后面跟着原路径与新路径，必须按 NUL 字段顺序读。
- **提交内差异**：原内容取 `<oid>^:<原路径>`（根提交或新增文件取不到就是 null），新内容取 `<oid>:<路径>`；
  重命名条目要用 `oldPath` 取原内容，否则会显示成「新文件」。
- **按文件看历史**：`history` 接受可选 `path`（项目内相对路径），命令里作为 pathspec 传给 `git log -- <path>`；
  改动行上的时钟按钮直接把历史切到该文件的过滤模式。

刻意留到后续（与第 5.8 节一致）：改动行数统计（工作区）、轮询与文件监听、AI 提交信息、分支与远端操作（fetch/pull/push、分支比较）、冲突解决流程、写操作的信任边界。其中**信任边界**是唯一带安全含义的遗留项：`commit`/`pull` 会执行仓库里的 hook 与 filter，接入时应复用 `TrustManager` 与 `TrustDialog`。
