/**
 * 工作流的固定通道、定义与运行契约，以及跨进程响应校验。
 *
 * 定义是一张有向图：`start` → `agent`（可多个，各自一次独立 Agent 会话）→ `end`；
 * `approval` 是人工门，运行到它时停下等人。边带路由：状态边（`success` / `failure` / `always`）
 * 按节点终态走，条件边（`condition`）按源节点结论文本求值；状态边优先，条件边只在没有状态边可走时参与判定。
 *
 * 图形与条件的校验放在本文件，页面保存、主进程落盘与运行启动共用同一份判定，不各自实现一套。
 * 运行记录由主进程持有并推送快照；页面只读快照并发出启动、取消与审批。
 */

/** 工作流定义清单：只返回结构与更新时间，不带完整图。 */
export const WORKFLOWS_LIST_CHANNEL = 'desktop:workflows-list'
/** 读取一份工作流定义。 */
export const WORKFLOW_READ_CHANNEL = 'desktop:workflow-read'
/** 新建或保存一份工作流定义；`workflowId` 为空表示新建，标识由主进程分配。 */
export const WORKFLOW_SAVE_CHANNEL = 'desktop:workflow-save'
/** 删除一份工作流定义；文件走系统废纸篓。 */
export const WORKFLOW_DELETE_CHANNEL = 'desktop:workflow-delete'
/** 在指定项目里启动一次运行。 */
export const WORKFLOW_RUN_START_CHANNEL = 'desktop:workflow-run-start'
/** 取消一次仍在跑的运行。 */
export const WORKFLOW_RUN_CANCEL_CHANNEL = 'desktop:workflow-run-cancel'
/** 审批门的一次决定：通过与拒绝分别走 `success` 与 `failure` 边。 */
export const WORKFLOW_RUN_APPROVE_CHANNEL = 'desktop:workflow-run-approve'
/** 读取一次运行的最新快照（重开标签或重启后恢复面板）。 */
export const WORKFLOW_RUN_READ_CHANNEL = 'desktop:workflow-run-read'
/** 按工作流列出历次运行的摘要，供回放选择。 */
export const WORKFLOW_RUNS_LIST_CHANNEL = 'desktop:workflow-runs-list'
/** 清空已结束的运行记录；仍在跑的运行不受影响。 */
export const WORKFLOW_RUNS_CLEAR_CHANNEL = 'desktop:workflow-runs-clear'
/** 列出一个工作流的定时任务。 */
export const WORKFLOW_SCHEDULES_LIST_CHANNEL = 'desktop:workflow-schedules-list'
/** 新建或保存一个定时任务；`scheduleId` 为空表示新建。 */
export const WORKFLOW_SCHEDULE_SAVE_CHANNEL = 'desktop:workflow-schedule-save'
/** 删除一个定时任务。 */
export const WORKFLOW_SCHEDULE_DELETE_CHANNEL = 'desktop:workflow-schedule-delete'
/** 立即按这个定时任务的配置跑一次（不等下一个时刻）。 */
export const WORKFLOW_SCHEDULE_RUN_CHANNEL = 'desktop:workflow-schedule-run'
/** 运行快照推送：状态变化与节点收敛时各推一次整体快照，页面不自己拼装状态。 */
export const WORKFLOW_RUN_EVENT = 'desktop:workflow-run-event'

/** 工作流份数上限：与专家、团队同一量级，超出按清单无效处理。 */
export const MAX_WORKFLOW_ENTRIES = 256
/** 单张图的节点与边上限；超限说明配置写错而不是真的需要这么多步。 */
export const MAX_WORKFLOW_NODES = 64
export const MAX_WORKFLOW_EDGES = 128
/** 名称与简介长度；超长定义仍可读，保存时由写通道拒绝。 */
export const MAX_WORKFLOW_NAME_LENGTH = 64
export const MAX_WORKFLOW_SUMMARY_LENGTH = 200
/** 节点标题与提示词长度；提示词是节点这一轮的唯一输入。 */
export const MAX_WORKFLOW_NODE_TITLE_LENGTH = 40
export const MAX_WORKFLOW_NODE_PROMPT_LENGTH = 8000
/** 条件值长度：条件是对结论文本的简单匹配，超出这个长度说明用错了地方。 */
export const MAX_WORKFLOW_CONDITION_LENGTH = 200

/** 参数上限与字段长度；参数值随运行或调度落盘，长度按一段提示文本量级定。 */
export const MAX_WORKFLOW_PARAMETERS = 8
export const MAX_WORKFLOW_PARAMETER_LABEL = 40
export const MAX_WORKFLOW_PARAMETER_VALUE = 400
export const MAX_WORKFLOW_PARAMETER_OPTIONS = 20
/** 单个工作流的定时任务上限；再多说明把多个流程塞进同一张图了。 */
export const MAX_WORKFLOW_SCHEDULES = 8
/** 审批门说明的长度：这段文字只给人看，不进模型指令。 */
export const MAX_WORKFLOW_APPROVAL_NOTE_LENGTH = 400
/** 一次运行保留的事件条数与单条文本长度；超出丢最早的，避免记录无界增长。 */
export const MAX_WORKFLOW_RUN_EVENTS = 400
export const MAX_WORKFLOW_EVENT_TEXT = 400
/** 节点结论摘要长度：运行面板只展示摘要，完整内容在节点会话里。 */
export const MAX_WORKFLOW_NODE_OUTPUT = 4000
/** 同层并发上限：与子代理批内并发同一口径，避免一次扇出打满机器。 */
export const MAX_WORKFLOW_CONCURRENCY = 3
/** 单节点单轮超时：超时按失败收敛，不无限挂着拖住整次运行。 */
export const WORKFLOW_NODE_TIMEOUT_MS = 15 * 60_000
/** 运行列表一次最多返回的份数。 */
export const MAX_WORKFLOW_RUN_LIST = 50

export type WorkflowNodeType = 'start' | 'agent' | 'end' | 'approval'

export const WORKFLOW_NODE_TYPES: readonly WorkflowNodeType[] = ['start', 'agent', 'end', 'approval']

export type WorkflowEdgeRoute = 'success' | 'failure' | 'always' | 'condition'

export const WORKFLOW_EDGE_ROUTES: readonly WorkflowEdgeRoute[] = ['success', 'failure', 'always', 'condition']

