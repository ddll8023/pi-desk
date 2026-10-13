/** 只定义「会话运行状态」查询与事件的固定通道、载荷类型与跨进程校验；页面据此展示后台会话的运行、等待与未确认状态。 */

export const SESSION_RUNS_STATE_CHANNEL = 'desktop:session-runs-state'
export const SESSION_RUNS_EVENT = 'desktop:session-runs-changed'

/** 运行实例生命周期阶段；`unconfirmed` 表示退出或关闭结果未确认，占用与状态都必须如实保留。 */
export type SessionRunPhase = 'idle' | 'opening' | 'running' | 'closing' | 'unconfirmed'

/** 宿主进程状态；`none` 表示该实例还没有宿主进程。 */
export type SessionRunHostState = 'none' | 'starting' | 'ready' | 'recovering' | 'stopping' | 'failed'

/**
 * 单个运行实例的粗粒度状态。只含低频变化的展示字段：消息条数、用量、速率等流式期间高频变化的
 * 内容不在这里表达，页面需要时另读 Runtime 状态通道，避免每次消息都触发一次广播。
 */
export interface SessionRunState {
  readonly runId: number
  readonly projectPath: string | null
  readonly sessionId: string | null
  readonly phase: SessionRunPhase
  /** 是否当前前台实例；同一时刻至多一个为真。 */
  readonly isForeground: boolean
  /** 绑定会话是否正在执行（模型或工具工作）；未绑定时为 false。 */
  readonly isStreaming: boolean
  /** 等待用户回应的审批或扩展输入条数；等待不属于空闲。 */
  readonly waitingDialogs: number
  readonly hostState: SessionRunHostState
}

export interface SessionRunsSnapshot {
  readonly runs: readonly SessionRunState[]
}

export type SessionRunsResult =
  | { readonly ok: true; readonly data: SessionRunsSnapshot }
  | {
      readonly ok: false
      readonly error: {
        readonly code: 'FORBIDDEN' | 'INVALID_REQUEST' | 'INTERNAL_ERROR' | 'BRIDGE_UNAVAILABLE' | 'BRIDGE_CALL_FAILED'
        readonly message: string
      }
    }

export interface SessionRunApi {
  /** 读取应用内全部运行实例的粗粒度状态；不建立宿主、不触发任何会话操作。 */
  readonly getSessionRuns: () => Promise<SessionRunsResult>
  /** 订阅运行状态变化；返回释放函数，页面卸载时必须调用。 */
  readonly onSessionRunsChanged: (listener: (snapshot: SessionRunsSnapshot) => void) => () => void
}

const SESSION_RUN_PHASES: readonly SessionRunPhase[] = ['idle', 'opening', 'running', 'closing', 'unconfirmed']

const SESSION_RUN_HOST_STATES: readonly SessionRunHostState[] = [
  'none', 'starting', 'ready', 'recovering', 'stopping', 'failed'
]

// 与 desktop-api.ts 的共享错误码保持一致；查询失败不把实例内部结构泄露给页面。
const SESSION_RUNS_ERROR_CODES: readonly string[] = [
  'FORBIDDEN',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
  'BRIDGE_UNAVAILABLE',
  'BRIDGE_CALL_FAILED'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSessionRunState(value: unknown): value is SessionRunState {
  if (!isRecord(value)) return false
  return typeof value.runId === 'number'
    && Number.isSafeInteger(value.runId)
    && value.runId > 0
    && (value.projectPath === null || typeof value.projectPath === 'string')
    && (value.sessionId === null || typeof value.sessionId === 'string')
    && typeof value.phase === 'string'
    && SESSION_RUN_PHASES.includes(value.phase as SessionRunPhase)
    && typeof value.isForeground === 'boolean'
    && typeof value.isStreaming === 'boolean'
    && typeof value.waitingDialogs === 'number'
    && Number.isInteger(value.waitingDialogs)
    && value.waitingDialogs >= 0
    && typeof value.hostState === 'string'
    && SESSION_RUN_HOST_STATES.includes(value.hostState as SessionRunHostState)
}

function isSessionRunsSnapshot(value: unknown): value is SessionRunsSnapshot {
  if (!isRecord(value)) return false
  return Array.isArray(value.runs) && value.runs.every(isSessionRunState)
}

// TypeScript 声明不能保证 invoke 的实际返回值；沙箱桥接只放行本契约。
export function isSessionRunsResult(value: unknown): value is SessionRunsResult {
  if (!isRecord(value)) return false

  if (value.ok === true) return isSessionRunsSnapshot(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof message === 'string'
    && typeof code === 'string'
    && SESSION_RUNS_ERROR_CODES.includes(code)
}

/** 事件载荷与查询结果同形；契约不符时页面丢弃，由下一次事件或查询收敛。 */
export function isSessionRunsEvent(value: unknown): value is SessionRunsSnapshot {
  return isSessionRunsSnapshot(value)
}
