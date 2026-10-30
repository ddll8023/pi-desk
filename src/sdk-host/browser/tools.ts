/**
 * 内置浏览器操控的 7 个原子工具定义：快照、正文、导航、点击、输入、按键与滚动。
 *
 * 通过受限的 SdkBrowserOperator 调用主进程 CDP 能力；
 * 格式化输出紧凑的无障碍树与自愈指引，并在快照过期时明确引导模型重新调用快照。
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { SdkBrowserOperation, SdkBrowserOperationResult } from '../protocol'
import type { BrowserContentResult, BrowserSnapshot } from '../../shared/browser-session-api'

export type SdkBrowserOperator = (operation: SdkBrowserOperation) => Promise<SdkBrowserOperationResult>

type ToolParameters = Parameters<ExtensionAPI['registerTool']>[0]['parameters']

const SNAPSHOT_PARAMETERS = {
  type: 'object',
  properties: {},
  additionalProperties: false
} as unknown as ToolParameters

const CONTENT_PARAMETERS = {
  type: 'object',
  properties: {},
  additionalProperties: false
} as unknown as ToolParameters

const NAVIGATE_PARAMETERS = {
  type: 'object',
  required: ['url'],
  additionalProperties: false,
  properties: {
    url: {
      type: 'string',
      description: '要导航的目标完整网址，例如 http://localhost:5173 或 https://example.com'
    }
  }
} as unknown as ToolParameters

const CLICK_PARAMETERS = {
  type: 'object',
  required: ['ref'],
  additionalProperties: false,
  properties: {
    ref: {
      type: 'number',
      description: '当前快照中元素对应的数字标号 [ref: N]，例如 1'
    }
  }
} as unknown as ToolParameters

const FILL_PARAMETERS = {
  type: 'object',
  required: ['ref', 'text'],
  additionalProperties: false,
  properties: {
    ref: {
      type: 'number',
      description: '当前快照中输入框对应的数字标号 [ref: N]，例如 2'
    },
    text: {
      type: 'string',
      description: '要填入输入框的文本字符串'
    }
  }
} as unknown as ToolParameters

const PRESS_PARAMETERS = {
  type: 'object',
  required: ['key'],
  additionalProperties: false,
  properties: {
    key: {
      type: 'string',
      description: '要按下的控制按键名称，如 Enter, Tab, Escape, Backspace, ArrowDown, ArrowUp'
    }
  }
} as unknown as ToolParameters

const SCROLL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    deltaY: {
      type: 'number',
      description: '垂直滚动像素值，正数向下，负数向上，默认 300'
    },
    deltaX: {
      type: 'number',
      description: '水平滚动像素值，正数向右，负数向左，默认 0'
    }
  }
} as unknown as ToolParameters

export function registerBrowserTools(pi: ExtensionAPI, operator: SdkBrowserOperator): void {
  pi.registerTool({
    name: 'browser_snapshot',
    description: '获取当前受管内置浏览器页面的结构化无障碍树快照。输出包含当前页面 URL、标题及带 [ref: N] 标号的可交互控件列表。动作前必须先通过本工具获取最新快照引用。',
    parameters: SNAPSHOT_PARAMETERS,
    handler: async () => {
      const result = await operator({ kind: 'snapshot' })
      if (!result.ok) {
        return { content: [{ type: 'text', text: `获取页面快照失败：${result.error}` }] }
      }

      const snapshot = result.data as BrowserSnapshot
      let text = `[页面地址]: ${snapshot.url}\n[页面标题]: ${snapshot.title}\n[可交互元素清单]:\n`

      for (const node of snapshot.nodes) {
        const refStr = node.refId > 0 ? `[ref: ${node.refId}]` : '      '
        const roleStr = node.role
        const nameStr = node.name ? `"${node.name}"` : ''
        const valStr = node.value ? `value="${node.value}"` : ''
        const states: string[] = []
        if (node.disabled) states.push('disabled')
        if (node.focused) states.push('focused')
        if (node.checked === true) states.push('checked')
        if (node.checked === 'mixed') states.push('checked(mixed)')
        const stateStr = states.length > 0 ? ` (${states.join(', ')})` : ''
        text += `  ${refStr} ${roleStr} ${nameStr} ${valStr}${stateStr}\n`
      }

      if (snapshot.hasMore) {
        text += '  ... (页面元素较多，已截断显示前 250 个交互节点)\n'
      }

      return { content: [{ type: 'text', text }] }
    }
  })

  pi.registerTool({
    name: 'browser_get_content',
    description: '提取当前内置浏览器页面的纯文本正文内容。适用于长网页、文档阅读与纯文本分析场景。',
    parameters: CONTENT_PARAMETERS,
    handler: async () => {
      const result = await operator({ kind: 'get-content' })
      if (!result.ok) {
        return { content: [{ type: 'text', text: `提取页面正文失败：${result.error}` }] }
      }

      const content = result.data as BrowserContentResult
      const text = `[页面地址]: ${content.url}\n[页面标题]: ${content.title}\n\n${content.text}`
      return { content: [{ type: 'text', text }] }
    }
  })

  pi.registerTool({
    name: 'browser_navigate',
    description: '在当前绑定的内置浏览器中导航到指定的 URL 地址。',
    parameters: NAVIGATE_PARAMETERS,
    handler: async (rawParams: unknown) => {
      const params = rawParams as { url?: string }
      if (!params || typeof params.url !== 'string') {
        return { content: [{ type: 'text', text: '参数错误：url 必须为字符串。' }] }
      }

      const result = await operator({ kind: 'navigate', url: params.url })
      if (!result.ok) {
        return { content: [{ type: 'text', text: `导航失败：${result.error}` }] }
      }

      const data = result.data as { title: string; url: string }
      return { content: [{ type: 'text', text: `已成功导航到目标页面：${data.title} (${data.url})` }] }
    }
  })

  pi.registerTool({
    name: 'browser_click',
    description: '点击当前页面快照中指定的 [ref: N] 元素。执行前会进行动态视口滚动与盒模型可见性校验。',
    parameters: CLICK_PARAMETERS,
    handler: async (rawParams: unknown) => {
      const params = rawParams as { ref?: number }
      if (!params || typeof params.ref !== 'number') {
        return { content: [{ type: 'text', text: '参数错误：ref 必须为数字标号。' }] }
      }

      const result = await operator({ kind: 'click', refId: params.ref })
      if (!result.ok) {
        const errorMsg = result.error.includes('不存在') || result.error.includes('过期')
          ? `点击失败：元素标号 [ref: ${params.ref}] 已失效或未找到。请先调用 browser_snapshot 获取当前最新页面快照。`
          : `点击失败：${result.error}`
        return { content: [{ type: 'text', text: errorMsg }] }
      }

      const data = result.data as { title: string; url: string }
      return { content: [{ type: 'text', text: `已成功点击 [ref: ${params.ref}]。当前页面：${data.title} (${data.url})` }] }
    }
  })

  pi.registerTool({
    name: 'browser_fill',
    description: '在当前页面快照中指定的输入框 [ref: N] 中清空并输入文本内容。',
    parameters: FILL_PARAMETERS,
    handler: async (rawParams: unknown) => {
      const params = rawParams as { ref?: number; text?: string }
      if (!params || typeof params.ref !== 'number' || typeof params.text !== 'string') {
        return { content: [{ type: 'text', text: '参数错误：必须提供有效的 ref 数字和 text 字符串。' }] }
      }

      const result = await operator({ kind: 'fill', refId: params.ref, text: params.text })
      if (!result.ok) {
        const errorMsg = result.error.includes('不存在') || result.error.includes('过期')
          ? `输入失败：输入框标号 [ref: ${params.ref}] 已失效或未找到。请先调用 browser_snapshot 获取当前最新页面快照。`
          : `输入失败：${result.error}`
        return { content: [{ type: 'text', text: errorMsg }] }
      }

      const data = result.data as { title: string; url: string }
      return { content: [{ type: 'text', text: `已成功在 [ref: ${params.ref}] 中输入文本。当前页面：${data.title} (${data.url})` }] }
    }
  })

  pi.registerTool({
    name: 'browser_press_key',
    description: '向当前浏览器页面派发控制按键（支持 Enter、Tab、Escape、Backspace、ArrowDown 等）。',
    parameters: PRESS_PARAMETERS,
    handler: async (rawParams: unknown) => {
      const params = rawParams as { key?: string }
      if (!params || typeof params.key !== 'string') {
        return { content: [{ type: 'text', text: '参数错误：key 必须为字符串。' }] }
      }

      const result = await operator({ kind: 'press', key: params.key })
      if (!result.ok) {
        return { content: [{ type: 'text', text: `按键派发失败：${result.error}` }] }
      }

      const data = result.data as { title: string; url: string }
      return { content: [{ type: 'text', text: `已成功向页面派发按键 [${params.key}]。当前页面：${data.title} (${data.url})` }] }
    }
  })

  pi.registerTool({
    name: 'browser_scroll',
    description: '在当前页面滚动指定的像素位移。默认向下滚动 300 像素。',
    parameters: SCROLL_PARAMETERS,
    handler: async (rawParams: unknown) => {
      const params = (rawParams ?? {}) as { deltaX?: number; deltaY?: number }
      const deltaX = typeof params.deltaX === 'number' ? params.deltaX : 0
      const deltaY = typeof params.deltaY === 'number' ? params.deltaY : 300

      const result = await operator({ kind: 'scroll', deltaX, deltaY })
      if (!result.ok) {
        return { content: [{ type: 'text', text: `滚动派发失败：${result.error}` }] }
      }

      const data = result.data as { title: string; url: string }
      return { content: [{ type: 'text', text: `已成功在页面派发滚动。当前页面：${data.title} (${data.url})` }] }
    }
  })
}