export const WORKFLOW_EDGE_ROUTE_LABELS: Readonly<Record<WorkflowEdgeRoute, string>> = {
  success: '成功',
  failure: '失败',
  always: '总是',
  condition: '条件'
}

export type WorkflowConditionKind = 'contains' | 'not-contains' | 'equals' | 'not-equals' | 'regex'

export const WORKFLOW_CONDITION_KINDS: readonly WorkflowConditionKind[] = [
  'contains', 'not-contains', 'equals', 'not-equals', 'regex'
]

export const WORKFLOW_CONDITION_LABELS: Readonly<Record<WorkflowConditionKind, string>> = {
  contains: '包含',
  'not-contains': '不包含',
  equals: '等于',
  'not-equals': '不等于',
  regex: '匹配正则'
}

/** 条件边的判定：对源节点结论文本求值。`value` 的长度上限在保存时校验。 */
export interface WorkflowEdgeCondition {
  readonly kind: WorkflowConditionKind
  readonly value: string
}

/** 图上的一个节点；坐标只用于画布还原。 */
export interface WorkflowNode {
  readonly id: string
  readonly type: WorkflowNodeType
  readonly title: string
  readonly x: number
  readonly y: number
  /** 节点使用的专家标识；`start`、`end` 与 `approval` 为 null。 */
  readonly expertId: string | null
  /** Agent 节点是这一轮的唯一输入；审批门节点是给人看的说明（不进模型指令）；其余为空串。 */
  readonly prompt: string
  /** 写入范围：null 不限制，空数组只读；`start`、`end` 与 `approval` 恒为 null。 */
  readonly writeScope: readonly string[] | null
}

/** 图上的一条有向边；同一对节点之间允许存在不同路由的多条边。 */
export interface WorkflowEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly route: WorkflowEdgeRoute
  /** 只有 `condition` 路由带条件；其余路由为 null。 */
  readonly condition: WorkflowEdgeCondition | null
}

/**
 * 一个启动参数：运行前填值，节点提示词用 `{{名称}}` 引用。
 * `name` 只能是小写字母开头的标识，它就是占位符里的名字；改名字等于改占位符，所以保存时会连带校验。
 */
export interface WorkflowParameter {
  readonly name: string
  readonly label: string
  readonly type: WorkflowParameterType
  /** 必填参数在没给值时拒绝启动；有多默认值的也算有值。 */
  readonly required: boolean
  readonly defaultValue: string
  /** 只对 `select` 有意义；`text` 恒为空数组。 */
  readonly options: readonly string[]
}

export type WorkflowParameterType = 'text' | 'select'

export const WORKFLOW_PARAMETER_TYPES: readonly WorkflowParameterType[] = ['text', 'select']

/** 运行参数值：参数名 → 值；缺省的参数按定义里的默认值补齐。 */
export type WorkflowParameterValues = Readonly<Record<string, string>>

export interface WorkflowDefinition {
  readonly id: string
  readonly name: string
  readonly summary: string
  readonly parameters: readonly WorkflowParameter[]
  readonly nodes: readonly WorkflowNode[]
  readonly edges: readonly WorkflowEdge[]
  readonly updatedAt: number
}

/** 清单里的一项：只带身份与规模，不带图内容。 */
export interface WorkflowView {
  readonly id: string
  readonly name: string
  readonly summary: string
  readonly nodeCount: number
  readonly updatedAt: number
}

/** 图形校验的失败原因；页面在画布上就地提示，保存与启动同样拒绝。 */
export type WorkflowIssueKind =
  | 'empty-name'
  | 'too-many-nodes'
  | 'too-many-edges'
  | 'no-start'
  | 'multiple-start'
  | 'no-end'
  | 'cycle'
  | 'dangling-edge'
  | 'duplicate-node'
  | 'duplicate-edge'
  | 'agent-node-incomplete'
  | 'approval-node-incomplete'
  | 'condition-invalid'
  | 'parameter-invalid'
  | 'placeholder-unknown'
  | 'write-scope-invalid'

export interface WorkflowIssueView {
  readonly kind: WorkflowIssueKind
  /** 出问题的节点或边标识；图级问题为 null。 */
  readonly nodeId: string | null
  readonly message: string
}

export type WorkflowNodeStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped'

export const WORKFLOW_NODE_STATUS_LABELS: Readonly<Record<WorkflowNodeStatus, string>> = {
  idle: '未开始',
  queued: '排队中',
  running: '执行中',
  waiting: '等待审批',
  completed: '已完成',
  failed: '失败',
  cancelled: '已中断',
  skipped: '已跳过'
}

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export const WORKFLOW_RUN_STATUS_LABELS: Readonly<Record<WorkflowRunStatus, string>> = {
  running: '运行中',
  completed: '已结束',
  failed: '失败',
  cancelled: '已取消'
}

/** 节点失败的成因；区分超时、用户取消、审批拒绝、子进程异常与无法启动。 */
export type WorkflowNodeFailure = 'timeout' | 'aborted' | 'rejected' | 'error' | 'unavailable'

export interface WorkflowNodeRun {
  readonly nodeId: string
  readonly status: WorkflowNodeStatus
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly output: string | null
  readonly failure: WorkflowNodeFailure | null
}

export interface WorkflowRunEvent {
  readonly at: number
  readonly nodeId: string | null
  readonly level: 'info' | 'warn' | 'error'
  readonly message: string
}

export interface WorkflowRun {
  readonly runId: string
  readonly workflowId: string
  readonly workflowName: string
  readonly projectPath: string
  readonly status: WorkflowRunStatus
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly nodes: readonly WorkflowNodeRun[]
  readonly events: readonly WorkflowRunEvent[]
}

/** 运行列表的一项：回放面板只按它选择，不加载全部节点明细。 */
export interface WorkflowRunSummary {
  readonly runId: string
  readonly workflowId: string
  readonly workflowName: string
  readonly status: WorkflowRunStatus
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly nodeCount: number
}

