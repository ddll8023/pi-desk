/**
 * 子代理通信协议 - TypeScript 类型定义
 * 
 * 这个文件定义了主 Agent 与子代理之间的所有通信格式。
 * 所有入参、出参都必须通过这些类型的验证。
 * 
 * @see docs/modules/sub-agent.md
 */

/**
 * 子代理类型
 */
export type SubAgentType = 'query' | 'research' | 'review' | 'document'

/**
 * 执行状态：子代理自报的完成情况。
 * 取消不落在这个字段上：子进程被终止时没有机会自报状态，
 * “已请求停止”与“已中断”由 `SubAgentView` 的 phase 表达。
 */
export type SubAgentStatus = 'success' | 'partial' | 'error'

/**
 * 审查维度
 */
export type ReviewDimension = 'security' | 'performance' | 'convention' | 'logic'

/**
 * 问题严重级别
 */
export type Severity = 'critical' | 'warning' | 'info'

// ============================================================================
// 请求类型
// ============================================================================

/**
 * 子代理请求 - 基础字段
 */
export interface SubAgentRequestBase {
  /** 子代理类型 */
  subagent_type: SubAgentType
  
  /** 任务 ID，用于结果缓存与去重 */
  task_id: string
  
  /** 可选的请求 ID，用于日志关联 */
  request_id?: string
  
  /** 最小必需上下文（完全隔离） */
  context: SubAgentContext
  
  /** 执行约束 */
  constraints: SubAgentConstraints
}

/**
 * 子代理上下文 - 完全隔离的最小上下文集合
 */
export interface SubAgentContext {
  /** 项目根路径（绝对） */
  project_root: string
  
  /** 工作目录（绝对） */
  working_dir: string
  
  /** 待处理的文件列表（相对于 project_root），可选 */
  target_file_paths?: string[]
  
  /** 代码片段（如审查场景），可选 */
  code_snippet?: string
  
  /** 最小化的用户偏好 */
  user_pref?: {
    language?: 'zh' | 'en'
    detail_level?: 'brief' | 'normal' | 'detailed'
  }
}

/**
 * 执行约束
 */
export interface SubAgentConstraints {
  /** 超时时间（秒），默认 30 */
  timeout_seconds: number
  
  /** 最大 token 数，默认 5000 */
  max_tokens: number
  
  /** 是否只读（query/research/review=true; document=false） */
  read_only: boolean
  
  /** 调研时的额外参数 */
  research?: {
    num_sources?: number  // 默认 3
    include_local?: boolean  // 默认 true
  }
  
  /** 文档代理时的额外参数 */
  document?: {
    target_dir?: string  // 默认 'docs/'
    backup?: boolean  // 默认 true
  }
}

// ============================================================================
// 查询代理
// ============================================================================

export interface QueryRequest extends SubAgentRequestBase {
  subagent_type: 'query'
  payload: QueryPayload
}

export interface QueryPayload {
  /** 查询语句，如 "find all usages of useUserStore" */
  query: string
  
  /** 前后文行数，默认 2 */
  context_lines?: number
  
  /** 文件过滤器，glob pattern（例如只检索 src 下的 TypeScript 文件） */
  file_filter?: string
}

export interface QueryResult {
  /** 找到的匹配数 */
  found_count: number
  
  /** 一句话摘要 */
  summary: string
  
  /** 代码片段列表 */
  file_snippets: Array<{
    path: string  // 相对路径
    lines: number  // 行号
    content: string  // 前后文代码
  }>
  
  /** 搜索覆盖范围 */
  search_coverage: {
    files_scanned: number
    regex_pattern_used?: string
  }
}

// ============================================================================
// 调研代理
// ============================================================================

export interface ResearchRequest extends SubAgentRequestBase {
  subagent_type: 'research'
  payload: ResearchPayload
}

export interface ResearchPayload {
  /** 调研问题，如 "compare Vue Router vs TanStack Router" */
  question: string
  
  /** 项目背景信息（可选） */
  background?: string
  
  /** 评估标准列表（可选） */
  decision_criteria?: string[]
}

export interface ResearchCandidate {
  /** 选项名称 */
  name: string
  
  /** 核心描述 */
  description: string
  
  /** 优点列表 */
  pros: string[]
  
  /** 缺点列表 */
  cons: string[]
  
  /** 对当前项目的匹配度（0-1） */
  fit_score: number
  
