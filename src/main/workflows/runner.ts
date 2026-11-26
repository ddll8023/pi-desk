/**
 * 工作流运行的调度与生命周期：按图推进节点、记状态、推快照、支持取消。
 *
 * 调度规则（阶段一）：
 * - 只有 `start` / `agent` / `end` 三类节点；`start` 与 `end` 不启进程，直接收敛。
 * - 一个节点的所有入边来源都已终态时才判定它：任一条被激活即执行，全部未激活即跳过。
 * - 节点完成激活 `success` 与 `always` 出边，失败或中断激活 `failure` 与 `always` 出边。
 * - 同层并发受 `MAX_WORKFLOW_CONCURRENCY` 约束；用户取消会终止全部活跃子进程。
 *
 * 运行只在主进程内存里推进，落盘与推送是它的观测面：记录写不进去不中断运行。
 */
import { getPiAgentDir } from '../shared/pi-paths'
import { sendToRenderer } from '../window-channel'
import {
  MAX_WORKFLOW_CONCURRENCY,
  MAX_WORKFLOW_EVENT_TEXT,
  MAX_WORKFLOW_RUN_EVENTS,
  WORKFLOW_CONDITION_LABELS,
  WORKFLOW_NODE_TIMEOUT_MS,
  applyWorkflowParameters,
  evaluateWorkflowCondition
} from '../../shared/workflow-api'
import type {
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeFailure,
  WorkflowNodeRun,
  WorkflowNodeStatus,
  WorkflowParameterValues,
  WorkflowRun,
  WorkflowRunEvent
} from '../../shared/workflow-api'
import { WORKFLOW_RUN_EVENT } from '../../shared/workflow-api'
import { saveWorkflowRun, workflowNodeSessionDir } from './run-store'
import { resetExpertCache, resolveNodeRole, runWorkflowNode } from './node-runner'

/** 节点终态：进入这些状态后不再变化，边的激活判定只读它们。 */
const TERMINAL_STATUSES: readonly WorkflowNodeStatus[] = ['completed', 'failed', 'cancelled', 'skipped']