export type WorkflowErrorCode =
  | 'FORBIDDEN'
  | 'INVALID_REQUEST'
  | 'INTERNAL_ERROR'
  | 'INVALID_RESPONSE'
  | 'BRIDGE_UNAVAILABLE'
  /** 定义不成立：校验未通过，`issues` 给出具体项。 */
  | 'INVALID_DEFINITION'
  /** 目标工作流或运行不存在。 */
  | 'NOT_FOUND'
  /** 运行已结束或已经取消。 */
  | 'RUN_SETTLED'
  /** 这次运行里没有等待审批的该节点，或审批已经决定过。 */
  | 'NO_PENDING_APPROVAL'
  /** 必填参数缺值：启动或保存定时任务时拒绝。 */
  | 'MISSING_PARAMETERS'
  /** 这份工作流已有运行在推进：不并行开第二次。 */
  | 'ALREADY_RUNNING'
  /** 项目未登记：工作流只能在已添加的项目里运行。 */
  | 'PROJECT_UNAVAILABLE'

export interface WorkflowError {
  readonly code: WorkflowErrorCode
  readonly message: string
}

export interface WorkflowsListResult {
  readonly ok: true
  readonly data: { readonly workflows: readonly WorkflowView[] }
}
export type WorkflowsListOutcome = WorkflowsListResult | { readonly ok: false; readonly error: WorkflowError }

export interface WorkflowReadRequest {
  readonly workflowId: string
}

export type WorkflowReadOutcome =
  | { readonly ok: true; readonly data: WorkflowDefinition }
  | { readonly ok: false; readonly error: WorkflowError }

export interface WorkflowSaveRequest {
  /** 空串表示新建；保存成功后返回主进程分配的标识。 */
  readonly workflowId: string
  readonly name: string
  readonly summary: string
  readonly parameters: readonly WorkflowParameter[]
  readonly nodes: readonly WorkflowNode[]
  readonly edges: readonly WorkflowEdge[]
}

export type WorkflowSaveOutcome =
  | { readonly ok: true; readonly data: { readonly workflowId: string } }
  | { readonly ok: false; readonly error: WorkflowError; readonly issues?: readonly WorkflowIssueView[] }

export interface WorkflowDeleteRequest {
  readonly workflowId: string
}

/**
 * 一个定时任务：到点按这里的项目与参数值启动一次运行。
 * 它不保存上次触发时间：是否正在跑由当前运行表回答，历史在运行记录里。
 */
export interface WorkflowSchedule {
  readonly id: string
  readonly workflowId: string
  /** 五段 cron：`分 时 日 月 周`，只支持 `*`、数字、区间、列表与步长。 */
  readonly cron: string
  readonly projectPath: string
  readonly parameters: WorkflowParameterValues
  readonly enabled: boolean
}

export interface WorkflowRunStartRequest {
  readonly workflowId: string
  /** 必须在已添加的项目里：节点子进程的工作目录就是它。 */
  readonly projectPath: string
  /** 运行参数值；未列的参数按定义默认值补齐，必填仍缺时拒绝启动。 */
  readonly parameters: WorkflowParameterValues
}

export interface WorkflowRunCancelRequest {
  readonly runId: string
}

export interface WorkflowRunApproveRequest {
  readonly runId: string
  readonly nodeId: string
  /** true 走 `success` 与 `always` 边，false 走 `failure` 与 `always` 边。 */
  readonly approved: boolean
}

export interface WorkflowRunReadRequest {
  readonly runId: string
}

export interface WorkflowSchedulesListRequest {
  readonly workflowId: string
}

export interface WorkflowScheduleSaveRequest {
  /** 空串表示新建；标识由主进程分配。 */
  readonly scheduleId: string
  readonly workflowId: string
  readonly cron: string
  readonly projectPath: string
  readonly parameters: WorkflowParameterValues
  readonly enabled: boolean
}

export interface WorkflowScheduleDeleteRequest {
  readonly scheduleId: string
}

export interface WorkflowScheduleRunRequest {
  readonly scheduleId: string
}

export interface WorkflowRunsListRequest {
  readonly workflowId: string
}

export type WorkflowRunOutcome =
  | { readonly ok: true; readonly data: WorkflowRun }
  | { readonly ok: false; readonly error: WorkflowError }

export type WorkflowRunsListOutcome =
  | { readonly ok: true; readonly data: { readonly runs: readonly WorkflowRunSummary[] } }
  | { readonly ok: false; readonly error: WorkflowError }

export type WorkflowDeleteOutcome =
  | { readonly ok: true; readonly data: Record<string, never> }
  | { readonly ok: false; readonly error: WorkflowError }

/** 清空运行记录：返回本次删除的份数，0 份不当作失败。 */
export type WorkflowRunsClearOutcome =
  | { readonly ok: true; readonly data: { readonly removed: number } }
  | { readonly ok: false; readonly error: WorkflowError }

export type WorkflowSchedulesListOutcome =
  | { readonly ok: true; readonly data: { readonly schedules: readonly WorkflowSchedule[] } }
  | { readonly ok: false; readonly error: WorkflowError }

export type WorkflowScheduleSaveOutcome =
  | { readonly ok: true; readonly data: { readonly scheduleId: string } }
  | { readonly ok: false; readonly error: WorkflowError; readonly issues?: readonly WorkflowIssueView[] }

export type WorkflowScheduleDeleteOutcome =
  | { readonly ok: true; readonly data: Record<string, never> }
  | { readonly ok: false; readonly error: WorkflowError }

export interface WorkflowApi {
  readonly listWorkflows: () => Promise<WorkflowsListOutcome>
  readonly readWorkflow: (request: WorkflowReadRequest) => Promise<WorkflowReadOutcome>
  readonly saveWorkflow: (request: WorkflowSaveRequest) => Promise<WorkflowSaveOutcome>
  readonly deleteWorkflow: (request: WorkflowDeleteRequest) => Promise<WorkflowDeleteOutcome>
  readonly startWorkflowRun: (request: WorkflowRunStartRequest) => Promise<WorkflowRunOutcome>
  readonly cancelWorkflowRun: (request: WorkflowRunCancelRequest) => Promise<WorkflowRunOutcome>
  /** 对等待中的审批门给出决定；返回给出决定后的运行快照。 */
  readonly approveWorkflowRun: (request: WorkflowRunApproveRequest) => Promise<WorkflowRunOutcome>
  readonly readWorkflowRun: (request: WorkflowRunReadRequest) => Promise<WorkflowRunOutcome>
  readonly listWorkflowRuns: (request: WorkflowRunsListRequest) => Promise<WorkflowRunsListOutcome>
  readonly listWorkflowSchedules: (request: WorkflowSchedulesListRequest) => Promise<WorkflowSchedulesListOutcome>
  readonly saveWorkflowSchedule: (request: WorkflowScheduleSaveRequest) => Promise<WorkflowScheduleSaveOutcome>
  readonly deleteWorkflowSchedule: (request: WorkflowScheduleDeleteRequest) => Promise<WorkflowScheduleDeleteOutcome>
  readonly runWorkflowSchedule: (request: WorkflowScheduleRunRequest) => Promise<WorkflowRunOutcome>
  /** 清空已结束的运行记录；返回清掉的份数。 */
  readonly clearWorkflowRuns: () => Promise<WorkflowRunsClearOutcome>
  /** 订阅运行快照；返回取消订阅函数。 */
  readonly onWorkflowRun: (listener: (run: WorkflowRun) => void) => () => void
}

