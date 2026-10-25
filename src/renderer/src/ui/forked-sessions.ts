/** 分叉会话折叠：回退（Pi 的 fork）保留来源文件，列表只展示链上最新一条；侧栏项目树使用。 */
import type { SessionSummary } from '../../../shared/session-api'

/**
 * 分叉折叠：回退（Pi 的 fork）新建会话并保留来源文件，列表只展示分叉链里最新的一条。
 * `keep` 命中的会话即使已被新的一条取代也保留，用于当前会话与仍承载运行实例的会话；
 * 来源不在 `sessions` 里的分叉不受影响。
 */
export function collapseForkedSessions(
  sessions: readonly SessionSummary[],
  keep: (sessionId: string) => boolean
): readonly SessionSummary[] {
  const ids = new Set(sessions.map(session => session.sessionId))
  const superseded = new Set<string>()
  for (const session of sessions) {
    const source = session.forkedFromSessionId
    if (source !== null && ids.has(source)) superseded.add(source)
  }
  if (superseded.size === 0) return sessions
  return sessions.filter(session => !superseded.has(session.sessionId) || keep(session.sessionId))
}
