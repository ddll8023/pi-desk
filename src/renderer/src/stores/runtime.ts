/** 保存 Runtime、聊天投影、对话回退、模型选择与展示偏好状态；不持有进程所有权，不写 Pi 配置或项目文件。 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { WatchStopHandle } from 'vue'
import type { ModelDisplayPreference, ModelPreferenceResult, PreferencesError } from '../../../shared/preferences-api'
import type {
  AgentCapabilities,
  ModelIdentity,
  ModelSummary,
  PiResourcePreview,
  ProjectionBatch,
  ProjectionBlock,
  ProjectionMessage,
  ProjectionUpdate,
  PromptDisposition,
  PromptImageInput,
  RuntimeError,
  RuntimeRewindRequest,
  RuntimeStatus,
  ToolExecution
} from '../../../shared/runtime-api'
import { useTrustStore } from './trust'
import { useProjectStore } from './project'
import { useAuthStore } from './auth'
import { getResourcePreview } from '../services/resource'
import { getModelDisplay, getNewSessionModel, setModelDisplay, setNewSessionModel } from '../services/preferences'
import {
  abortRuntime,
  ackRuntimeProjection,
  getRuntimeCapabilities,
  getRuntimeProjection,
  getRuntimeStatus,
  sendPrompt,
  rewindRuntime,
  setRuntimeModel,
  startRuntime,
  stopRuntime,
  subscribeRuntimeProjection,
  subscribeRuntimeStatus
} from '../services/runtime'

type RuntimeViewState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'ready'; snapshot: RuntimeStatus }
  | { phase: 'stopping' }
  | { phase: 'closed' }
  | { phase: 'failed'; error: RuntimeError }

type PromptViewState =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'accepted'; disposition: PromptDisposition }
  | { phase: 'error'; error: RuntimeError }

/** 回退结果未知时禁止继续写入；重新打开会话后才解除保守保护。 */
type RewindViewState =
  | { phase: 'idle' }
  | { phase: 'requesting' }
  | { phase: 'done'; cancelled: boolean }
  | { phase: 'error'; error: RuntimeError; blocked: boolean }

/** 中止请求的展示状态；运行中状态本身仍由事件流收敛。 */
type AbortViewState =
  | { phase: 'idle' }
  | { phase: 'requesting' }
  | { phase: 'error'; error: RuntimeError }

/** 模型切换只保存动作状态，当前模型始终由 Runtime 快照表达。 */
type ModelSwitchViewState =
  | { phase: 'idle' }
  | { phase: 'switching' }
  | { phase: 'error'; error: RuntimeError }

/** `synced` 表示当前展示就是基准（无 Runtime 时为空基准），`syncing` 表示未取得基准或正在重同步，`stale` 表示失去同步且尚未取得快照。 */
type ProjectionSyncState = 'syncing' | 'synced' | 'stale'

/** 可用模型列表的读取状态。 */
type CapabilitiesViewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; data: AgentCapabilities }
  | { phase: 'error'; error: RuntimeError }

/** 预读与 Runtime 能力分开保存，不能把不执行扩展的预读列表混进运行中清单。 */
type ModelPreviewViewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; data: PiResourcePreview }
  | { phase: 'error'; error: RuntimeError }

type ModelPreferenceViewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'saving' }
  | { phase: 'error'; error: PreferencesError }

/** 对话页模型展示偏好的读取与保存状态；保存成功后才提交选择。 */
type ModelDisplayViewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'saving' }
  | { phase: 'error'; error: PreferencesError }

/** 块级幂等替换；新块按 contentIndex 顺序插入。 */
function replaceBlock(blocks: readonly ProjectionBlock[], block: ProjectionBlock): ProjectionBlock[] {
  const index = blocks.findIndex((candidate) => candidate.contentIndex === block.contentIndex)
  if (index < 0) {
    return [...blocks, block].sort((left, right) => left.contentIndex - right.contentIndex)
  }
  const next = [...blocks]
  next[index] = block
  return next
}

/** 追加要求长度不变式成立；不符时返回 null，由调用方转快照重同步，不猜测补齐。 */
function appendBlock(
  blocks: readonly ProjectionBlock[],
  contentIndex: number,
  text: string,
  length: number
): ProjectionBlock[] | null {
  const index = blocks.findIndex((candidate) => candidate.contentIndex === contentIndex)
  const target = index < 0 ? undefined : blocks[index]
  if (target === undefined) return null

  const nextText = target.text + text
  if (nextText.length !== length) return null
  const next = [...blocks]
  next[index] = { ...target, text: nextText }
  return next
}