const NODE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const WORKFLOW_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
/** 运行标识与调度标识：与目录名一致，禁止路径分隔与越界段。 */
const RUN_ID_PATTERN = /^run-[a-z0-9-]{1,40}$/
const SCHEDULE_ID_PATTERN = /^sch-[a-z0-9-]{1,40}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNodeType(value: unknown): value is WorkflowNodeType {
  return WORKFLOW_NODE_TYPES.some(type => type === value)
}

function isEdgeRoute(value: unknown): value is WorkflowEdgeRoute {
  return WORKFLOW_EDGE_ROUTES.some(route => route === value)
}

function isConditionKind(value: unknown): value is WorkflowConditionKind {
  return WORKFLOW_CONDITION_KINDS.some(kind => kind === value)
}

function isNodeStatus(value: unknown): value is WorkflowNodeStatus {
  return Object.hasOwn(WORKFLOW_NODE_STATUS_LABELS, value as string)
}

function isRunStatus(value: unknown): value is WorkflowRunStatus {
  return Object.hasOwn(WORKFLOW_RUN_STATUS_LABELS, value as string)
}

function isNodeFailure(value: unknown): value is WorkflowNodeFailure {
  return value === 'timeout' || value === 'aborted' || value === 'rejected'
    || value === 'error' || value === 'unavailable'
}

export function isWorkflowId(value: unknown): value is string {
  return typeof value === 'string' && WORKFLOW_ID_PATTERN.test(value)
}

/** 运行标识：三条运行通道共用，避免任意字符串被拼进运行目录。 */
export function isWorkflowRunId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value)
}

/** 调度标识：与运行目录同一套边界要求。 */
export function isWorkflowScheduleId(value: unknown): value is string {
  return typeof value === 'string' && SCHEDULE_ID_PATTERN.test(value)
}

function parseWriteScope(value: unknown): readonly string[] | null | undefined {
  if (value === null) return null
  if (!Array.isArray(value)) return undefined
  const scope: string[] = []
  for (const item of value.slice(0, 8)) {
    if (typeof item !== 'string' || item === '') return undefined
    // 绝对路径、盘符与越界段不接受：范围是项目内相对路径。
    if (item.startsWith('/') || item.includes('\\') || /^[a-zA-Z]:/.test(item)) return undefined
    if (item.split('/').some(segment => segment === '..' || segment === '.')) return undefined
    scope.push(item)
  }
  return scope
}

/** 条件解析：`null` 是「无条件」，`undefined` 是「写了但不合法」，两者不能混为一谈。 */
function parseCondition(value: unknown): WorkflowEdgeCondition | null | undefined {
  if (value === null || value === undefined) return null
  if (!isRecord(value)) return undefined
  if (!isConditionKind(value.kind)) return undefined
  if (typeof value.value !== 'string' || value.value === '') return undefined
  if (value.value.length > MAX_WORKFLOW_CONDITION_LENGTH) return undefined
  return { kind: value.kind, value: value.value }
}

export function parseWorkflowNode(value: unknown): WorkflowNode | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || !NODE_ID_PATTERN.test(value.id)) return null
  if (!isNodeType(value.type)) return null
  const title = typeof value.title === 'string' ? value.title.slice(0, MAX_WORKFLOW_NODE_TITLE_LENGTH) : ''
  const promptLimit = value.type === 'approval' ? MAX_WORKFLOW_APPROVAL_NOTE_LENGTH : MAX_WORKFLOW_NODE_PROMPT_LENGTH
  const prompt = typeof value.prompt === 'string' ? value.prompt.slice(0, promptLimit) : ''
  const writeScope = parseWriteScope(value.writeScope)
  if (writeScope === undefined) return null
  return {
    id: value.id,
    type: value.type,
    title,
    x: isCount(value.x) ? Math.round(value.x) : 0,
    y: isCount(value.y) ? Math.round(value.y) : 0,
    expertId: typeof value.expertId === 'string' && value.expertId !== '' ? value.expertId : null,
    prompt,
    writeScope
  }
}

/** 边解析：条件写坏了整条边作废；非条件路由带着条件仍可读，由校验层报「状态边不得带条件」。 */
export function parseWorkflowEdge(value: unknown): WorkflowEdge | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || value.id === '' || value.id.length > 64) return null
  if (typeof value.source !== 'string' || typeof value.target !== 'string') return null
  if (!isEdgeRoute(value.route)) return null
  const condition = parseCondition(value.condition)
  if (condition === undefined) return null
  return { id: value.id, source: value.source, target: value.target, route: value.route, condition }
}

/** 定义的文件形态与跨进程形态共用这一个解析；任何一项不合法即整份作废。 */
export function parseWorkflowDefinition(value: unknown): WorkflowDefinition | null {
  if (!isRecord(value)) return null
  if (!isWorkflowId(value.id)) return null
  if (typeof value.name !== 'string') return null
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) return null
  if (value.nodes.length > MAX_WORKFLOW_NODES || value.edges.length > MAX_WORKFLOW_EDGES) return null
  const nodes: WorkflowNode[] = []
  for (const item of value.nodes) {
    const node = parseWorkflowNode(item)
    if (node === null) return null
    nodes.push(node)
  }
  const parameters: WorkflowParameter[] = []
  if (Array.isArray(value.parameters)) {
    for (const item of value.parameters.slice(0, MAX_WORKFLOW_PARAMETERS)) {
      const parameter = parseWorkflowParameter(item)
      if (parameter === null) return null
      parameters.push(parameter)
    }
  }
  const edges: WorkflowEdge[] = []
  for (const item of value.edges) {
    const edge = parseWorkflowEdge(item)
    if (edge === null) return null
    edges.push(edge)
  }
  return {
    id: value.id,
    name: value.name.slice(0, MAX_WORKFLOW_NAME_LENGTH),
    summary: typeof value.summary === 'string' ? value.summary.slice(0, MAX_WORKFLOW_SUMMARY_LENGTH) : '',
    parameters,
    nodes,
    edges,
    updatedAt: isCount(value.updatedAt) ? Math.floor(value.updatedAt) : 0
  }
}

