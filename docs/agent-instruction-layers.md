# Agent 指令分层与归属

修改任何 AGENTS 文件或产品内置提示前，必须先按本文判定归属；pi-desk 专有规则不得写入全局文件。

## 四层载体

| 层级 | 路径 | 加载条件 | 用途 |
| --- | --- | --- | --- |
| 全局用户级 | `~/.pi/agent/AGENTS.md` | 所有宿主会话共用；pi-desk 会话以只读方式注入同一份文件 | 跨项目用户偏好：沟通风格、权限边界、判断原则、环境适配 |
| 工作区项目 | `<cwd>/AGENTS.md` | 当前工作目录是该项目时 | 该项目的技术栈、开发约定、验证命令 |
| pi-desk 开发仓库 | `<pi-desk>/AGENTS.md` | 当前工作目录是 pi-desk 仓库时 | pi-desk 开发期约定（如跨平台兼容、Python 环境选择） |
| 打包产物内置 | 代码分段 + `out/sdk-host/agent-resources/` | pi-desk 应用启动时注入 | 产品行为：执行模式、需求理解、延续判定、记忆/委派时机、Skill 裁剪 |

## 产品内置规则的真实载体

pi-desk 产品行为只能存在于以下位置，**禁止写入全局 AGENTS.md**：

| 内容 | 实现位置 |
| --- | --- |
| 执行模式定义 | `src/shared/preferences-api.ts` 契约、`src/main/config/desktop-config-store.ts` 持久化 |
| 标准/快速模式分段 | `src/sdk-host/session-runtime.ts` 常量 `STANDARD_MODE_SECTION`、`FAST_MODE_SECTION` |
| 需求理解与延续判定分段 | `src/sdk-host/session-runtime.ts` 常量 `INTENT_SUMMARY_SECTION`、`CONTINUATION_SECTION`，判定函数 `judgeContinuation` |
| 快速模式豁免 Skill | `src/sdk-host/product-resources.ts` 常量 `FAST_MODE_BLOCKED_SKILLS` |
| 记忆与委派工具时机 | `src/sdk-host/product-tools-hint.ts` 函数 `productToolsSection`，由 `session-runtime.ts` 的 `MODE_HINT_EXTENSION_NAME` 扩展注入 |
| 回合头改动文件提示 | `src/sdk-host/turn-files-hint.ts` |
| 扩展与 Skill | `resources/agent/**` → 构建暂存为 `out/sdk-host/agent-resources/`（不携带 AGENTS 文件） |

**设计原则**（来自 `src/sdk-host/product-tools-hint.ts` 文件头与 `session-runtime.ts` 的模式提示扩展注释）：
- 记忆与委派工具随应用提供，其他宿主没有。
- 使用时机写进分段，不写全局 AGENTS.md，避免在缺少工具的宿主里产生"有规范无工具"的偏置。

## 归属判定规则

写入全局文件前自检：**该规则在非 pi-desk 宿主（Codex / Claude Code / 其他 Pi 项目）是否成立？**

| 内容特征 | 归属层级 |
| --- | --- |
| 提到 pi-desk、设置页路径、功能开关名称、随包资源路径 | 打包产物内置（代码分段） |
| 提到特定宿主的工具名（如 `memory_*`、`delegate_subagent`、`ui_render`） | 打包产物内置（分段） |
| 提到 pi-desk 的技术栈、构建命令、目录约定 | pi-desk 开发仓库 AGENTS |
| 跨项目通用的沟通、权限、判断原则 | 全局用户级 AGENTS |
| 项目专有的技术栈、数据库、API 约定 | 工作区项目 AGENTS |

以下内容不得写入全局 `~/.pi/agent/AGENTS.md`：宿主产品名称、设置页路径或 UI 组件名、功能开关状态、随包资源路径（如 `resources/agent/**`、`out/sdk-host/**`）、产品特有工具的使用时机、执行模式定义与快速模式豁免 Skill 清单。

跨宿主同样成立的通用判断规则（如新任务／延续的信号判定、显式识别的触发条件）可以留在全局文件；但不得把产品注入分段的原文照抄进来，同一要求在 pi-desk 会话中只保留产品分段这一处来源。

## 检查流程

修改前按以下顺序检查：
1. 读本文，判定目标层级。
2. 若属打包产物内置，定位对应代码分段或 `resources/agent/**`，不动全局文件。
3. 若属全局用户级，核查是否依赖产品功能；若依赖则移至产品分段。
4. 改动后检查同义规则是否散落多层；若重复则保留单一来源。
5. 把产品规则从全局文件移出时，先确认产品分段已完整承载原约束（含例外与不豁免项），再删除全局表述，避免约束变弱。
