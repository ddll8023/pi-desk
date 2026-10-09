/**
 * 保存认证面板的展示状态：Provider 与认证状态、当前登录流程快照、操作状态与输入态。
 *
 * 只保存主进程投影的副本，不缓存凭据内容：
 * - 密钥与验证码输入只在提交窗口内存在，提交、取消、失败或提示变化后立即清空；
 * - 登录成功只以重读到的状态为据，不把它当作 Pi 已经使用新凭据；
 * - 流程快照来自主进程事件，页面失去订阅时以重新读取的状态收敛。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  AuthError,
  AuthFlowSnapshot,
  AuthMethod,
  AuthProviderStatus
} from '../../../shared/auth-api'
import {
  cancelAuthLogin,
  getAuthStatus,
  logoutAuthProvider,
  openAuthFlowUrl,
  respondAuthLogin,
  startAuthLogin,
  subscribeAuthFlow
} from '../services/auth'

/** 状态读取的展示状态；`error` 表示读取失败，与「确实没有 Provider」区分。 */
type StatusViewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'error'; error: AuthError }

/** 登录流程操作的展示状态；流程本身的状态以快照为准。 */
type FlowActionState =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'error'; error: AuthError }

/** 终态：流程结束后不再等待输入。 */
const TERMINAL_PHASES: readonly string[] = ['completed', 'failed', 'cancelled']

