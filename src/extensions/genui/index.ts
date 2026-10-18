/**
 * 内置生成式 UI 扩展：把界面渲染能力作为 pi-desk 的产品特性，而不是用户自行安装的插件。
 *
 * 与既有内置扩展（codemode / tool-search / mcp）保持同一注册形态。工厂本身必须永不抛出：
 * SDK 宿主在扩展加载出错时直接拒绝建立会话（`SESSION_BIND_FAILED`），一次注册失败会让用户
 * 打不开任何会话，因此这里把注册失败降级为"工具不可用"并留下一条诊断。
 */
import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { registerGenuiTools } from './tools'

/** 扩展在启动清单与错误信息里的名字。 */
export const GENUI_EXTENSION_NAME = 'genui'

/**
 * 构造扩展工厂。返回的函数只做注册，不启动进程、不建定时器、不读配置：
 * Pi 会在部分不进入会话的调用里也加载扩展，加载期不应产生副作用。
 */
export function createGenuiExtension(): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    try {
      registerGenuiTools(pi)
    } catch (error) {
      // 不向上抛：注册失败只让生成式 UI 不可用，不影响其余工具与会话建立。
      console.error('[genui] 注册失败，生成式界面不可用：', error instanceof Error ? error.message : String(error))
    }
  }
}
