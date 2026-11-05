# 记忆开关显示开启但保存被拒的问题调研

## 1. 现象与本文定位

用户报告：桌面全局记忆在设置页处于开启状态，但实际保存记忆时被拒绝，提示"记忆已停用；先由用户明确恢复记忆"，并且"经常出现"。

本文把该症状对应的判定链路、可能的来源、已排除的方向和仍待确认的事实记录下来，供后续单独调查。文中的依据全部是当前仓库的项目事实（标 `文件:行`）；不含外部证据，也不含修复方案。本文不构成代码修改、重载、运行或测试授权。

## 2. 判定链路

报错文案来自扩展侧的租约检查，不是文件引擎或库状态返回的结论：

1. `resources/agent/extensions/pi-memory/context.ts:112` — `lease.assert()` 在 `state.enabled` 为 false 时抛出"记忆已停用；先由用户明确恢复记忆"。`memory_search`、`memory_read`、`memory_save` 等操作都要先取租约，因此一处为假即全部被拒。
2. `resources/agent/extensions/pi-memory/context.ts:83` — `state.enabled = this.config.hostEnabled && sessionEnabled`。会话内 `/memory on` 只写 `sessionEnabled`（`context.ts:125-131` 把 `{ enabled }` 追加为会话条目，`context.ts:76-81` 从分支重放），不能改变 `hostEnabled`。
3. `resources/agent/extensions/pi-memory/context.ts:134` — `status.global_enabled` 直接等于 `config.hostEnabled`，`status.enabled` 是 `state.enabled && !closed`。本次观测到的 `enabled: false`、`global_enabled: false`、`session_enabled: true` 三者一致地指向 `hostEnabled === false`。
4. `resources/agent/extensions/pi-memory/engine.ts:158` — 受管配置下 `hostEnabled` 取自宿主传入的 `host.enabled`；该对象由主进程 `MemoryManager.configuration()` 生成（`src/main/memory/memory-manager.ts:57-59`），而 `enabled` 来自 `enabled()` 的读取结果（`memory-manager.ts:49-55`）。

结论：扩展侧只是忠实反映桌面配置里的那一个布尔值。问题域不在记忆库、不在索引，也不在会话内开关。

## 3. 「关闭」结论的三条来源

### 来源 1：持久化配置里确实是关闭

`src/main/config/desktop-config-store.ts:708-713` 的 `readMemoryEnabled()` 每次读盘后返回内存中的 `memoryEnabled`；解析时该字段缺失按开启处理（`desktop-config-store.ts:975` 的 `value.memoryEnabled !== false`），只有配置文件里明确写了 `false` 才是关闭。写入只发生在 `saveMemoryEnabled()`（`desktop-config-store.ts:716-734`，且 `readOnly` 时直接抛错不写入）和 `persist()` 的兜底合并（`desktop-config-store.ts:1043`，`undefined` 时沿用当前值），因此不存在"顺手写成 false"的路径。

特征：设置页也会显示停用，因为设置页读的就是同一个 `snapshot()`（`memory-manager.ts:77` 的 `notice` 与 `enabled` 同一次读取）。若用户看到的确实是开启，这一条需要配置文件里的字段值来确认或否定。

### 来源 2：读取抛错被静默降级成关闭

`memory-manager.ts:49-55`：

- 成功时返回 `(await store.readMemoryEnabled()).enabled`；
- 任何异常都返回 `{ enabled: false }`，并附一句"本地配置暂时无法读取，本次运行按关闭处理，不会保存开关"的 notice。

该 notice 只出现在 `snapshot()` 的返回里（`memory-manager.ts:74`，设置页在 `MemorySettingsSection.vue:119` 渲染），**不会**随配置推送给宿主。于是同一个开关可以出现两种结果：设置页（另一次读取、可能更早）显示开启，推送时刻的读取返回 false，宿主据此判定关闭。

特征：`config_revision` 不会因为这次降级而递增；设置页该次快照带 notice。

### 来源 3：开启状态没有送达正在运行的宿主