export function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  return parseWorkflowDefinition(value) !== null
}

/** 正则条件在保存时编译一次：写错的正则不能等到运行到那一步才失败。 */
function compilesAsRegex(pattern: string): boolean {
  try {
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}

/** 图形校验：保存与启动共用。返回空数组表示可以落盘与运行。 */
export function validateWorkflowGraph(
  input: {
    readonly name: string
    readonly parameters: readonly WorkflowParameter[]
    readonly nodes: readonly WorkflowNode[]
    readonly edges: readonly WorkflowEdge[]
  }
): WorkflowIssueView[] {
  const issues: WorkflowIssueView[] = []
  const issue = (kind: WorkflowIssueKind, nodeId: string | null, message: string): void => {
    issues.push({ kind, nodeId, message })
  }
  if (input.name.trim() === '') issue('empty-name', null, '工作流名称不能为空。')
  if (input.nodes.length > MAX_WORKFLOW_NODES) issue('too-many-nodes', null, `节点数不能超过 ${MAX_WORKFLOW_NODES} 个。`)
  if (input.edges.length > MAX_WORKFLOW_EDGES) issue('too-many-edges', null, `边数不能超过 ${MAX_WORKFLOW_EDGES} 条。`)
  if (input.parameters.length > MAX_WORKFLOW_PARAMETERS) {
    issue('parameter-invalid', null, `参数不能超过 ${MAX_WORKFLOW_PARAMETERS} 个。`)
  }

  const parameterNames = new Set<string>()
  for (const parameter of input.parameters) {
    if (!PARAMETER_NAME_PATTERN.test(parameter.name)) {
      issue('parameter-invalid', null, `参数名「${parameter.name}」不合法：只能是小写字母开头，字母、数字或下划线。`)
      continue
    }
    if (parameterNames.has(parameter.name)) {
      issue('parameter-invalid', null, `参数名重复：${parameter.name}。`)
      continue
    }
    parameterNames.add(parameter.name)
    if (parameter.type === 'select' && parameter.options.length === 0) {
      issue('parameter-invalid', null, `参数「${parameter.label}」是下拉选择，但一个选项也没写。`)
    }
  }

  const ids = new Set<string>()
  for (const node of input.nodes) {
    if (ids.has(node.id)) issue('duplicate-node', node.id, `节点标识重复：${node.id}。`)
    ids.add(node.id)
    if (node.type === 'agent' && (node.expertId === null || node.prompt.trim() === '')) {
      issue('agent-node-incomplete', node.id, 'Agent 节点需要选专家并填写提示词。')
    }
    if (node.type === 'agent') {
      for (const name of workflowPlaceholders(node.prompt)) {
        if (!parameterNames.has(name)) {
          issue('placeholder-unknown', node.id, `提示词里的 {{${name}}} 没有对应参数。`)
        }
      }
    }
    if (node.type === 'approval' && node.title.trim() === '') {
      issue('approval-node-incomplete', node.id, '审批门需要写一个标题，让人知道要确认什么。')
    }
    if (node.type !== 'agent' && node.writeScope !== null && node.writeScope.length > 0) {
      issue('write-scope-invalid', node.id, '只有 Agent 节点可以配置写入范围。')
    }
  }

  const starts = input.nodes.filter(node => node.type === 'start')
  if (starts.length === 0) issue('no-start', null, '图里需要一个开始节点。')
  if (starts.length > 1) issue('multiple-start', null, '图里只能有一个开始节点。')
  if (!input.nodes.some(node => node.type === 'end')) issue('no-end', null, '图里需要一个结束节点。')

  const edgeIds = new Set<string>()
  const statusRoutes = new Set<string>()
  const conditionKeys = new Set<string>()
  for (const edge of input.edges) {
    if (edgeIds.has(edge.id)) issue('duplicate-edge', edge.id, `边标识重复：${edge.id}。`)
    edgeIds.add(edge.id)
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      issue('dangling-edge', null, `边的两端必须都是图上的节点：${edge.source} → ${edge.target}。`)
    }
    if (edge.route === 'condition') {
      if (edge.condition === null) {
        issue('condition-invalid', null, `条件边 ${edge.source} → ${edge.target} 缺少条件。`)
      } else if (edge.condition.kind === 'regex' && !compilesAsRegex(edge.condition.value)) {
        issue('condition-invalid', null, `条件边 ${edge.source} → ${edge.target} 的正则写错了。`)
      } else {
        const key = `${edge.source}:${edge.condition.kind}:${edge.condition.value}`
        if (conditionKeys.has(key)) {
          issue('duplicate-edge', edge.id, `同一节点上的重复条件：${edge.condition.value}。`)
        }
        conditionKeys.add(key)
      }
      continue
    }
    if (edge.condition !== null) {
      issue('condition-invalid', null, `只有条件边可以带条件：${edge.source} → ${edge.target}。`)
    }
    // 状态边里成功与失败各只能有一条：同一来源出现两条会让「走哪条」取决于书写顺序。
    if (edge.route === 'success' || edge.route === 'failure') {
      const key = `${edge.source}:${edge.route}`
      if (statusRoutes.has(key)) {
        issue('duplicate-edge', edge.id, `同一节点上的「${WORKFLOW_EDGE_ROUTE_LABELS[edge.route]}」路由只能有一条。`)
      }
      statusRoutes.add(key)
    }
  }

  if (hasCycle(input.nodes, input.edges)) issue('cycle', null, '图里存在环：运行无法收敛。')
  return issues
}

