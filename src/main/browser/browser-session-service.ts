/**
 * 主进程受管浏览器会话服务：统一管理 webview 实例登记、项目分区归属、会话独占绑定与接管状态机。
 *
 * 作为浏览器自动操控的权威状态持有者，不依赖 renderer 页面脚本做授权判定；
 * webview 销毁、主窗口失效或会话代际过期时自动收拢控制权。
 */

import { webContents } from 'electron'
import type { WebContents } from 'electron'
import { normalizeBrowserUrl } from '../../shared/browser-api'
import {
  extractOrigin,
  getProjectBrowserPartition
} from '../../shared/browser-session-api'
import type {
  BrowserActionRequest,
  BrowserActionResult,
  BrowserBindRequest,
  BrowserBindResult,
  BrowserContentResult,
  BrowserControlPhase,
  BrowserControlState,
  BrowserInstanceRecord,
  BrowserInstanceRegistration,
  BrowserOperationResult,
  BrowserRegisterResult,
  BrowserSnapshotResult
} from '../../shared/browser-session-api'
import { BrowserCdpAdapter } from './browser-cdp-adapter'

export class BrowserSessionService {
  /** 实例标识 -> 实例元数据记录。 */
  private readonly instances = new Map<string, BrowserInstanceRecord>()
  /** webContentsId -> 实例标识反查索引。 */
  private readonly webContentsIndex = new Map<number, string>()
  /** 实例标识 -> 独占控制权与租约状态。 */
  private readonly controlStates = new Map<string, BrowserControlState>()
  /** 实例标识 -> CDP 协议适配器。 */
  private readonly cdpAdapters = new Map<string, BrowserCdpAdapter>()
  /** 实例标识 -> 当前生效快照的短生命周期引用映射。 */
  private readonly activeSnapshots = new Map<string, { snapshotId: string; refMap: Map<number, number> }>()
  /** 已绑定的事件清理回调。 */
  private readonly cleanupListeners = new Map<number, () => void>()

  /** 登记受管 webview 实例；校验调用者必须为主窗口且 target 必须为所属 webview。 */
  registerInstance(
    registration: BrowserInstanceRegistration,
    hostWebContents: WebContents
  ): BrowserRegisterResult {
    const target = webContents.fromId(registration.webContentsId)
    if (!target || target.isDestroyed()) {
      return { ok: false, error: '指定的浏览器页面不存在或已被销毁。' }
    }
    if (target.getType() !== 'webview' || target.hostWebContents !== hostWebContents) {
      return { ok: false, error: '无法登记非当前可信窗口宿主的 webview 页面。' }
    }

    const partition = getProjectBrowserPartition(registration.projectPath)
    const now = Date.now()
    const existing = this.instances.get(registration.instanceId)

    const record: BrowserInstanceRecord = {
      instanceId: registration.instanceId,
      projectPath: registration.projectPath,
      partition,
      webContentsId: registration.webContentsId,
      url: registration.url,
      title: registration.title,
      status: 'ready',
      registeredAt: existing ? existing.registeredAt : now,
      updatedAt: now
    }

    this.instances.set(registration.instanceId, record)
    this.webContentsIndex.set(registration.webContentsId, registration.instanceId)

    // 若此前没有控制权状态，初始化为未绑定状态
    if (!this.controlStates.has(registration.instanceId)) {
      this.controlStates.set(registration.instanceId, {
        instanceId: registration.instanceId,
        sessionId: null,
        runId: null,
        generation: null,
        phase: 'unbound',
        allowedOrigin: null,
        pausedReason: null,
        attachedAt: null,
        updatedAt: now
      })
    }

    this.attachTargetLifecycle(target, registration.instanceId)
    return { ok: true, record }
  }

  /** 注销受管实例；释放其占有的会话独占租约并清空事件监听与调试连接。 */
  unregisterInstance(instanceId: string): BrowserOperationResult {
    const record = this.instances.get(instanceId)
    if (!record) return { ok: true }

    this.releaseControlState(instanceId)
    const adapter = this.cdpAdapters.get(instanceId)
    if (adapter) {
      adapter.detach()
      this.cdpAdapters.delete(instanceId)
    }
    this.activeSnapshots.delete(instanceId)

    const cleanup = this.cleanupListeners.get(record.webContentsId)
    if (cleanup) {
      cleanup()
      this.cleanupListeners.delete(record.webContentsId)
    }

    this.webContentsIndex.delete(record.webContentsId)
    this.instances.delete(instanceId)
    return { ok: true }
  }

