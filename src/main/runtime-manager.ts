/**
 * 唯一 Runtime 的所有者：状态机、启停编排（含恢复会话时的历史基准）、受限业务操作与状态快照。
 *
 * 不直接管理 Pi Session 与消息内容；进程与管道操作交给 pi-process，展示投影交给
 * message-projection，Extension UI 状态按代际持有交给 extension-ui-manager（快照经订阅者
 * 广播），IPC 契约与校验在 shared/runtime-api.ts。不接受页面传入的可执行文件路径或启动参数，
 * 旧 Runtime 的异步结果不得覆盖新状态。
 */
import type {
  AgentCapabilities,
  CapabilitiesResult,
  ExtensionErrorEntry,
  McpCommandAction,
  McpCommandResult,
  McpStatusResult,
  ModelSummary,
  ProjectionBatch,
  ProjectionResult,
  PromptDisposition,
  PromptImageInput,
  PromptResult,
  ResourcesResult,
  RuntimeDiagnosticsResult,
  RuntimeErrorCode,
  RuntimeResult,
  RuntimeStatus
} from '../shared/runtime-api'
import type { ExtensionDialogResponseInput, ExtensionUiSnapshot } from '../shared/extension-ui-api'
import { MessageProjection } from './message-projection'
import type { ProjectionStatusHint } from './message-projection'
import { ExtensionUiManager } from './extension-ui-manager'
import { PiProcess, PiProcessError } from './pi-process'
import type { PiExitEvent } from './pi-process'
import {
  PiProtocol,
  toExtensionError,
  toModelSummaries,
  toPromptDisposition,
  toResources,
  toRuntimeInfo
} from './pi-protocol'
import type { PiResponseRecord } from './pi-protocol'
import { ProjectPathError, normalizeProjectPath } from './project-path'
import { getSessionRoot } from './session-store'

/** get_state 就绪等待期限；超时只结束等待，不证明 Pi 没有响应。 */
const READY_TIMEOUT_MS = 10_000

/** prompt 只等待 preflight 的期限；超时只结束等待，结果未知且不自动重发。 */
const PROMPT_TIMEOUT_MS = 30_000

/** 中止当前操作的等待期限；超时只结束等待，结果未知且不自动重发。 */
const ABORT_TIMEOUT_MS = 30_000

/** 关闭链里的取消等待上限；明显短于退出总预算，超时就直接进入兜底。 */
const ABORT_SHUTDOWN_WAIT_MS = 3_000

/** 恢复会话时读取历史消息的等待上限；超时按启动失败处理，不显示不完整的历史。 */
const HISTORY_TIMEOUT_MS = 15_000

/** 可用模型列表查询的等待上限。 */
const CAPABILITIES_TIMEOUT_MS = 15_000

/** prompt 文本上限，按 UTF-8 字节计。 */
const PROMPT_MAX_BYTES = 1_048_576

/** 允许的图片 MIME 类型；与常见图像格式一致，其他类型一律拒绝。 */
const PROMPT_IMAGE_MIME_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** 单张图片 base64 编码后的字符数上限；约对应 3 MiB 原始数据。 */
const PROMPT_IMAGE_MAX_CHARS = 4_194_304

/** 单条 Prompt 最多携带的图片数。 */
const PROMPT_IMAGE_MAX_COUNT = 4

/** 失败时回传给页面的诊断行数上限。 */
const DIAGNOSTIC_TAIL_LINES = 6

/** 资源清单读取的等待上限。 */
const RESOURCES_TIMEOUT_MS = 15_000

/** MCP 状态读取的等待上限：`/mcp` 会等待所有已启用服务器连接完成，比普通命令长。 */
const MCP_STATUS_TIMEOUT_MS = 60_000

/** `/mcp` 是读取 MCP 状态的唯一固定命令；不接受页面传入命令文本。 */
const MCP_STATUS_PROMPT = '/mcp'

/** MCP 登录的等待上限：需要用户在浏览器里完成授权，明显长于状态读取。 */
const MCP_LOGIN_TIMEOUT_MS = 300_000

/** MCP 退出登录的等待上限；不涉及浏览器交互。 */
const MCP_LOGOUT_TIMEOUT_MS = 30_000

/** 资源条目上限；超出截断并如实标记，不伪装成完整清单。 */
const RESOURCE_ENTRY_LIMIT = 500

/** 面板展示的诊断行数上限；诊断文本本身已由 PiProcess 截断并去 ANSI。 */
const DIAGNOSTIC_VIEW_LINES = 20

/** Extension 运行时错误的保留条数上限；超出丢弃最旧。 */
const EXTENSION_ERROR_LIMIT = 20

/** 状态变化订阅者；只在主进程内使用，不进 IPC 契约。 */
export type RuntimeStatusListener = (status: RuntimeStatus) => void

/** 投影批次订阅者；只在主进程内使用，不进 IPC 契约。 */
export type RuntimeProjectionListener = (batch: ProjectionBatch) => void

/** Extension UI 快照订阅者；只在主进程内使用，不进 IPC 契约。 */
export type ExtensionUiListener = (snapshot: ExtensionUiSnapshot) => void