  /** 证据来源 */
  evidence: {
    sources: string[]  // URL 或 "project:path/to/doc"
    expert_references?: string[]  // 论文、官方文档引用
  }
}

export interface ResearchResult {
  /** 回传原问题 */
  question: string
  
  /** 候选方案列表 */
  candidates: ResearchCandidate[]
  
  /** 推荐信息 */
  recommendation: {
    option: string  // 推荐哪个选项
    reasoning: string  // 为什么推荐
    caveats?: string[]  // 注意事项
  }
  
  /** 按评估标准的对比 */
  decision_factors: Record<string, string>
}

// ============================================================================
// 审查代理
// ============================================================================

export interface ReviewRequest extends SubAgentRequestBase {
  subagent_type: 'review'
  payload: ReviewPayload
}

export interface ReviewPayload {
  /** 待审查的代码 */
  code_to_review: string
  
  /** 审查维度 */
  dimensions: ReviewDimension[]
  
  /** 相关文件路径（可选） */
  related_files?: string[]
  
  /** 改动背景说明（可选） */
  change_context?: string
}

export interface ReviewFinding {
  /** 审查维度 */
  dimension: ReviewDimension
  
  /** 严重级别 */
  severity: Severity
  
  /** 问题位置 */
  location: {
    /** 问题所在文件，相对于 project_root；省略时表示 code_to_review */
    file?: string
    /** 行号；省略 file 时相对 code_to_review */
    line: number
    column?: number
    length?: number
  }
  
  /** 问题标题 */
  title: string
  
  /** 详细描述 */
  description: string
  
  /** 修复建议（可选） */
  suggestion?: string
  
  /** 规范或最佳实践引用（可选） */
  reference?: string
}

export interface ReviewResult {
  /** 回传待审查代码 */
  code_snippet: string
  
  /** 问题列表 */
  findings: ReviewFinding[]
  
  /** 统计摘要 */
  summary: {
    total: number
    by_dimension: Record<ReviewDimension, number>
    by_severity: Record<Severity, number>
  }
  
  /** 是否通过审查（无 critical 且 warning 可接受） */
  pass: boolean
}

// ============================================================================
// 文档代理
// ============================================================================

export interface DocumentRequest extends SubAgentRequestBase {
  subagent_type: 'document'
  payload: DocumentPayload
}

export interface DocumentPayload {
  /** 文件路径（相对于 docs/） */
  file_path: string
  
  /** 操作类型 */
  operation: 'create' | 'update' | 'append'
  
  /** 新增或更新内容 */
  content: string
  
  /** 仅 update：更新哪个 section */
  section?: string
  
  /** 验证规则 */
  validation_rules?: {
    check_links?: boolean  // 验证 markdown 链接
    check_formatting?: boolean  // 验证格式
  }
}

export interface DocumentChange {
  /** 变更前内容（用于备份） */
  before?: string
  
  /** 变更后内容 */
  after: string
  
  /** diff 展示 */
  diff?: string
}

export interface DocumentValidationError {
  type: 'link' | 'formatting' | 'syntax'
  location: string
  message: string
}

export interface DocumentResult {
  /** 文件路径 */
  file_path: string
  
  /** 操作类型 */
  operation: 'create' | 'update' | 'append'
  
  /** 操作是否成功 */
  success: boolean
  
  /** 变更信息 */
  changes?: DocumentChange
  
  /** 验证结果 */
  validation: {
    passed: boolean
    errors: DocumentValidationError[]
  }
  
  /** 文件统计信息 */
  file_stats: {
    size_bytes: number
    lines: number
    encoding: string
  }
}

// ============================================================================
// 响应类型
// ============================================================================

/**
 * 子代理响应 - 所有子代理都使用这个格式
 */
export interface SubAgentResponse {
  /** 子代理类型 */
  subagent_type: SubAgentType
  
  /** 任务 ID（回传收到的） */
  task_id: string
  
  /** 可选的请求 ID（回传收到的） */
  request_id?: string
  
  /** 执行状态 */
  status: SubAgentStatus
  
  /** 错误信息（status 为 error 时必需） */
  error?: SubAgentError
  
  /** 结果（按类型变化，status 为 error 时可能为 null） */
  result: QueryResult | ResearchResult | ReviewResult | DocumentResult | null
  
  /** 元数据 */
  metadata: SubAgentMetadata
}

export interface SubAgentError {
  /** 错误代码 */
  code: string
  
  /** 错误消息 */
  message: string
  