function isTerminal(status: WorkflowNodeStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

interface ActiveRun {
  readonly runId: string
  readonly definition: WorkflowDefinition
  readonly projectPath: string
  /** 本次运行的参数值（已按定义补齐默认值）：节点提示词里的占位符用它替换。 */
  readonly parameters: WorkflowParameterValues
  readonly startedAt: number
  cancelled: boolean
  /** 已开始过一轮的节点：同一节点在一次运行里最多执行一次。 */
  readonly launched: Set<string>
  readonly statuses: Map<string, WorkflowNodeStatus>
  readonly nodeRuns: Map<string, WorkflowNodeRun>
  /** 已被激活的边：节点的就绪判定只看这个集合。 */
  readonly activatedEdges: Set<string>
  /** 等待中的审批门：节点标识 → 决定回调；审批与取消都走这里释放。 */
  readonly approvals: Map<string, (decision: ApprovalDecision) => void>
  readonly events: WorkflowRunEvent[]
  finished: boolean
}

/** 审批门的三种出口；取消是整次运行的结局，不能记成对这个节点的否决。 */
type ApprovalDecision = 'approved' | 'rejected' | 'cancelled'

const activeRuns = new Map<string, ActiveRun>()

function agentDir(): string {
  return getPiAgentDir()
}

function allocateRunId(): string {
  const stamp = Date.now().toString(36)
  let candidate = `run-${stamp}`
  let suffix = 1
  while (activeRuns.has(candidate)) {
    candidate = `run-${stamp}-${suffix}`
    suffix += 1
  }
  return candidate
}

function incomingEdges(definition: WorkflowDefinition, nodeId: string): readonly WorkflowEdge[] {
  return definition.edges.filter(edge => edge.target === nodeId)
}

/** 快照：每次推送与落盘都用新对象，页面拿到的值不会随后续推进被改写。 */
function snapshot(state: ActiveRun): WorkflowRun {
  const nodes = state.definition.nodes.map(node => state.nodeRuns.get(node.id) ?? idleNodeRun(node))
  const finished = state.finished
  const statuses = nodes.map(node => node.status)
  const status = !finished
    ? 'running'
    : state.cancelled || statuses.includes('cancelled')
      ? 'cancelled'
      : statuses.includes('failed') ? 'failed' : 'completed'
  const finishedAt = finished
    ? nodes.reduce<number | null>((latest, node) => (
        node.finishedAt !== null && (latest === null || node.finishedAt > latest) ? node.finishedAt : latest
      ), null) ?? Date.now()
    : null
  return {
    runId: state.runId,
    workflowId: state.definition.id,
    workflowName: state.definition.name,
    projectPath: state.projectPath,
    status,
    startedAt: state.startedAt,
    finishedAt,
    nodes,
    events: [...state.events]
  }
}

function idleNodeRun(node: WorkflowNode): WorkflowNodeRun {
  return { nodeId: node.id, status: 'idle', startedAt: null, finishedAt: null, output: null, failure: null }
}

function publish(state: ActiveRun): void {
  const run = snapshot(state)
  sendToRenderer(WORKFLOW_RUN_EVENT, run)
  void saveWorkflowRun(agentDir(), run)
}

function pushEvent(
  state: ActiveRun,
  nodeId: string | null,
  level: WorkflowRunEvent['level'],
  message: string
): void {
  state.events.push({
    at: Date.now(),
    nodeId,
    level,
    message: message.slice(0, MAX_WORKFLOW_EVENT_TEXT)
  })
  if (state.events.length > MAX_WORKFLOW_RUN_EVENTS) state.events.splice(0, state.events.length - MAX_WORKFLOW_RUN_EVENTS)
}

function settleNode(
  state: ActiveRun,
  node: WorkflowNode,
  status: WorkflowNodeStatus,
  output: string | null,
  failure: WorkflowNodeFailure | null
): void {
  const existing = state.nodeRuns.get(node.id)
  const startedAt = existing?.startedAt ?? (status === 'skipped' ? null : Date.now())
  state.statuses.set(node.id, status)
  state.nodeRuns.set(node.id, {
    nodeId: node.id,
    status,
    startedAt,
    finishedAt: status === 'skipped' ? null : Date.now(),
    output,
    failure
  })
  if (status === 'completed') {
    activateEdges(state, node, status, output)
  } else if (status === 'failed') {
    activateEdges(state, node, status, output)
  }
}

/**
 * 激活出边：状态边优先，没有状态边可走时才按定义顺序取第一条命中的条件边。
 * 取消不激活任何边——整次运行已经结束；审批拒绝按失败处理，走 `failure` 与 `always`。
 */
function activateEdges(
  state: ActiveRun,
  node: WorkflowNode,
  status: 'completed' | 'failed',
  output: string | null
): void {
  const statusRoute = status === 'completed' ? 'success' : 'failure'
  const outgoing = state.definition.edges.filter(edge => edge.source === node.id)
  let activated = false
  for (const edge of outgoing) {
    if (edge.route === statusRoute || edge.route === 'always') {
      state.activatedEdges.add(edge.id)
      activated = true
    }
  }
  if (activated || output === null) return
  for (const edge of outgoing) {
    if (edge.route !== 'condition' || edge.condition === null) continue
    if (!evaluateWorkflowCondition(edge.condition, output)) continue
    state.activatedEdges.add(edge.id)
    pushEvent(
      state, node.id, 'info',
      `条件「${WORKFLOW_CONDITION_LABELS[edge.condition.kind]} ${edge.condition.value}」命中。`
    )
    return
  }
}

/** 就绪判定：入边来源全部终态，且至少一条入边被激活。 */
function isReady(state: ActiveRun, node: WorkflowNode): boolean {
  const incoming = incomingEdges(state.definition, node.id)
  if (incoming.length === 0) return true
  const sourcesSettled = incoming.every(edge => {
    const status = state.statuses.get(edge.source)
    return status !== undefined && isTerminal(status)
  })
  if (!sourcesSettled) return false
  return incoming.some(edge => state.activatedEdges.has(edge.id))
}

/** 跳过判定：入边来源全部终态，但没有一条被激活。 */
function shouldSkip(state: ActiveRun, node: WorkflowNode): boolean {
  const incoming = incomingEdges(state.definition, node.id)
  if (incoming.length === 0) return false
  const sourcesSettled = incoming.every(edge => {
    const status = state.statuses.get(edge.source)
    return status !== undefined && isTerminal(status)
  })
  if (!sourcesSettled) return false
  return !incoming.some(edge => state.activatedEdges.has(edge.id))
}

async function launch(state: ActiveRun, node: WorkflowNode): Promise<void> {
  state.launched.add(node.id)
  if (node.type === 'start' || node.type === 'end') {
    pushEvent(state, node.id, 'info', `${node.title === '' ? node.type : node.title} 通过。`)
    settleNode(state, node, 'completed', null, null)
    publish(state)
    return
  }

  // 审批门：不启进程，等人给决定；把节点标为 waiting 让运行面板能定位到它。
  if (node.type === 'approval') {
    state.statuses.set(node.id, 'waiting')
    state.nodeRuns.set(node.id, {
      nodeId: node.id,
      status: 'waiting',
      startedAt: Date.now(),
      finishedAt: null,
      output: null,
      failure: null
    })
    pushEvent(state, node.id, 'info', node.prompt.trim() === '' ? '等待人工审批。' : `等待人工审批：${node.prompt.trim()}`)
    publish(state)
    const decision = await waitApproval(state, node.id)
    if (decision === 'cancelled') {
      settleNode(state, node, 'cancelled', null, 'aborted')
      pushEvent(state, node.id, 'warn', '审批等待已随运行取消。')
      publish(state)
      return
    }
    const approved = decision === 'approved'
    settleNode(state, node, approved ? 'completed' : 'failed', null, approved ? null : 'rejected')
    pushEvent(state, node.id, approved ? 'info' : 'warn', approved ? '审批通过。' : '审批被拒绝。')
    publish(state)
    return
  }

  const role = resolveNodeRole(node.expertId, node.writeScope)
  if (node.expertId !== null && role.systemPrompt === '') {
    pushEvent(state, node.id, 'warn', `专家 ${node.expertId} 不可用，本节点按无角色段运行。`)
  }
  if (role.tools !== null && role.tools.length === 0) {
    // 专家选了「仅用选中工具」却一个都没选：不传 `--tools`，但要让人看到范围没生效。
    pushEvent(state, node.id, 'warn', '专家的工具范围为空，本节点按默认工具集运行。')
  }

  state.statuses.set(node.id, 'running')
  state.nodeRuns.set(node.id, {
    nodeId: node.id,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    output: null,
    failure: null
  })
  pushEvent(state, node.id, 'info', '节点开始执行。')
  publish(state)

  const outcome = await runWorkflowNode({
    cwd: state.projectPath,
    sessionDir: workflowNodeSessionDir(agentDir(), state.runId, node.id),
    sessionId: node.id,
    instruction: applyWorkflowParameters(node.prompt, state.parameters),
    systemPrompt: role.systemPrompt,
    writeScope: role.writeScope,
    tools: role.tools,
    timeoutMs: WORKFLOW_NODE_TIMEOUT_MS,
    signal: { get cancelled() { return state.cancelled } }
  })

  settleNode(state, node, outcome.status, outcome.output, outcome.failure)
  const level = outcome.status === 'completed' ? 'info' : 'error'
  const detail = outcome.failure === null ? '完成' : `以「${outcome.failure}」结束`
  pushEvent(state, node.id, level, `节点${detail}。`)
  publish(state)
}

/** 审批等待：把回调存进运行状态，审批与取消都通过它释放。 */
function waitApproval(state: ActiveRun, nodeId: string): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>(resolve => {
    state.approvals.set(nodeId, resolve)
  })
}