/** 环检测：只按边方向做一次深度优先，不依赖节点顺序。 */
function hasCycle(nodes: readonly WorkflowNode[], edges: readonly WorkflowEdge[]): boolean {
  const outgoing = new Map<string, string[]>()
  for (const node of nodes) outgoing.set(node.id, [])
  for (const edge of edges) {
    const list = outgoing.get(edge.source)
    if (list !== undefined && outgoing.has(edge.target)) list.push(edge.target)
  }
  const visiting = new Set<string>()
  const done = new Set<string>()
  const walk = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (done.has(id)) return false
    visiting.add(id)
    for (const next of outgoing.get(id) ?? []) {
      if (walk(next)) return true
    }
    visiting.delete(id)
    done.add(id)
    return false
  }
  for (const node of nodes) {
    if (walk(node.id)) return true
  }
  return false
}

/** 条件求值：只看文本层面的匹配，不做语义判断。正则已在保存时校验过，运行时失败按不命中处理。 */
export function evaluateWorkflowCondition(condition: WorkflowEdgeCondition, output: string): boolean {
  switch (condition.kind) {
    case 'contains': return output.includes(condition.value)
    case 'not-contains': return !output.includes(condition.value)
    case 'equals': return output.trim() === condition.value.trim()
    case 'not-equals': return output.trim() !== condition.value.trim()
    case 'regex':
      try {
        return new RegExp(condition.value).test(output)
      } catch {
        return false
      }
    default: return false
  }
}

/** 参数名即占位符名：小写字母开头，只允许小写字母、数字与下划线。 */
const PARAMETER_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/
const PLACEHOLDER_PATTERN = /\{\{([a-z][a-z0-9_]{0,31})\}\}/g

/** 提示词里引用的参数名：去重，保持出现顺序。 */
export function workflowPlaceholders(text: string): string[] {
  const names: string[] = []
  for (const matched of text.matchAll(PLACEHOLDER_PATTERN)) {
    const name = matched[1]
    if (name !== undefined && !names.includes(name)) names.push(name)
  }
  return names
}

/** 把已声明的占位符换成实际值；定义与值都由调用方校验过，这里只做替换。 */
export function applyWorkflowParameters(text: string, values: WorkflowParameterValues): string {
  return text.replace(PLACEHOLDER_PATTERN, (whole, name: string) => (
    Object.hasOwn(values, name) ? values[name] : whole
  ))
}

/** 缺值的必填参数：调用方据此拒绝启动。有默认值的参数在启动前已补齐，不算缺。 */
export function missingWorkflowParameters(
  parameters: readonly WorkflowParameter[],
  values: WorkflowParameterValues
): string[] {
  return parameters
    .filter(item => item.required && (values[item.name] ?? item.defaultValue).trim() === '')
    .map(item => item.name)
}

/** 用默认值补齐未提供的参数，返回一份可直接用于运行的完整值。 */
export function resolveWorkflowParameters(
  parameters: readonly WorkflowParameter[],
  values: WorkflowParameterValues
): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const item of parameters) {
    const provided = values[item.name]
    resolved[item.name] = typeof provided === 'string' && provided !== '' ? provided : item.defaultValue
  }
  return resolved
}

function isParameterType(value: unknown): value is WorkflowParameterType {
  return WORKFLOW_PARAMETER_TYPES.some(type => type === value)
}

/** 参数解析：名称不合法或字段缺失即整个参数作废，不让半份配置进入定义。 */
export function parseWorkflowParameter(value: unknown): WorkflowParameter | null {
  if (!isRecord(value)) return null
  if (typeof value.name !== 'string' || !PARAMETER_NAME_PATTERN.test(value.name)) return null
  if (!isParameterType(value.type)) return null
  const label = typeof value.label === 'string' ? value.label.slice(0, MAX_WORKFLOW_PARAMETER_LABEL) : ''
  const options: string[] = []
  if (Array.isArray(value.options)) {
    for (const item of value.options.slice(0, MAX_WORKFLOW_PARAMETER_OPTIONS)) {
      if (typeof item !== 'string' || item === '') continue
      options.push(item.slice(0, MAX_WORKFLOW_PARAMETER_VALUE))
    }
  }
  return {
    name: value.name,
    label: label === '' ? value.name : label,
    type: value.type,
    required: value.required === true,
    defaultValue: typeof value.defaultValue === 'string'
      ? value.defaultValue.slice(0, MAX_WORKFLOW_PARAMETER_VALUE)
      : '',
    options: value.type === 'select' ? options : []
  }
}

/** 参数值表：只保留字符串值，长度截断；不认识的键不进入运行。 */
export function parseParameterValues(value: unknown): Record<string, string> {
  const values: Record<string, string> = {}
  if (!isRecord(value)) return values
  for (const [key, item] of Object.entries(value)) {
    if (!PARAMETER_NAME_PATTERN.test(key) || typeof item !== 'string') continue
    values[key] = item.slice(0, MAX_WORKFLOW_PARAMETER_VALUE)
  }
  return values
}

/**
 * 五段 cron 的字段解析：支持 `*`、数字、区间、逗号列表，以及用星号加斜杠加数字表示的步长。
 * 返回 null 表示写法不合法，由校验层报错。
 */
function parseCronField(field: string, min: number, max: number): ((value: number) => boolean) | null {
  const testers: ((value: number) => boolean)[] = []
  for (const part of field.split(',')) {
    const text = part.trim()
    if (text === '') return null
    if (text === '*') {
      testers.push(() => true)
      continue
    }
    const stepMatch = /^\*\/(\d+)$/.exec(text)
    if (stepMatch !== null) {
      const step = Number(stepMatch[1])
      if (!Number.isInteger(step) || step <= 0) return null
      testers.push(value => (value - min) % step === 0)
      continue
    }
    const rangeStep = /^(\d+)-(\d+)\/(\d+)$/.exec(text)
    if (rangeStep !== null) {
      const from = Number(rangeStep[1]), to = Number(rangeStep[2]), step = Number(rangeStep[3])
      if (from < min || to > max || from > to || step <= 0) return null
      testers.push(value => value >= from && value <= to && (value - from) % step === 0)
      continue
    }
    const range = /^(\d+)-(\d+)$/.exec(text)
    if (range !== null) {
      const from = Number(range[1]), to = Number(range[2])
      if (from < min || to > max || from > to) return null
      testers.push(value => value >= from && value <= to)
      continue
    }
    if (!/^\d+$/.test(text)) return null
    const single = Number(text)
    if (single < min || single > max) return null
    testers.push(value => value === single)
  }
  if (testers.length === 0) return null
  return value => testers.some(tester => tester(value))
}

