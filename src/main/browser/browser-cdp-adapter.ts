/**
 * 主进程受管浏览器的 CDP 适配层：封装基于 webContents.debugger 的无障碍快照、正文提取与有限输入派发。
 *
 * 仅在需要观察或交互时按需 attach 调试协议，并在会话解绑或标签销毁时 detach；
 * 捕获 DevTools 竞争等 detach 事件，避免底层抛出未受控异常。
 */

import type { WebContents } from 'electron'
import type {
  BrowserA11yNode,
  BrowserActionResult,
  BrowserContentResult,
  BrowserSnapshot
} from '../../shared/browser-session-api'

/** 常见控制键的虚拟按键映射表。 */
interface KeyDefinition {
  readonly key: string
  readonly code: string
  readonly keyCode: number
}

const COMMON_KEYS: Record<string, KeyDefinition> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Space: { key: ' ', code: 'Space', keyCode: 32 }
}

/** 判定为需要分配操作引用标号的可交互角色。 */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'treeitem'
])

export interface CdpParsedSnapshot {
  readonly snapshot: BrowserSnapshot
  readonly refMap: Map<number, number>
}

export class BrowserCdpAdapter {
  private attached = false
  private detachListener: ((event: unknown, reason: string) => void) | null = null

  constructor(
    private readonly target: WebContents,
    private readonly onDetached?: (reason: string) => void
  ) {}

  /** 确保 CDP 已附加到目标页面。 */
  async ensureAttached(): Promise<boolean> {
    if (this.target.isDestroyed()) return false
    if (this.attached && this.target.debugger.isAttached()) return true

    try {
      this.target.debugger.attach('1.3')
      this.attached = true

      if (!this.detachListener) {
        this.detachListener = (_event: unknown, reason: string): void => {
          this.attached = false
          if (this.onDetached) {
            this.onDetached(reason)
          }
        }
        this.target.debugger.on('detach', this.detachListener)
      }
      return true
    } catch (error) {
      this.attached = false
      return false
    }
  }

  /** 主动脱离调试连接。 */
  detach(): void {
    if (!this.target.isDestroyed() && this.target.debugger.isAttached()) {
      try {
        this.target.debugger.detach()
      } catch {
        // 静默处理脱离异常
      }
    }
    this.attached = false
  }

  /** 获取当前连接状态。 */
  get isConnected(): boolean {
    return !this.target.isDestroyed() && this.attached && this.target.debugger.isAttached()
  }

