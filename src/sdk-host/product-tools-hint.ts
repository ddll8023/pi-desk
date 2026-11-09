/**
 * 产品级工具使用分段：只在本应用内注入，说明记忆工具与子代理工具的主动使用时机。
 *
 * 这些能力随应用打包，其他 Agent 环境没有对应工具；规则写进系统提示分段，
 * 不写进全局 AGENTS.md，避免在缺少工具的宿主里产生「有规范无工具」的偏置。
 *
 * 分工：何时使用只在本文件维护，Skill 只写能力域与写入边界，工具描述只写参数契约与责任边界。
 * 例外：独立 CLI 没有本分段，检索时机由 `memory/SKILL.md` 正文承担。
 */
import type { ExecutionMode } from '../shared/preferences-api'

/** 分段键同时是提示里的 XML 包裹名，保持短且不与既有分段重名。 */
export const PRODUCT_TOOLS_SECTION_KEY = 'product-tools'

const MEMORY_SECTION = `记忆工具（memory_search / memory_rules / memory_read）是背景来源，按需主动查询，不等用户开口：
- 新任务涉及设计取舍、用户偏好、既有约定或反复出现的问题时先查；
- 需要知道某个现有实现为什么这样做时查 rules；
- 只有用户明确指向某个项目时才传 scope（current-project 或 project + 项目名），其余不传，默认全库；
- 查到的摘要需要完整正文时按记录 ID 读原文。
背景中已注入的约定优先于通用习惯与个人偏好：产出文档、清单、索引、规范前，先用 memory_rules 按 rule_key 核对该族最新约定。`

const SUBAGENT_SECTION = `委派工具 delegate_subagent 用于结构化批量产出，不是 read/ffgrep 的替代：
- query：需要读多处文件才能回答、或把检索过程放进主会话会挤占上下文时（典型是 3 个以上符号或跨多个模块），用 query 批量并行；同步注释与文档前确认受影响位置也走这条；
- research：需要外部资料（官方文档、开源仓库、论文）作依据、做多方案对比或核查结论来源时，用 research；
- review：需要按安全、性能、规范、逻辑多维度审查代码时，用 review；项目有适用规范 skill 时，把要核对的条款写进 payload.standards，子代理不会自己加载规范；
- document：需要创建或按小节更新 2 个以上文档时，用 document 并声明 write_scope。
单点定位、单文件小改、需要边讨论边改的工作直接用 read / ffgrep / edit，不要委派；仓库内的符号定位仍用 query，不因要查词就派 research。`

/**
 * 快速模式整组下线记忆工具，注入记忆指引会让模型去找不存在的工具，因此只保留委派段。
 */
export function productToolsSection(mode: ExecutionMode): string {
  return mode === 'fast' ? SUBAGENT_SECTION : `${MEMORY_SECTION}\n\n${SUBAGENT_SECTION}`
}
