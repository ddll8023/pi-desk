/**
 * 保存 Pi 版本检查、扩展更新与内置 Pi agent 安装的展示状态：快照、手动重查的进行与失败状态、
 * 启动提示的开关，以及两者的进行状态、进度、结论与失败原因。
 *
 * 只做状态映射，不持有检查、更新或安装进程；三者一律由主进程执行，页面只能读取快照与进度并请求动作。
 * 更新或安装成功后重新检查一次：两者都会改变实际加载的版本，列表必须回到与磁盘一致的状态。
 * 提示策略：每次应用运行最多自动弹一次，且只由「启动后第一次完成的检查」触发；
 * 只提示扩展：Pi agent 随应用发布或由运行时目录提供，不作为用户待办，也不弹窗。
 * 没有结论、也没有失败原因的空快照（`checkedAt` 与 `error` 都为空，例如启动检查开始前
 * 页面读到的那一份）不算一次完成的检查，不消耗这次机会；手动重查只更新设置页里的结果，不再弹窗。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { EMPTY_UPDATES_SNAPSHOT } from '../../../shared/updates-api'
import type {
  AgentInstallOutcome,
  AgentInstallProgress,
  PackageUpdateOutcome,
  PackageUpdateProgress,
  UpdatesSnapshot
} from '../../../shared/updates-api'
import {
  checkUpdates,
  getUpdates,
  installAgentRuntime,
  subscribeAgentInstallProgress,
  subscribePackageUpdateProgress,
  subscribeUpdates,
  updatePackages
} from '../services/updates'

/** 进度列表只保留最近若干条：进度只用于展示，不承担历史记录职责。 */
const PROGRESS_LIMIT = 30