  /** 提取页面的紧凑无障碍树快照，并分配 [refId -> backendNodeId] 映射。 */
  async captureA11ySnapshot(instanceId: string): Promise<CdpParsedSnapshot | null> {
    const ready = await this.ensureAttached()
    if (!ready) return null

    try {
      const response = await this.target.debugger.sendCommand('Accessibility.getFullAXTree') as {
        nodes?: Array<{
          nodeId: string
          backendDOMNodeId?: number
          role?: { value?: string }
          name?: { value?: string }
          value?: { value?: string }
          description?: { value?: string }
          properties?: Array<{ name: string; value?: { value?: unknown } }>
        }>
      }

      const rawNodes = response.nodes ?? []
      const refMap = new Map<number, number>()
      const a11yNodes: BrowserA11yNode[] = []
      let refSeed = 0
      const MAX_INTERACTIVE_NODES = 250
      let hasMore = false

      for (const node of rawNodes) {
        const role = node.role?.value ?? ''
        const name = (node.name?.value ?? '').trim()
        const value = node.value?.value ? String(node.value.value).trim() : undefined
        const description = node.description?.value ? String(node.description.value).trim() : undefined
        const backendNodeId = node.backendDOMNodeId

        // 仅收录具备语义或交互价值的节点
        const isInteractive = INTERACTIVE_ROLES.has(role)
        const hasText = name.length > 0 || (value !== undefined && value.length > 0)
        if (!isInteractive && !hasText) continue

        let disabled: boolean | undefined
        let focused: boolean | undefined
        let checked: boolean | 'mixed' | undefined

        if (Array.isArray(node.properties)) {
          for (const prop of node.properties) {
            if (prop.name === 'disabled') disabled = Boolean(prop.value?.value)
            if (prop.name === 'focused') focused = Boolean(prop.value?.value)
            if (prop.name === 'checked') {
              const val = prop.value?.value
              if (val === 'mixed') checked = 'mixed'
              else checked = Boolean(val)
            }
          }
        }

        let refId = 0
        if (backendNodeId && backendNodeId > 0 && isInteractive) {
          if (refSeed < MAX_INTERACTIVE_NODES) {
            refSeed++
            refId = refSeed
            refMap.set(refId, backendNodeId)
          } else {
            hasMore = true
            continue
          }
        }

        const a11yNode: BrowserA11yNode = {
          refId,
          role,
          name,
          ...(value !== undefined ? { value } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(disabled !== undefined ? { disabled } : {}),
          ...(focused !== undefined ? { focused } : {}),
          ...(checked !== undefined ? { checked } : {})
        }
        a11yNodes.push(a11yNode)
      }

      const snapshotId = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      const snapshot: BrowserSnapshot = {
        snapshotId,
        instanceId,
        url: this.target.getURL(),
        title: this.target.getTitle(),
        nodes: a11yNodes,
        hasMore,
        capturedAt: Date.now()
      }

      return { snapshot, refMap }
    } catch {
      return null
    }
  }

  /** 提取当前页面的纯文本正文。 */
  async extractContent(): Promise<BrowserContentResult> {
    if (this.target.isDestroyed()) {
      return { ok: false, error: '页面已销毁。' }
    }

    try {
      const text = await this.target.executeJavaScript('document.body ? document.body.innerText : ""')
      return {
        ok: true,
        text: typeof text === 'string' ? text : '',
        title: this.target.getTitle(),
        url: this.target.getURL()
      }
    } catch (error) {
      return { ok: false, error: `正文提取失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** 获取元素的实时中心坐标（并在视口外时自动滚动到可视区域）。 */
  private async resolveNodeCenter(backendNodeId: number): Promise<{ x: number; y: number } | null> {
    const ready = await this.ensureAttached()
    if (!ready) return null

    try {
      // 滚动至可视区域
      await this.target.debugger.sendCommand('DOM.scrollIntoViewIfNeeded', { backendNodeId })
      // 读取最新的盒模型边界
      const boxResult = await this.target.debugger.sendCommand('DOM.getBoxModel', { backendNodeId }) as {
        model?: { border?: number[]; width?: number; height?: number }
      }

      const border = boxResult.model?.border
      if (!Array.isArray(border) || border.length < 8) return null

      const [x0, y0, x1, y1, x2, y2, x3, y3] = border
      if (
        x0 === undefined || y0 === undefined ||
        x1 === undefined || y1 === undefined ||
        x2 === undefined || y2 === undefined ||
        x3 === undefined || y3 === undefined
      ) {
        return null
      }

      // 取四角多边形的几何中心点
      const x = (x0 + x1 + x2 + x3) / 4
      const y = (y0 + y1 + y2 + y3) / 4

      return { x: Math.round(x), y: Math.round(y) }
    } catch {
      return null
    }
  }

  /** 派发点击动作。 */
  async clickNode(backendNodeId: number): Promise<BrowserActionResult> {
    const center = await this.resolveNodeCenter(backendNodeId)
    if (!center) {
      return { ok: false, error: '元素在当前页面不可见或无法定位几何位置。' }
    }

    try {
      await this.target.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: center.x,
        y: center.y,
        button: 'left',
        clickCount: 1
      })
      await this.target.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: center.x,
        y: center.y,
        button: 'left',
        clickCount: 1
      })

      return {
        ok: true,
        dispatched: true,
        url: this.target.getURL(),
        title: this.target.getTitle()
      }
    } catch (error) {
      return { ok: false, error: `点击派发失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** 派发文本填充动作。 */
  async fillNode(backendNodeId: number, text: string): Promise<BrowserActionResult> {
    const center = await this.resolveNodeCenter(backendNodeId)
    if (!center) {
      return { ok: false, error: '输入框在当前页面不可见或无法定位。' }
    }

    try {
      // 先点击获取焦点
      await this.clickNode(backendNodeId)

      // 全选已有文本并删除清空（macOS 使用 Meta+A，其他系统使用 Ctrl+A）
      const selectAllModifiers = process.platform === 'darwin' ? 4 : 2
      await this.target.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        modifiers: selectAllModifiers
      })
      await this.target.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        modifiers: selectAllModifiers
      })
      await this.pressKey('Backspace')

      // 逐字符派发字符事件
      for (let i = 0; i < text.length; i++) {
        const char = text[i]
        await this.target.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'char',
          text: char
        })
      }

      return {
        ok: true,
        dispatched: true,
        url: this.target.getURL(),
        title: this.target.getTitle()
      }
    } catch (error) {
      return { ok: false, error: `输入派发失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** 派发按键。 */
  async pressKey(keyName: string): Promise<BrowserActionResult> {
    const ready = await this.ensureAttached()
    if (!ready) return { ok: false, error: 'CDP 调试通道未连接。', detached: true }

    const keyDef = COMMON_KEYS[keyName] ?? {
      key: keyName,
      code: keyName,
      keyCode: 0
    }

    try {
      await this.target.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: keyDef.key,
        code: keyDef.code,
        windowsVirtualKeyCode: keyDef.keyCode
      })
      await this.target.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: keyDef.key,
        code: keyDef.code,
        windowsVirtualKeyCode: keyDef.keyCode
      })

      return {
        ok: true,
        dispatched: true,
        url: this.target.getURL(),
        title: this.target.getTitle()
      }
    } catch (error) {
      return { ok: false, error: `按键派发失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** 派发滚轮滚动。 */
  async scroll(deltaX = 0, deltaY = 300): Promise<BrowserActionResult> {
    const ready = await this.ensureAttached()
    if (!ready) return { ok: false, error: 'CDP 调试通道未连接。', detached: true }

    try {
      await this.target.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: 200,
        y: 200,
        deltaX,
        deltaY
      })

      return {
        ok: true,
        dispatched: true,
        url: this.target.getURL(),
        title: this.target.getTitle()
      }
    } catch (error) {
      return { ok: false, error: `滚动派发失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
}