/** 节点抛错时的收敛：已终态的不重复结算，未终态的记失败并说明。 */
function settleFailed(state: ActiveRun, node: WorkflowNode): void {
  const status = state.statuses.get(node.id)
  if (status !== undefined && isTerminal(status)) return
  pushEvent(state, node.id, 'error', '节点执行时发生异常，按失败处理。')
  settleNode(state, node, 'failed', null, 'error')
  publish(state)
}

/** 调度主循环：就绪即启动，满并发就等一个收敛，直到没有可推进的节点。 */
async function drive(state: ActiveRun): Promise<void> {
  const running = new Map<string, Promise<void>>()
  try {
    for (;;) {
      if (state.cancelled) {
        await Promise.allSettled([...running.values()])
        break
      }
      // 跳过判定循环到本轮无新增：节点在数组里的顺序不代表图的顺序，
      // 单遍遍历会让排在数组后面的分支漏判，最后被收尾错记成中断。
      let skippedAny = true
      while (skippedAny) {
        skippedAny = false
        for (const node of state.definition.nodes) {
          if (state.launched.has(node.id)) continue
          if (!shouldSkip(state, node)) continue
          settleNode(state, node, 'skipped', null, null)
          pushEvent(state, node.id, 'info', '入边都未激活，节点跳过。')
          publish(state)
          skippedAny = true
        }
      }

      const ready = state.definition.nodes.filter(node => !state.launched.has(node.id) && isReady(state, node))
      if (ready.length === 0) {
        if (running.size === 0) break
        await Promise.race(running.values())
        continue
      }
      for (const node of ready) {
        while (running.size >= MAX_WORKFLOW_CONCURRENCY) await Promise.race(running.values())
        if (state.cancelled) break
        const promise = launch(state, node)
          // 单个节点抛错不能让整次运行卡在 running：按失败收敛，其余分支继续。
          .catch(() => { settleFailed(state, node) })
          .finally(() => running.delete(node.id))
        running.set(node.id, promise)
      }
    }
  } finally {
    // 收尾：仍在跑、在等审批或排队的节点只可能是取消路径留下的，记中断；
    // 从未开始的节点保持 idle，不冒充中断——否则整次运行会被误判成 cancelled。
    for (const [nodeId, status] of state.statuses) {
      if (isTerminal(status)) continue
      const node = state.definition.nodes.find(item => item.id === nodeId)
      if (node === undefined) continue
      if (status === 'running' || status === 'waiting' || status === 'queued') {
        settleNode(state, node, 'cancelled', null, 'aborted')
      }
    }
    state.finished = true
    if (state.cancelled) pushEvent(state, null, 'warn', '运行已被用户取消。')
    else pushEvent(state, null, 'info', '运行结束。')
    activeRuns.delete(state.runId)
    publish(state)
    state.events.length = 0
  }
}

