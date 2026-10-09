/**
 * 保存 Pi 资源面板的展示状态：`get_commands` 清单、启动诊断、MCP 状态与安全模式启动结果。
 *
 * 只保存主进程投影的副本，不缓存历史、不解析 Pi 配置文件；清单与诊断都只在 Runtime 就绪时读取，
 * 代际变化后自动重读（资源只在进程启动时加载，重载必须重启 Runtime）。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type {
  ExtensionErrorEntry,
  PiResourceEntry,
  PromptDisposition,
  RuntimeError
} from '../../../shared/runtime-api'
import { useRuntimeStore } from './runtime'
import { useSessionStore } from './session'
import { getDiagnostics, getResources, readMcpStatus, startRuntimeSafely } from '../services/resource'

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
  const resourcesTruncated = ref(false)
  const diagnostics = ref<readonly string[]>([])
  const extensionErrors = ref<readonly ExtensionErrorEntry[]>([])
  const diagnosticsLoading = ref(false)
  const diagnosticsError = ref<RuntimeError | null>(null)
  const mcpView = ref<McpViewState>({ phase: 'idle' })
  const safeStart = ref<SafeStartState>({ phase: 'idle' })

  /** 已读取过的 Runtime 代际；代际变化后重新读取清单与诊断。 */
  let loadedRuntimeId: number | null = null
  let resourcesReading = false
  let stopWatch: (() => void) | null = null

  const runtimeReady = computed(() => runtimeStore.view.phase === 'ready')
  const currentRuntimeId = computed(() => (
    runtimeStore.view.phase === 'ready' ? runtimeStore.view.snapshot.runtimeId : null
  ))

  const skills = computed(() => entries.value.filter((entry) => entry.kind === 'skill'))
  const prompts = computed(() => entries.value.filter((entry) => entry.kind === 'prompt'))
  const commands = computed(() => entries.value.filter((entry) => entry.kind === 'extension'))

  /** 清空与 Runtime 代际绑定的展示状态；诊断与 MCP 状态在离开就绪后不再有意义。 */
  function resetViews(): void {
    resourcesView.value = { phase: 'idle' }
    entries.value = []
    resourcesTruncated.value = false
    diagnostics.value = []
    extensionErrors.value = []
    diagnosticsError.value = null
    mcpView.value = { phase: 'idle' }
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

  /** 手动刷新清单与诊断；Runtime 未就绪时只清空展示状态。 */
  async function refresh(): Promise<void> {
    await Promise.all([refreshResources(true), refreshDiagnostics()])
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

  /** 应用启动时读取一次，并监听 Runtime 代际变化自动重读；重复调用无副作用。 */
  function initialize(): void {
    if (stopWatch === null) {
      stopWatch = watch(currentRuntimeId, (runtimeId) => {
        if (runtimeId === null) {
          resetViews()
          return
        }
        void refresh()
      })
    }
    void refresh()
  }

  /** 应用卸载时释放监听；重复调用无副作用。 */
  function dispose(): void {
    stopWatch?.()
    stopWatch = null
  }

  return {
    resourcesView,
    entries,
    skills,
    prompts,
    commands,
    resourcesTruncated,
    diagnostics,
    extensionErrors,
    diagnosticsLoading,
    diagnosticsError,
    mcpView,
    safeStart,
    runtimeReady,
    refresh,
    requestMcpStatus,
    startSafely,
    initialize,
    dispose
  }
})