  /** 会话申请独占绑定控制权。 */
  bindSession(request: BrowserBindRequest): BrowserBindResult {
    const record = this.instances.get(request.instanceId)
    if (!record || record.status === 'destroyed') {
      return { ok: false, error: '申请绑定的浏览器实例不存在或已销毁。' }
    }

    const current = this.controlStates.get(request.instanceId)
    if (current && current.phase !== 'unbound' && current.sessionId !== null && current.sessionId !== request.sessionId) {
      return { ok: false, error: `该浏览器当前正被会话 ${current.sessionId} 控制，禁止并发绑定。` }
    }

    const origin = request.initialAllowedOrigin ?? extractOrigin(record.url)
    const now = Date.now()
    const nextState: BrowserControlState = {
      instanceId: request.instanceId,
      sessionId: request.sessionId,
      runId: request.runId,
      generation: request.generation,
      phase: 'attached',
      allowedOrigin: origin,
      pausedReason: null,
      attachedAt: now,
      updatedAt: now
    }

    this.controlStates.set(request.instanceId, nextState)
    return { ok: true, state: nextState }
  }

  /** 释放会话对该浏览器的独占绑定。 */
  releaseSession(instanceId: string, sessionId: string): BrowserOperationResult {
    const current = this.controlStates.get(instanceId)
    if (!current) return { ok: true }
    if (current.sessionId && current.sessionId !== sessionId) {
      return { ok: false, error: '无权释放其他会话持有的浏览器控制权。' }
    }

    this.releaseControlState(instanceId)
    const adapter = this.cdpAdapters.get(instanceId)
    if (adapter) {
      adapter.detach()
      this.cdpAdapters.delete(instanceId)
    }
    this.activeSnapshots.delete(instanceId)
    return { ok: true }
  }

  /** 用户手动接管；立即将状态置为 takeover，排空后续动作并作废快照引用。 */
  takeover(instanceId: string, reason?: string): BrowserOperationResult {
    const current = this.controlStates.get(instanceId)
    if (!current) return { ok: false, error: '实例不存在。' }

    this.activeSnapshots.delete(instanceId)
    const now = Date.now()
    this.controlStates.set(instanceId, {
      ...current,
      phase: 'takeover',
      pausedReason: reason ?? '用户手动接管',
      updatedAt: now
    })
    return { ok: true }
  }

  /** 恢复控制；仅在用户明确重连且授权仍然有效时生效。 */
  resume(instanceId: string): BrowserOperationResult {
    const current = this.controlStates.get(instanceId)
    if (!current) return { ok: false, error: '实例不存在。' }
    if (current.phase !== 'takeover' && current.phase !== 'paused') {
      return { ok: true }
    }

    const now = Date.now()
    this.controlStates.set(instanceId, {
      ...current,
      phase: current.sessionId ? 'attached' : 'unbound',
      pausedReason: null,
      updatedAt: now
    })
    return { ok: true }
  }

  /** 获取指定实例的控制状态。 */
  queryControlState(instanceId: string): BrowserControlState | null {
    return this.controlStates.get(instanceId) ?? null
  }

  /** 获取指定实例的元数据记录。 */
  getInstanceRecord(instanceId: string): BrowserInstanceRecord | null {
    return this.instances.get(instanceId) ?? null
  }

  /** 根据会话运行身份与代际检索其绑定的受管浏览器实例。 */
  findBoundInstanceForSession(sessionId: string, runId: number, generation: number): BrowserInstanceRecord | null {
    for (const [instanceId, control] of this.controlStates.entries()) {
      if (control.sessionId === sessionId && control.runId === runId && control.generation === generation
        && control.phase !== 'unbound') {
        const record = this.instances.get(instanceId)
        if (record && record.status !== 'destroyed') {
          return record
        }
      }
    }
    return null
  }