export const useUpdatesStore = defineStore('updates', () => {
  /** 最近一次快照；初始值是「还没有检查过」，不把未知显示成最新。 */
  const snapshot = ref<UpdatesSnapshot>({ ...EMPTY_UPDATES_SNAPSHOT })
  /** 页面发起的那次重查的调用状态；检查本身的进行状态在 `snapshot.checking`。 */
  const checkState = ref<'idle' | 'checking' | 'error'>('idle')
  /** 页面这次调用失败的原因（桥接异常等）；检查进程自己的失败在 `snapshot.error`。 */
  const checkError = ref<string | null>(null)
  /** 启动提示弹窗是否打开。 */
  const noticeOpen = ref(false)
  /** 更新的进行状态与结果；与检查状态分开，两者含义不同。 */
  const updateState = ref<'idle' | 'updating' | 'error'>('idle')
  const updateProgress = ref<PackageUpdateProgress[]>([])
  const updateOutcome = ref<PackageUpdateOutcome | null>(null)
  /** 页面这次更新调用失败的原因（桥接异常等）；更新进程自己的失败在 `updateOutcome` 里。 */
  const updateError = ref<string | null>(null)
  /** 内置 Pi agent 安装的状态与结果；与扩展更新分开，两者的阶段与失败原因不同。 */
  const agentInstallState = ref<'idle' | 'installing' | 'error'>('idle')
  const agentInstallProgress = ref<AgentInstallProgress[]>([])
  const agentInstallOutcome = ref<AgentInstallOutcome | null>(null)
  /** 页面这次安装调用失败的原因（桥接异常等）；安装进程自己的失败在 `agentInstallOutcome` 里。 */
  const agentInstallError = ref<string | null>(null)
  let releaseSubscription: (() => void) | null = null
  let releaseProgressSubscription: (() => void) | null = null
  let releaseAgentInstallSubscription: (() => void) | null = null
  /** 启动阶段的提示机会：第一次完成的检查之后就用掉，不再自动弹。 */
  let noticeArmed = true

  const piAgent = computed(() => snapshot.value.piAgent)
  const extensions = computed(() => snapshot.value.extensions)
  const checking = computed(() => snapshot.value.checking || checkState.value === 'checking')
  const updating = computed(() => updateState.value === 'updating')
  const installingAgent = computed(() => agentInstallState.value === 'installing')
  const checkedAt = computed(() => snapshot.value.checkedAt)
  /** 检查进程报告的整体失败原因；单个条目失败在各条目的 `error` 里。 */
  const checkFailure = computed(() => snapshot.value.error)
  /** 有更新的扩展条目；顺序保持快照顺序。 */
  const outdatedExtensions = computed(() => (
    snapshot.value.extensions.filter((entry) => entry.status === 'update-available')
  ))

  /** 应用一份快照；启动后的第一份完成结果决定是否弹提示。 */
  function apply(next: UpdatesSnapshot): void {
    snapshot.value = next
    if (next.checking) return
    if (!noticeArmed) return
    // 还没有任何检查结论、也没有失败原因时不能占用这次机会：启动检查开始前读到的那一份快照
    // 就属于这种情形，若在这里用掉，启动检查真正查出更新时反而不会弹。
    if (next.checkedAt === null && next.error === null) return
    noticeArmed = false
    if (outdatedExtensions.value.length > 0) noticeOpen.value = true
  }

  /** 先订阅、再取当前快照，避免初始化期间漏掉正在进行的检查结果。 */
  async function initialize(): Promise<void> {
    if (releaseSubscription !== null) return
    releaseSubscription = subscribeUpdates(apply)
    releaseProgressSubscription = subscribePackageUpdateProgress(applyProgress)
    releaseAgentInstallSubscription = subscribeAgentInstallProgress(applyAgentInstallProgress)
    const result = await getUpdates()
    if (result.ok) apply(result.data)
    else checkError.value = result.error.message
  }

  /** 追加一条更新进度；进度只用于展示，超出上限时丢弃最早的条目。 */
  function applyProgress(progress: PackageUpdateProgress): void {
    updateProgress.value = [...updateProgress.value, progress].slice(-PROGRESS_LIMIT)
  }

  /** 追加一条安装进度；上限与更新进度一致。 */
  function applyAgentInstallProgress(progress: AgentInstallProgress): void {
    agentInstallProgress.value = [...agentInstallProgress.value, progress].slice(-PROGRESS_LIMIT)
  }

  /**
   * 安装或切换内置 Pi agent 的运行时版本；省略版本时取官方最新。
   * 进行中时忽略重复触发；结束后重新检查一次，让列表反映新的将加载版本。
   */
  async function installAgent(version?: string): Promise<void> {
    if (agentInstallState.value === 'installing') return
    agentInstallState.value = 'installing'
    agentInstallError.value = null
    agentInstallOutcome.value = null
    agentInstallProgress.value = []
    const result = await installAgentRuntime(version)
    if (!result.ok) {
      agentInstallState.value = 'error'
      agentInstallError.value = result.error.message
      return
    }
    agentInstallState.value = 'idle'
    agentInstallOutcome.value = result.data
    await check()
  }

  /**
   * 执行扩展更新；省略来源时更新全部已声明的包。
   * 进行中时忽略重复触发；结束后重新检查一次，让列表反映新的已装版本。
   */
  async function update(source?: string): Promise<void> {
    if (updateState.value === 'updating') return
    updateState.value = 'updating'
    updateError.value = null
    updateOutcome.value = null
    updateProgress.value = []
    const result = await updatePackages(source)
    if (!result.ok) {
      updateState.value = 'error'
      updateError.value = result.error.message
      return
    }
    updateState.value = 'idle'
    updateOutcome.value = result.data
    await check()
  }

  /** 手动重查：进行中时复用同一次检查，不排队也不叠加；手动重查一律不再弹提示。 */
  async function check(): Promise<void> {
    if (checkState.value === 'checking') return
    noticeArmed = false
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
    releaseProgressSubscription?.()
    releaseProgressSubscription = null
    releaseAgentInstallSubscription?.()
    releaseAgentInstallSubscription = null
  }

  return {
    snapshot,
    piAgent,
    extensions,
    checking,
    checkedAt,
    checkFailure,
    checkError,
    outdatedExtensions,
    noticeOpen,
    updateState,
    updating,
    updateProgress,
    updateOutcome,
    updateError,
    agentInstallState,
    installingAgent,
    agentInstallProgress,
    agentInstallOutcome,
    agentInstallError,
    initialize,
    check,
    update,
    installAgent,
    dismissNotice,
    dispose
  }
})
