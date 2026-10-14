/** 保存 Runtime、聊天投影、对话回退、模型选择与展示偏好状态；不持有进程所有权，也不直接访问文件系统。 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { WatchStopHandle } from 'vue'
import type { ModelDisplayPreference, PreferencesError } from '../../../shared/preferences-api'
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
  RuntimeTarget,
  ToolExecution
} from '../../../shared/runtime-api'
import { useProjectStore } from './project'
import { useAuthStore } from './auth'
import { useSessionRunsStore } from './session-runs'
import { getResourcePreview } from '../services/resource'
import { getModelDisplay, setModelDisplay } from '../services/preferences'
import { getPiDefaultModel, setPiDefaultModel as savePiDefaultModel } from '../services/pi-settings'
import {
  abortRuntime,
  ackRuntimeProjection,
  getRuntimeCapabilities,
  getRuntimeProjection,
  getRuntimeStatus,
  sendPrompt,
  rewindRuntime,
  setRuntimeModel,
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

/**
 * 一个运行实例的投影分片：离开前台时留底，之后到达的批次只更新自己的分片，切回时取回。
 * `appliedRuntimeId` 是这份内容对应的绑定代际，与当前代际不符时必须重新取基准。
 */
interface ProjectionSlice {
  messages: readonly ProjectionMessage[]
  tools: readonly ToolExecution[]
  sync: ProjectionSyncState
  truncated: boolean
  droppedMessages: number
  droppedTools: number
  appliedRuntimeId: number | null
  appliedSeq: number
}

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

/** Pi 默认模型的读取与保存状态；保存成功后才提交选择。 */
type PiDefaultModelViewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'saving' }
  | { phase: 'error'; error: PreferencesError }

