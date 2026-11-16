/**
 * 作品库工具扩展：向会话注册清单、详情与登记三个工具。
 *
 * 工厂自身不抛出未捕获异常，确保注册失败时不影响会话主链；只有主进程注入了
 * 作品操作派发函数时才会装配本扩展（见 session-runtime）。
 */

import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { registerPortfolioTools } from './tools'
import type { SdkPortfolioOperator } from './tools'

export const PORTFOLIO_EXTENSION_NAME = 'portfolio'
export type { SdkPortfolioOperator } from './tools'

export function createPortfolioExtension(operator: SdkPortfolioOperator): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    try {
      registerPortfolioTools(pi, operator)
    } catch (error) {
      console.error('[portfolio] 注册失败，作品库工具不可用：', error instanceof Error ? error.message : String(error))
    }
  }
}
