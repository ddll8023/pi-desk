/**
 * 保存 Extension UI 的展示状态：dialog 队列与收起态、通知、状态条、widget 与编辑器填充文本。
 * 只做状态映射、收起/恢复与响应提交，不持有运行实例所有权。
 *
 * 状态按来源实例分片：快照带 `runId` 时先路由到来源实例，前台实例的内容进入展示，
 * 后台实例的内容只更新它自己的分片（切回时无需重新查询）；序号水位只在同一实例内可比，
 * 实例换代时重置。分片寿命跟随运行实例，实例从运行状态列表消失时丢弃。
 */
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { WatchStopHandle } from 'vue'
import type {
  ExtensionDialogRequest,
  ExtensionDialogResponseInput,
  ExtensionUiSnapshot
} from '../../../../shared/extension-ui-api'
import { useRuntimeStore } from './runtime'
import { useSessionRunsStore } from './session-runs'
import {
  getExtensionUiState,
  respondExtensionDialog,
  subscribeExtensionUi
} from '../services/extension-ui'

/** 对话响应动作的展示状态；成功以主进程快照收敛，不在这里保存结果。 */
type RespondState =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'error'; message: string }

/**
 * 一个运行实例的交互分片：离开前台时留底，之后到达的快照只更新自己的分片。
 * `runtimeId` 是分片对应的绑定代际，与当前代际不符时不能复用（回应会落到失效代际上）。
 */
interface UiSlice {
  runtimeId: number | null
  seq: number
  dialogs: readonly ExtensionDialogRequest[]
  notifications: ExtensionUiSnapshot['state']['notifications']
  statuses: ExtensionUiSnapshot['state']['statuses']
  widgets: ExtensionUiSnapshot['state']['widgets']
  editorText: string | null
  invalidCount: number
  minimizedDialogId: string | null
  respondState: RespondState
}

