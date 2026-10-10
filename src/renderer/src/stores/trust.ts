/** 保存 Project Trust 的展示状态：当前项目的信任状态、待决定的对话框与决定动作；探测与持久化都在主进程。 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { TrustDecision, TrustStatus } from '../../../shared/trust-api'
import { decideTrust, getTrustStatus } from '../services/trust'
import { useResourceStore } from './resource'

export const useTrustStore = defineStore('trust', () => {
  /** `prompting` 表示正在展示信任对话框；决定或关闭后回到 `idle`。 */
  const view = ref<{ phase: 'idle' } | { phase: 'prompting'; status: TrustStatus }>({ phase: 'idle' })
  /** 最近一次决定动作的失败信息；只影响对话框内的提示，不改变信任状态。 */
  const actionError = ref<string | null>(null)
  const deciding = ref(false)

  /** 读取当前项目的信任状态并进入待决定状态；状态读取失败时由调用方展示错误。 */
  async function openPrompt(): Promise<boolean> {
    const result = await getTrustStatus()
    if (!result.ok) {
      actionError.value = result.error.message
      return false
    }
    if (result.data.projectPath === null) {
      actionError.value = '尚未选择项目，无法做出信任决定。'
      return false
    }
    actionError.value = null
    view.value = { phase: 'prompting', status: result.data }
    return true
  }

  /** 保存决定并退出对话框；决定失败时保持对话框并展示原因。 */
  async function decide(decision: TrustDecision): Promise<void> {
    if (view.value.phase !== 'prompting' || deciding.value) return
    const projectPath = view.value.status.projectPath
    if (projectPath === null) return

    deciding.value = true
    actionError.value = null
    try {
      const result = await decideTrust(projectPath, decision)
      if (!result.ok) {
        actionError.value = result.error.message
        return
      }
      view.value = { phase: 'idle' }
      // 信任决定会改变项目级资源的可见性，重读一次预读清单；Runtime 未启动时才真正探测。
      void useResourceStore().refreshPreview()
    } finally {
      deciding.value = false
    }
  }

  /** 放弃决定并关闭对话框；不保存任何状态，下次启动会再次询问。 */
  function cancel(): void {
    if (view.value.phase !== 'prompting' || deciding.value) return
    view.value = { phase: 'idle' }
    actionError.value = null
  }

  /** 读取当前项目的信任状态（供详情弹层判断重置入口）；失败时返回错误消息。 */
  async function queryStatus(): Promise<TrustStatus | { error: string }> {
    const result = await getTrustStatus()
    if (!result.ok) return { error: result.error.message }
    return result.data
  }

  /** 清除当前项目的信任决定；成功返回 null，失败返回可展示的错误消息。 */
  async function resetCurrentProject(): Promise<string | null> {
    const status = await getTrustStatus()
    if (!status.ok) return status.error.message
    const projectPath = status.data.projectPath
    if (projectPath === null) return '尚未选择项目，无需重置。'
    if (status.data.decision === null) return null
    const result = await decideTrust(projectPath, 'unset')
    if (!result.ok) return result.error.message
    return null
  }

  return {
    view,
    actionError,
    deciding,
    openPrompt,
    decide,
    cancel,
    queryStatus,
    resetCurrentProject
  }
})
