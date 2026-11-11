/**
 * 会话与专家绑定的解析与读写口。
 *
 * 主进程不缓存专家定义：绑定只存标识，定义是否还存在由宿主在装载时诊断。
 * 打开会话时已持久化的绑定优先于请求里的值，避免页面用陈旧状态覆盖用户此前的选择；
 * 新会话还没有会话 id，只能先用请求里的值，等首轮产生会话 id 后再由页面落盘。
 */
import { isExpertId } from '../../shared/session-api'

/** 绑定读写口；实现由 `src/main/services.ts` 接到 `DesktopConfigStore`。 */
export interface SessionExpertBindings {
  readonly read: (projectPath: string, sessionId: string) => Promise<string | null>
  readonly save: (binding: {
    readonly projectPath: string
    readonly sessionId: string
    readonly expertId: string | null
  }) => Promise<string | null>
  readonly forget: (projectPath: string, sessionId: string) => Promise<void>
}

/**
 * 解析某个会话本次要用的专家：已存在的会话以持久绑定为准，没有绑定才回落到请求值。
 * 格式不合法的请求值直接忽略——它只可能来自陈旧的页面状态，不该让打开失败。
 */
export async function resolveSessionExpert(input: {
  readonly bindings: SessionExpertBindings
  readonly projectPath: string
  readonly sessionId: string | null
  readonly requested: string | null | undefined
}): Promise<string | null> {
  const requested = isExpertId(input.requested) ? input.requested : null
  if (input.sessionId === null) return requested
  try {
    return await input.bindings.read(input.projectPath, input.sessionId) ?? requested
  } catch {
    // 配置读不出来时按「本次仍按请求值」处理：专家是增强，不能因此挡住会话打开。
    return requested
  }
}
