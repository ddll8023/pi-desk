/**
 * 自定义供应商（Pi 的 models.json）的展示状态：快照、读取、按条目保存与删除。
 * 文件读写、校验与脱敏都在主进程，这里只持有页面需要的投影与动作状态。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ModelsConfigError, ModelsConfigSnapshot } from '../../../../shared/models-config-api'
import { deleteModelsConfigProvider, getModelsConfig, saveModelsConfigProvider } from '../services/models-config'

/** 快照读取状态；`ready` 时才可能带 `parseError`（文件存在但损坏）。 */
export type ModelsConfigView =
  | { readonly phase: 'idle' }
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly data: ModelsConfigSnapshot }
  | { readonly phase: 'error'; readonly error: ModelsConfigError }

/** 写动作状态；失败时保留原因，成功回到 `idle`。 */
export type ModelsConfigActionView =
  | { readonly phase: 'idle' }
  | { readonly phase: 'running' }
  | { readonly phase: 'error'; readonly error: ModelsConfigError }

export const useModelsConfigStore = defineStore('modelsConfig', () => {
  const view = ref<ModelsConfigView>({ phase: 'idle' })
  const saveView = ref<ModelsConfigActionView>({ phase: 'idle' })
  const deleteView = ref<ModelsConfigActionView>({ phase: 'idle' })

  const snapshot = computed<ModelsConfigSnapshot | null>(() => {
    const current = view.value
    return current.phase === 'ready' ? current.data : null
  })
  const providers = computed(() => snapshot.value?.providers ?? [])
  const parseError = computed(() => snapshot.value?.parseError ?? null)
  const busy = computed(() => saveView.value.phase === 'running' || deleteView.value.phase === 'running')
  /** 写动作的错误统一展示；保存与删除共用一个入口，避免两个错误同时出现。 */
  const actionError = computed<ModelsConfigError | null>(() => {
    const save = saveView.value
    if (save.phase === 'error') return save.error
    const removal = deleteView.value
    if (removal.phase === 'error') return removal.error
    return null
  })

  /** 重新读盘；这次读取同时成为主进程后续保存的比对基线。 */
  async function refresh(): Promise<void> {
    view.value = { phase: 'loading' }
    const result = await getModelsConfig()
    view.value = result.ok ? { phase: 'ready', data: result.data } : { phase: 'error', error: result.error }
  }

  /** 保存一个条目；返回是否成功，成功后用主进程确认的快照替换当前状态。 */
  async function save(providerId: string, json: string): Promise<boolean> {
    if (busy.value) return false
    saveView.value = { phase: 'running' }
    const result = await saveModelsConfigProvider(providerId, json)
    if (!result.ok) {
      saveView.value = { phase: 'error', error: result.error }
      return false
    }
    view.value = { phase: 'ready', data: result.data }
    saveView.value = { phase: 'idle' }
    return true
  }

  /** 删除一个条目；条目不存在时主进程不写文件，同样返回当前快照。 */
  async function remove(providerId: string): Promise<boolean> {
    if (busy.value) return false
    deleteView.value = { phase: 'running' }
    const result = await deleteModelsConfigProvider(providerId)
    if (!result.ok) {
      deleteView.value = { phase: 'error', error: result.error }
      return false
    }
    view.value = { phase: 'ready', data: result.data }
    deleteView.value = { phase: 'idle' }
    return true
  }

  /** 清掉写动作的错误；打开编辑器或重新读取前调用。 */
  function clearActionError(): void {
    saveView.value = { phase: 'idle' }
    deleteView.value = { phase: 'idle' }
  }

  return {
    view,
    saveView,
    deleteView,
    snapshot,
    providers,
    parseError,
    busy,
    actionError,
    refresh,
    save,
    remove,
    clearActionError
  }
})