export const useExtensionUiStore = defineStore('extension-ui', () => {
  /** 已应用快照的来源运行实例；没有前台实例或尚未取得快照时为 null。 */
  const runId = ref<number | null>(null)
  const runtimeId = ref<number | null>(null)
  const dialogs = ref<readonly ExtensionDialogRequest[]>([])
  const notifications = ref<ExtensionUiSnapshot['state']['notifications']>([])
  const statuses = ref<ExtensionUiSnapshot['state']['statuses']>([])
  const widgets = ref<ExtensionUiSnapshot['state']['widgets']>([])
  const editorText = ref<string | null>(null)
  const invalidCount = ref(0)
  /**
   * 被收起的队首 dialog id：收起只隐藏弹窗，不提交响应，Pi 侧仍在等待；
   * 队首变化或队列清空时自动作废，避免恢复到已结束的请求。
   */
  const minimizedDialogId = ref<string | null>(null)
  const respondState = ref<RespondState>({ phase: 'idle' })
  /** 已被页面消费的编辑器填充文本；PromptComposer 消费后调用 markEditorTextConsumed。 */
  let editorTextSeq = 0
  const editorTextVersion = ref(0)
  let releaseSubscription: (() => void) | null = null
  let stopRuntimeWatch: WatchStopHandle | null = null
  let stopRunsWatch: WatchStopHandle | null = null
  /** 已应用的快照序号；只在同一来源实例内可比，切换实例时重置。 */
  let appliedSeq = -1
  /** 已按分片处理过的前台实例；用来区分「换了实例」与「同一实例的状态变化」。 */
  let appliedForeground: number | null = null
  /** 后台实例的交互分片；只保存离开前台时的内容与之后到达的快照，不参与前台展示。 */
  const backgroundUi = new Map<number, UiSlice>()

  /**
   * 先订阅、再取当前前台实例的快照，避免初始化期间漏掉通知；
   * 前台实例变化时先取回分片，没有分片才重新查询。
   */
  async function initialize(): Promise<void> {
    if (releaseSubscription === null) {
      releaseSubscription = subscribeExtensionUi(applySnapshot)
    }
    if (stopRuntimeWatch === null) {
      const runtimeStore = useRuntimeStore()
      stopRuntimeWatch = watch(
        () => [runtimeStore.foregroundRunId, runtimeStore.view.phase] as const,
        () => { onForegroundChanged() }
      )
    }
    if (stopRunsWatch === null) {
      // 分片寿命跟随运行实例：实例从列表消失后不再保留它的交互状态。
      stopRunsWatch = watch(
        () => useSessionRunsStore().runs.map(run => run.runId),
        (runIds) => pruneSlices(new Set(runIds))
      )
    }
    onForegroundChanged()
  }

  /** 页面卸载时释放订阅与监听；重复调用无副作用。 */
  function dispose(): void {
    releaseSubscription?.()
    releaseSubscription = null
    stopRuntimeWatch?.()
    stopRuntimeWatch = null
    stopRunsWatch?.()
    stopRunsWatch = null
    backgroundUi.clear()
    appliedForeground = null
    minimizedDialogId.value = null
  }

  /**
   * 前台实例变化时先留底再取回分片；有可用分片就不重新查询，因为分片已经包含离开期间到达的快照。
   * 同一实例的状态变化仍重新查询一次，避免漏掉订阅建立前的状态。
   */
  function onForegroundChanged(): void {
    const foreground = useRuntimeStore().foregroundRunId
    if (foreground === appliedForeground) {
      void refreshFromForeground()
      return
    }
    stashLive()
    appliedForeground = foreground
    if (restoreSlice(foreground)) return
    resetSnapshot()
    void refreshFromForeground()
  }

  /** 把当前展示留底到它自己的来源实例；没有来源实例时无可留底。 */
  function stashLive(): void {
    const origin = runId.value
    if (origin === null) return
    backgroundUi.set(origin, {
      runtimeId: runtimeId.value,
      seq: appliedSeq,
      dialogs: dialogs.value,
      notifications: notifications.value,
      statuses: statuses.value,
      widgets: widgets.value,
      editorText: editorText.value,
      invalidCount: invalidCount.value,
      minimizedDialogId: minimizedDialogId.value,
      respondState: respondState.value
    })
  }

  /** 取回某个实例的分片；没有分片或代际已变时返回 false，由调用方重新查询。 */
  function restoreSlice(foreground: number | null): boolean {
    if (foreground === null) return false
    const saved = backgroundUi.get(foreground)
    if (saved === undefined) return false
    const runtimeStore = useRuntimeStore()
    const current = runtimeStore.view.phase === 'ready' ? runtimeStore.view.snapshot.runtimeId : null
    // 代际已变：分片属于旧绑定，回应会落到失效代际上，因此不复用，改为重新查询。
    if (saved.runtimeId !== current) return false
    runId.value = foreground
    runtimeId.value = saved.runtimeId
    appliedSeq = saved.seq
    dialogs.value = saved.dialogs
    notifications.value = saved.notifications
    statuses.value = saved.statuses
    widgets.value = saved.widgets
    invalidCount.value = saved.invalidCount
    minimizedDialogId.value = saved.minimizedDialogId
    respondState.value = saved.respondState
    applyEditorText(saved.editorText)
    return true
  }

  /** 运行实例消失（释放、移除或退出）后丢弃它的交互分片。 */
  function pruneSlices(active: ReadonlySet<number>): void {
    for (const origin of [...backgroundUi.keys()]) {
      if (!active.has(origin)) backgroundUi.delete(origin)
    }
  }

  /** 编辑器填充文本按内容比较后发布版本；消费方只处理真正变化的文本。 */
  function applyEditorText(text: string | null): void {
    if (text === editorText.value) return
    editorText.value = text
    editorTextSeq += 1
    editorTextVersion.value = editorTextSeq
  }

  /** 按当前前台实例重新取交互快照；没有前台实例时清空展示，不保留上一个实例的交互。 */
  async function refreshFromForeground(): Promise<void> {
    const foreground = useRuntimeStore().foregroundRunId
    if (foreground === null) {
      resetSnapshot()
      return
    }
    const result = await getExtensionUiState(foreground)
    // 期间前台又切换了：结果属于旧实例，等新实例自己的查询收敛。
    if (!result.ok || useRuntimeStore().foregroundRunId !== foreground) return
    applySnapshot(result.data)
  }

  /** 清空交互展示并重置序号水位；没有来源实例时展示的就是无交互。 */
  function resetSnapshot(): void {
    runId.value = null
    appliedSeq = -1
    dialogs.value = []
    notifications.value = []
    statuses.value = []
    widgets.value = []
    editorText.value = null
    invalidCount.value = 0
    minimizedDialogId.value = null
    // 上一个实例的回应状态已经随分片留底，这里不能留给新前台。
    respondState.value = { phase: 'idle' }
  }

  /** 收起当前对话：只影响展示，不代替取消；底部入口据此恢复。 */
  function minimizeDialog(dialogId: string): void {
    if (!dialogs.value.some((entry) => entry.id === dialogId)) return
    minimizedDialogId.value = dialogId
  }

  /** 恢复被收起的对话；没有收起态时无副作用。 */
  function restoreDialog(): void {
    minimizedDialogId.value = null
  }

  /** 提交 dialog 响应；只有 sending 之外的空闲状态才发起，目标固定为已应用的来源实例。 */
  async function respond(dialogId: string, response: ExtensionDialogResponseInput): Promise<void> {
    if (respondState.value.phase === 'sending') return
    const target = respondTarget()
    // 没有来源实例或代际时不提交：回应不能落到别的实例或旧代际上。
    if (target === null) return
    const origin = runId.value
    respondState.value = { phase: 'sending' }
    const result = await respondExtensionDialog(target, dialogId, response)
    if (result.ok) {
      setRespondState(origin, { phase: 'idle' })
      applySnapshot(result.data)
      return
    }
    setRespondState(origin, { phase: 'error', message: result.error.message })
  }

  /** 回应结果写回它自己的实例：期间前台切走时不能改写新前台的展示状态。 */
  function setRespondState(origin: number | null, state: RespondState): void {
    if (origin !== null && origin !== runId.value) {
      const slice = backgroundUi.get(origin)
      if (slice !== undefined) slice.respondState = state
      return
    }
    respondState.value = state
  }

  /** 关闭一条错误提示；错误在下次提交或新快照到达时清除。 */
  function clearRespondError(): void {
    if (respondState.value.phase === 'error') respondState.value = { phase: 'idle' }
  }

  /** 关闭一条通知；只影响本地展示，主进程列表仍由 Pi 驱动。 */
  function dismissNotification(id: string): void {
    notifications.value = notifications.value.filter((entry) => entry.id !== id)
  }

  /** PromptComposer 消费填充文本后调用，避免同一文本被重复写入。 */
  function markEditorTextConsumed(): void {
    editorText.value = null
  }

  /** 提交目标：已应用快照的来源实例与代际；两者缺一就不提交。 */
  function respondTarget(): { readonly runId: number; readonly runtimeId: number } | null {
    const origin = runId.value
    const generation = runtimeId.value
    if (origin === null || generation === null) return null
    return { runId: origin, runtimeId: generation }
  }

  /** 快照按来源实例分流：前台整体替换展示，后台只更新来源实例的分片。 */
  function applySnapshot(snapshot: ExtensionUiSnapshot): void {
    const origin = snapshot.runId ?? useRuntimeStore().foregroundRunId
    if (origin !== null && origin !== useRuntimeStore().foregroundRunId) {
      applyBackground(snapshot, origin)
      return
    }
    applyLive(snapshot, origin)
  }

  /** 前台快照按序号应用：旧序号丢弃，新快照整体替换。 */
  function applyLive(snapshot: ExtensionUiSnapshot, origin: number | null): void {
    // 序号只在同一实例内可比：来源实例变化时重置水位，避免跨实例回退丢帧。
    if (runId.value !== origin) appliedSeq = -1
    if (snapshot.seq <= appliedSeq) return
    appliedSeq = snapshot.seq
    runId.value = origin
    runtimeId.value = snapshot.runtimeId
    dialogs.value = snapshot.state.dialogs
    notifications.value = snapshot.state.notifications
    statuses.value = snapshot.state.statuses
    widgets.value = snapshot.state.widgets
    invalidCount.value = snapshot.state.invalidCount
    // 收起的目标已经回应或被新请求取代：清除收起态，不把入口指向旧请求。
    if (minimizedDialogId.value !== null
      && !snapshot.state.dialogs.some((entry) => entry.id === minimizedDialogId.value)) {
      minimizedDialogId.value = null
    }
    applyEditorText(snapshot.state.editorText)
  }

  /** 后台快照只更新来源实例的分片：前台展示不受影响，切回时不再重新查询。 */
  function applyBackground(snapshot: ExtensionUiSnapshot, origin: number): void {
    const slice = backgroundUi.get(origin)
    if (slice === undefined) return
    // 序号只在同一实例内可比；分片换代时重置水位。
    if (slice.runtimeId !== snapshot.runtimeId) slice.seq = -1
    if (snapshot.seq <= slice.seq) return
    slice.seq = snapshot.seq
    slice.runtimeId = snapshot.runtimeId
    slice.dialogs = snapshot.state.dialogs
    slice.notifications = snapshot.state.notifications
    slice.statuses = snapshot.state.statuses
    slice.widgets = snapshot.state.widgets
    slice.invalidCount = snapshot.state.invalidCount
    slice.editorText = snapshot.state.editorText
    // 收起的目标已经回应或被新请求取代：清除收起态，不把入口指向旧请求。
    if (slice.minimizedDialogId !== null
      && !snapshot.state.dialogs.some((entry) => entry.id === slice.minimizedDialogId)) {
      slice.minimizedDialogId = null
    }
  }

  return {
    runId,
    runtimeId,
    dialogs,
    notifications,
    statuses,
    widgets,
    editorText,
    editorTextVersion,
    invalidCount,
    minimizedDialogId,
    respondState,
    initialize,
    dispose,
    respond,
    minimizeDialog,
    restoreDialog,
    clearRespondError,
    dismissNotification,
    markEditorTextConsumed
  }
})
