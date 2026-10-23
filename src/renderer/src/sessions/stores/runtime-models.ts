/**
 * 模型能力、候选预读与切换：可用模型清单、Runtime 未启动时的预读、Pi 默认模型、当前会话换模型。
 * 会话运行状态由 `runtime-core` 持有，本切片只单向读取它并经注入的写入函数提交动作结果，
 * 因此会话切片不反向依赖这里；模型展示偏好与写回另见 `runtime-model-display`。
 */
import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { PreferencesError } from '../../../../shared/preferences-api'
import type {
  AgentCapabilities,
  ModelIdentity,
  ModelSummary,
  PiResourcePreview,
  RuntimeError,
  RuntimeStatus,
  RuntimeTarget
} from '../../../../shared/runtime-api'
import { getPiDefaultModel, setPiDefaultModel as savePiDefaultModel } from '../../providers/services/pi-settings'
import { getResourcePreview } from '../../resources/services/resource'
import { getRuntimeCapabilities, setRuntimeModel } from '../services/runtime'
import type { ModelSwitchViewState, PromptViewState, RuntimeLifecycle, RuntimeViewState } from './runtime-core'

/** 可用模型列表的读取状态。 */
export type CapabilitiesViewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; data: AgentCapabilities }
  | { phase: 'error'; error: RuntimeError }

/** 预读与 Runtime 能力分开保存，不能把不执行扩展的预读列表混进运行中清单。 */
export type ModelPreviewViewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; data: PiResourcePreview }
  | { phase: 'error'; error: RuntimeError }

/** Pi 默认模型的读取与保存状态；保存成功后才提交选择。 */
export type PiDefaultModelViewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'saving' }
  | { phase: 'error'; error: PreferencesError }

/** Pi 默认模型的保存结果；失败原因直接交给选择器做可见反馈。 */
export type PiDefaultModelSaveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }

/** 一轮状态收敛给模型侧带来的影响；由 `runtime-core` 在状态应用后同步转交。 */
export interface ModelStatusEffects {
  /** 会话侧是否换了前台实例、绑定代际或已离开就绪。 */
  targetChanged: boolean
  /** 是否换了会话身份。 */
  sessionChanged: boolean
  /** 上一轮快照是否仍在流式输出。 */
  previousStreaming: boolean
  /** 本轮状态是否不带任何会话身份，用于判断能力清单要不要清空。 */
  sessionAbsent: boolean
}

/** 预读判定所需的项目事实；项目列表未读完时先不探测，避免先做一次全局探测再为真实项目重做。 */
export interface PreviewContext {
  projectPath: string | null
  projectListLoading: boolean
}

export interface RuntimeModelsDeps {
  lifecycle: RuntimeLifecycle
  view: Ref<RuntimeViewState>
  /** 当前就绪快照的二维目标；未就绪时为 null。 */
  currentTarget(): RuntimeTarget | null
  /** 换模型的互斥状态由会话侧持有；本切片只经这两个入口读写它。 */
  modelSwitchState(): ModelSwitchViewState
  setModelSwitchState(next: ModelSwitchViewState): void
  promptView: Ref<PromptViewState>
  preparingPrompt: Ref<boolean>
  rewindBlocksWrites(): boolean
  /** 换模型成功后以权威状态收敛会话侧展示。 */
  applyStatus(status: RuntimeStatus): void
  /** 当前项目与项目列表状态；预读与能力清单都按它判重和取范围。 */
  previewContext(): PreviewContext
}

export interface RuntimeModels {
  capabilitiesView: Ref<CapabilitiesViewState>
  modelPreviewView: Ref<ModelPreviewViewState>
  piDefaultModelView: Ref<PiDefaultModelViewState>
  piDefaultModel: Ref<ModelIdentity | null>
  piDefaultModelLoaded: Ref<boolean>
  availableModels: ComputedRef<readonly ModelSummary[]>
  refreshCapabilities(): Promise<void>
  refreshModelPreview(force?: boolean): Promise<void>
  refreshModelPreviewIfNeeded(): void
  clearModelPreview(): void
  loadPiDefaultModel(force?: boolean): Promise<void>
  setPiDefaultModel(model: ModelIdentity): Promise<PiDefaultModelSaveResult>
  switchModel(provider: string, modelId: string): Promise<void>
  /** 一轮状态收敛后的模型侧动作：作废迟到结果并按需重读。 */
  applyStatusEffects(effects: ModelStatusEffects): void
  pruneSlices(active: ReadonlySet<number>): void
  reset(): void
}

