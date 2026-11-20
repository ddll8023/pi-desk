/**
 * 会话与团队绑定的解析与读写口，与 `session-experts.ts` 同构。
 *
 * 绑定只存团队标识：团队定义、团长与成员是否还可用由宿主装配时诊断，主进程不缓存正文。
 * 已有会话以持久绑定为准，请求里的值只对新会话生效，避免页面用陈旧状态覆盖此前的选择。
 */
import { isExpertId } from '../../shared/session-api'

/** 绑定读写口；实现由 `src/main/services.ts` 接到 `DesktopConfigStore`。 */
export interface SessionTeamBindings {
  readonly read: (projectPath: string, sessionId: string) => Promise<string | null>
  readonly save: (binding: {
    readonly projectPath: string
    readonly sessionId: string
    readonly teamId: string | null
  }) => Promise<string | null>
  readonly forget: (projectPath: string, sessionId: string) => Promise<void>
}

/**
 * 解析某个会话本次要用的团队：已存在的会话以持久绑定为准，没有绑定才回落到请求值。
 * 团队与专家同属引用类标识，字符规则共用 `isExpertId`；格式不合法的请求值直接忽略，
 * 它只可能来自陈旧的页面状态，不该让打开失败。
 */
export async function resolveSessionTeam(input: {
  readonly bindings: SessionTeamBindings
  readonly projectPath: string
  readonly sessionId: string | null
  readonly requested: string | null | undefined
}): Promise<string | null> {
  const requested = isExpertId(input.requested) ? input.requested : null
  if (input.sessionId === null) return requested
  try {
    return await input.bindings.read(input.projectPath, input.sessionId) ?? requested
  } catch {
    // 配置读不出来时按「本次仍按请求值」处理：团队是增强，不能因此挡住会话打开。
    return requested
  }
}