/** 启动一次运行：返回首个快照，后续推进在后台进行。 */
export function startWorkflowRun(
  definition: WorkflowDefinition,
  projectPath: string,
  parameters: WorkflowParameterValues
): WorkflowRun {
  const state: ActiveRun = {
    runId: allocateRunId(),
    definition,
    projectPath,
    parameters,
    startedAt: Date.now(),
    cancelled: false,
    launched: new Set(),
    statuses: new Map(),
    nodeRuns: new Map(),
    activatedEdges: new Set(),
    approvals: new Map(),
    events: [],
    finished: false
  }
  for (const node of definition.nodes) state.statuses.set(node.id, 'idle')
  // 每次运行重新读一次专家清单：专家改版后下一轮运行就按新正文跑。
  resetExpertCache()
  activeRuns.set(state.runId, state)
  pushEvent(state, null, 'info', `开始运行「${definition.name}」。`)
  publish(state)
  void drive(state)
  return snapshot(state)
}

/** 取消一次运行：只置标记，子进程由节点载体在下一轮检查时终止。 */
export function cancelWorkflowRun(runId: string): WorkflowRun | null {
  const state = activeRuns.get(runId)
  if (state === undefined) return null
  state.cancelled = true
  // 等待中的审批门没有人会再点：先全部释放为「取消」，否则调度循环永远挂着。
  for (const resolve of state.approvals.values()) resolve('cancelled')
  state.approvals.clear()
  pushEvent(state, null, 'warn', '收到取消请求，正在终止活跃节点。')
  const run = snapshot(state)
  sendToRenderer(WORKFLOW_RUN_EVENT, run)
  return run
}

/** 对等待中的审批门给出决定；没有这个等待中的节点时返回 null，由调用方报错。 */
export function approveWorkflowNode(runId: string, nodeId: string, approved: boolean): WorkflowRun | null {
  const state = activeRuns.get(runId)
  if (state === undefined) return null
  const resolve = state.approvals.get(nodeId)
  if (resolve === undefined) return null
  state.approvals.delete(nodeId)
  resolve(approved ? 'approved' : 'rejected')
  return snapshot(state)
}

/** 内存里的活跃运行快照；不在内存中时返回 null，由调用方回落到文件。 */
export function activeWorkflowRun(runId: string): WorkflowRun | null {
  const state = activeRuns.get(runId)
  return state === undefined ? null : snapshot(state)
}

/** 仍在推进的运行标识：清空记录时跳过它们，避免删掉一个马上就会被重写的目录。 */
export function liveWorkflowRunIds(): ReadonlySet<string> {
  return new Set(activeRuns.keys())
}

/** 这份工作流是否有运行正在推进：定时触发据此跳过本次，不排队补跑。 */
export function hasRunningWorkflow(workflowId: string): boolean {
  for (const state of activeRuns.values()) {
    if (state.definition.id === workflowId) return true
  }
  return false
}