- 宿主初始化时读一次配置并随 `initialize` 下发（`src/main/sessions/sdk-host-manager.ts:876-882`）。
- 之后的变化走 `refreshMemoryConfiguration()`（`sdk-host-manager.ts:1206-1214`），但它对未就绪宿主直接 return，注释明确"未就绪宿主不补发"。通道是 `postMessage`，没有确认帧。
- 推送入口是 `MemoryManager.settleHosts()`（`memory-manager.ts:139-148`），只有 `notifyHosts()` 抛错时才把结果标成 `unconfirmed`；正常返回即认为已生效。

特征：`config_revision` 会因 `setEnabled()` 递增（`memory-manager.ts:100-107`），但当前会话的扩展可能仍持有旧值。

## 4. 已排除的方向

- **环境变量缺失或解析失败**：`resources/agent/extensions/pi-memory/host.ts:40-45` 解析失败时返回 `undefined`，扩展随即按独立 CLI 行为处理，`hostEnabled: true`（`engine.ts:168`）。这条路径只会让记忆变成"开启"，不会造成停用，可作为反向判据。
- **配置版本号（revision）比较丢弃新配置**：扩展的 `updateHost()`（`context.ts:59`）无条件替换配置与引擎；`revision` 只用于在版本变化时丢弃旧的会话态（`context.ts:69-74`）。revision 在应用重启后归零，也不会阻止新值生效。
- **只推活跃宿主**：`src/main/sessions/sdk-runtime-bridge.ts:345-347` 遍历 `allRuns()` 逐个推送，不是只推当前宿主。

## 5. 本次观测证据

表现态（`memory_status`，同一会话内）：

```
enabled: false            // state.enabled && !closed
global_enabled: false     // config.hostEnabled
session_enabled: true     // 会话内未关闭
available: true           // 受管运行时可用，与故障无关
config_revision: 0        // 本进程内没有发生过 setEnabled 或 initialize
```

`config_revision: 0` 是本次最关键的一条：`revision` 只在 `setEnabled()`（`memory-manager.ts:95`）与 `initialize()`（`memory-manager.ts:132`）之后递增，0 表示**本次应用运行期间没有通过设置页切换过开关，也没有创建过记忆库**。也就是说，宿主拿到的 `hostEnabled: false` 是启动时就读到的值，来源 3 的"切换后未送达"在本次不成立，剩下的分歧集中在来源 1（磁盘里是 false）与来源 2（读盘抛错降级）之间。

同一会话内执行 `memory_control on` 后，`session_enabled` 变为 true，但 `enabled` 与 `global_enabled` 仍为 false，随后的 `memory_search` 依旧被拒。这与第 2 节的链路一致：会话内控制无法越过全局关闭。

## 6. 待确认事实

- 配置文件 `desktop-config.json`（位于 Electron userData 目录，`desktop-config-store.ts:5`、`1068`）中 `memoryEnabled` 的实际取值。为 `false` 支持来源 1；缺失或为 `true` 则否定来源 1。
- 设置页「全局记忆」分节是否显示"本地配置暂时无法读取"类 notice（`MemorySettingsSection.vue:119`）。显示即支持来源 2。
- 出现在该问题上的会话，其宿主是在开关切换前后哪个时点创建的。若创建于切换之前且此后未重建，支持来源 3。
- 问题是否只在应用重启后、或长时间运行后出现。这决定来源 2 是否与读取时机相关，还是与磁盘状态相关。
- 多宿主场景下其余 run 的表现是否一致；不一致说明问题跟着宿主实例走，而不是跟着配置走。

以上属于事实缺口，可在后续调查中通过读取配置文件与既有状态输出补齐，不依赖修改代码。

## 7. 影响范围

只要 `hostEnabled` 为 false，扩展内所有需要租约的操作都会被拒：检索、读取、保存、月度整理。错误文案指向"记忆已停用"，容易被读成用户自己关掉了开关，从而掩盖来源 2、3 这类"开关是开的但没生效"的故障。库、索引、受管运行时与此无关——本次 `available: true`、库存在 167 条记录，均说明故障发生在开关判定层。

## 8. 边界

本文只记录现状、判定链路与待确认事实，不提出修复方案，也不含验证步骤与通过标准。修复方向需在确认第 6 节的证据之后再讨论，届时涉及"读取失败是否应降级为关闭"与"未就绪宿主是否补发配置"这两个独立决定，需分别评估其可见行为变化。
