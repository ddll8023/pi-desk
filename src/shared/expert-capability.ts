/**
 * 专家能力范围的跨进程契约：技能、MCP 与工具三个维度的模式与加减集。
 *
 * 设置页请求、会话专家视图、定义解析与保存各用一份字段声明时，改一个字段要同步多处，
 * 漏改一处不会有编译错误、只会静默失效；因此字段结构只在这里声明一次。
 * `skillIds`、`body` 属于声明内容而不是范围，仍由各接口自己声明。
 * 进程边界的白名单拷贝（IPC 投影、preload 请求）保持显式，不复用本类型代替字段拷贝。
 */

/** 能力范围的两种语义：继承默认基线后加减，或直接给出白名单。 */
export type ExpertCapabilityMode = 'inherit' | 'only'

/**
 * 一份能力范围：三个维度各带模式、`only` 模式的白名单与相对基线的加减集。
 * 模式为 `inherit` 时白名单只作提示，实际范围由加减集在默认基线上算出。
 */
export interface ExpertCapabilityFields {
  /** 技能范围：`only` 时 `skillIds` 是白名单，`inherit` 时由默认基线加减决定。 */
  readonly skillsMode: ExpertCapabilityMode
  /** 继承模式下在基线之上加回的技能；基线不含它时才有意义。 */
  readonly skillAddIds: readonly string[]
  /** 继承模式下从基线排除的技能。 */
  readonly skillRemoveIds: readonly string[]
  /** MCP 范围：语义同技能，列表换成服务器名。 */
  readonly mcpMode: ExpertCapabilityMode
  /** `only` 模式下保留的 MCP 服务器名。 */
  readonly mcpServerIds: readonly string[]
  /** 继承模式下在基线之上加回的 MCP 服务器。 */
  readonly mcpAddIds: readonly string[]
  /** 继承模式下从基线排除的 MCP 服务器。 */
  readonly mcpRemoveIds: readonly string[]
  /** 工具范围：语义同技能，列表换成工具名；被排除的工具在会话装配期从激活集合移除。 */
  readonly toolsMode: ExpertCapabilityMode
  /** `only` 模式下保留的工具名。 */
  readonly toolIds: readonly string[]
  /** 继承模式下在基线之上加回的工具。 */
  readonly toolAddIds: readonly string[]
  /** 继承模式下从基线排除的工具。 */
  readonly toolRemoveIds: readonly string[]
}

/** 默认能力基线：`null` 表示该维度不限制，等于全部可用。 */
export interface ExpertCapabilityDefaults {
  readonly skills: readonly string[] | null
  readonly mcpServers: readonly string[] | null
  readonly tools: readonly string[] | null
}

/**
 * 不受专家工具范围约束的工具：排除它们会让会话在功能上断裂，而不是简单少一个能力。
 *
 * - `skill_guard_select`：技能门禁靠它登记本轮规范，移除后所有工具调用都会被拒；
 * - `todo_write`：标准模式的模式分段要求先提交待办清单，移除后提示与工具对不上；
 * - 记忆组：整组由记忆配置与快速模式决定，单独移除会留下「背景注入仍生效、工具不可用」的半残状态。
 */
export const PROTECTED_EXPERT_TOOLS: readonly string[] = [
  'skill_guard_select',
  'todo_write',
  'memory_status', 'memory_control', 'memory_profiles', 'memory_rules', 'memory_search',
  'memory_read', 'memory_reinforce', 'memory_save', 'memory_profile_save'
]

/** 受保护判定：设置页据此把候选标成「必需」并禁止取消，保存期仍以它为唯一口径。 */
export function isProtectedExpertTool(name: string): boolean {
  return PROTECTED_EXPERT_TOOLS.includes(name)
}

/** 模式取值校验：声明解析与跨进程响应校验共用同一口径，避免一边放宽后另一边仍拒。 */
export function isExpertCapabilityMode(value: unknown): value is ExpertCapabilityMode {
  return value === 'inherit' || value === 'only'
}
