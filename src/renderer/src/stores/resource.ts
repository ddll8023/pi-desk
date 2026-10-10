/**
 * 保存 Pi 资源视图的展示状态：`get_commands` 清单、Runtime 未启动时的资源预读清单、启动诊断、
 * MCP 配置文件列举、MCP 服务器探测结果、MCP 登录/退出/重连结果与安全模式启动结果。
 *
 * 只保存主进程投影的副本，不缓存历史、不解析 Pi 配置文件；清单与诊断都只在 Runtime 就绪时读取，
 * 代际变化后自动重读（资源只在进程启动时加载，重载必须重启 Runtime）。
 * 预读清单只用于 Runtime 未启动时的展示与输入框补全，就绪后丢弃，不合并成同一份清单。
 * MCP 列表以配置文件列举为骨架（与 Runtime 无关，未启动也可读），探测结果只按名叠加为连接状态。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type {
  ExtensionErrorEntry,
  McpCommandAction,
  McpConfigListing,
  McpInspection,
  McpServerReport,
  McpStatus,
  PiResourceEntry,
  PromptDisposition,
  RuntimeError
} from '../../../shared/runtime-api'
import { useRuntimeStore } from './runtime'
import { useSessionStore } from './session'
import { useProjectStore } from './project'
import {
  abortMcpInspection,
  getDiagnostics,
  getMcpConfig,
  getResourcePreview,
  getResources,
  inspectMcpServers,
  readMcpStatus,
  runMcpCommand,
  startRuntimeSafely
} from '../services/resource'

/** 资源清单的展示状态；`error` 表示清单读取失败，与“确实没有资源”区分。 */
type ResourcesViewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'error'; error: RuntimeError }

/** MCP 状态请求的展示状态；`ready` 保留 Pi 返回的状态文本。 */
type McpViewState =
  | { phase: 'idle' }
  | { phase: 'requesting' }
  | { phase: 'ready'; disposition: PromptDisposition; messages: readonly string[] }
  | { phase: 'error'; error: RuntimeError }

/** MCP 登录/退出/重连的展示状态；登录需要用户在浏览器里完成授权，可能等待较久。 */
type McpCommandViewState =
  | { phase: 'idle' }
  | { phase: 'running'; action: McpCommandAction; serverName: string }
  | { phase: 'ready'; action: McpCommandAction; serverName: string; data: McpStatus }
  | { phase: 'error'; action: McpCommandAction; serverName: string; error: RuntimeError }

/** MCP 服务器探测的展示状态；探测会另起官方 CLI 进程重新连接所有已启用服务器。 */
type McpInspectViewState =
  | { phase: 'idle' }
  | { phase: 'inspecting' }
  | { phase: 'ready'; data: McpInspection }
  | { phase: 'error'; error: RuntimeError }

/** MCP 配置文件列举的展示状态；`error` 与「确实没有配置服务器」区分。 */
type McpConfigViewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; data: McpConfigListing }
  | { phase: 'error'; error: RuntimeError }

/** 资源预读的展示状态：`error` 与「确实没有 Skill」区分，`loading` 供按钮反馈。 */
type PreviewViewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'error'; error: RuntimeError }

/** MCP 列表行：以配置文件列举为骨架，按名叠加探测报告。 */
export interface McpServerRow {
  readonly name: string
  readonly scope: string
  readonly source: string
  readonly enabled: boolean
  readonly transport: string | null
  readonly override: string | null
  /** 探测报告；null 表示本次没有测到（尚未探测，或探测不覆盖的条目）。 */
  readonly report: McpServerReport | null
}

/** 安全模式启动的展示状态；成功只表示本次启动请求被接受，运行状态由 Runtime 快照收敛。 */
type SafeStartState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'done' }
  | { phase: 'error'; error: RuntimeError }

