/**
 * 保存 Pi 版本检查的展示状态：快照、手动重查的进行与失败状态、启动提示的开关。
 *
 * 只做状态映射，不持有检查进程；检查一律由主进程执行，页面只能读取快照与请求重查。
 * 提示策略：每次应用运行最多自动弹一次，且只由「启动后第一次完成的检查」触发；
 * 手动重查只更新设置页里的结果，不再弹窗。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { EMPTY_UPDATES_SNAPSHOT } from '../../../shared/updates-api'
import type { UpdatesSnapshot } from '../../../shared/updates-api'
import { checkUpdates, getUpdates, subscribeUpdates } from '../services/updates'

export const useUpdatesStore = defineStore('updates', () => {
  /** 最近一次快照；初始值是「还没有检查过」，不把未知显示成最新。 */
  const snapshot = ref<UpdatesSnapshot>({ ...EMPTY_UPDATES_SNAPSHOT })
  /** 页面发起的那次重查的调用状态；检查本身的进行状态在 `snapshot.checking`。 */
  const checkState = ref<'idle' | 'checking' | 'error'>('idle')
  /** 页面这次调用失败的原因（桥接异常等）；检查进程自己的失败在 `snapshot.error`。 */
  const checkError = ref<string | null>(null)
  /** 启动提示弹窗是否打开。 */
  const noticeOpen = ref(false)
  let releaseSubscription: (() => void) | null = null
  /** 启动阶段的提示机会：第一次完成的检查之后就用掉，不再自动弹。 */
  let noticeArmed = true

  const piAgent = computed(() => snapshot.value.piAgent)
  const extensions = computed(() => snapshot.value.extensions)
  const checking = computed(() => snapshot.value.checking || checkState.value === 'checking')
  const checkedAt = computed(() => snapshot.value.checkedAt)
  /** 检查进程报告的整体失败原因；单个条目失败在各条目的 `error` 里。 */
  const checkFailure = computed(() => snapshot.value.error)
  const piAgentOutdated = computed(() => snapshot.value.piAgent?.status === 'update-available')
  /** 有更新的扩展条目；顺序保持快照顺序。 */
  const outdatedExtensions = computed(() => (
    snapshot.value.extensions.filter((entry) => entry.status === 'update-available')
  ))
  const hasUpdates = computed(() => piAgentOutdated.value || outdatedExtensions.value.length > 0)

  /** 应用一份快照；启动后的第一份完成结果决定是否弹提示。 */
  function apply(next: UpdatesSnapshot): void {
    snapshot.value = next
    if (next.checking) return
    if (!noticeArmed) return
    noticeArmed = false
    if (hasUpdates.value) noticeOpen.value = true
  }

  /** 先订阅、再取当前快照，避免初始化期间漏掉正在进行的检查结果。 */
  async function initialize(): Promise<void> {
    if (releaseSubscription !== null) return
    releaseSubscription = subscribeUpdates(apply)
    const result = await getUpdates()
    if (result.ok) apply(result.data)
    else checkError.value = result.error.message
  }

  /** 手动重查：进行中时复用同一次检查，不排队也不叠加。 */
  async function check(): Promise<void> {
    if (checkState.value === 'checking') return
    checkState.value = 'checking'
    checkError.value = null
    const result = await checkUpdates()
    if (result.ok) {
      checkState.value = 'idle'
      apply(result.data)
      return
    }
    checkState.value = 'error'
    checkError.value = result.error.message
  }

  function dismissNotice(): void {
    noticeOpen.value = false
  }

  function dispose(): void {
    releaseSubscription?.()
    releaseSubscription = null
  }

  return {
    snapshot,
    piAgent,
    extensions,
    checking,
    checkedAt,
    checkFailure,
    checkError,
    piAgentOutdated,
    outdatedExtensions,
    hasUpdates,
    noticeOpen,
    initialize,
    check,
    dismissNotice,
    dispose
  }
})
