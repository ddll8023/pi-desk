/**
 * Runtime 状态门面：装配会话运行、历史缓存、模型能力与模型展示偏好四个切片，并编排它们的初始化与释放。
 * 只做组合与顺序编排，不持有状态也不含业务判定；切片之间不互相 import，反向影响由这里晚绑定。
 */
import { defineStore } from 'pinia'
import { watch } from 'vue'
import type { WatchStopHandle } from 'vue'
import { useAuthStore } from '../../providers/stores/auth'
import { useProjectStore } from '../../projects/stores/project'
import { useSessionRunsStore } from './session-runs'
import { createRuntimeCore } from './runtime-core'
import type { RuntimeLifecycle } from './runtime-core'
import { createRuntimeModelDisplay } from './runtime-model-display'
import { createRuntimeModels } from './runtime-models'

export { historyChunkKey } from './runtime-history'
export type { HistoryChunkLoadState, HistoryTurnState } from './runtime-history'

export const useRuntimeStore = defineStore('runtime', () => {
  /** 页面每次释放都递增；切片据此丢弃在途结果，避免迟到的读取写回新页面。 */
  const lifecycle: RuntimeLifecycle = { count: 0 }
  const core = createRuntimeCore({
    lifecycle,
    currentProjectPath: () => useProjectStore().currentProject?.path ?? null
  })
  const modelSlice = createRuntimeModels({
    lifecycle,
    view: core.view,
    currentTarget: core.currentTarget,
    modelSwitchState: () => core.modelSwitchView.value,
    setModelSwitchState: (next) => { core.modelSwitchView.value = next },
    promptView: core.promptView,
    preparingPrompt: core.preparingPrompt,
    rewindBlocksWrites: core.rewindBlocksWrites,
    applyStatus: core.applyStatus,
    previewContext: () => ({
      projectPath: useProjectStore().currentProject?.path ?? null,
      projectListLoading: useProjectStore().view.phase === 'loading'
    })
  })
  const modelDisplay = createRuntimeModelDisplay({ lifecycle, availableModels: modelSlice.availableModels })
  // 会话状态收敛后同步转交模型侧影响：切片之间不 import，绑定只在组合根发生一次。
  core.bindStatusEffects((context) => modelSlice.applyStatusEffects(context))

  let stopProjectWatch: WatchStopHandle | null = null
  let stopAuthWatch: WatchStopHandle | null = null
  let stopRunsWatch: WatchStopHandle | null = null

  /** 先订阅状态与投影、再取快照，避免初始化期间漏掉通知。 */
  async function initialize(): Promise<void> {
    core.subscribe()
    if (stopProjectWatch === null) {
      // 项目列表读完但没有当前项目时也要探测一次全局目录，因此把列表状态一并作为触发条件。
      stopProjectWatch = watch(
        () => [useProjectStore().currentProject?.path ?? null, useProjectStore().view.phase] as const,
        () => {
          modelSlice.clearModelPreview()
          void modelSlice.refreshModelPreview()
        }
      )
    }
    if (stopAuthWatch === null) {
      const auth = useAuthStore()
      stopAuthWatch = watch(() => [auth.providers, auth.flow?.phase] as const,
        ([providers, phase], [previousProviders, previousPhase]) => {
          if (providers !== previousProviders || (phase === 'completed' && previousPhase !== phase)) {
            void modelSlice.refreshModelPreview(true)
          }
        })
    }
    if (stopRunsWatch === null) {
      // 分片寿命跟随运行实例：实例从列表消失后不再保留它的投影与模型清单。
      stopRunsWatch = watch(
        () => useSessionRunsStore().runs.map(run => run.runId),
        (runIds) => {
          const active = new Set(runIds)
          core.pruneSlices(active)
          modelSlice.pruneSlices(active)
        }
      )
    }
    void modelSlice.loadPiDefaultModel()
    void modelDisplay.loadModelDisplay()
    await core.refreshStatus()
    modelSlice.refreshModelPreviewIfNeeded()
    await core.syncProjection()
  }

  /** 页面卸载时释放订阅并作废各切片的在途结果；不取消主进程已提交的操作。 */
  function dispose(): void {
    core.reset()
    modelSlice.reset()
    modelDisplay.reset()
    stopProjectWatch?.()
    stopProjectWatch = null
    stopAuthWatch?.()
    stopAuthWatch = null
    stopRunsWatch?.()
    stopRunsWatch = null
    lifecycle.count += 1
  }

  return {
    view: core.view,
    foregroundRunId: core.foregroundRunId,
    suspendedSessionId: core.suspendedSessionId,
    foregroundSessionId: core.foregroundSessionId,
    conversationKey: core.conversationKey,
    promptView: core.promptView,
    preparingPrompt: core.preparingPrompt,
    rewindView: core.rewindView,
    abortView: core.abortView,
    compactView: core.compactView,
    capabilitiesView: modelSlice.capabilitiesView,
    modelSwitchView: core.modelSwitchView,
    modelPreviewView: modelSlice.modelPreviewView,
    piDefaultModelView: modelSlice.piDefaultModelView,
    piDefaultModel: modelSlice.piDefaultModel,
    piDefaultModelLoaded: modelSlice.piDefaultModelLoaded,
    hiddenModels: modelDisplay.hiddenModels,
    modelDisplayLoaded: modelDisplay.modelDisplayLoaded,
    modelDisplayView: modelDisplay.modelDisplayView,
    availableModels: modelSlice.availableModels,
    visibleModels: modelDisplay.visibleModels,
    messages: core.messages,
    tools: core.tools,
    displayMessages: core.displayMessages,
    displayTools: core.displayTools,
    history: core.history,
    activity: core.activity,
    logSessionId: core.logSessionId,
    applyLogPage: core.applyLogPage,
    clearPreview: core.clearPreview,
    loadEarlierHistory: core.loadEarlierHistory,
    setHistoryVisibility: core.setHistoryVisibility,
    loadHistoryTurn: core.loadHistoryTurn,
    loadHistoryChunk: core.loadHistoryChunk,
    projectionSync: core.projectionSync,
    projectionTruncated: core.projectionTruncated,
    droppedMessages: core.droppedMessages,
    droppedTools: core.droppedTools,
    initialize,
    dispose,
    send: core.send,
    syncProjection: core.syncProjection,
    rewind: core.rewind,
    compact: core.compact,
    switchModel: modelSlice.switchModel,
    refreshModelPreview: modelSlice.refreshModelPreview,
    loadPiDefaultModel: modelSlice.loadPiDefaultModel,
    setPiDefaultModel: modelSlice.setPiDefaultModel,
    loadModelDisplay: modelDisplay.loadModelDisplay,
    setModelsVisibility: modelDisplay.setModelsVisibility,
    showAllModels: modelDisplay.showAllModels,
    stopOperation: core.stopOperation,
    refreshCapabilities: modelSlice.refreshCapabilities
  }
})