/** 应用一批更新；遇到未知消息或长度不符时返回 null，表示必须整表重同步。 */
function applyUpdates(
  messages: readonly ProjectionMessage[],
  tools: readonly ToolExecution[],
  updates: readonly ProjectionUpdate[]
): { messages: ProjectionMessage[]; tools: ToolExecution[] } | null {
  let nextMessages = [...messages]
  let nextTools = [...tools]
  for (const update of updates) {
    if (update.kind === 'tool') {
      const incoming = update.tool
      // 工具条目本身是权威内容：未知 toolCallId 也直接收录，不做猜测。
      const known = nextTools.some((tool) => tool.toolCallId === incoming.toolCallId)
      nextTools = known
        ? nextTools.map((tool) => (tool.toolCallId === incoming.toolCallId ? incoming : tool))
        : [...nextTools, incoming]
      continue
    }
    if (update.kind === 'message') {
      const incoming = update.message
      const messageIndex = nextMessages.findIndex((message) => message.id === incoming.id)
      nextMessages = messageIndex < 0
        ? [...nextMessages, incoming]
        : nextMessages.map((message) => (message.id === incoming.id ? incoming : message))
      continue
    }

    const messageId = update.messageId
    const index = nextMessages.findIndex((message) => message.id === messageId)
    const target = index < 0 ? undefined : nextMessages[index]
    if (target === undefined) return null

    const blocks = update.kind === 'block'
      ? replaceBlock(target.blocks, update.block)
      : appendBlock(target.blocks, update.contentIndex, update.text, update.length)
    if (blocks === null) return null
    nextMessages[index] = { ...target, blocks }
  }
  return { messages: nextMessages, tools: nextTools }
}