/** cron 是否写得合法；保存与运行共用。 */
export function isWorkflowCron(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const fields = value.trim().split(/\s+/)
  if (fields.length !== 5) return false
  return parseCronField(fields[0] ?? '', 0, 59) !== null
    && parseCronField(fields[1] ?? '', 0, 23) !== null
    && parseCronField(fields[2] ?? '', 1, 31) !== null
    && parseCronField(fields[3] ?? '', 1, 12) !== null
    && parseCronField(fields[4] ?? '', 0, 6) !== null
}

/**
 * cron 是否命中给定时刻（秒与毫秒忽略）。
 * 日与周两段都写死时按 POSIX 语义取「任一命中」；只写一个时按与运算。
 */
export function matchesWorkflowCron(cron: string, at: Date): boolean {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields as [string, string, string, string, string]
  const minute = parseCronField(minuteField, 0, 59)
  const hour = parseCronField(hourField, 0, 23)
  const day = parseCronField(dayField, 1, 31)
  const month = parseCronField(monthField, 1, 12)
  const weekday = parseCronField(weekdayField, 0, 6)
  if (minute === null || hour === null || day === null || month === null || weekday === null) return false
  if (!minute(at.getMinutes()) || !hour(at.getHours()) || !month(at.getMonth() + 1)) return false
  const dayMatched = day(at.getDate())
  const weekdayMatched = weekday(at.getDay())
  // 与 POSIX 一致：只有字段真的是 `*` 才算未限制，`*/2` 属于受限（参与 OR 组合）。
  const dayRestricted = dayField.trim() !== '*'
  const weekdayRestricted = weekdayField.trim() !== '*'
  if (dayRestricted && weekdayRestricted) return dayMatched || weekdayMatched
  return dayMatched && weekdayMatched
}

function parseNodeRun(value: unknown): WorkflowNodeRun | null {
  if (!isRecord(value)) return null
  if (typeof value.nodeId !== 'string' || !isNodeStatus(value.status)) return null
  return {
    nodeId: value.nodeId,
    status: value.status,
    startedAt: isCount(value.startedAt) ? Math.floor(value.startedAt) : null,
    finishedAt: isCount(value.finishedAt) ? Math.floor(value.finishedAt) : null,
    output: typeof value.output === 'string' ? value.output.slice(0, MAX_WORKFLOW_NODE_OUTPUT) : null,
    failure: isNodeFailure(value.failure) ? value.failure : null
  }
}

function parseRunEvent(value: unknown): WorkflowRunEvent | null {
  if (!isRecord(value)) return null
  if (!isCount(value.at) || typeof value.message !== 'string') return null
  const level = value.level === 'warn' || value.level === 'error' ? value.level : 'info'
  return {
    at: Math.floor(value.at),
    nodeId: typeof value.nodeId === 'string' && value.nodeId !== '' ? value.nodeId : null,
    level,
    message: value.message.slice(0, MAX_WORKFLOW_EVENT_TEXT)
  }
}

export function parseWorkflowRun(value: unknown): WorkflowRun | null {
  if (!isRecord(value)) return null
  if (typeof value.runId !== 'string' || value.runId === '') return null
  if (!isWorkflowId(value.workflowId)) return null
  if (typeof value.projectPath !== 'string' || value.projectPath === '') return null
  if (!isRunStatus(value.status)) return null
  if (!isCount(value.startedAt)) return null
  if (!Array.isArray(value.nodes) || !Array.isArray(value.events)) return null
  const nodes: WorkflowNodeRun[] = []
  for (const item of value.nodes) {
    const node = parseNodeRun(item)
    if (node === null) return null
    nodes.push(node)
  }
  const events: WorkflowRunEvent[] = []
  for (const item of value.events) {
    const event = parseRunEvent(item)
    if (event === null) continue
    events.push(event)
  }
  return {
    runId: value.runId,
    workflowId: value.workflowId,
    workflowName: typeof value.workflowName === 'string' ? value.workflowName : '',
    projectPath: value.projectPath,
    status: value.status,
    startedAt: Math.floor(value.startedAt),
    finishedAt: isCount(value.finishedAt) ? Math.floor(value.finishedAt) : null,
    nodes,
    events
  }
}

export function isWorkflowRun(value: unknown): value is WorkflowRun {
  return parseWorkflowRun(value) !== null
}

/** 运行摘要解析：回放列表只依赖这几个字段。 */
export function parseWorkflowRunSummary(value: unknown): WorkflowRunSummary | null {
  if (!isRecord(value)) return null
  if (typeof value.runId !== 'string' || value.runId === '') return null
  if (!isWorkflowId(value.workflowId)) return null
  if (!isRunStatus(value.status)) return null
  if (!isCount(value.startedAt)) return null
  return {
    runId: value.runId,
    workflowId: value.workflowId,
    workflowName: typeof value.workflowName === 'string' ? value.workflowName : '',
    status: value.status,
    startedAt: Math.floor(value.startedAt),
    finishedAt: isCount(value.finishedAt) ? Math.floor(value.finishedAt) : null,
    nodeCount: isCount(value.nodeCount) ? Math.floor(value.nodeCount) : 0
  }
}

export function isWorkflowsListOutcome(value: unknown): value is WorkflowsListOutcome {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  if (!value.ok) return isRecord(value.error) && typeof value.error.code === 'string'
  const data = value.data
  if (!isRecord(data) || !Array.isArray(data.workflows)) return false
  return data.workflows.every(item => isRecord(item)
    && isWorkflowId(item.id)
    && typeof item.name === 'string'
    && typeof item.summary === 'string'
    && isCount(item.nodeCount)
    && isCount(item.updatedAt))
}

export function isWorkflowReadOutcome(value: unknown): value is WorkflowReadOutcome {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  if (!value.ok) return isRecord(value.error) && typeof value.error.code === 'string'
  return isWorkflowDefinition(value.data)
}

export function isWorkflowSaveOutcome(value: unknown): value is WorkflowSaveOutcome {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  if (!value.ok) return isRecord(value.error) && typeof value.error.code === 'string'
  return isRecord(value.data) && isWorkflowId(value.data.workflowId)
}

export function isWorkflowDeleteOutcome(value: unknown): value is WorkflowDeleteOutcome {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  if (!value.ok) return isRecord(value.error) && typeof value.error.code === 'string'
  return isRecord(value.data)
}