/** Pi 默认模型的保存结果；失败原因直接交给选择器做可见反馈。 */
type PiDefaultModelSaveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }

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
  /** 前台运行实例身份；事件与请求的目标都按它校验，切换时同步重置展示基准。 */
  const foregroundRunId = ref<number | null>(null)
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
  const piDefaultModelView = ref<PiDefaultModelViewState>({ phase: 'idle' })
  const piDefaultModel = ref<ModelIdentity | null>(null)
  const piDefaultModelLoaded = ref(false)
  let piDefaultModelRequest = 0
  let modelLifecycle = 0
  let piDefaultModelPromise: Promise<void> | null = null
  let piDefaultModelSavePromise: Promise<void> | null = null
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
  let stopRunsWatch: WatchStopHandle | null = null
  let modelSwitchRequest = 0
  let capabilitiesRequest = 0
  let releaseSubscription: (() => void) | null = null
  let releaseProjection: (() => void) | null = null
  /** 已取得基准快照的运行实例与 Runtime 代际；两者一起判定当前展示是否仍是权威基准。 */
  let appliedRunId: number | null = null
  let appliedRuntimeId: number | null = null
  let appliedSeq = 0
  /**
   * 后台实例的投影分片：只保存离开前台时的内容与之后到达的增量，不参与前台展示。
   * 分片寿命跟随运行实例，实例从运行状态列表消失时丢弃（见 pruneProjections）。
   */
  const backgroundProjections = new Map<number, ProjectionSlice>()
  /**
   * 各实例上次读到的模型清单：切回前台时先顶上，避免闪一次空列表；命中后仍会重新读取，
   * 因此不会把过期清单当权威。分片寿命与投影分片一致。
   */
  const capabilitiesCache = new Map<number, AgentCapabilities>()
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
    if (stopRunsWatch === null) {
      // 分片寿命跟随运行实例：实例从列表消失后不再保留它的投影。
      stopRunsWatch = watch(
        () => useSessionRunsStore().runs.map(run => run.runId),
        (runIds) => pruneProjections(new Set(runIds))
      )
    }
    void loadPiDefaultModel()
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
    foregroundRunId.value = null
    appliedRunId = null
    stopProjectWatch?.()
    stopProjectWatch = null
    stopAuthWatch?.()
    stopAuthWatch = null
    stopRunsWatch?.()
    stopRunsWatch = null
    backgroundProjections.clear()
    capabilitiesCache.clear()
    clearModelPreview()
    modelLifecycle += 1
    rewindRequest += 1
    rewindView.value = { phase: 'idle' }
    preparingPrompt.value = false
    piDefaultModelRequest += 1
    piDefaultModelLoaded.value = false
    piDefaultModelView.value = { phase: 'idle' }
    piDefaultModelPromise = null
    piDefaultModelSavePromise = null
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

  /** Pi 默认模型只读一次；失败可显式重读，保存中不让读请求覆盖用户的新选择。 */
  async function loadPiDefaultModel(force = false): Promise<void> {
    const lifecycle = modelLifecycle
    if (piDefaultModelSavePromise !== null) await piDefaultModelSavePromise
    if (lifecycle !== modelLifecycle) return
    if (piDefaultModelPromise !== null) return piDefaultModelPromise
    if (piDefaultModelLoaded.value && !force) return
    const request = ++piDefaultModelRequest
    piDefaultModelView.value = { phase: 'loading' }
    const promise = (async () => {
      const result = await getPiDefaultModel()
      if (request !== piDefaultModelRequest) return
      if (!result.ok) {
        piDefaultModelView.value = { phase: 'error', error: result.error }
        return
      }
      piDefaultModel.value = result.data
      piDefaultModelLoaded.value = true
      piDefaultModelView.value = { phase: 'ready' }
    })()
    piDefaultModelPromise = promise
    try { await promise } finally {
      if (request === piDefaultModelRequest) piDefaultModelPromise = null
    }
  }

  /**
   * 只保存候选目录中的真实身份，成功后再更新选择。
   * Runtime 就绪时也能调用：此时候选来自 Runtime 能力，设置默认与当前会话模型互不影响。
   */
  async function setPiDefaultModel(model: ModelIdentity): Promise<PiDefaultModelSaveResult> {
    if ((!canPreviewModels() && view.value.phase !== 'ready') || !piDefaultModelLoaded.value
      || piDefaultModelView.value.phase === 'loading' || piDefaultModelView.value.phase === 'saving') {
      return { ok: false, message: 'Pi 默认模型尚未读取完成，请稍后再试。' }
    }
    if (!availableModels.value.some(candidate => (
      candidate.provider === model.provider && candidate.id === model.modelId
    ))) {
      return { ok: false, message: '该模型当前不可用，未保存为 Pi 默认模型。' }
    }
    const request = ++piDefaultModelRequest
    piDefaultModelView.value = { phase: 'saving' }
    const promise = (async (): Promise<PiDefaultModelSaveResult> => {
      const result = await savePiDefaultModel(model)
      if (request !== piDefaultModelRequest) return { ok: false, message: '本次保存已被新的选择取代。' }
      if (!result.ok) {
        piDefaultModelView.value = { phase: 'error', error: result.error }
        return { ok: false, message: result.error.message }
      }
      piDefaultModel.value = result.data
      piDefaultModelView.value = { phase: 'ready' }
      return { ok: true }
    })()
    piDefaultModelSavePromise = promise.then(() => undefined)
    try { return await promise } finally {
      if (request === piDefaultModelRequest) piDefaultModelSavePromise = null
    }
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

  /** 回退处理中或结果未知时，禁止发送和切换模型。 */
  function rewindBlocksWrites(): boolean {
    return rewindView.value.phase === 'requesting'
      || (rewindView.value.phase === 'error' && rewindView.value.blocked)
  }

  /** 当前就绪快照的二维目标；未就绪或缺少运行身份时返回 null，调用方据此不发起请求。 */
  function currentTarget(): RuntimeTarget | null {
    if (view.value.phase !== 'ready') return null
    const status = view.value.snapshot
    if (status.runId === null) return null
    return { runId: status.runId, runtimeId: status.runtimeId }
  }

  /** 提交 Prompt；旧实例或旧会话的迟到结果不能清空或改写当前输入。 */
  async function send(message: string, images: readonly PromptImageInput[] = []): Promise<void> {
    if (view.value.phase !== 'ready' || promptView.value.phase === 'sending'
      || modelSwitchView.value.phase === 'switching' || rewindBlocksWrites()) return
    const target = currentTarget()
    if (target === null) return
    const sessionId = view.value.snapshot.info?.sessionId ?? null
    promptView.value = { phase: 'sending' }
    const result = await sendPrompt(target, message, images)
    if (view.value.phase !== 'ready' || view.value.snapshot.runId !== target.runId
      || view.value.snapshot.runtimeId !== target.runtimeId
      || (view.value.snapshot.info?.sessionId ?? null) !== sessionId) return
    promptView.value = result.ok
      ? { phase: 'accepted', disposition: result.data.disposition }
      : { phase: 'error', error: result.error }
  }

  /** 显式确认后回退；成功时同步投影。 */
  async function rewind(request: RuntimeRewindRequest): Promise<boolean> {
    if (view.value.phase !== 'ready' || rewindBlocksWrites() || preparingPrompt.value
      || promptView.value.phase === 'sending' || modelSwitchView.value.phase === 'switching'
      || view.value.snapshot.info?.isStreaming === true || projectionSync.value !== 'synced'
      || view.value.snapshot.runId !== request.runId || view.value.snapshot.runtimeId !== request.runtimeId
      || view.value.snapshot.info?.sessionId !== request.sessionId) return false
    const sequence = ++rewindRequest
    rewindView.value = { phase: 'requesting' }
    try {
      const result = await rewindRuntime(request)
      if (sequence !== rewindRequest || view.value.phase !== 'ready'
        || view.value.snapshot.runId !== request.runId
        || view.value.snapshot.runtimeId !== request.runtimeId) return false
      if (!result.ok) {
        rewindView.value = { phase: 'error', error: result.error, blocked: result.blocked === true }
        return false
      }
      const status = result.data.status
      const sessionId = status.info?.sessionId
      const currentSessionId = view.value.snapshot.info?.sessionId
      if (status.state !== 'ready' || status.runId !== request.runId
        || status.runtimeId !== request.runtimeId
        || (currentSessionId !== request.sessionId && currentSessionId !== sessionId)) return false
      if (result.data.cancelled) {
        rewindView.value = { phase: 'done', cancelled: true }
        return false
      }
      applyStatus(status)
      await syncProjection(status.runtimeId ?? undefined)
      if (sequence !== rewindRequest || view.value.phase !== 'ready'
        || view.value.snapshot.runId !== status.runId || view.value.snapshot.runtimeId !== status.runtimeId
        || view.value.snapshot.info?.sessionId !== sessionId) return false
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

  /** 只在当前实例的当前绑定空闲时切换；不乐观更新模型，也不自动重试写操作。 */
  async function switchModel(provider: string, modelId: string): Promise<void> {
    if (view.value.phase !== 'ready' || view.value.snapshot.info?.isStreaming === true
      || promptView.value.phase === 'sending' || preparingPrompt.value
      || modelSwitchView.value.phase === 'switching' || rewindBlocksWrites()) return
    const status = view.value.snapshot
    const runtimeId = status.runtimeId
    if (runtimeId === null || status.runId === null) return
    if (status.info?.modelProvider === provider && status.info.modelId === modelId) return

    const request = ++modelSwitchRequest
    const runId = status.runId
    modelSwitchView.value = { phase: 'switching' }
    const result = await setRuntimeModel({ runId, runtimeId, provider, modelId })
    if (request !== modelSwitchRequest || view.value.phase !== 'ready'
      || view.value.snapshot.runId !== runId || view.value.snapshot.runtimeId !== runtimeId) return
    if (!result.ok) {
      modelSwitchView.value = { phase: 'error', error: result.error }
      return
    }
    if (result.data.runId !== runId || result.data.runtimeId !== runtimeId || result.data.state !== 'ready') {
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
   * 请求中止目标实例的当前操作；只在就绪且事件流显示运行中时发起，发送中不重复提交。
   * 成功只表示 Pi 已确认取消，运行中状态的最终收敛仍由事件流负责。
   */
  async function stopOperation(): Promise<void> {
    if (view.value.phase !== 'ready') return
    if (view.value.snapshot.info?.isStreaming !== true) return
    if (abortView.value.phase === 'requesting') return
    const target = currentTarget()
    if (target === null) return

    abortView.value = { phase: 'requesting' }
    const result = await abortRuntime(target)
    // 期间前台切走：结果属于旧实例，不写入新前台的展示状态。
    if (view.value.phase !== 'ready' || view.value.snapshot.runId !== target.runId
      || view.value.snapshot.runtimeId !== target.runtimeId) return
    abortView.value = result.ok
      ? { phase: 'idle' }
      : { phase: 'error', error: result.error }
  }

  /**
   * 全量重同步：快照是唯一基准，期间到达的增量由序号守卫丢弃；只向当前前台实例取基准。
   * 没有前台实例时空基准就是真实状态，不向任何目标发请求。
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

  /** 读取期间换实例、换代或换会话就丢弃旧响应，并在同一等待链中取得新目标的快照。 */
  async function readProjection(expectedRuntimeId?: number): Promise<void> {
    projectionSync.value = 'syncing'
    const lifecycle = modelLifecycle
    while (lifecycle === modelLifecycle) {
      const target = currentTarget()
      if (target === null) {
        resetProjection()
        return
      }
      const sessionId = view.value.phase === 'ready' ? view.value.snapshot.info?.sessionId ?? null : null
      const result = await getRuntimeProjection(target)
      const current = currentTarget()
      const currentSessionId = view.value.phase === 'ready' ? view.value.snapshot.info?.sessionId ?? null : null
      if (lifecycle !== modelLifecycle) return
      if (target.runId !== current?.runId || target.runtimeId !== current?.runtimeId
        || sessionId !== currentSessionId) {
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
      appliedRunId = target.runId
      appliedRuntimeId = snapshot.runtimeId
      appliedSeq = snapshot.seq
      messages.value = snapshot.messages
      tools.value = snapshot.tools
      projectionTruncated.value = snapshot.truncated
      droppedMessages.value = snapshot.droppedMessages
      droppedTools.value = snapshot.droppedTools
      projectionSync.value = 'synced'
      if (snapshot.runtimeId !== null) ackRuntimeProjection(target, snapshot.seq)
      return
    }
  }

  /** 批次按来源实例分流：前台走展示状态，后台只更新来源实例的分片。 */
  function applyBatch(batch: ProjectionBatch): void {
    const origin = batch.runId ?? foregroundRunId.value
    if (origin === null) return
    if (origin !== foregroundRunId.value) {
      applyBackgroundBatch(origin, batch)
      return
    }
    const target: RuntimeTarget = { runId: origin, runtimeId: batch.runtimeId }
    if (appliedRunId !== origin || batch.runtimeId !== appliedRuntimeId) {
      // 尚无基准快照，或批次属于其他实例/代际：不能无基准地应用增量。
      void syncProjection(batch.runtimeId)
      return
    }
    if (batch.resyncRequired) {
      void syncProjection(batch.runtimeId)
      return
    }
    if (batch.seq <= appliedSeq) {
      // 快照已经覆盖的迟到批次，只需补一次确认。
      ackRuntimeProjection(target, appliedSeq)
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
    ackRuntimeProjection(target, appliedSeq)
  }

  /** 投影随运行实例与绑定代际存在：离开就绪即清空展示消息；没有目标时空投影本身就是基准。 */
  function resetProjection(): void {
    messages.value = []
    tools.value = []
    projectionSync.value = 'synced'
    projectionTruncated.value = false
    droppedMessages.value = 0
    droppedTools.value = 0
    appliedRunId = null
    appliedRuntimeId = null
    appliedSeq = 0
  }

  /** 离开前台时把当前展示留底到该实例的分片；未就绪或没有来源时不留底。 */
  function stashProjection(runId: number): void {
    if (view.value.phase !== 'ready') return
    backgroundProjections.set(runId, {
      messages: messages.value,
      tools: tools.value,
      sync: projectionSync.value,
      truncated: projectionTruncated.value,
      droppedMessages: droppedMessages.value,
      droppedTools: droppedTools.value,
      appliedRuntimeId,
      appliedSeq
    })
  }

  /**
   * 切回前台时取回分片；没有分片就按空基准处理，由状态收敛决定是否重取。
   * 分片保留在表里：中间经过一个未就绪的前台不会把已取得的内容丢掉。
   */
  function restoreProjection(runId: number | null): void {
    const saved = runId === null ? undefined : backgroundProjections.get(runId)
    if (saved === undefined) {
      resetProjection()
      return
    }
    messages.value = saved.messages
    tools.value = saved.tools
    projectionSync.value = saved.sync
    projectionTruncated.value = saved.truncated
    droppedMessages.value = saved.droppedMessages
    droppedTools.value = saved.droppedTools
    appliedRunId = runId
    appliedRuntimeId = saved.appliedRuntimeId
    appliedSeq = saved.appliedSeq
  }

  /** 运行实例消失（释放、移除或退出）后丢弃它的分片，不让已结束实例的内容留在内存里。 */
  function pruneProjections(active: ReadonlySet<number>): void {
    for (const runId of [...backgroundProjections.keys()]) {
      if (!active.has(runId)) backgroundProjections.delete(runId)
    }
    for (const runId of [...capabilitiesCache.keys()]) {
      if (!active.has(runId)) capabilitiesCache.delete(runId)
    }
  }

  /**
   * 后台实例的批次只更新它的分片：前台展示不变，切回时无需重取。
   * 没有基准或代际不符时不做无基准的增量，只标记为需要重取。
   */
  function applyBackgroundBatch(runId: number, batch: ProjectionBatch): void {
    const slice = backgroundProjections.get(runId)
    if (slice === undefined) return
    const target: RuntimeTarget = { runId, runtimeId: batch.runtimeId }
    if (slice.appliedRuntimeId !== batch.runtimeId) {
      slice.sync = 'stale'
      return
    }
    if (batch.seq <= slice.appliedSeq) {
      ackRuntimeProjection(target, slice.appliedSeq)
      return
    }
    if (batch.resyncRequired || batch.seq !== slice.appliedSeq + 1) {
      slice.sync = 'stale'
      return
    }
    const applied = applyUpdates(slice.messages, slice.tools, batch.updates)
    if (applied === null) {
      slice.sync = 'stale'
      return
    }
    slice.messages = applied.messages
    slice.tools = applied.tools
    slice.appliedSeq = batch.seq
    slice.sync = 'synced'
    ackRuntimeProjection(target, slice.appliedSeq)
  }

  /** 主进程快照是唯一真相：事件通知与查询结果都经这里映射为展示状态。 */
  function applyStatus(status: RuntimeStatus): void {
    const previous = view.value.phase === 'ready' ? view.value.snapshot : null
    const previousRunId = previous?.runId ?? null
    // 运行实例与绑定代际一起决定目标：任一维度变化都重置瞬态并重取基准。
    const targetChanged = status.state !== 'ready'
      || status.runId !== previous?.runId
      || status.runtimeId !== previous?.runtimeId
    const sessionChanged = status.state === 'ready'
      && (status.info?.sessionId ?? null) !== (previous?.info?.sessionId ?? null)
    const previousStreaming = previous?.info?.isStreaming === true
    foregroundRunId.value = status.runId
    // 前台换实例：把上一个实例的投影留底，再取回目标实例的分片；同一实例内换代由下面的重取收敛。
    if (previousRunId !== status.runId) {
      if (previousRunId !== null) stashProjection(previousRunId)
      // 目标实例未就绪时没有可展示的投影，分片留在表里等它重新就绪。
      if (status.state === 'ready') restoreProjection(status.runId)
      else resetProjection()
    }
    if (targetChanged) {
      rewindRequest += 1
      rewindView.value = { phase: 'idle' }
      preparingPrompt.value = false
    }
    if (targetChanged || sessionChanged) {
      promptView.value = { phase: 'idle' }
      abortView.value = { phase: 'idle' }
      modelSwitchRequest += 1
      capabilitiesRequest += 1
      modelSwitchView.value = { phase: 'idle' }
    }
    if (status.state === 'starting' || status.state === 'stopping' || status.state === 'ready') {
      if (modelPreviewView.value.phase !== 'idle' || modelPreviewAttemptedScope !== undefined) clearModelPreview()
    }
    if (status.state !== 'ready') {
      resetProjection()
      // 离开就绪后，上一次中止请求的展示状态不再有意义。
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
      // 换实例、换代、换会话与上一次重同步未收敛（syncing/stale）都重新取基准。
      if (targetChanged || sessionChanged || status.runtimeId !== appliedRuntimeId
        || projectionSync.value !== 'synced') {
        void syncProjection(status.runtimeId ?? undefined)
      }
      // 新实例、新会话或一轮结束后刷新模型列表，维持 Provider、模型显示名与图片输入能力提示。
      if (targetChanged || sessionChanged || status.runtimeId !== capabilitiesAttemptedRuntimeId
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

  /** 读取当前前台实例的可用模型；只接收同一实例同一代际中最新请求的结果，其余结果丢弃。 */
  async function refreshCapabilities(): Promise<void> {
    const target = currentTarget()
    if (target === null) return
    const request = ++capabilitiesRequest
    capabilitiesAttemptedRuntimeId = target.runtimeId
    // 本实例上次读到的清单先顶上（代际一致时），避免切回前台时闪一次空列表；下面仍会重新读取。
    const cached = capabilitiesCache.get(target.runId)
    if (cached !== undefined && cached.runtimeId === target.runtimeId) {
      capabilitiesView.value = { phase: 'ready', data: cached }
    } else if (capabilitiesView.value.phase !== 'ready' || capabilitiesView.value.data.modelsError !== null) {
      capabilitiesView.value = { phase: 'loading' }
    }

    const result = await getRuntimeCapabilities(target)
    const current = currentTarget()
    if (request !== capabilitiesRequest || current === null
      || current.runId !== target.runId || current.runtimeId !== target.runtimeId) return
    if (!result.ok) {
      capabilitiesView.value = { phase: 'error', error: result.error }
      return
    }
    if (result.data.runtimeId !== target.runtimeId) return
    capabilitiesView.value = { phase: 'ready', data: result.data }
    capabilitiesCache.set(target.runId, result.data)
  }

  return {
    view,
    foregroundRunId,
    promptView,
    preparingPrompt,
    rewindView,
    abortView,
    capabilitiesView,
    modelSwitchView,
    modelPreviewView,
    piDefaultModelView,
    piDefaultModel,
    piDefaultModelLoaded,
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
    send,
    rewind,
    switchModel,
    refreshModelPreview,
    loadPiDefaultModel,
    setPiDefaultModel,
    loadModelDisplay,
    saveModelDisplay,
    setModelsVisibility,
    showAllModels,
    stopOperation,
    refreshCapabilities
  }
})