export function createRuntimeModels(deps: RuntimeModelsDeps): RuntimeModels {
  const capabilitiesView = ref<CapabilitiesViewState>({ phase: 'idle' })
  const modelPreviewView = ref<ModelPreviewViewState>({ phase: 'idle' })
  const piDefaultModelView = ref<PiDefaultModelViewState>({ phase: 'idle' })
  const piDefaultModel = ref<ModelIdentity | null>(null)
  const piDefaultModelLoaded = ref(false)
  let piDefaultModelRequest = 0
  let piDefaultModelPromise: Promise<void> | null = null
  let piDefaultModelSavePromise: Promise<void> | null = null
  let modelPreviewRequest = 0
  /** 已发起过预读的范围；undefined 表示尚未发起。 */
  let modelPreviewAttemptedScope: string | undefined
  let modelSwitchRequest = 0
  let capabilitiesRequest = 0
  /** 各实例上次读到的模型清单：切回前台时先顶上，避免闪一次空列表；命中后仍会重新读取，因此不会把过期清单当权威。 */
  const capabilitiesCache = new Map<number, AgentCapabilities>()
  /** 已发起过读取的代际：读取失败后不因每次状态广播重复重试。 */
  let capabilitiesAttemptedRuntimeId: number | null = null

  /** 只在没有活动 Runtime 时读取启动前候选，失败状态也允许重新选择。 */
  function canPreviewModels(): boolean {
    return deps.view.value.phase === 'idle' || deps.view.value.phase === 'closed' || deps.view.value.phase === 'failed'
  }

  /** 预读范围标记：未选项目统一用全局标记，避免未选项目时反复探测。 */
  function modelPreviewScope(projectPath: string | null): string {
    return projectPath ?? '__global__'
  }

  /**
   * 当前可见的模型来源：就绪时取 Runtime 能力，未启动时取主进程预读；
   * 两处都会按 Runtime 代际或预读范围丢弃过期结果。模型选择器与设置页的模型分节共用这一份。
   */
  const availableModels = computed<readonly ModelSummary[]>(() => {
    if (deps.view.value.phase === 'ready') {
      return capabilitiesView.value.phase === 'ready'
        && capabilitiesView.value.data.runtimeId === deps.view.value.snapshot.runtimeId
        ? capabilitiesView.value.data.models : []
    }
    if (!canPreviewModels()) return []
    return modelPreviewView.value.phase === 'ready'
      && modelPreviewView.value.data.projectPath === deps.previewContext().projectPath
      ? modelPreviewView.value.data.models : []
  })

  /** 离开预读阶段或切换项目时使迟到结果失效。 */
  function clearModelPreview(): void {
    modelPreviewRequest += 1
    modelPreviewAttemptedScope = undefined
    modelPreviewView.value = { phase: 'idle' }
  }

  /** 状态广播只为尚未读过的范围发起一次，错误不因广播自动重试。 */
  function refreshModelPreviewIfNeeded(): void {
    const path = deps.previewContext().projectPath
    if (canPreviewModels() && modelPreviewScope(path) !== modelPreviewAttemptedScope) void refreshModelPreview()
  }

  /** 资源与模型共用主进程的一次性预读；项目或 Runtime 改变后丢弃结果。未选项目时读全局模型目录。 */
  async function refreshModelPreview(force = false): Promise<void> {
    if (!canPreviewModels()) return
    const { projectPath, projectListLoading } = deps.previewContext()
    // 项目列表还没读完时先不探测：否则会先做一次全局探测，随后又为真实项目重做一次。
    if (projectPath === null && projectListLoading) return
    const scope = modelPreviewScope(projectPath)
    if (!force && modelPreviewAttemptedScope === scope && modelPreviewView.value.phase === 'loading') return
    const request = ++modelPreviewRequest
    modelPreviewAttemptedScope = scope
    modelPreviewView.value = { phase: 'loading' }
    const result = await getResourcePreview(force)
    if (request !== modelPreviewRequest || !canPreviewModels()
      || deps.previewContext().projectPath !== projectPath) return
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
    const lifecycle = deps.lifecycle.count
    if (piDefaultModelSavePromise !== null) await piDefaultModelSavePromise
    if (lifecycle !== deps.lifecycle.count) return
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
    if ((!canPreviewModels() && deps.view.value.phase !== 'ready') || !piDefaultModelLoaded.value
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

  /** 只在当前实例的当前绑定空闲时切换；不乐观更新模型，也不自动重试写操作。 */
  async function switchModel(provider: string, modelId: string): Promise<void> {
    const view = deps.view.value
    if (view.phase !== 'ready' || view.snapshot.info?.isStreaming === true
      || deps.promptView.value.phase === 'sending' || deps.preparingPrompt.value
      || deps.modelSwitchState().phase === 'switching' || deps.rewindBlocksWrites()) return
    const status = view.snapshot
    const runtimeId = status.runtimeId
    if (runtimeId === null || status.runId === null) return
    if (status.info?.modelProvider === provider && status.info.modelId === modelId) return

    const request = ++modelSwitchRequest
    const runId = status.runId
    deps.setModelSwitchState({ phase: 'switching' })
    const result = await setRuntimeModel({ runId, runtimeId, provider, modelId })
    const current = deps.view.value
    if (request !== modelSwitchRequest || current.phase !== 'ready'
      || current.snapshot.runId !== runId || current.snapshot.runtimeId !== runtimeId) return
    if (!result.ok) {
      deps.setModelSwitchState({ phase: 'error', error: result.error })
      return
    }
    if (result.data.runId !== runId || result.data.runtimeId !== runtimeId || result.data.state !== 'ready') {
      deps.setModelSwitchState({
        phase: 'error',
        error: { code: 'INVALID_RESPONSE', message: '模型切换返回了其他会话的状态，未应用该结果。' }
      })
      return
    }
    deps.applyStatus(result.data)
    deps.setModelSwitchState({ phase: 'idle' })
    void refreshCapabilities()
  }

  /** 读取当前前台实例的可用模型；只接收同一实例同一代际中最新请求的结果，其余结果丢弃。 */
  async function refreshCapabilities(): Promise<void> {
    const target = deps.currentTarget()
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
    const current = deps.currentTarget()
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

  /**
   * 一轮状态收敛的模型侧结果：离开预读、按需重读模型清单与预读范围。
   * 触发条件与原综合 Store 中 `applyStatus` 的分支逐条对应。
   */
  function applyStatusEffects(effects: ModelStatusEffects): void {
    const view = deps.view.value
    if (view.phase === 'starting' || view.phase === 'stopping' || view.phase === 'ready') {
      if (modelPreviewView.value.phase !== 'idle' || modelPreviewAttemptedScope !== undefined) clearModelPreview()
    }
    if (effects.targetChanged || effects.sessionChanged) {
      modelSwitchRequest += 1
      capabilitiesRequest += 1
      deps.setModelSwitchState({ phase: 'idle' })
    }
    if (view.phase !== 'ready' && effects.sessionAbsent) {
      capabilitiesView.value = { phase: 'idle' }
      capabilitiesAttemptedRuntimeId = null
    }
    if (view.phase === 'failed') {
      refreshModelPreviewIfNeeded()
      return
    }
    if (view.phase === 'ready') {
      const status = view.snapshot
      // 新实例、新会话或一轮结束后刷新模型列表，维持 Provider、模型显示名与图片输入能力提示。
      if (effects.targetChanged || effects.sessionChanged || status.runtimeId !== capabilitiesAttemptedRuntimeId
        || (effects.previousStreaming && status.info?.isStreaming !== true)) {
        void refreshCapabilities()
      }
      return
    }
    if (view.phase === 'stopping' || view.phase === 'starting') return
    refreshModelPreviewIfNeeded()
  }

  function pruneSlices(active: ReadonlySet<number>): void {
    for (const runId of [...capabilitiesCache.keys()]) {
      if (!active.has(runId)) capabilitiesCache.delete(runId)
    }
  }

  /** 页面卸载：作废在途读取与切换，清空分片与预读。 */
  function reset(): void {
    clearModelPreview()
    piDefaultModelRequest += 1
    piDefaultModelLoaded.value = false
    piDefaultModelView.value = { phase: 'idle' }
    piDefaultModelPromise = null
    piDefaultModelSavePromise = null
    modelSwitchRequest += 1
    capabilitiesRequest += 1
    deps.setModelSwitchState({ phase: 'idle' })
    capabilitiesCache.clear()
  }

  return {
    capabilitiesView,
    modelPreviewView,
    piDefaultModelView,
    piDefaultModel,
    piDefaultModelLoaded,
    availableModels,
    refreshCapabilities,
    refreshModelPreview,
    refreshModelPreviewIfNeeded,
    clearModelPreview,
    loadPiDefaultModel,
    setPiDefaultModel,
    switchModel,
    applyStatusEffects,
    pruneSlices,
    reset
  }
}
