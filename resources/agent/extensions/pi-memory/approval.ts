/** 真实宿主交互审批：桌面只用完整正文 confirm，CLI 用可逐页完整阅读的 TUI。 */
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import type { GeneratedPlan, MemoryEngine } from './engine.ts'

interface Capabilities { version: 1; fullText: true; maxMessageChars: number }
type DesktopUI = ExtensionContext['ui'] & { piDeskConfirmCapabilities?: () => Capabilities | null }

/** 能力声明不是批准；未知 RPC 客户端不能被当作安全审批通道。 */
export function approvalLimit(ctx: ExtensionContext): number {
  if (!ctx.hasUI) throw new Error('没有真实交互能力，未生成保存计划或提交')
  if (ctx.mode === 'tui') return 65_536
  if (ctx.mode === 'rpc') {
    const capabilities = (ctx.ui as DesktopUI).piDeskConfirmCapabilities?.()
    if (capabilities?.version === 1 && capabilities.fullText === true
      && Number.isSafeInteger(capabilities.maxMessageChars) && capabilities.maxMessageChars > 0) {
      return Math.min(capabilities.maxMessageChars, 65_536)
    }
  }
  throw new Error('当前宿主未声明完整审批正文能力；仅保留读取，未生成计划或提交')
}

export function approvalText(engine: MemoryEngine, plan: GeneratedPlan,
  source: { sessionId: string; cwd: string }): string {
  // JSON 转义保留原始内容含义；额外显式显示双向控制字符，避免终端排版伪装审批内容。
  const body = JSON.stringify({ source_pi_session: source, plan: plan.raw }, null, 2).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return [
    '确认提交以下具体记忆计划？批准仅覆盖本计划，不授权其他文件操作。',
    `目标域：用户级全局${plan.operation === 'save' ? '工作日记' : '个人画像'}（不绑定项目）`,
    `记忆库：${JSON.stringify(engine.store)}`,
    `计划协议版本：${JSON.stringify(plan.raw.plan_version)}；提交时核对库版本序号，变化则拒绝`,
    '以下为引擎生成的完整计划，payload 包含完整新旧正文、来源和替代／撤回影响。',
    plan.operation === 'save'
      ? 'supersede 只标记旧规则为已替代，保留旧正文和 ID；withdrawn_months 中的月摘要会撤回，不自动重建。'
      : 'replace_ids 指定的旧画像会被新画像替换；replaced_profiles 展示其完整原文，日记来源保留。',
    '计划已写入记忆库的待确认表，24 小时失效；生成时可清理过期计划。取消不改变权威记忆，不自动删除候选。',
    '提交由引擎在单个数据库事务内写入权威数据与词项；失败不自动恢复或重试。',
    '计划变化、源内容变化、过期或会话绑定变化均使本次确认失效。',
    '控制字符以 JSON 转义表示，不执行正文中的命令或指令。', '', body
  ].join('\n')
}

export async function approve(ctx: ExtensionContext, message: string, signal: AbortSignal): Promise<boolean> {
  const limit = approvalLimit(ctx)
  if (!message.trim() || message.length > limit) throw new Error(`计划正文超过完整展示上限 ${limit} 字符；未截断或提交`)
  if (signal.aborted) return false
  if (ctx.mode === 'rpc') {
    const accepted = await ctx.ui.confirm('保存记忆：审批完整计划', message, { signal })
    // 交互能力或绑定已失效时，不沿用先前返回的 true。
    approvalLimit(ctx)
    return accepted === true && !signal.aborted
  }
  return ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
    if (signal.aborted) throw new Error('记忆审批已取消')
    let closed = false
    let width = 0
    let rows = 0
    let lines: string[] = []
    let offset = 0
    let height = 1
    let seenThrough = 0
    const finish = (accepted: boolean): void => {
      if (closed) return
      closed = true
      signal.removeEventListener('abort', abort)
      done(accepted && !signal.aborted)
    }
    const abort = (): void => finish(false)
    signal.addEventListener('abort', abort, { once: true })
    return {
      render(nextWidth: number): string[] {
        if (closed) return []
        const nextRows = tui.terminal.rows
        if (nextWidth < 24 || nextRows < 10) {
          finish(false)
          return [truncateToWidth('终端过小，已取消记忆保存。', Math.max(1, nextWidth))]
        }
        if (nextWidth !== width || nextRows !== rows) {
          width = nextWidth
          rows = nextRows
          lines = wrapTextWithAnsi(message, width)
          height = Math.max(1, Math.floor(rows * 0.8) - 4)
          // 重排后重新从头阅读，不能以旧布局已阅读的行数批准新布局。
          offset = 0
          seenThrough = 0
        }
        offset = Math.min(offset, Math.max(0, lines.length - height))
        if (offset <= seenThrough) seenThrough = Math.max(seenThrough, Math.min(lines.length, offset + height))
        const canApprove = seenThrough >= lines.length && offset + height >= lines.length
        return [
          truncateToWidth(theme.fg('accent', '记忆计划：完整正文审批'), width),
          truncateToWidth(`行 ${offset + 1}–${Math.min(offset + height, lines.length)} / ${lines.length}`, width),
          ...lines.slice(offset, offset + height),
          truncateToWidth('↑↓ / PgUp PgDn 阅读；Esc 取消', width),
          truncateToWidth(canApprove ? 'Ctrl+Y：明确批准本计划' : '逐页读至末尾后才可批准', width)
        ]
      },
      handleInput(data: string): void {
        if (closed) return
        if (keybindings.matches(data, 'tui.select.cancel') || matchesKey(data, 'ctrl+c')) { finish(false); return }
        if (matchesKey(data, 'ctrl+y')) {
          if (lines.length && seenThrough >= lines.length && offset + height >= lines.length) finish(true)
          return
        }
        if (keybindings.matches(data, 'tui.select.down')) offset += 1
        else if (keybindings.matches(data, 'tui.select.up')) offset = Math.max(0, offset - 1)
        else if (matchesKey(data, 'pageDown')) offset += Math.max(1, height - 1)
        else if (matchesKey(data, 'pageUp')) offset = Math.max(0, offset - Math.max(1, height - 1))
        else return
        tui.requestRender()
      },
      invalidate(): void { width = 0 },
      dispose(): void { closed = true; signal.removeEventListener('abort', abort) }
    }
  }, { overlay: true, overlayOptions: { width: '90%', maxHeight: '80%', anchor: 'center' } })
}
