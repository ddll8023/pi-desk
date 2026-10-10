/**
 * 作为渲染端认证状态、Provider 登录流程与退出登录的调用入口，
 * 把桥接缺失与通信异常转换为安全的展示结果。
 *
 * 密钥只经 `respondAuthLogin` 单向提交；这里不缓存、不记录也不展示它。
 */
import type {
  AuthError,
  AuthFlowResult,
  AuthFlowSnapshot,
  AuthLogoutResult,
  AuthMethod,
  AuthStatusResult
} from '../../../shared/auth-api'

function unavailable(): { ok: false; error: AuthError } {
  return {
    ok: false,
    error: {
      code: 'BRIDGE_UNAVAILABLE',
      message: '桌面桥接不可用，请通过 Electron 打开此页面。',
      detail: null
    }
  }
}

/**
 * 桥接调用异常：原始错误文本进 `detail`，与认证错误的分层呈现保持一致，
 * 既保留一句面向用户的结论，也不丢掉唯一能定位原因的信息。
 */
function callFailed(error: unknown): { ok: false; error: AuthError } {
  return {
    ok: false,
    error: {
      code: 'BRIDGE_CALL_FAILED',
      message: '桌面桥接调用失败，可以重试。',
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

/** 读取 Provider 与认证状态；不含任何已有凭据内容。 */
export async function getAuthStatus(): Promise<AuthStatusResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getAuthStatus !== 'function') return unavailable()
  try {
    return await bridge.getAuthStatus()
  } catch (error) {
    return callFailed(error)
  }
}

/** 启动官方登录流程；成功只表示流程已开始。 */
export async function startAuthLogin(providerId: string, method: AuthMethod): Promise<AuthFlowResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.startAuthLogin !== 'function') return unavailable()
  try {
    return await bridge.startAuthLogin(providerId, method)
  } catch (error) {
    return callFailed(error)
  }
}

/** 回应流程中的当前提示；密钥只经这里提交一次。 */
export async function respondAuthLogin(
  flowId: string,
  promptId: string,
  value: string
): Promise<AuthFlowResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.respondAuthLogin !== 'function') return unavailable()
  try {
    return await bridge.respondAuthLogin(flowId, promptId, value)
  } catch (error) {
    return callFailed(error)
  }
}

/** 取消登录流程；取消后凭据不会保存。 */
export async function cancelAuthLogin(flowId: string): Promise<AuthFlowResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.cancelAuthLogin !== 'function') return unavailable()
  try {
    return await bridge.cancelAuthLogin(flowId)
  } catch (error) {
    return callFailed(error)
  }
}

/** 在系统浏览器中打开当前流程记录的授权地址；页面不传 URL。 */
export async function openAuthFlowUrl(flowId: string): Promise<AuthFlowResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.openAuthFlowUrl !== 'function') return unavailable()
  try {
    return await bridge.openAuthFlowUrl(flowId)
  } catch (error) {
    return callFailed(error)
  }
}

/** 删除已保存的凭据；不影响环境变量与 models.json 配置。 */
export async function logoutAuthProvider(providerId: string): Promise<AuthLogoutResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.logoutAuthProvider !== 'function') return unavailable()
  try {
    return await bridge.logoutAuthProvider(providerId)
  } catch (error) {
    return callFailed(error)
  }
}

/** 订阅登录流程变化；返回释放函数。 */
export function subscribeAuthFlow(listener: (snapshot: AuthFlowSnapshot) => void): () => void {
  const bridge = window.desktop
  if (!bridge || typeof bridge.onAuthFlowChanged !== 'function') return () => undefined
  return bridge.onAuthFlowChanged(listener)
}
