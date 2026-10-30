/**
 * 内置浏览器自动化扩展：向会话注册受管浏览器操控工具。
 *
 * 工厂自身不抛出未捕获异常，确保注册失败时不影响会话主链。
 */

import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { registerBrowserTools } from './tools'
import type { SdkBrowserOperator } from './tools'

export const BROWSER_EXTENSION_NAME = 'browser'
export type { SdkBrowserOperator } from './tools'

export function createBrowserExtension(operator: SdkBrowserOperator): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    try {
      registerBrowserTools(pi, operator)
    } catch (error) {
      console.error('[browser] 注册失败，浏览器操控工具不可用：', error instanceof Error ? error.message : String(error))
    }
  }
}