export const useRuntimeStore = defineStore('runtime', () => {
  const view = ref<RuntimeViewState>({ phase: 'idle' })
  const promptView = ref<PromptViewState>({ phase: 'idle' })
  /** 附件读取也属于提交阶段，回退和切换模型不能穿插其间。 */
  const preparingPrompt = ref(false)
  const rewindView = ref<RewindViewState>({ phase: 'idle' })
  let rewindRequest = 0
  const abortView = ref<AbortViewState>({ phase: 'idle' })
  const messages = ref<readonly ProjectionMessage[]>([])
  const tools = ref<readonly ToolExecution[]>([])
  const projectionSync = ref<ProjectionSyncState>('syncing')
  const projectionTruncated = ref(false)
  const droppedMessages = ref(0)
  const droppedTools = ref(0)
  const capabilitiesView = ref<CapabilitiesViewState>({ phase: 'idle' })
  const modelSwitchView = ref<ModelSwitchViewState>({ phase: 'idle' })
  const modelPreviewView = ref<ModelPreviewViewState>({ phase: 'idle' })
  const modelPreferenceView = ref<ModelPreferenceViewState>({ phase: 'idle' })
  const newSessionModel = ref<ModelIdentity | null>(null)
  const modelPreferenceLoaded = ref(false)
  let modelPreferenceRequest = 0
  let modelLifecycle = 0
  let modelPreferencePromise: Promise<void> | null = null
  let modelSavePromise: Promise<void> | null = null
  const hiddenModels = ref<readonly ModelIdentity[]>([])
  const modelDisplayLoaded = ref(false)
  const modelDisplayView = ref<ModelDisplayViewState>({ phase: 'idle' })
  let modelDisplayRequest = 0
  let modelDisplayPromise: Promise<void> | null = null
  let modelDisplaySavePromise: Promise<void> | null = null
  let modelPreviewRequest = 0
  /** 已发起过预读的范围；undefined 表示尚未发起。 */
  let modelPreviewAttemptedScope: string | undefined
  let stopProjectWatch: WatchStopHandle | null = null
  let stopAuthWatch: WatchStopHandle | null = null
  let modelSwitchRequest = 0
  let capabilitiesRequest = 0
  let releaseSubscription: (() => void) | null = null
  let releaseProjection: (() => void) | null = null
  /** 已取得基准快照的 Runtime 代际；为空表示当前没有 Runtime 代际（空基准或尚未取得快照）。 */
  let appliedRuntimeId: number | null = null
  let appliedSeq = 0
  let projectionSyncPromise: Promise<void> | null = null
  /** 已发起过读取的代际：读取失败后不因每次状态广播重复重试。 */
  let capabilitiesAttemptedRuntimeId: number | null = null

  /** 先订阅状态与投影、再取快照，避免初始化期间漏掉通知。 */
  async function initialize(): Promise<void> {
    if (releaseSubscription === null) {
      releaseSubscription = subscribeRuntimeStatus(applyStatus)
    }
    if (releaseProjection === null) {
      releaseProjection = subscribeRuntimeProjection(applyBatch)
    }
    if (stopProjectWatch === null) {
      // 项目列表读完但没有当前项目时也要探测一次全局目录，因此把列表状态一并作为触发条件。
      stopProjectWatch = watch(
        () => [useProjectStore().currentProject?.path ?? null, useProjectStore().view.phase] as const,
        () => {
          clearModelPreview()
          void refreshModelPreview()
        }
      )
    }
    if (stopAuthWatch === null) {
      const auth = useAuthStore()
      stopAuthWatch = watch(() => [auth.providers, auth.flow?.phase] as const,
        ([providers, phase], [previousProviders, previousPhase]) => {
          if (providers !== previousProviders || (phase === 'completed' && previousPhase !== phase)) {
            void refreshModelPreview(true)
          }
        })
    }
    void loadModelPreference()
    void loadModelDisplay()
    const result = await getRuntimeStatus()
    if (result.ok) applyStatus(result.data)
    refreshModelPreviewIfNeeded()
    await syncProjection()
  }

  /** 页面卸载时释放订阅并作废模型切换与模型列表读取的迟到结果；不取消主进程已提交的操作。 */
  function dispose(): void {
    releaseSubscription?.()
    releaseSubscription = null
    releaseProjection?.()
    releaseProjection = null
    projectionSyncPromise = null
    stopProjectWatch?.()
    stopProjectWatch = null
    stopAuthWatch?.()
    stopAuthWatch = null
    clearModelPreview()
    modelLifecycle += 1
    rewindRequest += 1
    rewindView.value = { phase: 'idle' }
    preparingPrompt.value = false
    modelPreferenceRequest += 1
    modelPreferenceLoaded.value = false
    modelPreferenceView.value = { phase: 'idle' }
    modelPreferencePromise = null
    modelSavePromise = null
    modelDisplayRequest += 1
    hiddenModels.value = []
    modelDisplayLoaded.value = false
    modelDisplayView.value = { phase: 'idle' }
    modelDisplayPromise = null
    modelDisplaySavePromise = null
    modelSwitchRequest += 1
    capabilitiesRequest += 1
    modelSwitchView.value = { phase: 'idle' }
  }

  /** 只在没有活动 Runtime 时读取启动前候选，失败状态也允许重新选择。 */
  function canPreviewModels(): boolean {
    return view.value.phase === 'idle' || view.value.phase === 'closed' || view.value.phase === 'failed'
  }

  /**
   * 预读范围标记：已选项目用项目路径，未选项目统一用全局标记（项目路径均为绝对路径，不会与之相同）。
   * 结果与“是否已发起过预读”的判重都按这个标记，避免未选项目时反复探测。
   */
  function modelPreviewScope(projectPath: string | null): string {
    return projectPath ?? '__global__'
  }

  /**
   * 当前可见的模型来源：就绪时取 Runtime 能力，未启动时取主进程预读；
   * 两处都会按 Runtime 代际或预读范围丢弃过期结果。模型选择器与设置子页共用这一份。
   */
  const availableModels = computed<readonly ModelSummary[]>(() => {
    if (view.value.phase === 'ready') {
      return capabilitiesView.value.phase === 'ready'
        && capabilitiesView.value.data.runtimeId === view.value.snapshot.runtimeId
        ? capabilitiesView.value.data.models : []
    }
    if (!canPreviewModels()) return []
    return modelPreviewView.value.phase === 'ready'
      && modelPreviewView.value.data.projectPath === (useProjectStore().currentProject?.path ?? null)
      ? modelPreviewView.value.data.models : []
  })

  /** 顶栏切换器的候选项：排除在设置中隐藏的模型。 */
  const visibleModels = computed<readonly ModelSummary[]>(() => (
    availableModels.value.filter((model) => !hiddenModels.value.some((hidden) => (
      hidden.provider === model.provider && hidden.modelId === model.id
    )))
  ))

  /** 离开预读阶段或切换项目时使迟到结果失效。 */
  function clearModelPreview(): void {
    modelPreviewRequest += 1
    modelPreviewAttemptedScope = undefined
    modelPreviewView.value = { phase: 'idle' }
  }

  /** 状态广播只为尚未读过的范围发起一次，错误不因广播自动重试。 */
  function refreshModelPreviewIfNeeded(): void {
    const path = useProjectStore().currentProject?.path ?? null
    if (canPreviewModels() && modelPreviewScope(path) !== modelPreviewAttemptedScope) void refreshModelPreview()
  }

  /** 资源与模型共用主进程的一次性预读；项目或 Runtime 改变后丢弃结果。未选项目时读全局模型目录。 */
  async function refreshModelPreview(force = false): Promise<void> {
    if (!canPreviewModels()) return
    const projectStore = useProjectStore()
    const projectPath = projectStore.currentProject?.path ?? null
    // 项目列表还没读完时先不探测：否则会先做一次全局探测，随后又为真实项目重做一次。
    if (projectPath === null && projectStore.view.phase === 'loading') return
    const scope = modelPreviewScope(projectPath)
    if (!force && modelPreviewAttemptedScope === scope && modelPreviewView.value.phase === 'loading') return
    const request = ++modelPreviewRequest
    modelPreviewAttemptedScope = scope
    modelPreviewView.value = { phase: 'loading' }
    const result = await getResourcePreview(force)
    if (request !== modelPreviewRequest || !canPreviewModels()
      || (projectStore.currentProject?.path ?? null) !== projectPath) return
    if (!result.ok) {
      modelPreviewView.value = { phase: 'error', error: result.error }
      return
    }
    if (result.data.projectPath !== projectPath) {
      modelPreviewView.value = {
        phase: 'error', error: { code: 'INVALID_RESPONSE', message: '模型预读返回了其他范围的结果，未应用。' }
      }
      return
    }
    modelPreviewView.value = { phase: 'ready', data: result.data }
  }

  /** 模型偏好只读一次；失败可显式重读，保存中不让读请求覆盖用户的新选择。 */
  async function loadModelPreference(force = false): Promise<void> {
    const lifecycle = modelLifecycle
    if (modelSavePromise !== null) await modelSavePromise
    if (lifecycle !== modelLifecycle) return
    if (modelPreferencePromise !== null) return modelPreferencePromise
    if (modelPreferenceLoaded.value && !force) return
    const request = ++modelPreferenceRequest
    modelPreferenceView.value = { phase: 'loading' }
    const promise = (async () => {
      const result = await getNewSessionModel()
      if (request !== modelPreferenceRequest) return
      if (!result.ok) {
        modelPreferenceView.value = { phase: 'error', error: result.error }
        return
      }
      newSessionModel.value = result.data
      modelPreferenceLoaded.value = true
      modelPreferenceView.value = { phase: 'ready' }
    })()
    modelPreferencePromise = promise
    try { await promise } finally {
      if (request === modelPreferenceRequest) modelPreferencePromise = null
    }
  }

  /**
   * 只保存候选目录中的真实身份，成功后再更新选择；空值用于恢复跟随 Pi 默认。
   * Runtime 就绪时也能调用：此时候选来自 Runtime 能力，设置默认与当前会话模型互不影响。
   */
  async function chooseNewSessionModel(model: ModelIdentity | null): Promise<void> {
    if ((!canPreviewModels() && view.value.phase !== 'ready') || !modelPreferenceLoaded.value
      || modelPreferenceView.value.phase === 'loading' || modelPreferenceView.value.phase === 'saving') return
    if (model !== null && !availableModels.value.some(candidate => (
      candidate.provider === model.provider && candidate.id === model.modelId
    ))) return
    const request = ++modelPreferenceRequest
    modelPreferenceView.value = { phase: 'saving' }
    const promise = (async () => {
      const result = await setNewSessionModel(model)
      if (request !== modelPreferenceRequest) return
      if (!result.ok) {
        modelPreferenceView.value = { phase: 'error', error: result.error }
        return
      }
      newSessionModel.value = result.data
      modelPreferenceView.value = { phase: 'ready' }
    })()
    modelSavePromise = promise
    try { await promise } finally {
      if (request === modelPreferenceRequest) modelSavePromise = null
    }
  }

  /** 新建会话等待初始读取或正在保存的选择，不能在竞态中错误使用 Pi 默认。 */
  async function prepareNewSessionModel(): Promise<ModelPreferenceResult> {
    await loadModelPreference()
    if (modelPreferenceView.value.phase === 'error') {
      return { ok: false, error: modelPreferenceView.value.error }
    }
    if (!modelPreferenceLoaded.value) {
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: '新会话默认模型尚未读取完成。' } }
    }
    return { ok: true, data: newSessionModel.value === null ? null : { ...newSessionModel.value } }
  }

  /** 展示偏好只读一次；失败可显式重读，保存中不让读请求覆盖用户的新选择。 */
  async function loadModelDisplay(force = false): Promise<void> {
    const lifecycle = modelLifecycle
    if (modelDisplaySavePromise !== null) await modelDisplaySavePromise
    if (lifecycle !== modelLifecycle) return
    if (modelDisplayPromise !== null) return modelDisplayPromise
    if (modelDisplayLoaded.value && !force) return
    const request = ++modelDisplayRequest
    modelDisplayView.value = { phase: 'loading' }
    const promise = (async () => {
      const result = await getModelDisplay()
      if (request !== modelDisplayRequest) return
      if (!result.ok) {
        modelDisplayView.value = { phase: 'error', error: result.error }
        return
      }
      hiddenModels.value = result.data.hiddenModels.map((model) => ({ provider: model.provider, modelId: model.modelId }))
      modelDisplayLoaded.value = true
      modelDisplayView.value = { phase: 'ready' }
    })()
    modelDisplayPromise = promise
    try { await promise } finally {
      if (request === modelDisplayRequest) modelDisplayPromise = null
    }
  }

  /** 保存成功后才更新展示偏好；失败保留原值并暴露错误，不乐观改写。 */
  async function saveModelDisplay(preference: ModelDisplayPreference): Promise<void> {
    if (!modelDisplayLoaded.value || modelDisplayView.value.phase === 'loading'
      || modelDisplayView.value.phase === 'saving') return
    const request = ++modelDisplayRequest
    modelDisplayView.value = { phase: 'saving' }
    const promise = (async () => {
      const result = await setModelDisplay(preference)
      if (request !== modelDisplayRequest) return
      if (!result.ok) {
        modelDisplayView.value = { phase: 'error', error: result.error }
        return
      }
      hiddenModels.value = result.data.hiddenModels.map((model) => ({ provider: model.provider, modelId: model.modelId }))
      modelDisplayView.value = { phase: 'ready' }
    })()
    modelDisplaySavePromise = promise
    try { await promise } finally {
      if (request === modelDisplayRequest) modelDisplaySavePromise = null
    }
  }

  /**
   * 批量设置一组模型在对话页的可见性：`visible` 为真时从隐藏列表移除，为假时全部加入。
   * 单个模型开关与供应商级的全选/全不选共用这一入口。
   */
  function setModelsVisibility(models: readonly ModelIdentity[], visible: boolean): void {
    const target = new Set(models.map((model) => `${model.provider}\u0000${model.modelId}`))
    const kept = hiddenModels.value.filter((hidden) => !target.has(`${hidden.provider}\u0000${hidden.modelId}`))
    const next = visible
      ? kept
      : [...kept, ...models.map((model) => ({ provider: model.provider, modelId: model.modelId }))]
    void saveModelDisplay({ hiddenModels: next })
  }

  /** 恢复为全部显示；清空隐藏列表并保存。 */
  function showAllModels(): void {
    void saveModelDisplay({ hiddenModels: [] })
  }

  /** 启动唯一 Runtime；启动、就绪或关闭中都不重复发起。当前界面不调用它，启动统一走打开或新建会话。 */
  async function launch(projectPath: string): Promise<void> {
    if (view.value.phase === 'starting' || view.value.phase === 'ready' || view.value.phase === 'stopping') {
      return
    }

    view.value = { phase: 'starting' }
    const result = await startRuntime(projectPath)
    if (!result.ok) {
      if (result.error.code === 'TRUST_REQUIRED') {
        // 与会话切换共用同一条信任决定流程；用户取消后回到当前状态。
        view.value = { phase: 'idle' }
        await useTrustStore().openPrompt()
        return
      }
      view.value = { phase: 'failed', error: result.error }
      return
    }
    // 主进程只在就绪时返回成功；其他状态按失败展示，不把进程存在当作可用。
    if (result.data.state !== 'ready') {
      view.value = {
        phase: 'failed',
        error: { code: 'INTERNAL_ERROR', message: 'Runtime 没有进入就绪状态。' }
      }
      return
    }
    applyStatus(result.data)
  }

  /** 关闭当前 Runtime；只有就绪状态才发起关闭。 */
  async function shutdown(): Promise<void> {
    if (view.value.phase !== 'ready') return

    view.value = { phase: 'stopping' }
    const result = await stopRuntime()
    if (!result.ok) {
      view.value = { phase: 'failed', error: result.error }
      return
    }
    applyStatus(result.data)
  }

  /** 回退处理中或结果未知时，禁止发送和切换模型。 */
  function rewindBlocksWrites(): boolean {
    return rewindView.value.phase === 'requesting'
      || (rewindView.value.phase === 'error' && rewindView.value.blocked)
  }

  /** 提交 Prompt；旧会话的迟到结果不能清空或改写新会话输入。 */
  async function send(message: string, images: readonly PromptImageInput[] = []): Promise<void> {
    if (view.value.phase !== 'ready' || promptView.value.phase === 'sending'
      || modelSwitchView.value.phase === 'switching' || rewindBlocksWrites()) return
    const target = view.value.snapshot
    promptView.value = { phase: 'sending' }
    const result = await sendPrompt(message, images)
    if (view.value.phase !== 'ready' || view.value.snapshot.runtimeId !== target.runtimeId
      || view.value.snapshot.info?.sessionId !== target.info?.sessionId) return
    promptView.value = result.ok
      ? { phase: 'accepted', disposition: result.data.disposition }
      : { phase: 'error', error: result.error }
  }

  /** 显式确认后回退；成功时同步投影。 */
  async function rewind(request: RuntimeRewindRequest): Promise<boolean> {
    if (view.value.phase !== 'ready' || rewindBlocksWrites() || preparingPrompt.value
      || promptView.value.phase === 'sending' || modelSwitchView.value.phase === 'switching'
      || view.value.snapshot.info?.isStreaming === true || projectionSync.value !== 'synced'
      || view.value.snapshot.runtimeId !== request.runtimeId || view.value.snapshot.info?.sessionId !== request.sessionId) return false
    const sequence = ++rewindRequest
    rewindView.value = { phase: 'requesting' }
    try {
      const result = await rewindRuntime(request)
      if (sequence !== rewindRequest || view.value.phase !== 'ready'
        || view.value.snapshot.runtimeId !== request.runtimeId) return false
      if (!result.ok) {
        rewindView.value = { phase: 'error', error: result.error, blocked: result.blocked === true }
        return false
      }
      const status = result.data.status
      const sessionId = status.info?.sessionId
      const currentSessionId = view.value.snapshot.info?.sessionId
      if (status.state !== 'ready' || status.runtimeId !== request.runtimeId
        || (currentSessionId !== request.sessionId && currentSessionId !== sessionId)) return false
      if (result.data.cancelled) {
        rewindView.value = { phase: 'done', cancelled: true }
        return false
      }
      applyStatus(status)
      await syncProjection(status.runtimeId ?? undefined)
      if (sequence !== rewindRequest || view.value.phase !== 'ready'
        || view.value.snapshot.runtimeId !== status.runtimeId || view.value.snapshot.info?.sessionId !== sessionId) return false
      if (projectionSync.value !== 'synced') {
        rewindView.value = { phase: 'error', error: { code: 'INVALID_RESPONSE', message: '对话已回退，但消息同步失败；请重新打开会话。' }, blocked: true }
        return false
      }
      rewindView.value = { phase: 'done', cancelled: false }
      return true
    } finally {
      if (sequence === rewindRequest && rewindView.value.phase === 'requesting') rewindView.value = { phase: 'idle' }
    }
  }

  /** 只在当前代际空闲时切换；不乐观更新模型，也不自动重试写操作。 */
  async function switchModel(provider: string, modelId: string): Promise<void> {
    if (view.value.phase !== 'ready' || view.value.snapshot.info?.isStreaming === true
      || promptView.value.phase === 'sending' || preparingPrompt.value
      || modelSwitchView.value.phase === 'switching' || rewindBlocksWrites()) return
    const status = view.value.snapshot
    const runtimeId = status.runtimeId
    if (runtimeId === null) return
    if (status.info?.modelProvider === provider && status.info.modelId === modelId) return

    const request = ++modelSwitchRequest
    modelSwitchView.value = { phase: 'switching' }
    const result = await setRuntimeModel(runtimeId, provider, modelId)
    if (request !== modelSwitchRequest || view.value.phase !== 'ready'
      || view.value.snapshot.runtimeId !== runtimeId) return
    if (!result.ok) {
      modelSwitchView.value = { phase: 'error', error: result.error }
      return
    }
    if (result.data.runtimeId !== runtimeId || result.data.state !== 'ready') {
      modelSwitchView.value = {
        phase: 'error',
        error: { code: 'INVALID_RESPONSE', message: '模型切换返回了其他会话的状态，未应用该结果。' }
      }
      return
    }
    applyStatus(result.data)
    modelSwitchView.value = { phase: 'idle' }
    void refreshCapabilities()
  }

  /**
   * 请求中止当前操作；只在就绪且事件流显示运行中时发起，发送中不重复提交。
   * 成功只表示 Pi 已确认取消，运行中状态的最终收敛仍由事件流负责。
   */
  async function stopOperation(): Promise<void> {
    if (view.value.phase !== 'ready') return
    if (view.value.snapshot.info?.isStreaming !== true) return
    if (abortView.value.phase === 'requesting') return

    abortView.value = { phase: 'requesting' }
    const result = await abortRuntime()
    abortView.value = result.ok
      ? { phase: 'idle' }
      : { phase: 'error', error: result.error }
  }

  /**
   * 全量重同步：快照是唯一基准，期间到达的增量由序号守卫丢弃。
   * 无活动 Runtime 的空快照（`runtimeId` 为 null）本身是有效空基准，不作为换代冲突处理。
   */
  function syncProjection(expectedRuntimeId?: number): Promise<void> {
    if (projectionSyncPromise !== null) return projectionSyncPromise
    // 回退动作必须等真正的同步完成，不能因另一个请求进行中就提前返回。
    const pending: Promise<void> = readProjection(expectedRuntimeId).finally(() => {
      if (projectionSyncPromise === pending) projectionSyncPromise = null
    })
    projectionSyncPromise = pending
    return pending
  }

  /** 读取期间换会话就丢弃旧响应，并在同一等待链中取得新会话的快照。 */
  async function readProjection(expectedRuntimeId?: number): Promise<void> {
    projectionSync.value = 'syncing'
    const lifecycle = modelLifecycle
    while (lifecycle === modelLifecycle) {
      const target = view.value.phase === 'ready' ? view.value.snapshot : null
      const result = await getRuntimeProjection()
      const current = view.value.phase === 'ready' ? view.value.snapshot : null
      if (lifecycle !== modelLifecycle) return
      if (target?.runtimeId !== current?.runtimeId || target?.info?.sessionId !== current?.info?.sessionId) {
        expectedRuntimeId = current?.runtimeId ?? undefined
        continue
      }
      if (!result.ok) {
        projectionSync.value = 'stale'
        return
      }
      const snapshot = result.data
      if (expectedRuntimeId !== undefined && snapshot.runtimeId !== expectedRuntimeId) {
        projectionSync.value = 'stale'
        return
      }
      appliedRuntimeId = snapshot.runtimeId
      appliedSeq = snapshot.seq
      messages.value = snapshot.messages
      tools.value = snapshot.tools
      projectionTruncated.value = snapshot.truncated
      droppedMessages.value = snapshot.droppedMessages
      droppedTools.value = snapshot.droppedTools
      projectionSync.value = 'synced'
      if (snapshot.runtimeId !== null) ackRuntimeProjection(snapshot.runtimeId, snapshot.seq)
      return
    }
  }

  /** 批次按序号连续应用；旧代际、缺口与重同步标记都收敛到快照。 */
  function applyBatch(batch: ProjectionBatch): void {
    if (appliedRuntimeId === null || batch.runtimeId !== appliedRuntimeId) {
      // 尚无基准快照或批次来自旧代际：不能无基准地应用增量。
      void syncProjection(batch.runtimeId)
      return
    }
    if (batch.resyncRequired) {
      void syncProjection(batch.runtimeId)
      return
    }
    if (batch.seq <= appliedSeq) {
      // 快照已经覆盖的迟到批次，只需补一次确认。
      ackRuntimeProjection(batch.runtimeId, appliedSeq)
      return
    }
    if (batch.seq !== appliedSeq + 1) {
      void syncProjection(batch.runtimeId)
      return
    }

    const applied = applyUpdates(messages.value, tools.value, batch.updates)
    if (applied === null) {
      projectionSync.value = 'stale'
      void syncProjection(batch.runtimeId)
      return
    }
    messages.value = applied.messages
    tools.value = applied.tools
    appliedSeq = batch.seq
    projectionSync.value = 'synced'
    ackRuntimeProjection(batch.runtimeId, appliedSeq)
  }

  /** 投影随 Runtime 代际存在：离开就绪即清空展示消息；没有 Runtime 时空投影本身就是基准。 */
  function resetProjection(): void {
    messages.value = []
    tools.value = []
    projectionSync.value = 'synced'
    projectionTruncated.value = false
    droppedMessages.value = 0
    droppedTools.value = 0
    appliedRuntimeId = null
    appliedSeq = 0
  }

  /** 主进程快照是唯一真相：事件通知与查询结果都经这里映射为展示状态。 */
  function applyStatus(status: RuntimeStatus): void {
    const previousRuntimeId = view.value.phase === 'ready' ? view.value.snapshot.runtimeId : null
    const previousSessionId = view.value.phase === 'ready' ? view.value.snapshot.info?.sessionId : null
    const sessionChanged = status.state === 'ready' && status.info?.sessionId !== previousSessionId
    if (status.state !== 'ready' || status.runtimeId !== previousRuntimeId) {
      rewindRequest += 1
      rewindView.value = { phase: 'idle' }
      preparingPrompt.value = false
    }
    if (status.state !== 'ready' || status.runtimeId !== previousRuntimeId || sessionChanged) {
      promptView.value = { phase: 'idle' }
      abortView.value = { phase: 'idle' }
    }
    const previousStreaming = view.value.phase === 'ready'
      && view.value.snapshot.info?.isStreaming === true
    if (status.state !== 'ready' || status.runtimeId !== previousRuntimeId || sessionChanged) {
      modelSwitchRequest += 1
      capabilitiesRequest += 1
      modelSwitchView.value = { phase: 'idle' }
    }
    if (status.state === 'starting' || status.state === 'stopping' || status.state === 'ready') {
      if (modelPreviewView.value.phase !== 'idle' || modelPreviewAttemptedScope !== undefined) clearModelPreview()
    }
    if (status.state !== 'ready') {
      resetProjection()
      // Runtime 离开就绪后，上一次中止请求的展示状态不再有意义。
      abortView.value = { phase: 'idle' }
      capabilitiesView.value = { phase: 'idle' }
      capabilitiesAttemptedRuntimeId = null
    }
    if (status.state === 'failed') {
      view.value = {
        phase: 'failed',
        error: {
          code: 'RUNTIME_EXITED',
          message: status.lastError ?? 'Runtime 已异常退出，结果不确定。'
        }
      }
      refreshModelPreviewIfNeeded()
      return
    }
    if (status.state === 'ready') {
      view.value = { phase: 'ready', snapshot: status }
      // 换代与上一次重同步未收敛（syncing/stale）都重新取基准。
      if (sessionChanged || status.runtimeId !== appliedRuntimeId || projectionSync.value !== 'synced') {
        void syncProjection(status.runtimeId ?? undefined)
      }
      // 新 Runtime 或一轮结束后刷新模型列表，维持 Provider、模型显示名与图片输入能力提示。
      if (sessionChanged || status.runtimeId !== capabilitiesAttemptedRuntimeId
        || (previousStreaming && status.info?.isStreaming !== true)) {
        void refreshCapabilities()
      }
      return
    }
    if (status.state === 'stopping') {
      view.value = { phase: 'stopping' }
      return
    }
    if (status.state === 'starting') {
      view.value = { phase: 'starting' }
      return
    }
    // idle 且带 runtimeId 表示上一次 Runtime 已正常关闭。
    view.value = status.runtimeId === null ? { phase: 'idle' } : { phase: 'closed' }
    refreshModelPreviewIfNeeded()
  }

  /** 读取当前 Runtime 的可用模型；仅接收仍在就绪的同一代际中最新请求的结果，其余结果丢弃。 */
  async function refreshCapabilities(): Promise<void> {
    if (view.value.phase !== 'ready') return
    const requestedRuntimeId = view.value.snapshot.runtimeId
    const request = ++capabilitiesRequest
    capabilitiesAttemptedRuntimeId = requestedRuntimeId
    if (capabilitiesView.value.phase !== 'ready' || capabilitiesView.value.data.modelsError !== null) {
      capabilitiesView.value = { phase: 'loading' }
    }

    const result = await getRuntimeCapabilities()
    if (request !== capabilitiesRequest || view.value.phase !== 'ready'
      || view.value.snapshot.runtimeId !== requestedRuntimeId) return
    if (!result.ok) {
      capabilitiesView.value = { phase: 'error', error: result.error }
      return
    }
    if (result.data.runtimeId !== requestedRuntimeId) return
    capabilitiesView.value = { phase: 'ready', data: result.data }
  }

  return {
    view,
    promptView,
    preparingPrompt,
    rewindView,
    abortView,
    capabilitiesView,
    modelSwitchView,
    modelPreviewView,
    modelPreferenceView,
    newSessionModel,
    modelPreferenceLoaded,
    hiddenModels,
    modelDisplayLoaded,
    modelDisplayView,
    availableModels,
    visibleModels,
    messages,
    tools,
    projectionSync,
    projectionTruncated,
    droppedMessages,
    droppedTools,
    initialize,
    dispose,
    launch,
    shutdown,
    send,
    rewind,
    switchModel,
    refreshModelPreview,
    loadModelPreference,
    chooseNewSessionModel,
    prepareNewSessionModel,
    loadModelDisplay,
    saveModelDisplay,
    setModelsVisibility,
    showAllModels,
    stopOperation,
    refreshCapabilities
  }
})
