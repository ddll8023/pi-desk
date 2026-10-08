/** 保存 Runtime 页面的展示状态与启动动作，不持有 Runtime 所有权或消息投影。 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { RuntimeError, RuntimeStatus } from '../../../shared/runtime-api'
import { startRuntime } from '../services/runtime'

type RuntimeViewState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'ready'; snapshot: RuntimeStatus }
  | { phase: 'failed'; error: RuntimeError }

export const useRuntimeStore = defineStore('runtime', () => {
  const view = ref<RuntimeViewState>({ phase: 'idle' })

  /** 启动唯一 Runtime；重复点击不产生并行启动。 */
  async function launch(projectPath: string): Promise<void> {
    if (view.value.phase === 'starting' || view.value.phase === 'ready') return

    view.value = { phase: 'starting' }
    const result = await startRuntime(projectPath)
    if (!result.ok) {
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
    view.value = { phase: 'ready', snapshot: result.data }
  }

  return { view, launch }
})
