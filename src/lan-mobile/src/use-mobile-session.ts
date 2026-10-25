/** 手机会话状态：独立选择、权威快照与增量、历史缓存和弱网恢复；草稿与未知写请求只留在当前页面内存。 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import {
  isLanHistory, isLanInvalidation, isLanOpenedSession, isLanProjects, isLanSessions, isLanSnapshot,
  isLanRecord, LAN_REMOTE_MAX_MESSAGE_CHARS
} from '../../shared/lan-remote-api'
import type { LanProjectSummary, LanRequest, LanSessionTarget, LanSnapshot } from '../../shared/lan-remote-api'
import { isProjectionBatch, isPromptResult, isRuntimeStatus } from '../../shared/runtime-api'
import type { HistoryQuery, ProjectionMessage, ProjectionSnapshot, RuntimeStatus, ToolExecution } from '../../shared/runtime-api'
import { isExtensionUiSnapshot } from '../../shared/extension-ui-api'
import type { ExtensionDialogResponseInput, ExtensionUiSnapshot } from '../../shared/extension-ui-api'
import type { SessionSummary } from '../../shared/session-api'
import { MAX_SESSION_WINDOW, SESSION_PAGE_SIZE } from '../../shared/session-api'
import { applyProjectionUpdates } from '../../shared/runtime/projection-reducer'
import { createHistoryCache, emptyHistory } from '../../renderer/src/sessions/stores/runtime-history'
import { errorMessage, LanClientError, MobileClient, requiresPairing } from './client'

interface PendingWrite {
  readonly request: LanRequest
  readonly label: string
  readonly sessionKey: string
  readonly project: LanProjectSummary
  readonly session: SessionSummary
  readonly uncertain: boolean
}
export function useMobileSession() {
  const client = new MobileClient()
  const connection = ref<'checking' | 'connected' | 'offline' | 'unpaired' | 'blocked'>('checking')
  const sync = ref<'idle' | 'connecting' | 'synced' | 'retrying' | 'paused'>('idle')
  const projects = shallowRef<readonly LanProjectSummary[]>([])
  const sessions = shallowRef<readonly SessionSummary[]>([])
  const selectedProject = shallowRef<LanProjectSummary | null>(null)
  const selectedSession = shallowRef<SessionSummary | null>(null)
  const target = shallowRef<LanSessionTarget | null>(null)
  const projection = shallowRef<ProjectionSnapshot | null>(null)
  const status = shallowRef<RuntimeStatus | null>(null)
  const interaction = shallowRef<ExtensionUiSnapshot | null>(null)
  const loadingSessions = ref(false)
  const remainingSessions = ref(0)
  const sessionLimit = ref(SESSION_PAGE_SIZE)
  const draft = ref('')
  const error = ref('')
  const notice = ref('')
  const actionBusy = ref(false)
  const pendingWrite = shallowRef<PendingWrite | null>(null)
  const pairBusy = ref(false)
  const pairCode = ref(new URLSearchParams(location.hash.slice(1)).get('code') ?? '')
  const deviceName = ref('我的手机')
  if (location.hash) window.history.replaceState(null, '', `${location.pathname}${location.search}`)
  let alive = true
  let scope = 0
  let recoveringScope: number | null = null
  let listSequence = 0
  let source: EventSource | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let watchdog: ReturnType<typeof setInterval> | null = null
  let retryCount = 0
  let lastEventAt = 0
  let controller = new AbortController()
  const drafts = new Map<string, string>()
  const key = (): string => `${selectedProject.value?.id ?? ''}:${selectedSession.value?.sessionId ?? ''}`
  const historyCache = createHistoryCache({ request: readHistory, conversationKey: key })
  const history = historyCache.state
  const messages = computed<readonly ProjectionMessage[]>(() => {
    const rows = new Map<string, ProjectionMessage>()
    for (const message of [...history.value.pages, ...(projection.value?.messages ?? [])]) rows.set(message.entryId ?? message.id, message)
    return [...rows.values()]
  })
  const tools = computed<readonly ToolExecution[]>(() => projection.value?.tools ?? [])
  const canSend = computed(() => connection.value === 'connected' && sync.value === 'synced' && target.value !== null
    && !actionBusy.value && pendingWrite.value === null && draft.value.trim() !== '' && draft.value.length <= LAN_REMOTE_MAX_MESSAGE_CHARS)
  const isRunning = computed(() => status.value?.info?.isStreaming === true)

  function closeStream(): void { source?.close(); source = null }
  function cancelRetry(): void { if (retry) clearTimeout(retry); retry = null }
  function keepDraft(): void { if (selectedSession.value) drafts.set(key(), draft.value) }
  function resetView(): void {
    keepDraft(); scope += 1; controller.abort(); controller = new AbortController()
    closeStream(); cancelRetry(); target.value = null; projection.value = null; status.value = null; interaction.value = null
    history.value = emptyHistory(); sync.value = 'idle'; error.value = ''; notice.value = ''; retryCount = 0
  }
  function markFailure(failure: unknown): void {
    if (!alive) return
    error.value = errorMessage(failure)
    if (requiresPairing(failure)) {
      connection.value = 'unpaired'; sync.value = 'paused'; closeStream(); cancelRetry()
    } else if (failure instanceof LanClientError && failure.code === 'PROTOCOL_MISMATCH') {
      connection.value = 'blocked'; sync.value = 'paused'; closeStream(); cancelRetry()
    } else {
      connection.value = 'offline'
      if (failure instanceof LanClientError && ['FORBIDDEN', 'TRUST_REQUIRED', 'PAYLOAD_TOO_LARGE', 'REQUEST_LIMIT'].includes(failure.code)) {
        connection.value = 'connected'; sync.value = 'paused'; closeStream(); cancelRetry()
      } else scheduleRetry()
    }
  }
  function scheduleRetry(): void {
    closeStream(); cancelRetry()
    if (!alive || document.hidden || !navigator.onLine || connection.value === 'unpaired' || connection.value === 'blocked') { sync.value = 'paused'; return }
    sync.value = 'retrying'
    const delay = Math.min(10_000, 500 * 2 ** Math.min(retryCount++, 5)) * (0.75 + Math.random() * 0.25)
    retry = setTimeout(() => { retry = null; void recover() }, delay)
  }
  async function loadProjects(): Promise<void> {
    const own = scope
    const result = await client.request(client.prepare({ operation: 'projects' }), isLanProjects, controller.signal)
    if (!alive || own !== scope) return
    projects.value = result.projects
    if (selectedProject.value && !result.projects.some(project => project.id === selectedProject.value?.id)) {
      resetView(); selectedProject.value = null; selectedSession.value = null; sessions.value = []
      notice.value = '当前项目已被移除或不再授权，请选择其他项目。'
    }
  }
  async function loadSessions(more = false): Promise<void> {
    const project = selectedProject.value
    if (!project) return
    const sequence = ++listSequence
    const limit = more ? Math.min(MAX_SESSION_WINDOW, sessionLimit.value + SESSION_PAGE_SIZE) : sessionLimit.value
    loadingSessions.value = true
    try {
      const result = await client.request(client.prepare({ operation: 'sessions', projectId: project.id, limit }), isLanSessions, controller.signal)
      if (!alive || sequence !== listSequence || selectedProject.value?.id !== project.id) return
      if (result.projectId !== project.id) throw new LanClientError('INVALID_RESPONSE', '会话列表目标不匹配。')
      sessions.value = result.sessions; remainingSessions.value = result.remaining; sessionLimit.value = result.limit
    } catch (failure) { if (alive && sequence === listSequence && selectedProject.value?.id === project.id) markFailure(failure) }
    finally { if (alive && sequence === listSequence) loadingSessions.value = false }
  }
  async function readHistory(query: HistoryQuery) {
    const project = selectedProject.value; const session = selectedSession.value
    if (!project || !session) return null
    const own = scope; const revision = history.value.revision
    try {
      const result = await client.request(client.prepare({ operation: 'history', projectId: project.id, sessionId: session.sessionId, query }), isLanHistory, controller.signal)
      if (!alive || own !== scope || revision !== history.value.revision) return null
      if (result.projectId !== project.id || result.sessionId !== session.sessionId) throw new LanClientError('INVALID_RESPONSE', '历史目标不匹配。')
      return result.data
    } catch (failure) {
      if (!alive || own !== scope) return null
      if (failure instanceof LanClientError && failure.code === 'HISTORY_STALE') scheduleRetry()
      if (requiresPairing(failure)) markFailure(failure)
      throw failure
    }
  }
  function applySnapshot(snapshot: LanSnapshot, ref: LanSessionTarget): void {
    if (snapshot.status.runId !== ref.target.runId || snapshot.status.runtimeId !== ref.target.runtimeId
      || snapshot.status.sessionId !== ref.sessionId || snapshot.projection.runtimeId !== ref.target.runtimeId
      || snapshot.projection.runId !== ref.target.runId || snapshot.interaction.runtimeId !== ref.target.runtimeId
      || snapshot.interaction.runId !== ref.target.runId) {
      throw new LanClientError('TARGET_CHANGED', '会话快照身份不匹配，请重新连接。')
    }
    const revision = snapshot.projection.history?.revision ?? 0
    if (projection.value?.runtimeId !== snapshot.projection.runtimeId || history.value.revision !== revision) history.value = emptyHistory()
    history.value.revision = revision
    history.value.before = snapshot.projection.history?.before ?? null
    projection.value = snapshot.projection; status.value = snapshot.status; interaction.value = snapshot.interaction
    sync.value = 'synced'; connection.value = 'connected'; error.value = ''; retryCount = 0
  }
  function subscribe(ref: LanSessionTarget, own: number): void {
    closeStream(); sync.value = 'connecting'; lastEventAt = Date.now()
    const stream = client.stream(ref); source = stream
    const current = (): boolean => alive && own === scope && source === stream
    const receive = (type: string, apply: (value: unknown) => void): void => {
      stream.addEventListener(type, event => {
        if (!current() || !(event instanceof MessageEvent) || typeof event.data !== 'string') return
        lastEventAt = Date.now()
        try { const value: unknown = JSON.parse(event.data); apply(value) } catch (failure) { markFailure(failure) }
      })
    }
    receive('snapshot', value => {
      if (!isLanSnapshot(value)) throw new LanClientError('INVALID_RESPONSE', '会话基准无法识别。')
      applySnapshot(value, ref)
    })
    receive('projection', value => {
      if (!isProjectionBatch(value) || !projection.value || sync.value !== 'synced'
        || value.runId !== ref.target.runId || value.runtimeId !== ref.target.runtimeId || value.resyncRequired) {
        throw new LanClientError('RESYNC_REQUIRED', '会话增量需要重新同步。')
      }
      if (value.seq <= projection.value.seq) return
      if (value.seq !== projection.value.seq + 1) throw new LanClientError('RESYNC_REQUIRED', '会话增量有缺口。')
      const updated = applyProjectionUpdates(projection.value.messages, projection.value.tools, value.updates)
      if (!updated) throw new LanClientError('RESYNC_REQUIRED', '会话正文位置已变化。')
      projection.value = { ...projection.value, ...updated, seq: value.seq }
    })
    receive('status', value => {
      if (!isRuntimeStatus(value) || value.runId !== ref.target.runId || value.runtimeId !== ref.target.runtimeId
        || value.sessionId !== ref.sessionId) throw new LanClientError('TARGET_CHANGED', '会话状态已换代。')
      status.value = value
    })
    receive('interaction', value => {
      if (!isExtensionUiSnapshot(value) || value.runId !== ref.target.runId || value.runtimeId !== ref.target.runtimeId) throw new LanClientError('TARGET_CHANGED', '待处理问题已换代。')
      if (!interaction.value || value.seq > interaction.value.seq) interaction.value = value
    })
    receive('heartbeat', value => {
      if (!isLanRecord(value) || !isRuntimeStatus(value.status) || value.status.runId !== ref.target.runId
        || value.status.runtimeId !== ref.target.runtimeId) throw new LanClientError('TARGET_CHANGED', '会话连接已变化。')
      status.value = value.status
    })
    receive('invalidated', value => {
      if (!isLanInvalidation(value)) throw new LanClientError('INVALID_RESPONSE', '连接中断原因无法识别。')
      throw new LanClientError(value.code, value.message, value.code === 'UNAUTHENTICATED' ? 401 : 409)
    })
    stream.onerror = () => { if (current()) { error.value = '与电脑的实时连接已断开，正在重新同步。'; scheduleRetry() } }
  }
  async function recover(): Promise<void> {
    const own = scope
    if (!alive || recoveringScope === own || document.hidden || !navigator.onLine) return
    recoveringScope = own; cancelRetry(); closeStream(); sync.value = selectedSession.value ? 'connecting' : 'idle'
    try {
      await client.connect(controller.signal)
      if (!alive || own !== scope) return
      connection.value = 'connected'; pairCode.value = ''; error.value = ''
      await loadProjects()
      if (!alive || own !== scope) return
      const project = selectedProject.value; const session = selectedSession.value
      if (!project) { error.value = ''; return }
      if (!session) { await loadSessions(); return }
      if (!projection.value && history.value.pages.length === 0) {
        try {
          const page = await readHistory({ kind: 'page', before: null })
          if (page?.kind === 'page' && own === scope) { history.value.pages = page.messages; history.value.before = page.before }
        } catch (failure) { if (requiresPairing(failure)) throw failure }
      }
      if (!alive || own !== scope) return
      if (document.hidden || !navigator.onLine) { sync.value = 'paused'; return }
      const opened = await client.request(client.prepare({ operation: 'open', projectId: project.id, sessionId: session.sessionId }), isLanOpenedSession, controller.signal)
      if (!alive || own !== scope) return
      if (opened.projectId !== project.id || opened.sessionId !== session.sessionId || opened.target.runtimeId === null) throw new LanClientError('TARGET_CHANGED', '会话尚未就绪，请重新连接。')
      const ref: LanSessionTarget = { projectId: project.id, sessionId: session.sessionId,
        target: { runId: opened.target.runId, runtimeId: opened.target.runtimeId } }
      target.value = ref
      if (document.hidden || !navigator.onLine) { sync.value = 'paused'; return }
      subscribe(ref, own)
    } catch (failure) { if (alive && own === scope) markFailure(failure) }
    finally { if (recoveringScope === own) recoveringScope = null }
  }
  async function pair(): Promise<void> {
    if (pairBusy.value) return
    pairBusy.value = true; error.value = ''
    try {
      await client.pair(pairCode.value.trim(), deviceName.value.trim())
      if (!alive) return
      pairCode.value = ''; connection.value = 'connected'; await recover()
    } catch (failure) {
      if (alive) {
        if (failure instanceof LanClientError && failure.code === 'PROTOCOL_MISMATCH') markFailure(failure)
        else { connection.value = 'unpaired'; error.value = errorMessage(failure) }
      }
    } finally { if (alive) pairBusy.value = false }
  }
  function chooseProject(project: LanProjectSummary): void {
    if (actionBusy.value) return
    resetView(); selectedProject.value = project; selectedSession.value = null; sessions.value = []; sessionLimit.value = SESSION_PAGE_SIZE; remainingSessions.value = 0; draft.value = ''
    void recover()
  }
  function chooseSession(session: SessionSummary): void {
    if (actionBusy.value || !selectedProject.value) return
    resetView(); selectedSession.value = session; draft.value = drafts.get(key()) ?? ''
    void recover()
  }
  function back(): void {
    if (actionBusy.value) return
    const wasSession = selectedSession.value !== null
    resetView(); selectedSession.value = null; draft.value = ''
    if (!wasSession) selectedProject.value = null
    if (selectedProject.value) void recover()
  }
  function acceptPromptData(value: unknown): value is { readonly disposition: 'started' | 'queued' | 'handled' } {
    return isPromptResult({ ok: true, data: value })
  }
  async function sendPending(pending: PendingWrite): Promise<void> {
    if (actionBusy.value) return
    actionBusy.value = true; error.value = ''; notice.value = ''
    try {
      const command = pending.request.command
      if (command.operation === 'prompt') await client.request(pending.request, acceptPromptData)
      else if (command.operation === 'abort') await client.request(pending.request, isRuntimeStatus)
      else if (command.operation === 'respond') await client.request(pending.request, isExtensionUiSnapshot)
      else throw new LanClientError('INVALID_REQUEST', '待确认操作类型无效。')
      if (!alive) return
      if (command.operation === 'prompt' && pending.sessionKey === key() && draft.value === command.message) draft.value = ''
      pendingWrite.value = null
      notice.value = `${pending.sessionKey === key() ? '' : `${pending.project.name} 的原会话：`}${pending.label}已受理，实际进展以会话消息为准。`
    } catch (failure) {
      if (!alive) return
      if (pending.uncertain || (failure instanceof LanClientError && failure.uncertain)) pendingWrite.value = { ...pending, uncertain: true }
      else pendingWrite.value = null
      error.value = errorMessage(failure)
      if (requiresPairing(failure)) markFailure(failure)
    } finally { if (alive) actionBusy.value = false }
  }
  async function act(kind: 'prompt' | 'abort' | 'respond', response?: { dialogId: string; value: ExtensionDialogResponseInput }): Promise<void> {
    const ref = target.value
    const project = selectedProject.value; const session = selectedSession.value
    if (!ref || !project || !session || actionBusy.value || pendingWrite.value || sync.value !== 'synced') return
    const command = kind === 'prompt' ? { operation: 'prompt' as const, ...ref, message: draft.value }
      : kind === 'abort' ? { operation: 'abort' as const, ...ref }
        : response ? { operation: 'respond' as const, ...ref, dialogId: response.dialogId, response: response.value } : null
    if (!command) return
    if (kind === 'prompt' && !canSend.value) return
    try {
      const pending: PendingWrite = { request: client.prepare(command), label: kind === 'prompt' ? '消息' : kind === 'abort' ? '停止请求' : '回答',
        sessionKey: key(), project, session, uncertain: false }
      pendingWrite.value = pending; await sendPending(pending)
    } catch (failure) { error.value = errorMessage(failure) }
  }
  function visitPending(): void {
    const pending = pendingWrite.value
    if (!pending || actionBusy.value) return
    resetView(); selectedProject.value = pending.project; selectedSession.value = pending.session
    sessions.value = []; draft.value = drafts.get(key()) ?? ''
    void recover()
  }
  function acknowledgeUnknown(): void {
    if (actionBusy.value) return
    pendingWrite.value = null; error.value = ''; notice.value = '已解除保护；未重新发送上一条操作。'
  }
  function resume(): void { if (!pairCode.value && connection.value !== 'unpaired' && connection.value !== 'blocked') void recover() }
  function visibility(): void {
    if (document.hidden) { closeStream(); cancelRetry(); sync.value = 'paused' } else resume()
  }
  function offline(): void { closeStream(); cancelRetry(); connection.value = 'offline'; sync.value = 'paused'; error.value = '手机已离线；断开不会中断电脑上的任务。' }
  onMounted(() => {
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('online', resume); window.addEventListener('offline', offline)
    watchdog = setInterval(() => { if (source && !document.hidden && Date.now() - lastEventAt > 45_000) scheduleRetry() }, 5_000)
    if (pairCode.value) connection.value = 'unpaired'
    else if (!navigator.onLine) offline()
    else void recover()
  })
  onBeforeUnmount(() => {
    alive = false; controller.abort(); closeStream(); cancelRetry()
    if (watchdog) clearInterval(watchdog)
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('online', resume); window.removeEventListener('offline', offline)
    pendingWrite.value = null; drafts.clear(); pairCode.value = ''
  })
  return { connection, sync, projects, sessions, selectedProject, selectedSession, projection, status, interaction,
    loadingSessions, remainingSessions, sessionLimit, draft, error, notice, actionBusy, pendingWrite, pairBusy, pairCode, deviceName,
    history, messages, tools, canSend, isRunning, pair, recover, chooseProject, chooseSession, back, loadSessions,
    loadEarlier: historyCache.loadEarlier, loadTurn: historyCache.loadTurn, loadChunk: historyCache.loadChunk,
    setHistoryVisibility: historyCache.setVisibility, sessionKey: key,
    send: () => act('prompt'), stop: () => act('abort'),
    respond: (dialogId: string, value: ExtensionDialogResponseInput) => act('respond', { dialogId, value }),
    retryWrite: () => pendingWrite.value ? sendPending(pendingWrite.value) : Promise.resolve(), acknowledgeUnknown, visitPending }
}