export function isWorkflowRunOutcome(value: unknown): value is WorkflowRunOutcome {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  if (!value.ok) return isRecord(value.error) && typeof value.error.code === 'string'
  return isWorkflowRun(value.data)
}

export function isWorkflowRunsListOutcome(value: unknown): value is WorkflowRunsListOutcome {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  if (!value.ok) return isRecord(value.error) && typeof value.error.code === 'string'
  const data = value.data
  if (!isRecord(data) || !Array.isArray(data.runs)) return false
  return data.runs.every(item => parseWorkflowRunSummary(item) !== null)
}

export function isWorkflowRunsClearOutcome(value: unknown): value is WorkflowRunsClearOutcome {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  if (!value.ok) return isRecord(value.error) && typeof value.error.code === 'string'
  return isRecord(value.data) && typeof value.data.removed === 'number'
}

export function isWorkflowReadRequest(value: unknown): value is WorkflowReadRequest {
  return isRecord(value) && isWorkflowId(value.workflowId) && Object.keys(value).length === 1
}

export function isWorkflowDeleteRequest(value: unknown): value is WorkflowDeleteRequest {
  return isRecord(value) && isWorkflowId(value.workflowId) && Object.keys(value).length === 1
}

export function isWorkflowRunsListRequest(value: unknown): value is WorkflowRunsListRequest {
  return isRecord(value) && isWorkflowId(value.workflowId) && Object.keys(value).length === 1
}

export function isWorkflowRunStartRequest(value: unknown): value is WorkflowRunStartRequest {
  if (!isRecord(value) || Object.keys(value).length !== 3) return false
  if (!isWorkflowId(value.workflowId)) return false
  if (typeof value.projectPath !== 'string' || value.projectPath === '') return false
  return isParameterValues(value.parameters)
}

/** 参数值表只接受合法参数名到字符串的映射；多出来的键不算错，运行时会被忽略。 */
function isParameterValues(value: unknown): value is WorkflowParameterValues {
  if (!isRecord(value)) return false
  return Object.entries(value).every(([key, item]) => PARAMETER_NAME_PATTERN.test(key) && typeof item === 'string')
}

export function isWorkflowSchedulesListRequest(value: unknown): value is WorkflowSchedulesListRequest {
  return isRecord(value) && isWorkflowId(value.workflowId) && Object.keys(value).length === 1
}

export function isWorkflowScheduleSaveRequest(value: unknown): value is WorkflowScheduleSaveRequest {
  if (!isRecord(value) || Object.keys(value).length !== 6) return false
  if (value.scheduleId !== '' && typeof value.scheduleId !== 'string') return false
  if (!isWorkflowId(value.workflowId)) return false
  if (!isWorkflowCron(value.cron)) return false
  if (typeof value.projectPath !== 'string' || value.projectPath === '') return false
  if (typeof value.enabled !== 'boolean') return false
  return isParameterValues(value.parameters)
}

export function isWorkflowScheduleDeleteRequest(value: unknown): value is WorkflowScheduleDeleteRequest {
  return isRecord(value) && isWorkflowScheduleId(value.scheduleId) && Object.keys(value).length === 1
}

export function isWorkflowScheduleRunRequest(value: unknown): value is WorkflowScheduleRunRequest {
  return isRecord(value) && isWorkflowScheduleId(value.scheduleId) && Object.keys(value).length === 1
}

/** 调度解析：cron 写坏了整条作废，不让一条非法定时任务进入清单。 */
export function parseWorkflowSchedule(value: unknown): WorkflowSchedule | null {
  if (!isRecord(value)) return null
  if (!isWorkflowScheduleId(value.id)) return null
  if (!isWorkflowId(value.workflowId)) return null
  if (!isWorkflowCron(value.cron)) return null
  if (typeof value.projectPath !== 'string' || value.projectPath === '') return null
  return {
    id: value.id,
    workflowId: value.workflowId,
    cron: value.cron,
    projectPath: value.projectPath,
    parameters: parseParameterValues(value.parameters),
    enabled: value.enabled === true
  }
}

export function isWorkflowSchedulesListOutcome(value: unknown): value is WorkflowSchedulesListOutcome {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  if (!value.ok) return isRecord(value.error) && typeof value.error.code === 'string'
  const data = value.data
  if (!isRecord(data) || !Array.isArray(data.schedules)) return false
  return data.schedules.every(item => parseWorkflowSchedule(item) !== null)
}

export function isWorkflowScheduleSaveOutcome(value: unknown): value is WorkflowScheduleSaveOutcome {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  if (!value.ok) return isRecord(value.error) && typeof value.error.code === 'string'
  return isRecord(value.data) && typeof value.data.scheduleId === 'string' && value.data.scheduleId !== ''
}

export function isWorkflowScheduleDeleteOutcome(value: unknown): value is WorkflowScheduleDeleteOutcome {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  if (!value.ok) return isRecord(value.error) && typeof value.error.code === 'string'
  return isRecord(value.data)
}

export function isWorkflowRunCancelRequest(value: unknown): value is WorkflowRunCancelRequest {
  return isRecord(value) && isWorkflowRunId(value.runId) && Object.keys(value).length === 1
}

export function isWorkflowRunReadRequest(value: unknown): value is WorkflowRunReadRequest {
  return isRecord(value) && isWorkflowRunId(value.runId) && Object.keys(value).length === 1
}

export function isWorkflowRunApproveRequest(value: unknown): value is WorkflowRunApproveRequest {
  if (!isRecord(value) || Object.keys(value).length !== 3) return false
  if (!isWorkflowRunId(value.runId)) return false
  if (typeof value.nodeId !== 'string' || !NODE_ID_PATTERN.test(value.nodeId)) return false
  return typeof value.approved === 'boolean'
}

/** 保存请求校验：结构先过一遍，图级问题由 `validateWorkflowGraph` 给具体项。 */
export function isWorkflowSaveRequest(value: unknown): value is WorkflowSaveRequest {
  if (!isRecord(value)) return false
  if (value.workflowId !== '' && !isWorkflowId(value.workflowId)) return false
  if (typeof value.name !== 'string' || typeof value.summary !== 'string') return false
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) return false
  if (!Array.isArray(value.parameters)) return false
  return value.parameters.every(item => parseWorkflowParameter(item) !== null)
    && value.nodes.every(item => parseWorkflowNode(item) !== null)
    && value.edges.every(item => parseWorkflowEdge(item) !== null)
}
