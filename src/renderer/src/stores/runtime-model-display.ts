/**
 * 模型展示偏好：对话页里被隐藏的模型清单与串行写回。
 * 候选清单由 `runtime-models` 提供，本切片不自行读取 Runtime；写回串行化，失败回滚到最近一次服务端确认值。
 */
import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { PreferencesError } from '../../../shared/preferences-api'
import type { ModelIdentity, ModelSummary } from '../../../shared/runtime-api'
import { getModelDisplay, setModelDisplay } from '../services/preferences'
import type { RuntimeLifecycle } from './runtime-core'

/** 对话页模型展示偏好的读取与保存状态；保存成功后才提交选择。 */
export type ModelDisplayViewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'saving' }
  | { phase: 'error'; error: PreferencesError }

export interface RuntimeModelDisplayDeps {
  lifecycle: RuntimeLifecycle
  /** 当前可见的候选模型；隐藏偏好只在这些模型上生效。 */
  availableModels: ComputedRef<readonly ModelSummary[]>
}

export interface RuntimeModelDisplay {
  hiddenModels: Ref<readonly ModelIdentity[]>
  modelDisplayLoaded: Ref<boolean>
  modelDisplayView: Ref<ModelDisplayViewState>
  /** 输入坞模型选择器的候选项：排除在设置中隐藏的模型。 */
  visibleModels: ComputedRef<readonly ModelSummary[]>
  loadModelDisplay(force?: boolean): Promise<void>
  setModelsVisibility(models: readonly ModelIdentity[], visible: boolean): void
  showAllModels(): void
  reset(): void
}

export function createRuntimeModelDisplay(deps: RuntimeModelDisplayDeps): RuntimeModelDisplay {
  const hiddenModels = ref<readonly ModelIdentity[]>([])
  const modelDisplayLoaded = ref(false)
  const modelDisplayView = ref<ModelDisplayViewState>({ phase: 'idle' })
  let modelDisplayRequest = 0
  let modelDisplayPromise: Promise<void> | null = null
  let modelDisplaySavePromise: Promise<void> | null = null
  /** 最近一次服务端确认的隐藏列表；乐观更新失败时回滚到它。 */
  let confirmedHiddenModels: readonly ModelIdentity[] = []
  /** 是否已有在途写入；为真时新选择只置位待写标记，避免并发写入互相覆盖。 */
  let modelDisplayWriting = false
  /** 在途写入期间产生的新选择；本次写入结束后据此再写一次。 */
  let pendingModelDisplay = false

  /** 输入坞模型选择器的候选项：排除在设置中隐藏的模型。 */
  const visibleModels = computed<readonly ModelSummary[]>(() => (
    deps.availableModels.value.filter((model) => !hiddenModels.value.some((hidden) => (
      hidden.provider === model.provider && hidden.modelId === model.id
    )))
  ))

  /** 展示偏好只读一次；失败可显式重读，保存中不让读请求覆盖用户的新选择。 */
  async function loadModelDisplay(force = false): Promise<void> {
    const lifecycle = deps.lifecycle.count
    if (modelDisplaySavePromise !== null) await modelDisplaySavePromise
    if (lifecycle !== deps.lifecycle.count) return
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
      const loaded = result.data.hiddenModels.map((model) => ({ provider: model.provider, modelId: model.modelId }))
      hiddenModels.value = loaded
      confirmedHiddenModels = loaded
      modelDisplayLoaded.value = true
      modelDisplayView.value = { phase: 'ready' }
    })()
    modelDisplayPromise = promise
    try { await promise } finally {
      if (request === modelDisplayRequest) modelDisplayPromise = null
    }
  }

  /**
   * 把当前隐藏列表落盘。写入串行进行：在途期间产生的新选择只置位待写标记，
   * 本次结束后合并成一次写入，因此连点开关不会丢状态，也不会出现并发写入互相覆盖。
   * 失败时丢弃待写选择并回滚到最近一次服务端确认值，避免界面与磁盘长期不一致。
   */
  async function flushModelDisplay(): Promise<void> {
    if (modelDisplayWriting) {
      pendingModelDisplay = true
      return
    }
    modelDisplayWriting = true
    const lifecycle = deps.lifecycle.count
    try {
      do {
        pendingModelDisplay = false
        modelDisplayView.value = { phase: 'saving' }
        const result = await setModelDisplay({ hiddenModels: [...hiddenModels.value] })
        if (lifecycle !== deps.lifecycle.count) return
        if (!result.ok) {
          pendingModelDisplay = false
          hiddenModels.value = confirmedHiddenModels
          modelDisplayView.value = { phase: 'error', error: result.error }
          return
        }
        confirmedHiddenModels = result.data.hiddenModels.map(
          (model) => ({ provider: model.provider, modelId: model.modelId })
        )
        // 在途期间用户又改过时保留本地选择，只把确认基线推进到服务端结果。
        if (!pendingModelDisplay) hiddenModels.value = confirmedHiddenModels
        modelDisplayView.value = { phase: 'ready' }
      } while (pendingModelDisplay)
    } finally {
      modelDisplayWriting = false
    }
  }

  /** 发起一次落盘，并把在途写入暴露给读取路径；偏好未加载时没有确认基线，直接忽略。 */
  function requestModelDisplayWrite(): void {
    if (!modelDisplayLoaded.value) return
    if (modelDisplayWriting) {
      // 已有在途写入：只置位待写标记，由它结束后合并写入；这里不再碰在途写入的 Promise。
      pendingModelDisplay = true
      return
    }
    const promise = flushModelDisplay()
    modelDisplaySavePromise = promise
    void promise.finally(() => {
      if (modelDisplaySavePromise === promise) modelDisplaySavePromise = null
    })
  }

  /**
   * 批量设置一组模型在对话页的可见性：`visible` 为真时从隐藏列表移除，为假时全部加入。
   * 单个模型开关与供应商级的全选/全不选共用这一入口；界面先变、落盘在后台进行。
   */
  function setModelsVisibility(models: readonly ModelIdentity[], visible: boolean): void {
    if (!modelDisplayLoaded.value) return
    const target = new Set(models.map((model) => `${model.provider}\u0000${model.modelId}`))
    const kept = hiddenModels.value.filter((hidden) => !target.has(`${hidden.provider}\u0000${hidden.modelId}`))
    hiddenModels.value = visible
      ? kept
      : [...kept, ...models.map((model) => ({ provider: model.provider, modelId: model.modelId }))]
    requestModelDisplayWrite()
  }

  /** 恢复为全部显示；清空隐藏列表并保存。 */
  function showAllModels(): void {
    if (!modelDisplayLoaded.value) return
    hiddenModels.value = []
    requestModelDisplayWrite()
  }

  /** 页面卸载：作废在途读取与写入，清空本地选择与确认基线。 */
  function reset(): void {
    modelDisplayRequest += 1
    hiddenModels.value = []
    modelDisplayLoaded.value = false
    modelDisplayView.value = { phase: 'idle' }
    modelDisplayPromise = null
    modelDisplaySavePromise = null
    confirmedHiddenModels = []
    modelDisplayWriting = false
    pendingModelDisplay = false
  }

  return {
    hiddenModels,
    modelDisplayLoaded,
    modelDisplayView,
    visibleModels,
    loadModelDisplay,
    setModelsVisibility,
    showAllModels,
    reset
  }
}
