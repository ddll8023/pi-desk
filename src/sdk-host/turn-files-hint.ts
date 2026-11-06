/** 上一轮改动面以系统提示分段注入：只补文件事实，不改写用户输入，也不往 transcript 追加消息。 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import type { SessionActivity, SessionTurnFiles } from '../shared/runtime-api'

/** 分段键同时是提示里的 XML 包裹名，保持短且不与既有分段重名。 */
const SECTION_KEY = 'previous-turn-files'

/**
 * 取最近一次有写入的轮次。调用发生在用户轮次的 `before_agent_start`，本轮工具尚未执行，
 * 因此这里取到的必然是已经结束的轮次；更早的无写入轮次不参与。
 */
export function lastTurnWithWrites(view: SessionActivity | null): SessionTurnFiles | null {
  if (view === null) return null
  for (let index = view.turns.length - 1; index >= 0; index -= 1) {
    const turn = view.turns[index]
    if (turn !== undefined && turn.files.length > 0) return turn
  }
  return null
}

/** 截断标记保留在计数里，避免把前若干项读成全部改动；条数上限沿用投影侧口径。 */
function describe(turn: SessionTurnFiles): string {
  const count = turn.files.length
  const lines = [turn.truncated ? `上一轮改动 ${count}+ 个文件` : `上一轮改动 ${count} 个文件`]
  for (const file of turn.files) lines.push(file.label)
  return lines.join('\n')
}

/**
 * 只补改动面，不摘要对话：上一轮正文已在历史消息里，重复注入只增加固定 token 与偏置。
 * 返回分段内容会让 Pi 按差异追加一次系统提示补丁，因此仅在确有改动时写入。
 */
export function createTurnFilesHintExtension(readView: () => SessionActivity | null): ExtensionFactory {
  return pi => {
    pi.on('before_agent_start', event => {
      // 自定义消息触发的运行没有用户轮次，注入会把旧改动挂到无关请求上。
      if (event.messageType !== 'user') return undefined
      const turn = lastTurnWithWrites(readView())
      if (turn === null) return undefined
      event.systemPromptOptions.sections[SECTION_KEY] = describe(turn)
      return undefined
    })
  }
}