interface ActiveRuntime {
  readonly runtimeId: number
  readonly projectPath: string
  readonly process: PiProcess
  readonly protocol: PiProtocol
  readonly projection: MessageProjection
  /** 本代际收到的 `extension_error` 事件；有界、随代际清空。 */
  readonly extensionErrors: ExtensionErrorEntry[]
}

/** 可分类的 Runtime 操作失败，由 start 统一转换为结果对象。 */
class RuntimeFailure extends Error {
  readonly code: RuntimeErrorCode

  constructor(code: RuntimeErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function describeExit(event: PiExitEvent): string {
  if (event.code !== null) return `Pi 进程已退出（退出码 ${event.code}）。`
  if (event.signal !== null) return `Pi 进程被信号 ${event.signal} 结束。`
  return 'Pi 进程已退出。'
}

export class RuntimeManager {
  private runtimeIdSeed = 0
  private active: ActiveRuntime | null = null
  private snapshot: RuntimeStatus = { state: 'idle', runtimeId: null, info: null, lastError: null }
  private readonly listeners = new Set<RuntimeStatusListener>()
  private readonly projectionListeners = new Set<RuntimeProjectionListener>()
  private readonly extensionUiListeners = new Set<ExtensionUiListener>()
  /**
   * Extension UI 状态按代际持有；写回 Pi 管道时用当时的活动 Runtime，
   * 代际已切换时写入会按管道关闭收敛，不重发。
   */
  private readonly extensionUi = new ExtensionUiManager({
    onSnapshot: (snapshot) => this.emitExtensionUi(snapshot),
    onDialogResponse: (response) => {
      const runtime = this.active
      if (runtime === null) return
      // 与 protocol.request 同样按 JSONL 写入：行尾必须有换行符。
      void runtime.process.write(`${JSON.stringify(response)}\n`).catch(() => undefined)
    }
  })
  /** 是否由主动关闭触发：用于区分正常关闭与异常退出。 */
  private stopRequested = false
  /** 可用模型列表按 Runtime 代际缓存；代际不符时按未命中处理。 */
  private capabilityCache: {
    readonly runtimeId: number
    models: ModelSummary[] | null
  } | null = null
  /** 事件触发的状态刷新是否在进行中：避免每轮结束叠加多次 get_state。 */
  private refreshing = false
  /**
   * 最近一次启动意图（项目与会话 id）；只用于安全模式启动与重新加载资源，
   * 由主进程记录，不接受页面传入；退出后仍保留，以便启动失败时重试。
   */
  private lastLaunchIntent: { readonly projectPath: string; readonly sessionId: string | null } | null = null

  /** 订阅状态变化；返回释放函数。单个订阅者异常不影响 Runtime 状态。 */
  onStatusChanged(listener: RuntimeStatusListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 订阅投影批次；返回释放函数。单个订阅者异常不影响投影。 */
  onProjectionBatch(listener: RuntimeProjectionListener): () => void {
    this.projectionListeners.add(listener)
    return () => {
      this.projectionListeners.delete(listener)
    }
  }

  /** 订阅 Extension UI 快照；返回释放函数。单个订阅者异常不影响状态。 */
  onExtensionUi(listener: ExtensionUiListener): () => void {
    this.extensionUiListeners.add(listener)
    return () => {
      this.extensionUiListeners.delete(listener)
    }
  }

  /** 当前 Extension UI 快照；无活动 Runtime 时状态为空。 */
  getExtensionUiSnapshot(): ExtensionUiSnapshot {
    return this.extensionUi.snapshot()
  }

  /** 提交 Extension dialog 响应；id 不存在或形态不符时返回 null，由调用方转为错误结果。 */
  respondExtensionDialog(
    dialogId: string,
    response: ExtensionDialogResponseInput
  ): ExtensionUiSnapshot | null {
    const outcome = this.extensionUi.respond(dialogId, response)
    return outcome.ok ? outcome.snapshot : null
  }

  /**
   * 读取当前代际已加载的 Pi 资源清单：只调 `get_commands`，不解析 Pi 配置文件，
   * 也不建立平行资源模型。清单来源单一，失败时不返回条目。
   */
  async readResources(): Promise<ResourcesResult> {
    try {
      const runtime = this.requireReadyRuntime()
      const response = await this.requestCommand(
        runtime,
        { type: 'get_commands' },
        RESOURCES_TIMEOUT_MS,
        '读取 Pi 资源清单'
      )
      if (!response.success) {
        throw new RuntimeFailure(
          'RUNTIME_COMMAND_REJECTED',
          `Pi 拒绝了读取资源清单：${response.error ?? '未提供错误信息'}`
        )
      }
      const entries = toResources(response.data)
      if (entries === null) {
        throw new RuntimeFailure('RUNTIME_PROTOCOL_ERROR', 'get_commands 响应缺少约定的 commands 数组。')
      }
      const truncated = entries.length > RESOURCE_ENTRY_LIMIT
      return {
        ok: true,
        data: {
          runtimeId: runtime.runtimeId,
          entries: truncated ? entries.slice(0, RESOURCE_ENTRY_LIMIT) : entries,
          truncated,
          error: null
        }
      }
    } catch (error) {
      const failure = error instanceof RuntimeFailure
        ? error
        : new RuntimeFailure('INTERNAL_ERROR', '读取 Pi 资源清单时发生未预期的内部错误。')
      return { ok: false, error: { code: failure.code, message: failure.message } }
    }
  }

  /**
   * 当前代际的启动诊断尾部与 Extension 运行时错误；无活动 Runtime 时两项都为空。
   * stderr 文本是 Pi 输出原文，按不可信纯文本展示；技能/提示词加载警告在 RPC 模式下不可得。
   */
  getDiagnostics(): RuntimeDiagnosticsResult {
    const runtime = this.active
    if (runtime === null) {
      return { ok: true, data: { runtimeId: null, stderrLines: [], extensionErrors: [] } }
    }
    return {
      ok: true,
      data: {
        runtimeId: runtime.runtimeId,
        stderrLines: runtime.process.readDiagnostics().slice(-DIAGNOSTIC_VIEW_LINES),
        extensionErrors: runtime.extensionErrors.map((entry) => ({ ...entry }))
      }
    }
  }

  /**
   * 读取 MCP 状态：固定发送 `/mcp`（TUI 之外由 Pi 经 notify 返回状态文本），
   * 把捕获到的 notify 文本作为结果返回。超时只结束等待，结果未知且不自动重发。
   */
  async readMcpStatus(): Promise<McpStatusResult> {
    let endCapture: (() => readonly string[]) | null = null
    try {
      const runtime = this.requireReadyRuntime()
      const capture = this.extensionUi.beginNotifyCapture()
      endCapture = capture
      const response = await this.requestCommand(
        runtime,
        { type: 'prompt', message: MCP_STATUS_PROMPT },
        MCP_STATUS_TIMEOUT_MS,
        '读取 MCP 状态'
      )
      if (!response.success) {
        throw new RuntimeFailure(
          'RUNTIME_COMMAND_REJECTED',
          `Pi 拒绝了读取 MCP 状态：${response.error ?? '未提供错误信息'}`
        )
      }
      const disposition = toPromptDisposition(response.data)
      if (disposition === null) {
        throw new RuntimeFailure('RUNTIME_PROTOCOL_ERROR', 'prompt 响应缺少约定的 disposition 字段。')
      }
      return { ok: true, data: { disposition, messages: capture() } }
    } catch (error) {
      const failure = error instanceof RuntimeFailure
        ? error
        : new RuntimeFailure('INTERNAL_ERROR', '读取 MCP 状态时发生未预期的内部错误。')
      return { ok: false, error: { code: failure.code, message: failure.message } }
    } finally {
      // 提前返回与异常路径都要结束捕获，不留下长期存活的捕获数组。
      endCapture?.()
    }
  }

  /**
   * MCP 服务器 OAuth 登录或退出：主进程用受校验的服务器名拼出固定命令，经既有 prompt 通道发出。
   * 登录需要用户在浏览器里完成授权，期间浏览器地址、进度与 redirect URL 输入都由 Pi 经既有
   * Extension UI 通道给出；这里只回传命令被处理时捕获到的 notify 文本。
   */
  async runMcpCommand(action: McpCommandAction, serverName: string): Promise<McpCommandResult> {
    let endCapture: (() => readonly string[]) | null = null
    const label = action === 'login' ? 'MCP 登录' : 'MCP 退出登录'
    try {
      const runtime = this.requireReadyRuntime()
      const capture = this.extensionUi.beginNotifyCapture()
      endCapture = capture
      const response = await this.requestCommand(
        runtime,
        { type: 'prompt', message: `/mcp ${action} ${serverName}` },
        action === 'login' ? MCP_LOGIN_TIMEOUT_MS : MCP_LOGOUT_TIMEOUT_MS,
        label
      )
      if (!response.success) {
        throw new RuntimeFailure(
          'RUNTIME_COMMAND_REJECTED',
          `Pi 拒绝了${label}：${response.error ?? '未提供错误信息'}`
        )
      }
      const disposition = toPromptDisposition(response.data)
      if (disposition === null) {
        throw new RuntimeFailure('RUNTIME_PROTOCOL_ERROR', 'prompt 响应缺少约定的 disposition 字段。')
      }
      return { ok: true, data: { disposition, messages: capture() } }
    } catch (error) {
      const failure = error instanceof RuntimeFailure
        ? error
        : new RuntimeFailure('INTERNAL_ERROR', `${label}时发生未预期的内部错误。`)
      return { ok: false, error: { code: failure.code, message: failure.message } }
    } finally {
      // 提前返回与异常路径都要结束捕获，不留下长期存活的捕获数组。
      endCapture?.()
    }
  }

  /** 启动唯一 Runtime；重复启动被拒绝，不做隐式重启。`sessionId` 为 null 时新建会话。
   * `trustDecision` 是主进程探测并记录的 Project Trust 决定，不由页面指定。
   * `disableExtensions` 只为安全模式启动（不加载 Extension）使用，常规启动不传。
   */
  async start(
    projectPath: string,
    sessionId: string | null,
    trustDecision: 'trusted' | 'untrusted' | null,
    disableExtensions = false
  ): Promise<RuntimeResult> {
    try {
      return { ok: true, data: await this.launch(projectPath, sessionId, trustDecision, disableExtensions) }
    } catch (error) {
      const failure = error instanceof RuntimeFailure
        ? error
        : new RuntimeFailure('INTERNAL_ERROR', '启动 Runtime 时发生未预期的内部错误。')
      // 由主动关闭引发的启动失败不覆盖关闭后的快照，但仍如实返回本次启动失败。
      if (!this.stopRequested) {
        this.publish({ ...this.snapshot, state: 'failed', info: null, lastError: failure.message })
      }
      return { ok: false, error: { code: failure.code, message: failure.message } }
    }
  }

  /** 状态快照查询只读，不触发进程操作。 */
  getStatus(): RuntimeResult {
    return { ok: true, data: { ...this.snapshot } }
  }

  /**
   * 安全模式启动：不加载 Extension，复用最近一次启动目标（项目与会话 id）重启一次。
   * 项目必须与主进程当前项目一致；`trustDecision` 与常规启动一样由主进程解析。
   * 仅本次生效，不写任何配置，也不改变后续常规启动。
   */
  async startSafely(
    trustDecision: 'trusted' | 'untrusted' | null,
    currentProjectPath: string | null
  ): Promise<RuntimeResult> {
    const intent = this.lastLaunchIntent
    if (intent === null || currentProjectPath === null || intent.projectPath !== currentProjectPath) {
      return {
        ok: false,
        error: {
          code: 'INVALID_PROJECT_PATH',
          message: '没有可复用的启动目标；请先打开或新建会话，再使用安全模式启动。'
        }
      }
    }
    return this.start(intent.projectPath, intent.sessionId, trustDecision, true)
  }

  /** 投影快照只读；没有活动 Runtime 时返回空基准。 */
  getProjection(): ProjectionResult {
    const runtime = this.active
    if (runtime === null) {
      return {
        ok: true,
        data: {
          runtimeId: null,
          seq: 0,
          messages: [],
          tools: [],
          truncated: false,
          droppedMessages: 0,
          droppedTools: 0
        }
      }
    }
    return { ok: true, data: runtime.projection.snapshot() }
  }

  /** 记录渲染端已应用到的最高序号；只影响未确认通知窗口。 */
  ackProjection(runtimeId: number, seq: number): void {
    this.active?.projection.ack(runtimeId, seq)
  }

  /**
   * 提交 prompt 并返回请求接受或拒绝结果；不等待 Agent 执行结束。
   * busy、无模型与凭据问题一律由 Pi 的拒绝表达，主进程不做本地 streaming 预检。
   */
  async prompt(message: string, images: readonly PromptImageInput[] = []): Promise<PromptResult> {
    try {
      return { ok: true, data: { disposition: await this.submitPrompt(message, images) } }
    } catch (error) {
      const failure = error instanceof RuntimeFailure
        ? error
        : new RuntimeFailure('INTERNAL_ERROR', '提交 Prompt 时发生未预期的内部错误。')
      // 请求失败不改写 Runtime 快照；进程真的退出时由退出路径负责收敛状态。
      return { ok: false, error: { code: failure.code, message: failure.message } }
    }
  }

  /**
   * 请求中止当前 Agent 操作：只要求 Runtime 就绪，不做本地 streaming 预检。
   * 成功只表示 Pi 已确认取消，运行状态仍由事件流收敛；超时结果未知且不自动重发。
   */
  async abort(): Promise<RuntimeResult> {
    try {
      const runtime = this.active
      if (runtime === null || this.snapshot.state !== 'ready') {
        throw new RuntimeFailure('RUNTIME_NOT_READY', 'Runtime 尚未就绪，无法中止当前操作。')
      }
      await this.requestAbort(runtime, ABORT_TIMEOUT_MS)
      return { ok: true, data: { ...this.snapshot } }
    } catch (error) {
      const failure = error instanceof RuntimeFailure
        ? error
        : new RuntimeFailure('INTERNAL_ERROR', '中止当前操作时发生未预期的内部错误。')
      // 请求失败不改写 Runtime 快照；进程真的退出时由退出路径负责收敛状态。
      return { ok: false, error: { code: failure.code, message: failure.message } }
    }
  }

  /**
   * 读取当前 Runtime 代际的可用模型；模型列表失败作为结果中的错误返回。
   */
  async readCapabilities(): Promise<CapabilitiesResult> {
    try {
      const runtime = this.requireReadyRuntime()
      return { ok: true, data: await this.collectCapabilities(runtime) }
    } catch (error) {
      const failure = error instanceof RuntimeFailure
        ? error
        : new RuntimeFailure('INTERNAL_ERROR', '读取 Agent 能力时发生未预期的内部错误。')
      return { ok: false, error: { code: failure.code, message: failure.message } }
    }
  }

  /**
   * 关闭当前 Runtime：先停止接受新请求，有活动操作时先请求取消，再关闭 stdin、
   * 等待退出，超时后按平台定向终止。关闭是幂等动作，没有 Runtime 时直接返回当前快照。
   */
  async stop(): Promise<RuntimeResult> {
    const runtime = this.active
    if (runtime === null) {
      return { ok: true, data: { ...this.snapshot } }
    }

    // 运行中状态必须在置 stopping 前读取：stopping 快照不保留 info。
    const hadActiveRun = this.snapshot.state === 'ready' && this.snapshot.info?.isStreaming === true

    this.stopRequested = true
    this.publish({ state: 'stopping', runtimeId: runtime.runtimeId, info: null, lastError: null })
    if (hadActiveRun) {
      // 取消只尽力而为：超时或拒绝都不阻断后续 stdin 关闭与平台兜底。
      try {
        await this.requestAbort(runtime, ABORT_SHUTDOWN_WAIT_MS)
      } catch {
        // 取消失败由后续关闭链兜底。
      }
    }
    await runtime.process.stop()

    if (this.active !== null && this.active.runtimeId === runtime.runtimeId) {
      // 进程未在期限内确认退出：按失败收敛，并解除归属以免留下无主 Runtime。
      runtime.projection.dispose()
      this.extensionUi.dispose()
      this.active = null
      this.capabilityCache = null
      this.publish({
        state: 'failed',
        runtimeId: runtime.runtimeId,
        info: null,
        lastError: '关闭 Runtime 超时，未能确认相关 Pi 进程已退出。'
      })
    }
    return { ok: true, data: { ...this.snapshot } }
  }

  /** 应用退出时使用同一条关闭链；调用方负责在总预算内强制退出应用。 */
  async shutdown(): Promise<void> {
    await this.stop()
  }

  private async launch(
    projectPath: string,
    sessionId: string | null,
    trustDecision: 'trusted' | 'untrusted' | null,
    disableExtensions: boolean
  ): Promise<RuntimeStatus> {
    if (this.active !== null) {
      throw new RuntimeFailure(
        'RUNTIME_ALREADY_RUNNING',
        this.snapshot.state === 'stopping'
          ? 'Runtime 正在关闭，请稍后再启动。'
          : '已经有 Runtime 在运行；请先结束当前 Runtime。'
      )
    }

    this.stopRequested = false
    const projectDirectory = await this.checkProjectPath(projectPath)
    // 启动意图在 spawn 前记录：启动失败时仍能由页面重试安全模式启动。
    this.lastLaunchIntent = { projectPath: projectDirectory, sessionId }
    const runtimeId = (this.runtimeIdSeed += 1)
    this.publish({ state: 'starting', runtimeId, info: null, lastError: null })
    // Extension UI 状态随代际重建：上一代际的 dialog 队列与展示状态不再有意义。
    this.extensionUi.beginGeneration(runtimeId)

    // 投影随 Runtime 代际存在；批次与状态提示都只在该代际内生效。
    const projection = new MessageProjection(runtimeId, {
      onBatch: (batch) => this.emitProjection(batch),
      onStatusHint: (hint) => this.applyStatusHint(runtimeId, hint)
    })

    let exitEvent: PiExitEvent | null = null
    let spawnFailure: string | null = null
    let protocolError: string | null = null

    const protocol = new PiProtocol({
      onProtocolError: (message) => {
        protocolError ??= message
      },
      onRecord: (kind, payload) => {
        // Extension UI 请求进入 Extension 状态管理；会话事件进入展示投影与快照收敛。
        if (kind === 'extension-ui') {
          this.extensionUi.applyRequest(payload)
          return
        }
        if (kind !== 'session-event') return
        projection.applySessionEvent(payload)
        this.applyRuntimeEvent(runtimeId, payload)
      },
      onUnmatchedResponse: () => {
        // 无 pending 可匹配的 response 不致命，例如 Pi 自行回报的解析错误。
      }
    })

    let piProcess: PiProcess | null = null
    try {
      piProcess = PiProcess.start({
        projectPath: projectDirectory,
        sessionDir: getSessionRoot(),
        sessionId,
        trustDecision,
        ...(disableExtensions ? { disableExtensions: true } : {}),
        handlers: {
          onStdoutLine: (line) => protocol.handleLine(line),
          onProtocolError: (message) => {
            protocolError ??= message
          },
          onSpawnFailure: (message) => {
            spawnFailure ??= message
            protocol.failAll(message)
          },
          onExit: (event) => {
            exitEvent = event
            protocol.failAll(describeExit(event))
            this.handleExit(runtimeId, event)
          }
        }
      })

      const runtime: ActiveRuntime = {
        runtimeId,
        projectPath: projectDirectory,
        process: piProcess,
        protocol,
        projection,
        extensionErrors: []
      }
      this.active = runtime

      const outcome = await protocol.request(
        { type: 'get_state' },
        (line) => runtime.process.write(line),
        READY_TIMEOUT_MS
      )

      if (outcome.status === 'timeout') {
        throw new RuntimeFailure('RUNTIME_TIMEOUT', `Pi 在 ${READY_TIMEOUT_MS} 毫秒内没有返回 get_state 响应。`)
      }
      if (outcome.status === 'closed') {
        if (spawnFailure !== null) {
          throw new RuntimeFailure('RUNTIME_SPAWN_FAILED', `无法启动 Pi：${spawnFailure}`)
        }
        throw new RuntimeFailure('RUNTIME_EXITED', this.describeFailure(exitEvent, piProcess, outcome.reason))
      }
      if (protocolError !== null) {
        throw new RuntimeFailure('RUNTIME_PROTOCOL_ERROR', protocolError)
      }
      if (!outcome.response.success) {
        throw new RuntimeFailure(
          'RUNTIME_PROTOCOL_ERROR',
          `Pi 拒绝了 get_state：${outcome.response.error ?? '未提供错误信息'}`
        )
      }

      const info = toRuntimeInfo(outcome.response.data)
      if (info === null) {
        throw new RuntimeFailure('RUNTIME_PROTOCOL_ERROR', 'get_state 响应缺少约定的会话字段。')
      }
      if (info.messageCount > 0) {
        // 恢复会话：先取得历史消息作为投影基准，再对外声明就绪。
        await this.loadHistory(runtime, projection)
      }

      this.publish({ state: 'ready', runtimeId, info, lastError: null })
      return { ...this.snapshot }
    } catch (error) {
      // 只回收本次启动创建的进程与投影，不触碰既有 Runtime。
      projection.dispose()
      if (piProcess !== null) {
        if (this.active?.runtimeId === runtimeId) {
          this.active = null
        }
        await piProcess.stop()
      }
      if (error instanceof PiProcessError) {
        throw new RuntimeFailure('RUNTIME_SPAWN_FAILED', error.message)
      }
      throw error
    }
  }

  /**
   * 以 `get_messages` 的历史消息初始化展示投影。失败即按启动失败处理，
   * 不把空投影冒充成完整会话；历史超上限时的截断由投影自行计数。
   */
  private async loadHistory(runtime: ActiveRuntime, projection: MessageProjection): Promise<void> {
    const outcome = await runtime.protocol.request(
      { type: 'get_messages' },
      (line) => runtime.process.write(line),
      HISTORY_TIMEOUT_MS
    )

    if (outcome.status === 'timeout') {
      throw new RuntimeFailure(
        'RUNTIME_TIMEOUT',
        `Pi 在 ${HISTORY_TIMEOUT_MS} 毫秒内没有返回会话消息。`
      )
    }
    if (outcome.status === 'closed') {
      throw new RuntimeFailure(
        'RUNTIME_EXITED',
        this.describeFailure(
          runtime.process.exitEvent,
          runtime.process,
          outcome.reason,
          'Pi 进程在读取会话消息期间结束了标准输入。'
        )
      )
    }
    if (!outcome.response.success) {
      throw new RuntimeFailure(
        'RUNTIME_PROTOCOL_ERROR',
        `Pi 无法取出会话消息：${outcome.response.error ?? '未提供错误信息'}`
      )
    }
    if (!projection.seedHistory(outcome.response.data)) {
      throw new RuntimeFailure('RUNTIME_PROTOCOL_ERROR', 'get_messages 响应缺少约定的消息数组。')
    }
  }

  /**
   * 校验 prompt 文本与图片附件并发送；只返回 disposition，不做本地 busy 判定。
   * 图片校验 MIME 白名单、单图编码后大小与条数上限，校验失败按参数拒绝，不静默丢弃。
   */
  private async submitPrompt(
    message: string,
    images: readonly PromptImageInput[]
  ): Promise<PromptDisposition> {
    const runtime = this.active
    if (runtime === null || this.snapshot.state !== 'ready') {
      throw new RuntimeFailure('RUNTIME_NOT_READY', 'Runtime 尚未就绪，无法提交 Prompt；请先启动 Runtime。')
    }
    if (message.trim() === '') {
      throw new RuntimeFailure('INVALID_REQUEST', 'Prompt 内容不能为空。')
    }
    if (Buffer.byteLength(message, 'utf8') > PROMPT_MAX_BYTES) {
      throw new RuntimeFailure('INVALID_REQUEST', `Prompt 内容超过 ${PROMPT_MAX_BYTES} 字节上限。`)
    }
    if (images.length > PROMPT_IMAGE_MAX_COUNT) {
      throw new RuntimeFailure('INVALID_REQUEST', `单条 Prompt 最多携带 ${PROMPT_IMAGE_MAX_COUNT} 张图片。`)
    }

    const wireImages = images.map((image) => {
      if (!PROMPT_IMAGE_MIME_TYPES.includes(image.mimeType)) {
        throw new RuntimeFailure('INVALID_REQUEST', `不支持的图片类型：${image.mimeType}。`)
      }
      if (image.data.length === 0 || image.data.length > PROMPT_IMAGE_MAX_CHARS) {
        throw new RuntimeFailure('INVALID_REQUEST', `图片「${image.name}」超出编码后大小上限。`)
      }
      return { type: 'image', data: image.data, mimeType: image.mimeType }
    })

    const command: Record<string, unknown> = { type: 'prompt', message }
    if (wireImages.length > 0) command.images = wireImages

    const outcome = await runtime.protocol.request(
      command,
      (line) => runtime.process.write(line),
      PROMPT_TIMEOUT_MS
    )

    if (outcome.status === 'timeout') {
      throw new RuntimeFailure(
        'RUNTIME_TIMEOUT',
        `Pi 在 ${PROMPT_TIMEOUT_MS} 毫秒内没有回应本次 Prompt；结果未知，不会自动重发。`
      )
    }
    if (outcome.status === 'closed') {
      throw new RuntimeFailure(
        'RUNTIME_EXITED',
        this.describeFailure(
          runtime.process.exitEvent,
          runtime.process,
          outcome.reason,
          'Pi 进程在本次 Prompt 期间结束了标准输入。'
        )
      )
    }
    if (!outcome.response.success) {
      throw new RuntimeFailure(
        'PROMPT_REJECTED',
        `Pi 拒绝了本次 Prompt：${outcome.response.error ?? '未提供错误信息'}`
      )
    }

    const disposition = toPromptDisposition(outcome.response.data)
    if (disposition === null) {
      throw new RuntimeFailure('RUNTIME_PROTOCOL_ERROR', 'prompt 响应缺少约定的 disposition 字段。')
    }
    return disposition
  }

  /**
   * 向指定 Runtime 发送 abort 并等待有限期限；成功只表示 Pi 已确认取消。
   * 调用方决定超时与拒绝是否可以忽略（关闭链会忽略，用户请求则如实返回失败）。
   */
  private async requestAbort(runtime: ActiveRuntime, timeoutMs: number): Promise<void> {
    const outcome = await runtime.protocol.request(
      { type: 'abort' },
      (line) => runtime.process.write(line),
      timeoutMs
    )

    if (outcome.status === 'timeout') {
      throw new RuntimeFailure(
        'RUNTIME_TIMEOUT',
        `Pi 在 ${timeoutMs} 毫秒内没有确认中止当前操作；结果未知，不会自动重发。`
      )
    }
    if (outcome.status === 'closed') {
      throw new RuntimeFailure(
        'RUNTIME_EXITED',
        this.describeFailure(
          runtime.process.exitEvent,
          runtime.process,
          outcome.reason,
          'Pi 进程在本次中止请求期间结束了标准输入。'
        )
      )
    }
    if (!outcome.response.success) {
      throw new RuntimeFailure(
        'RUNTIME_PROTOCOL_ERROR',
        `Pi 拒绝了本次中止请求：${outcome.response.error ?? '未提供错误信息'}`
      )
    }
  }

  /** 就绪检查：未就绪统一按 `RUNTIME_NOT_READY` 返回，不做本地 streaming 预检。 */
  private requireReadyRuntime(): ActiveRuntime {
    const runtime = this.active
    if (runtime === null || this.snapshot.state !== 'ready') {
      throw new RuntimeFailure('RUNTIME_NOT_READY', 'Runtime 尚未就绪，无法执行该操作。')
    }
    return runtime
  }

  /** 发送一条命令并等待响应；超时与管道关闭按其错误码抛出，响应本身交给调用方判定。 */
  private async requestCommand(
    runtime: ActiveRuntime,
    command: Record<string, unknown>,
    timeoutMs: number,
    label: string
  ): Promise<PiResponseRecord> {
    const outcome = await runtime.protocol.request(
      command,
      (line) => runtime.process.write(line),
      timeoutMs
    )

    if (outcome.status === 'timeout') {
      throw new RuntimeFailure(
        'RUNTIME_TIMEOUT',
        `Pi 在 ${timeoutMs} 毫秒内没有回应${label}；结果未知，不会自动重发。`
      )
    }
    if (outcome.status === 'closed') {
      throw new RuntimeFailure(
        'RUNTIME_EXITED',
        this.describeFailure(
          runtime.process.exitEvent,
          runtime.process,
          outcome.reason,
          `Pi 进程在${label}期间结束了标准输入。`
        )
      )
    }
    return outcome.response
  }

  /** 只读能力查询：失败与形状不符都收敛为可展示原因，不让单项失败影响其他分区。 */
  private async readCapability<T>(
    runtime: ActiveRuntime,
    command: Record<string, unknown>,
    label: string,
    parse: (data: unknown) => T | null
  ): Promise<{ readonly value: T | null; readonly error: string | null }> {
    try {
      const response = await this.requestCommand(runtime, command, CAPABILITIES_TIMEOUT_MS, label)
      if (!response.success) {
        return { value: null, error: `Pi 拒绝了${label}：${response.error ?? '未提供错误信息'}` }
      }
      const value = parse(response.data)
      if (value === null) return { value: null, error: `Pi 返回的${label}格式不符合约定。` }
      return { value, error: null }
    } catch (error) {
      return {
        value: null,
        error: error instanceof RuntimeFailure ? error.message : `${label}时发生未预期的内部错误。`
      }
    }
  }

  /** 读取并按代际缓存可用模型列表。 */
  private async collectCapabilities(runtime: ActiveRuntime): Promise<AgentCapabilities> {
    const cached = this.capabilityCache?.runtimeId === runtime.runtimeId ? this.capabilityCache : null
    const cache = { runtimeId: runtime.runtimeId, models: cached?.models ?? null }
    let models = cache.models
    let modelsError: string | null = null
    if (models === null) {
      const read = await this.readCapability(
        runtime,
        { type: 'get_available_models' },
        '可用模型列表',
        toModelSummaries
      )
      models = read.value
      modelsError = read.error
      if (models !== null) cache.models = models
    }
    this.capabilityCache = cache
    return { runtimeId: runtime.runtimeId, models: models ?? [], modelsError }
  }

  /**
   * 用 `get_state` 刷新快照；只在该 Runtime 仍是当前代际且仍就绪时生效。
   * 刷新失败不改变既有快照，真实退出由退出路径收敛。
   */
  private async refreshStatus(runtime: ActiveRuntime): Promise<void> {
    try {
      const response = await this.requestCommand(
        runtime,
        { type: 'get_state' },
        READY_TIMEOUT_MS,
        '刷新 Runtime 状态'
      )
      if (!response.success) return
      const info = toRuntimeInfo(response.data)
      if (info === null) return
      if (this.active?.runtimeId !== runtime.runtimeId || this.snapshot.state !== 'ready') return
      this.publish({ state: 'ready', runtimeId: runtime.runtimeId, info, lastError: null })
    } catch {
      // 刷新失败不改变既有快照。
    }
  }

  /** 事件触发的刷新：同一时刻只跑一次，避免每轮结束叠加多个 get_state。 */
  private scheduleStatusRefresh(runtime: ActiveRuntime): void {
    if (this.refreshing) return
    this.refreshing = true
    void this.refreshStatus(runtime).finally(() => {
      this.refreshing = false
    })
  }

  /** Agent 一轮结束后刷新状态快照，确保消息计数等字段收敛。 */
  private applyRuntimeEvent(runtimeId: number, payload: Record<string, unknown>): void {
    const runtime = this.active
    if (runtime === null || runtime.runtimeId !== runtimeId) return

    // Extension 运行时错误只进本代际的有界列表，供资源面板如实展示。
    if (payload.type === 'extension_error') {
      const entry = toExtensionError(payload)
      if (entry === null) return
      runtime.extensionErrors.push(entry)
      if (runtime.extensionErrors.length > EXTENSION_ERROR_LIMIT) runtime.extensionErrors.shift()
      return
    }

    if (payload.type === 'agent_settled') this.scheduleStatusRefresh(runtime)
  }

  /** 退出结果只在该 Runtime 仍是当前代际时生效。 */
  private handleExit(runtimeId: number, event: PiExitEvent): void {
    const runtime = this.active
    if (runtime === null || runtime.runtimeId !== runtimeId) return
    runtime.projection.dispose()
    this.extensionUi.dispose()
    this.active = null
    this.capabilityCache = null
    if (this.stopRequested) {
      // 主动关闭：进程按请求结束，回到 idle 并保留本次运行时标识。
      this.publish({ state: 'idle', runtimeId, info: null, lastError: null })
      return
    }
    this.publish({
      state: 'failed',
      runtimeId,
      info: null,
      lastError: this.describeFailure(event, runtime.process, null)
    })
  }

  /** 把投影上报的运行提示合入就绪快照；只接受当前代际与就绪状态。 */
  private applyStatusHint(runtimeId: number, hint: ProjectionStatusHint): void {
    const runtime = this.active
    const info = this.snapshot.info
    if (runtime === null || runtime.runtimeId !== runtimeId) return
    if (this.snapshot.state !== 'ready' || info === null) return

    this.publish({
      state: 'ready',
      runtimeId,
      info: {
        ...info,
        isStreaming: hint.isStreaming ?? info.isStreaming,
        messageCount: hint.messageCount ?? info.messageCount
      },
      lastError: null
    })
  }

  /** 批次只发给订阅者；单个订阅者异常不影响投影状态。 */
  private emitProjection(batch: ProjectionBatch): void {
    for (const listener of [...this.projectionListeners]) {
      try {
        listener(batch)
      } catch {
        // 通知失败不改变投影状态。
      }
    }
  }

  /** Extension UI 快照只发给订阅者；单个订阅者异常不影响状态。 */
  private emitExtensionUi(snapshot: ExtensionUiSnapshot): void {
    for (const listener of [...this.extensionUiListeners]) {
      try {
        listener(snapshot)
      } catch {
        // 通知失败不改变 Extension UI 状态。
      }
    }
  }

  /** 写入快照并通知订阅者；所有状态变化都必须经过这里。 */
  private publish(next: RuntimeStatus): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) {
      try {
        listener({ ...next })
      } catch {
        // 通知失败不改变 Runtime 状态。
      }
    }
  }

  /** 把退出事件、诊断尾巴与等待收敛原因合并成一条可展示的错误信息。 */
  private describeFailure(
    event: PiExitEvent | null,
    piProcess: PiProcess | null,
    reason: string | null,
    missingExitMessage = 'Pi 进程在就绪前结束。'
  ): string {
    const parts: string[] = []
    parts.push(event === null ? missingExitMessage : describeExit(event))
    if (reason !== null && reason.trim() !== '') parts.push(reason)
    const diagnostics = (piProcess?.readDiagnostics() ?? []).slice(-DIAGNOSTIC_TAIL_LINES)
    if (diagnostics.length > 0) parts.push(`最近诊断：${diagnostics.join(' | ')}`)
    return parts.join(' ')
  }

  /**
   * 项目目录必须是存在的绝对目录，主进程不接受相对路径或其他启动参数。
   * 归一化（含符号链接与平台短名解析）统一在 project-path.ts，这里只做错误码归类。
   */
  private async checkProjectPath(projectPath: unknown): Promise<string> {
    try {
      return await normalizeProjectPath(projectPath)
    } catch (error) {
      if (error instanceof ProjectPathError) {
        throw new RuntimeFailure('INVALID_PROJECT_PATH', error.message)
      }
      throw error
    }
  }
}
