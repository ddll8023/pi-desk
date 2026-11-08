/**
 * 产品级工具使用分段：只在本应用内注入，说明记忆工具与子代理工具的主动使用时机。
 *
 * 这些能力随应用打包，其他 Agent 环境没有对应工具；规则写进系统提示分段，
 * 不写进全局 AGENTS.md，避免在缺少工具的宿主里产生「有规范无工具」的偏置。
 *
 * 分工：何时使用只在本文件维护，Skill 只写能力域与写入审批边界，工具描述只写参数契约与责任边界。
 * 例外：独立 CLI 没有本分段，检索时机由 `memory/SKILL.md` 正文承担。
 */
import type { ExecutionMode } from '../shared/preferences-api'

/** 分段键同时是提示里的 XML 包裹名，保持短且不与既有分段重名。 */
export const PRODUCT_TOOLS_SECTION_KEY = 'product-tools'

const MEMORY_SECTION = `记忆工具（memory_search / memory_rules / memory_read）是背景来源，按需主动查询，不等用户开口：
- 新任务涉及设计取舍、用户偏好、既有约定或反复出现的问题时先查；
- 需要知道某个现有实现为什么这样做时查 rules；
- 查到的摘要需要完整正文时按记录 ID 读原文。`

const SUBAGENT_SECTION = `委派工具 delegate_subagent 用于结构化批量产出，不是 read/ffgrep 的替代：
- 一次要查 3 个以上符号的定义与引用时，用 query 批量并行；
- 需要按安全、性能、规范、逻辑多维度审查代码时，用 review；
- 需要创建或按小节更新 2 个以上文档时，用 document 并声明 write_scope。
单点定位、单文件小改、需要边讨论边改的工作直接用 read / ffgrep / edit，不要委派。`

/**
 * 快速模式整组下线记忆工具，注入记忆指引会让模型去找不存在的工具，因此只保留委派段。
 */
export function productToolsSection(mode: ExecutionMode): string {
  return mode === 'fast' ? SUBAGENT_SECTION : `${MEMORY_SECTION}\n\n${SUBAGENT_SECTION}`
}