export const useResourceStore = defineStore('resource', () => {
  const runtimeStore = useRuntimeStore()
  const resourcesView = ref<ResourcesViewState>({ phase: 'idle' })
  const entries = ref<readonly PiResourceEntry[]>([])
  /** Runtime 未启动时的预读技能清单；只含技能，就绪后立即清空。 */
  const previewSkills = ref<readonly PiResourceEntry[]>([])
  const previewView = ref<PreviewViewState>({ phase: 'idle' })
  const resourcesTruncated = ref(false)
  const diagnostics = ref<readonly string[]>([])
  const extensionErrors = ref<readonly ExtensionErrorEntry[]>([])
  const diagnosticsLoading = ref(false)
  const diagnosticsError = ref<RuntimeError | null>(null)
  const mcpView = ref<McpViewState>({ phase: 'idle' })
  const mcpCommandView = ref<McpCommandViewState>({ phase: 'idle' })
  const mcpInspectView = ref<McpInspectViewState>({ phase: 'idle' })
  const mcpConfigView = ref<McpConfigViewState>({ phase: 'idle' })
  const safeStart = ref<SafeStartState>({ phase: 'idle' })

  /** 已读取过的 Runtime 代际；代际变化后重新读取清单与诊断。 */
  let loadedRuntimeId: number | null = null
  /** 预读请求序号：只接受最后一次请求的结果，切换项目或重复刷新时丢弃过期响应。 */
  let previewRequestId = 0
  let resourcesReading = false
  let stopRuntimeWatch: (() => void) | null = null
  let stopProjectWatch: (() => void) | null = null
  /** 用户已请求中止本次探测；中止成功后按取消处理，不当作失败展示。 */
  let inspectionCancelled = false

  const runtimeReady = computed(() => runtimeStore.view.phase === 'ready')
  const currentRuntimeId = computed(() => (
    runtimeStore.view.phase === 'ready' ? runtimeStore.view.snapshot.runtimeId : null
  ))

  const skills = computed(() => entries.value.filter((entry) => entry.kind === 'skill'))
  const prompts = computed(() => entries.value.filter((entry) => entry.kind === 'prompt'))
  const commands = computed(() => entries.value.filter((entry) => entry.kind === 'extension'))

  /** 清空与 Runtime 代际绑定的展示状态；诊断与 MCP 相关状态（含登录/退出结果）在离开就绪后不再有意义。
      MCP 配置文件列举属于项目而不属于代际，因此不在此清空。 */
  function resetViews(): void {
    resourcesView.value = { phase: 'idle' }
    entries.value = []
    resourcesTruncated.value = false
    diagnostics.value = []
    extensionErrors.value = []
    diagnosticsError.value = null
    mcpView.value = { phase: 'idle' }
    mcpCommandView.value = { phase: 'idle' }
    mcpInspectView.value = { phase: 'idle' }
    loadedRuntimeId = null
  }

  /** 读取资源清单；已读过同一代际时直接复用，`force` 用于用户手动刷新。 */
  async function refreshResources(force = false): Promise<void> {
    if (!runtimeReady.value) {
      resetViews()
      return
    }
    const runtimeId = currentRuntimeId.value
    if (runtimeId === null) return
    if (!force && loadedRuntimeId === runtimeId && resourcesView.value.phase === 'ready') return
    if (resourcesReading) return

    resourcesReading = true
    if (resourcesView.value.phase !== 'ready') resourcesView.value = { phase: 'loading' }
    try {
      const result = await getResources()
      // 结果必须属于同一仍就绪的代际，否则丢弃，等待新代际的读取。
      if (!runtimeReady.value || currentRuntimeId.value !== runtimeId) return
      if (!result.ok) {
        entries.value = []
        resourcesTruncated.value = false
        resourcesView.value = { phase: 'error', error: result.error }
        return
      }
      if (result.data.runtimeId !== runtimeId) return
      if (result.data.error !== null) {
        entries.value = []
        resourcesTruncated.value = false
        resourcesView.value = {
          phase: 'error',
          error: { code: 'RUNTIME_COMMAND_REJECTED', message: result.data.error }
        }
        return
      }
      entries.value = result.data.entries
      resourcesTruncated.value = result.data.truncated
      resourcesView.value = { phase: 'ready' }
      loadedRuntimeId = runtimeId
    } finally {
      resourcesReading = false
    }
  }

  /**
   * 读取 Runtime 未启动时的预读技能清单。就绪时立即清空且不探测；只保留技能：
   * 模板与扩展命令仍以运行中的 `get_commands` 为准，这里不给出第二份来源。
   * 项目切换、期间 Runtime 就绪或有更新的请求时丢弃响应；失败只记在展示状态里，
   * 不清空失败前的清单、不弹错，页面据此区分「预读失败」与「确实没有 Skill」。
   * `force` 为真时要求主进程绕过它的进程内缓存重新探测，供用户显式重新读取。
   */
  async function refreshPreview(force = false): Promise<void> {
    if (runtimeReady.value) {
      previewSkills.value = []
      previewView.value = { phase: 'idle' }
      return
    }
    const projectPath = useProjectStore().currentProject?.path ?? null
    if (projectPath === null) {
      previewSkills.value = []
      previewView.value = { phase: 'idle' }
      return
    }

    previewRequestId += 1
    const requestId = previewRequestId
    previewView.value = { phase: 'loading' }
    const result = await getResourcePreview(force)
    if (requestId !== previewRequestId) return
    if (runtimeReady.value || useProjectStore().currentProject?.path !== projectPath) {
      previewSkills.value = []
      previewView.value = { phase: 'idle' }
      return
    }
    if (!result.ok) {
      previewView.value = { phase: 'error', error: result.error }
      return
    }
    if (result.data.projectPath !== projectPath) {
      previewSkills.value = []
      previewView.value = { phase: 'idle' }
      return
    }
    previewSkills.value = result.data.entries.filter((entry) => entry.kind === 'skill')
    previewView.value = { phase: 'ready' }
  }

  /** 读取启动诊断与 Extension 运行时错误；诊断是 Pi 的 stderr 原文，按纯文本展示。 */
  async function refreshDiagnostics(): Promise<void> {
    if (diagnosticsLoading.value) return
    const runtimeId = currentRuntimeId.value
    diagnosticsLoading.value = true
    diagnosticsError.value = null
    try {
      const result = await getDiagnostics()
      if (currentRuntimeId.value !== runtimeId) return
      if (!result.ok) {
        diagnostics.value = []
        extensionErrors.value = []
        diagnosticsError.value = result.error
        return
      }
      if (result.data.runtimeId !== runtimeId) return
      diagnostics.value = result.data.stderrLines
      extensionErrors.value = result.data.extensionErrors
    } finally {
      diagnosticsLoading.value = false
    }
  }

  /**
   * 手动刷新清单、诊断与 MCP 配置列举；Runtime 未就绪时只清空与代际绑定的展示状态。
   * 探测结果属于探测那一刻的独立连接，不随这里的刷新清空；由 Runtime 代际变化与项目切换负责收拢。
   */
  async function refresh(): Promise<void> {
    await Promise.all([refreshResources(true), refreshDiagnostics(), refreshMcpConfig()])
  }

  /**
   * 读取 Pi 的 mcp.json 配置列举；与运行中的 Runtime 无关，未启动时也能读。
   * 期间切换了项目就丢弃本次结果，交给新项目的请求收敛。
   */
  async function refreshMcpConfig(): Promise<void> {
    const projectStore = useProjectStore()
    const projectId = projectStore.currentProjectId
    mcpConfigView.value = { phase: 'loading' }
    const result = await getMcpConfig()
    if (projectStore.currentProjectId !== projectId) return
    mcpConfigView.value = result.ok
      ? { phase: 'ready', data: result.data }
      : { phase: 'error', error: result.error }
  }

  /** 读取 MCP 状态：由主进程固定发送 `/mcp`，状态文本原样展示，不在页面拼造。 */
  async function requestMcpStatus(): Promise<void> {
    if (!runtimeReady.value || mcpView.value.phase === 'requesting') return

    mcpView.value = { phase: 'requesting' }
    const result = await readMcpStatus()
    if (!runtimeReady.value) {
      mcpView.value = { phase: 'idle' }
      return
    }
    mcpView.value = result.ok
      ? { phase: 'ready', disposition: result.data.disposition, messages: result.data.messages }
      : { phase: 'error', error: result.error }
  }

  /**
   * 探测 MCP 服务器状态：由主进程另起一次固定的 `pi mcp list --json`，结果只反映探测那一刻。
   * 正在探测时不重复发起；探测期间切换了项目就丢弃结果，不把旧项目的状态当成当前项目的。
   */
  async function inspectServers(): Promise<void> {
    if (mcpInspectView.value.phase === 'inspecting') return

    const projectStore = useProjectStore()
    const projectId = projectStore.currentProjectId
    inspectionCancelled = false
    mcpInspectView.value = { phase: 'inspecting' }
    const result = await inspectMcpServers()
    if (inspectionCancelled || projectStore.currentProjectId !== projectId) {
      mcpInspectView.value = { phase: 'idle' }
      return
    }
    mcpInspectView.value = result.ok
      ? { phase: 'ready', data: result.data }
      : { phase: 'error', error: result.error }
  }

  /**
   * 中止进行中的探测；中止请求没有生效时保持等待，
   * 让原请求的结果或错误自己收敛，不把未确认的中止当成已完成。
   */
  async function cancelInspection(): Promise<void> {
    if (mcpInspectView.value.phase !== 'inspecting') return
    inspectionCancelled = true
    const result = await abortMcpInspection()
    if (!result.ok || !result.data.aborted) inspectionCancelled = false
  }

  /**
   * MCP 列表：以配置文件列举为骨架，按名叠加探测报告；配置列举不可用时退化为探测结果，
   * 只出现在探测结果里的条目也照实列出，不因为不在配置文件里就静默隐藏。
   */
  const mcpServers = computed<readonly McpServerRow[]>(() => {
    const reports = new Map<string, McpServerReport>()
    if (mcpInspectView.value.phase === 'ready') {
      for (const server of mcpInspectView.value.data.servers) reports.set(server.name, server)
    }
    const listing = mcpConfigView.value.phase === 'ready' ? mcpConfigView.value.data : null
    if (listing === null) {
      return [...reports.values()].map((report) => ({
        name: report.name,
        scope: report.scope,
        source: report.source,
        enabled: report.enabled,
        transport: report.transport === '' ? null : report.transport,
        override: report.override,
        report
      }))
    }

    const rows: McpServerRow[] = listing.servers.map((server) => ({
      ...server,
      report: reports.get(server.name) ?? null
    }))
    const configured = new Set(listing.servers.map((server) => server.name))
    for (const report of reports.values()) {
      if (configured.has(report.name)) continue
      rows.push({
        name: report.name,
        scope: report.scope,
        source: report.source,
        enabled: report.enabled,
        transport: report.transport === '' ? null : report.transport,
        override: report.override,
        report
      })
    }
    return rows
  })

  /**
   * MCP 服务器 OAuth 登录、退出或重连：命令文本由主进程用服务器名拼出。
   * 登录需要用户在浏览器里完成授权，耗时较久；期间的浏览器地址与 redirect URL 输入
   * 由 Pi 经既有 Extension UI 通道给出，这里只展示本次请求的捕获文本。
   */
  async function runMcpServerCommand(action: McpCommandAction, serverName: string): Promise<void> {
    if (mcpCommandView.value.phase === 'running' || serverName === '') return

    mcpCommandView.value = { phase: 'running', action, serverName }
    const result = await runMcpCommand(action, serverName)
    mcpCommandView.value = result.ok
      ? { phase: 'ready', action, serverName, data: result.data }
      : { phase: 'error', action, serverName, error: result.error }
  }

  /**
   * 安全模式启动：不加载 Extension，仅本次生效；目标由主进程决定。
   * 成功后刷新会话列表（可能新建了会话），资源与诊断由代际监听重新读取。
   */
  async function startSafely(): Promise<void> {
    if (safeStart.value.phase === 'starting') return

    safeStart.value = { phase: 'starting' }
    const result = await startRuntimeSafely()
    if (!result.ok) {
      safeStart.value = { phase: 'error', error: result.error }
      return
    }
    safeStart.value = { phase: 'done' }
    resetViews()
    await useSessionStore().refresh()
  }

  /**
   * 应用启动时读取一次，并监听 Runtime 代际与当前项目的变化；重复调用无副作用。
   * 项目监听丢弃 MCP 探测结果并重读预读清单：两者都只对发起时的项目成立，
   * 而 Runtime 未启动时项目切换不会引起代际变化。
   */
  function initialize(): void {
    const projectStore = useProjectStore()
    if (stopRuntimeWatch === null) {
      stopRuntimeWatch = watch(currentRuntimeId, (runtimeId) => {
        if (runtimeId === null) {
          resetViews()
          void refreshPreview()
          return
        }
        void refresh()
        void refreshPreview()
      })
    }
    if (stopProjectWatch === null) {
      stopProjectWatch = watch(
        () => projectStore.currentProjectId,
        () => {
          mcpInspectView.value = { phase: 'idle' }
          void refreshPreview()
          void refreshMcpConfig()
        }
      )
    }
    void refresh()
    void refreshPreview()
  }

  /** 应用卸载时释放监听；重复调用无副作用。 */
  function dispose(): void {
    stopRuntimeWatch?.()
    stopRuntimeWatch = null
    stopProjectWatch?.()
    stopProjectWatch = null
  }

  return {
    resourcesView,
    entries,
    previewSkills,
    previewView,
    skills,
    prompts,
    commands,
    resourcesTruncated,
    diagnostics,
    extensionErrors,
    diagnosticsLoading,
    diagnosticsError,
    mcpView,
    mcpCommandView,
    mcpInspectView,
    mcpConfigView,
    mcpServers,
    safeStart,
    runtimeReady,
    refresh,
    refreshPreview,
    refreshMcpConfig,
    requestMcpStatus,
    inspectServers,
    cancelInspection,
    runMcpServerCommand,
    startSafely,
    initialize,
    dispose
  }
})