  /** 额外详情（可选） */
  details?: unknown
}

export interface SubAgentMetadata {
  /** 执行耗时（毫秒） */
  elapsed_ms: number
  
  /** 使用的 token 数 */
  tokens_used: number
  
  /** 缓存键（用于去重） */
  cache_key?: string
  
  /** 是否缓存命中 */
  cache_hit?: boolean
  
  /** 警告列表 */
  warnings?: string[]
  
  /** 调试信息 */
  debug_info?: unknown
}

// ============================================================================
// 联合类型
// ============================================================================

/**
 * 所有子代理请求的联合类型
 */
export type SubAgentRequest = 
  | QueryRequest
  | ResearchRequest
  | ReviewRequest
  | DocumentRequest

/**
 * 所有子代理结果的联合类型
 */
export type SubAgentResult = 
  | QueryResult
  | ResearchResult
  | ReviewResult
  | DocumentResult

// ============================================================================
// 验证器接口
// ============================================================================

/**
 * 请求验证结果
 */
export interface ValidationResult {
  valid: boolean
  errors?: string[]
}

/**
 * 子代理权限检查结果
 */
export interface PermissionCheckResult {
  allowed: boolean
  reason?: string
}

// ============================================================================
// 工具权限定义
// ============================================================================

export interface SubAgentToolPermission {
  /** 允许的工具列表 */
  allowedTools: string[]
  
  /** 拒绝的工具列表 */
  deniedTools: string[]
  
  /** 文件访问权限 */
  fileAccess: 'readonly-all' | 'readonly-changed-files' | 'write-restricted'
  
  /** 上下文访问权限 */
  contextAccess: 'none' | 'session-history' | 'full'
  
  /** 超时时间（毫秒） */
  timeout: number
  
  /** 最大 token 数 */
  maxTokens: number
}

/**
 * 所有子代理的权限矩阵。
 * query、review 与 document 都有运行时入口（`delegate_subagent`）；research 未启用，
 * 矩阵保留为后续阶段的能力依据。
 */
export const SUB_AGENT_PERMISSIONS: Record<SubAgentType, SubAgentToolPermission> = {
  query: {
    allowedTools: ['read', 'grep', 'find', 'ls'],
    deniedTools: ['edit', 'write', 'bash'],
    fileAccess: 'readonly-all',
    contextAccess: 'none',
    timeout: 30000,
    maxTokens: 5000
  },
  research: {
    allowedTools: ['web_search', 'fetch_content', 'ffgrep', 'read'],
    deniedTools: ['edit', 'write', 'mcp'],
    fileAccess: 'readonly-all',
    contextAccess: 'none',
    timeout: 60000,
    maxTokens: 8000
  },
  review: {
    allowedTools: ['read', 'grep', 'find', 'ls'],
    deniedTools: ['edit', 'write', 'bash'],
    fileAccess: 'readonly-changed-files',
    contextAccess: 'none',
    timeout: 45000,
    maxTokens: 6000
  },
  document: {
    // 子进程只加载 Pi 内置工具，产品侧的 ffgrep/fffind 不会随子进程生效。
    allowedTools: ['read', 'grep', 'find', 'ls', 'edit', 'write'],
    deniedTools: ['bash', 'web_search', 'fetch_content'],
    fileAccess: 'write-restricted',
    contextAccess: 'none',
    timeout: 120000,
    maxTokens: 6000
  }
}

/**
 * 文档任务的写入硬上限：目录前缀与单文件白名单共同构成产品边界。
 * 任务级 `write_scope` 只能是它的子集；模型只能收窄范围，不能扩大。
 */
export const SUB_AGENT_WRITE_POLICY = {
  /** 允许写入的目录前缀（相对项目根）。 */
  directoryPrefixes: ['docs/'],
  /** 允许写入的单个文件（相对项目根，区分大小写）。 */
  files: ['README.md'],
  /** 单任务可声明的范围项数。 */
  scopeItems: 8,
  /** 单条范围声明长度上限。 */
  scopeItem: 240
} as const

// ============================================================================
// 导出所有类型
// ============================================================================

/**
 * 子代理类型到产品 Skill 目录名的映射；子宿主按该名称定位规范正文。
 */
export const SUB_AGENT_SKILLS: Record<SubAgentType, string> = {
  query: 'sub-agent-query',
  research: 'sub-agent-research',
  review: 'sub-agent-review',
  document: 'sub-agent-document'
}