export const useAuthStore = defineStore('auth', () => {
  const statusView = ref<StatusViewState>({ phase: 'idle' })
  const providers = ref<readonly AuthProviderStatus[]>([])
  const configError = ref<string | null>(null)
  const flow = ref<AuthFlowSnapshot | null>(null)
  const flowAction = ref<FlowActionState>({ phase: 'idle' })
  const logoutAction = ref<FlowActionState>({ phase: 'idle' })
  const filter = ref('')
  /** 密钥与验证码输入；提交或取消后立即清空。 */
  const secretInput = ref('')
  /** select 提示的选中项；与密钥输入分开保存。 */
  const selectInput = ref('')
  let releaseSubscription: (() => void) | null = null

  const activeFlow = computed(() => (
    flow.value !== null && !TERMINAL_PHASES.includes(flow.value.phase) ? flow.value : null
  ))

  /** 按「已配置在前、名称升序」排序并应用过滤；过滤只匹配展示名与 provider id。 */
  const visibleProviders = computed(() => {
    const keyword = filter.value.trim().toLowerCase()
    const matched = keyword === ''
      ? [...providers.value]
      : providers.value.filter((provider) => (
        provider.name.toLowerCase().includes(keyword)
        || provider.providerId.toLowerCase().includes(keyword)
      ))
    return matched.sort((left, right) => {
      if (left.configured !== right.configured) return left.configured ? -1 : 1
      if (left.name === right.name) return left.providerId < right.providerId ? -1 : 1
      return left.name < right.name ? -1 : 1
    })
  })

  const configuredCount = computed(() => providers.value.filter((provider) => provider.configured).length)

  /** 订阅流程事件并读取一次状态；重复调用无副作用。 */
  async function initialize(): Promise<void> {
    if (releaseSubscription === null) {
      releaseSubscription = subscribeAuthFlow((snapshot) => applyFlow(snapshot))
    }
    await refresh()
  }

  /** 页面卸载时释放订阅；重复调用无副作用。 */
  function dispose(): void {
    releaseSubscription?.()
    releaseSubscription = null
  }

  /** 读取认证状态；失败时保留错误，不把空列表当作「没有 Provider」。 */
  async function refresh(): Promise<void> {
    if (statusView.value.phase === 'loading') return
    statusView.value = { phase: 'loading' }
    const result = await getAuthStatus()
    if (!result.ok) {
      statusView.value = { phase: 'error', error: result.error }
      return
    }
    providers.value = result.data.providers
    configError.value = result.data.configError
    applyFlow(result.data.flow)
    statusView.value = { phase: 'ready' }
  }

  /** 启动登录流程；同一时刻只允许一个流程，重复点击不重复发起。 */
  async function login(providerId: string, method: AuthMethod): Promise<void> {
    if (flowAction.value.phase === 'sending') return
    flowAction.value = { phase: 'sending' }
    clearInput()
    const result = await startAuthLogin(providerId, method)
    if (!result.ok) {
      flowAction.value = { phase: 'error', error: result.error }
      return
    }
    flowAction.value = { phase: 'idle' }
    applyFlow(result.data)
  }

  /** 回应当前提示：密钥或验证码只在这里提交一次，随后立即清空本地输入。 */
  async function respond(): Promise<void> {
    const snapshot = activeFlow.value
    const prompt = snapshot?.prompt ?? null
    if (snapshot === null || prompt === null || flowAction.value.phase === 'sending') return

    const value = prompt.kind === 'select' ? selectInput.value : secretInput.value
    if (value === '') return

    flowAction.value = { phase: 'sending' }
    const result = await respondAuthLogin(snapshot.flowId, prompt.promptId, value)
    clearInput()
    if (!result.ok) {
      flowAction.value = { phase: 'error', error: result.error }
      return
    }
    flowAction.value = { phase: 'idle' }
    applyFlow(result.data)
  }

  /** 取消登录流程；取消后不保存凭据，输入同时清空。 */
  async function cancel(): Promise<void> {
    const snapshot = activeFlow.value
    if (snapshot === null || flowAction.value.phase === 'sending') return
    flowAction.value = { phase: 'sending' }
    clearInput()
    const result = await cancelAuthLogin(snapshot.flowId)
    if (!result.ok) {
      flowAction.value = { phase: 'error', error: result.error }
      return
    }
    flowAction.value = { phase: 'idle' }
    applyFlow(result.data)
  }

  /** 在系统浏览器中打开流程记录的授权地址（或设备码验证地址）。 */
  async function openUrl(): Promise<void> {
    const snapshot = activeFlow.value
    if (snapshot === null || flowAction.value.phase === 'sending') return
    flowAction.value = { phase: 'sending' }
    const result = await openAuthFlowUrl(snapshot.flowId)
    if (!result.ok) {
      flowAction.value = { phase: 'error', error: result.error }
      return
    }
    flowAction.value = { phase: 'idle' }
    applyFlow(result.data)
  }

  /** 删除已保存的凭据；成功后以返回的状态收敛，并重新读取一次以获得完整列表。 */
  async function logout(providerId: string): Promise<void> {
    if (logoutAction.value.phase === 'sending') return
    logoutAction.value = { phase: 'sending' }
    const result = await logoutAuthProvider(providerId)
    if (!result.ok) {
      logoutAction.value = { phase: 'error', error: result.error }
      return
    }
    logoutAction.value = { phase: 'idle' }
    await refresh()
  }

  /** 提示变化时清空输入，避免上一轮的密钥留在输入框中。 */
  function applyFlow(next: AuthFlowSnapshot | null): void {
    const previousPromptId = flow.value?.prompt?.promptId ?? null
    flow.value = next
    const nextPromptId = next?.prompt?.promptId ?? null
    if (nextPromptId !== previousPromptId) clearInput()
  }

  function clearInput(): void {
    secretInput.value = ''
    selectInput.value = ''
  }

  function resetFlowError(): void {
    if (flowAction.value.phase === 'error') flowAction.value = { phase: 'idle' }
  }

  return {
    statusView,
    providers,
    configError,
    flow,
    activeFlow,
    flowAction,
    logoutAction,
    filter,
    secretInput,
    selectInput,
    visibleProviders,
    configuredCount,
    initialize,
    dispose,
    refresh,
    login,
    respond,
    cancel,
    openUrl,
    logout,
    resetFlowError
  }
})