  /** 在当前绑定的浏览器实例中导航到指定 URL。 */
  async navigate(instanceId: string, rawUrl: string): Promise<BrowserActionResult> {
    const record = this.instances.get(instanceId)
    if (!record || record.status === 'destroyed') {
      return { ok: false, error: '浏览器实例不存在或已关闭。' }
    }

    const control = this.controlStates.get(instanceId)
    if (control && (control.phase === 'takeover' || control.phase === 'paused')) {
      return { ok: false, error: `当前页面处于挂起状态 (${control.pausedReason ?? control.phase})，拒绝导航。` }
    }

    const target = webContents.fromId(record.webContentsId)
    if (!target || target.isDestroyed()) {
      return { ok: false, error: '浏览器底层页面已被销毁。' }
    }

    const normalized = normalizeBrowserUrl(rawUrl)
    try {
      await target.loadURL(normalized)
      await new Promise((resolve) => setTimeout(resolve, 100))
      const currentUrl = target.getURL()
      const currentTitle = target.getTitle()
      this.instances.set(instanceId, { ...record, url: currentUrl, title: currentTitle, updatedAt: Date.now() })
      return {
        ok: true,
        dispatched: true,
        url: currentUrl,
        title: currentTitle
      }
    } catch (error) {
      return { ok: false, error: `导航失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** 获取页面的紧凑结构化无障碍树快照。 */
  async takeSnapshot(instanceId: string): Promise<BrowserSnapshotResult> {
    const record = this.instances.get(instanceId)
    if (!record || record.status === 'destroyed') {
      return { ok: false, error: '浏览器实例不存在或已关闭。' }
    }

    const control = this.controlStates.get(instanceId)
    if (control && (control.phase === 'takeover' || control.phase === 'paused')) {
      return { ok: false, error: `当前页面处于挂起状态 (${control.pausedReason ?? control.phase})，无法生成快照。` }
    }

    const target = webContents.fromId(record.webContentsId)
    if (!target || target.isDestroyed()) {
      return { ok: false, error: '浏览器底层页面已被销毁。' }
    }

    const adapter = this.getOrInitCdpAdapter(instanceId, target)
    const result = await adapter.captureA11ySnapshot(instanceId)
    if (!result) {
      return { ok: false, error: '提取无障碍树快照失败，可能调试连接被抢占或页面不支持。' }
    }

    this.activeSnapshots.set(instanceId, {
      snapshotId: result.snapshot.snapshotId,
      refMap: result.refMap
    })

    return { ok: true, snapshot: result.snapshot }
  }

  /** 获取当前页面的纯文本正文。 */
  async getContent(instanceId: string): Promise<BrowserContentResult> {
    const record = this.instances.get(instanceId)
    if (!record || record.status === 'destroyed') {
      return { ok: false, error: '浏览器实例不存在或已关闭。' }
    }

    const target = webContents.fromId(record.webContentsId)
    if (!target || target.isDestroyed()) {
      return { ok: false, error: '浏览器底层页面已被销毁。' }
    }

    const adapter = this.getOrInitCdpAdapter(instanceId, target)
    return adapter.extractContent()
  }

  /** 派发有限交互动作。 */
  async dispatchAction(request: BrowserActionRequest): Promise<BrowserActionResult> {
    const record = this.instances.get(request.instanceId)
    if (!record || record.status === 'destroyed') {
      return { ok: false, error: '浏览器实例不存在或已关闭。' }
    }

    const control = this.controlStates.get(request.instanceId)
    if (control && (control.phase === 'takeover' || control.phase === 'paused')) {
      return { ok: false, error: `当前页面处于挂起状态 (${control.pausedReason ?? control.phase})，拒绝派发交互动作。` }
    }

    const target = webContents.fromId(record.webContentsId)
    if (!target || target.isDestroyed()) {
      return { ok: false, error: '浏览器底层页面已被销毁。' }
    }

    const adapter = this.getOrInitCdpAdapter(request.instanceId, target)
    if (!adapter.isConnected) {
      const ready = await adapter.ensureAttached()
      if (!ready) {
        return { ok: false, error: '无法附着 CDP 调试协议，可能开发者工具正在占用连接。', detached: true }
      }
    }

    // 将状态置为 running
    if (control && control.phase === 'attached') {
      this.controlStates.set(request.instanceId, { ...control, phase: 'running', updatedAt: Date.now() })
    }

    let actionResult: BrowserActionResult
    if (request.type === 'click' || request.type === 'fill') {
      const activeSnapshot = this.activeSnapshots.get(request.instanceId)
      if (!activeSnapshot) {
        return { ok: false, error: '未找到当前生效的快照或页面已刷新，请先获取页面快照。', refNotFound: true }
      }

      const backendNodeId = activeSnapshot.refMap.get(request.refId)
      if (!backendNodeId) {
        return { ok: false, error: `元素引用标号 [ref: ${request.refId}] 在当前快照中不存在，请重新生成快照。`, refNotFound: true }
      }

      if (request.type === 'click') {
        actionResult = await adapter.clickNode(backendNodeId)
      } else {
        actionResult = await adapter.fillNode(backendNodeId, request.text)
      }
    } else if (request.type === 'press') {
      actionResult = await adapter.pressKey(request.key)
    } else if (request.type === 'scroll') {
      actionResult = await adapter.scroll(request.deltaX, request.deltaY)
    } else {
      actionResult = { ok: false, error: '不支持的动作类型。' }
    }

    // 动作执行后让出 100ms 观察可能的导航或 DOM 变化
    await new Promise((resolve) => setTimeout(resolve, 100))

    if (actionResult.ok) {
      const currentUrl = target.getURL()
      const currentTitle = target.getTitle()
      this.instances.set(request.instanceId, { ...record, url: currentUrl, title: currentTitle, updatedAt: Date.now() })
      actionResult = {
        ok: true,
        dispatched: true,
        url: currentUrl,
        title: currentTitle
      }
    }

    // 动作收尾后若仍为 running，切回 attached
    const latestControl = this.controlStates.get(request.instanceId)
    if (latestControl && latestControl.phase === 'running') {
      this.controlStates.set(request.instanceId, { ...latestControl, phase: 'attached', updatedAt: Date.now() })
    }

    return actionResult
  }

  /** 获取或初始化对应实例的 CDP 适配器。 */
  private getOrInitCdpAdapter(instanceId: string, target: WebContents): BrowserCdpAdapter {
    let adapter = this.cdpAdapters.get(instanceId)
    if (!adapter) {
      adapter = new BrowserCdpAdapter(target, (reason) => {
        const control = this.controlStates.get(instanceId)
        if (control && control.phase !== 'takeover') {
          this.controlStates.set(instanceId, {
            ...control,
            phase: 'paused',
            pausedReason: `调试连接断开 (${reason})，可能是由于手动打开了开发者工具`,
            updatedAt: Date.now()
          })
        }
      })
      this.cdpAdapters.set(instanceId, adapter)
    }
    return adapter
  }

  /** 根据 webContentsId 检索受管实例元数据。 */
  findInstanceByWebContentsId(webContentsId: number): BrowserInstanceRecord | null {
    const instanceId = this.webContentsIndex.get(webContentsId)
    if (!instanceId) return null
    return this.instances.get(instanceId) ?? null
  }

  /** 清除实例绑定的控制权，恢复为初始 unbound 状态。 */
  private releaseControlState(instanceId: string): void {
    const current = this.controlStates.get(instanceId)
    if (!current) return
    this.controlStates.set(instanceId, {
      instanceId,
      sessionId: null,
      runId: null,
      generation: null,
      phase: 'unbound',
      allowedOrigin: null,
      pausedReason: null,
      attachedAt: null,
      updatedAt: Date.now()
    })
  }

  /** 监听 webview 原生导航与销毁生命周期。 */
  private attachTargetLifecycle(target: WebContents, instanceId: string): void {
    const existingCleanup = this.cleanupListeners.get(target.id)
    if (existingCleanup) existingCleanup()

    const onNavigate = (_event: unknown, url: string): void => {
      // 导航时作废当前生效快照
      this.activeSnapshots.delete(instanceId)
      const record = this.instances.get(instanceId)
      if (!record) return
      const now = Date.now()
      this.instances.set(instanceId, { ...record, url, updatedAt: now })

      // 若处于运行或已绑定状态，检测是否跨源跳转
      const control = this.controlStates.get(instanceId)
      if (control && (control.phase === 'running' || control.phase === 'attached') && control.allowedOrigin) {
        const nextOrigin = extractOrigin(url)
        if (nextOrigin && nextOrigin !== control.allowedOrigin) {
          this.controlStates.set(instanceId, {
            ...control,
            phase: 'paused',
            pausedReason: `页面跳转至跨源站点 (${nextOrigin})，已自动挂起等待人工扩权`,
            updatedAt: now
          })
        }
      }
    }

    const onDestroyed = (): void => {
      const record = this.instances.get(instanceId)
      if (record) {
        this.instances.set(instanceId, { ...record, status: 'destroyed', updatedAt: Date.now() })
      }
      this.releaseControlState(instanceId)
    }

    target.on('did-navigate', onNavigate)
    target.on('did-navigate-in-page', onNavigate)
    target.once('destroyed', onDestroyed)
    target.once('render-process-gone', onDestroyed)

    this.cleanupListeners.set(target.id, () => {
      if (!target.isDestroyed()) {
        target.removeListener('did-navigate', onNavigate)
        target.removeListener('did-navigate-in-page', onNavigate)
        target.removeListener('destroyed', onDestroyed)
        target.removeListener('render-process-gone', onDestroyed)
      }
    })
  }
}
