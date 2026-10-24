# 项目与信任

模块 ID：`projects-trust`。返回 [总览](../项目结构文档.md)。

## 职责与入口

负责项目目录选择、规范化、登记、当前项目切换、移除和 Project Trust 的资源探测／决定。入口为侧栏项目动作及信任对话框；项目与会话在同一棵侧栏树展示，但数据所有者不同。

不删除项目目录，不解析聊天正文，不提供 OS 沙箱或任意工具授权。移除项目记录与删除会话文件是不同动作。

## 专属文件

| 文件 | 用途 |
| --- | --- |
| `src/main/projects/project-manager.ts` | 项目列表、候选添加、切换、移除与 Runtime 协作 |
| `src/main/shared/project-path.ts` | 项目绝对路径规范化与显示名 |
| `src/main/trust/trust-manager.ts` | 受保护项目资源探测、信任状态与决定保存 |
| `src/main/trust/guards.ts` | 当前项目的信任门禁：探测是否需要信任决定，并为 Git 写操作提供统一放行判断 |
| `src/shared/project-api.ts` | 项目请求、列表、选择结果与运行时校验 |
| `src/shared/trust-api.ts` | 信任资源、状态与决定契约 |
| `src/renderer/src/projects/stores/project.ts` | 项目展示副本、候选添加、串行选择及操作错误 |
| `src/renderer/src/projects/stores/trust.ts` | 信任提示目标、决定与交互状态 |
| `src/renderer/src/projects/services/project.ts` | 项目固定桥接接口；重建普通信任载荷 |
| `src/renderer/src/projects/services/trust.ts` | 信任查询与决定的桥接接口 |
| `src/renderer/src/projects/components/TrustDialog.vue` | 候选项目及已有运行目标的信任交互 |

入口、主进程调用关系、项目 Store 与服务已读；信任界面及辅助契约由注册和引用定位。

## 公共与跨模块引用

- [F-sidebar](shared.md#f-sidebar项目会话树混合)：`src/renderer/src/projects/components/ProjectSidebar.vue`、`src/renderer/src/projects/components/ProjectRow.vue`、`src/renderer/src/projects/components/SessionRow.vue`、`src/renderer/src/projects/components/SessionStatusMark.vue`、`src/renderer/src/projects/sidebar-tree.ts` 承载项目与会话混合视图。
- [F-assembly](shared.md#f-assembly进程与页面组装混合)：`src/main/projects/ipc.ts` 的 `registerProjectHandlers`、`src/main/trust/ipc.ts` 的 `registerTrustHandlers` 与已登记项目解析；候选添加和移除确认的待确认目标在 `src/renderer/src/projects/stores/project.ts`，经 `src/renderer/src/shell/components/AppDialogHost.vue` 呈现。
- [F-config](shared.md#f-configdesktop-配置混合)：`src/main/config/desktop-config-store.ts` 是项目列表、当前项目、信任决定的唯一持久化入口。
- [会话](sessions-chat.md)：`src/main/sessions/session-run-registry.ts`、`src/main/sessions/sdk-runtime-bridge.ts` 提供占用查询、前台选择与项目范围关闭。
- [终端](terminal-commands.md)：项目移除成功后，主进程使用原规范路径另行请求关闭该项目终端。
- [Git](git.md)：Git 写动作经主进程的项目级信任拦截。

## 关键流程

### 添加与切换

1. 主进程目录选择器返回规范路径和信任资源状态，页面暂存候选。
2. 需要决定时先显示信任提示；取消不改变列表，确认随添加请求提交。
3. 主进程复核路径与信任，配置写入成功后返回列表；页面采纳返回值。
4. 切项目后前台运行实例跟随该项目已有实例，不因此建立宿主、重绑或中断其他项目的后台会话。

### 移除与信任

移除只清 Desktop 中的项目记录，并按占用条件收敛该项目运行实例；关联信任与项目范围快捷命令在配置层一并清除。信任查询带运行实例身份时，以登记的归属项目为目标；不带时按当前项目处理，不能在异步过程中改用另一个前台项目。

## 状态与存储边界

项目与信任写入 `desktop-config.json`，不写项目目录里的 Pi 配置。候选状态只在内存，桥接时由服务重建普通对象，不传 Vue 代理。

信任表示是否允许加载或执行受保护项目资源，不代表文件隔离、网络隔离或工具权限沙箱。同一项目多会话仍访问共享工作目录。项目路径的规范化、大小写比较和前台项目选择不能代替运行实例的授权归属。
