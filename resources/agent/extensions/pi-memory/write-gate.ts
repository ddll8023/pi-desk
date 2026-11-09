/** 记忆写入宿主闸门：只有具备真实交互桥的宿主可提交权威记忆，子代理与无 UI 进程一律拒绝。 */
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'

interface Capabilities { version: 1; fullText: true; maxMessageChars: number }
type DesktopUI = ExtensionContext['ui'] & { piDeskConfirmCapabilities?: () => Capabilities | null }

/** 闸门只判断宿主能不能写，不展示正文，也不代表用户已要求保存；能力声明不是保存授权。 */
export function assertWritableHost(ctx: ExtensionContext): void {
  if (!ctx.hasUI) throw new Error('没有真实交互能力，未生成计划或提交')
  if (ctx.mode === 'tui') return
  if (ctx.mode === 'rpc') {
    const capabilities = (ctx.ui as DesktopUI).piDeskConfirmCapabilities?.()
    // 未知 RPC 客户端不能当作可写宿主；宿主挂起或绑定失效时同样拒绝。
    if (capabilities?.version === 1 && capabilities.fullText === true
      && Number.isSafeInteger(capabilities.maxMessageChars) && capabilities.maxMessageChars > 0) return
  }
  throw new Error('当前宿主未声明可写能力；仅保留读取，未生成计划或提交')
}
