/** 保存 Runtime 页面的展示状态、订阅与启停、Prompt 提交动作，不持有 Runtime 所有权或消息投影。 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PromptDisposition, RuntimeError, RuntimeStatus } from '../../../shared/runtime-api'
import {
  getRuntimeStatus,
  sendPrompt,
  startRuntime,
  stopRuntime,
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

export const useRuntimeStore = defineStore('runtime', () => {
  const view = ref<RuntimeViewState>({ phase: 'idle' })
  const promptView = ref<PromptViewState>({ phase: 'idle' })
  let releaseSubscription: (() => void) | null = null

  /** 先订阅再取当前快照，避免初始化期间漏掉状态变化。 */
  async function initialize(): Promise<void> {
    if (releaseSubscription === null) {
      releaseSubscription = subscribeRuntimeStatus(applyStatus)
    }
    const result = await getRuntimeStatus()
    if (result.ok) applyStatus(result.data)
  }

  /** 页面卸载时释放订阅；重复调用无副作用。 */
  function dispose(): void {
    releaseSubscription?.()
    releaseSubscription = null
  }

  /** 启动唯一 Runtime；启动、就绪或关闭中都不重复发起。 */
  async function launch(projectPath: string): Promise<void> {
    if (view.value.phase === 'starting' || view.value.phase === 'ready' || view.value.phase === 'stopping') {
      return
    }

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

  /** 提交 Prompt；只有就绪状态才发起，发送中不重复提交。 */
  async function send(message: string): Promise<void> {
    if (view.value.phase !== 'ready' || promptView.value.phase === 'sending') return

    promptView.value = { phase: 'sending' }
    const result = await sendPrompt(message)
    promptView.value = result.ok
      ? { phase: 'accepted', disposition: result.data.disposition }
      : { phase: 'error', error: result.error }
  }

  /** 主进程快照是唯一真相：事件通知与查询结果都经这里映射为展示状态。 */
  function applyStatus(status: RuntimeStatus): void {
    if (status.state === 'failed') {
      view.value = {
        phase: 'failed',
        error: {
          code: 'RUNTIME_EXITED',
          message: status.lastError ?? 'Runtime 已异常退出，结果不确定。'
        }
      }
      return
    }
    if (status.state === 'ready') {
      view.value = { phase: 'ready', snapshot: status }
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
  }

  return { view, promptView, initialize, dispose, launch, shutdown, send }
})
