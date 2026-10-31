/** 手机会话状态：扫码、后台新建与同步，按目标读取命令候选并处理本地新建／受限压缩；草稿与未知写请求仅存页面内存，重连不重放。 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import {
  isLanCommands, isLanCreatedSession, isLanHistory, isLanInvalidation, isLanOpenedSession, isLanProjects, isLanSessions, isLanSnapshot,
  isLanRecord, LAN_REMOTE_MAX_MESSAGE_CHARS
} from '../../shared/lan-remote-api'
import type { LanCommandEntry, LanCreatedSession, LanProjectSummary, LanRequest, LanSessionActiveInfo, LanSessionTarget, LanSnapshot } from '../../shared/lan-remote-api'
import { COMPACT_INSTRUCTIONS_MAX_CHARS, isProjectionBatch, isPromptResult, isRuntimeStatus } from '../../shared/runtime-api'
import type { HistoryQuery, ProjectionMessage, ProjectionSnapshot, RuntimeStatus, ToolExecution } from '../../shared/runtime-api'
import { isExtensionUiSnapshot } from '../../shared/extension-ui-api'
import type { ExtensionDialogResponseInput, ExtensionUiSnapshot } from '../../shared/extension-ui-api'
import type { SessionSummary } from '../../shared/session-api'
import { MAX_SESSION_WINDOW, SESSION_PAGE_SIZE } from '../../shared/session-api'
import { applyProjectionUpdates } from '../../shared/runtime/projection-reducer'
import { createHistoryCache, emptyHistory } from '../../renderer/src/sessions/stores/runtime-history'
import { errorMessage, isUncertainWriteFailure, LanClientError, MobileClient, requiresPairing } from './client'

/** 新建响应已有实际会话身份，但首次写入前未必存在可读取元数据的会话文件。 */
type MobileSession = Pick<SessionSummary, 'sessionId'>

interface PendingWrite {
  readonly request: LanRequest
  readonly label: string
  readonly sessionKey: string
  readonly project: LanProjectSummary
  readonly session: MobileSession | null
  readonly uncertain: boolean
  /** 压缩保留原命令文本，只有本次操作成功且输入未变化时才清空。 */
  readonly inputDraft?: string
}
export function useMobileSession() {
  const client = new MobileClient()
  const connection = ref<'checking' | 'connected' | 'offline' | 'unpaired' | 'blocked'>('checking')
  const sync = ref<'idle' | 'connecting' | 'synced' | 'retrying' | 'paused'>('idle')
  const projects = shallowRef<readonly LanProjectSummary[]>([])
  const sessions = shallowRef<readonly SessionSummary[]>([])
  const activeSessions = shallowRef<readonly LanSessionActiveInfo[]>([])
  const selectedProject = shallowRef<LanProjectSummary | null>(null)
  const selectedSession = shallowRef<MobileSession | null>(null)
  const newSessionDraft = ref(false)
  const target = shallowRef<LanSessionTarget | null>(null)
  const projection = shallowRef<ProjectionSnapshot | null>(null)
  const status = shallowRef<RuntimeStatus | null>(null)
  const interaction = shallowRef<ExtensionUiSnapshot | null>(null)
  const loadingSessions = ref(false)
  const remainingSessions = ref(0)
  const sessionLimit = ref(SESSION_PAGE_SIZE)
  const commands = shallowRef<readonly LanCommandEntry[]>([])
  const commandsLoading = ref(false)
  const commandsError = ref('')
  const commandsTruncated = ref<boolean | null>(null)
  let commandsContext: string | null = null
  let commandsSequence = 0
  const draft = ref('')
  const error = ref('')
  const notice = ref('')
  const actionBusy = ref(false)
  const pendingWrite = shallowRef<PendingWrite | null>(null)
  const pairBusy = ref(false)
  const pairCode = ref(new URLSearchParams(location.hash.slice(1)).get('code') ?? '')
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
  const key = (): string => `${selectedProject.value?.id ?? ''}:${selectedSession.value
    ? `session:${selectedSession.value.sessionId}` : newSessionDraft.value ? 'draft' : 'list'}`
  const historyCache = createHistoryCache({ request: readHistory, conversationKey: key })
  const history = historyCache.state
  const messages = computed<readonly ProjectionMessage[]>(() => {
    const rows = new Map<string, ProjectionMessage>()
    for (const message of [...history.value.pages, ...(projection.value?.messages ?? [])]) rows.set(message.entryId ?? message.id, message)
    return [...rows.values()]
  })
  const tools = computed<readonly ToolExecution[]>(() => projection.value?.tools ?? [])
  const canCreateSession = computed(() => connection.value === 'connected' && selectedProject.value !== null
    && !actionBusy.value && pendingWrite.value === null)
  const canSend = computed(() => connection.value === 'connected'
    && (draft.value.trim() === '/new' || newSessionDraft.value || (sync.value === 'synced' && target.value !== null))
    && !actionBusy.value && pendingWrite.value === null && draft.value.trim() !== '' && draft.value.length <= LAN_REMOTE_MAX_MESSAGE_CHARS)
  const isRunning = computed(() => status.value?.info?.isStreaming === true)

  function closeStream(): void { source?.close(); source = null }
  function cancelRetry(): void { if (retry) clearTimeout(retry); retry = null }
  function keepDraft(): void { if (selectedSession.value || newSessionDraft.value) drafts.set(key(), draft.value) }
  function resetView(): void {
    keepDraft(); scope += 1; listSequence += 1; loadingSessions.value = false; activeSessions.value = []
    commandsSequence += 1; commandsContext = null; commands.value = []; commandsError.value = ''; commandsLoading.value = false; commandsTruncated.value = null
    controller.abort(); controller = new AbortController()
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
  async function loadProjects(silent = false): Promise<void> {
    const own = scope
    try {
      const result = await client.request(client.prepare({ operation: 'projects' }), isLanProjects, controller.signal)
      if (!alive || own !== scope) return
      projects.value = result.projects
      if (selectedProject.value && !result.projects.some(project => project.id === selectedProject.value?.id)) {
        resetView(); selectedProject.value = null; selectedSession.value = null; newSessionDraft.value = false; sessions.value = []
        notice.value = '当前项目已被移除，请选择其他项目。'
      }
    } catch (failure) {
      if (!silent) markFailure(failure)
    }
  }
  async function loadSessions(more = false, silent = false): Promise<void> {
    const project = selectedProject.value
    if (!project) return
    const sequence = ++listSequence
    const limit = more ? Math.min(MAX_SESSION_WINDOW, sessionLimit.value + SESSION_PAGE_SIZE) : sessionLimit.value
    if (!silent) loadingSessions.value = true
    try {
      const result = await client.request(client.prepare({ operation: 'sessions', projectId: project.id, limit }), isLanSessions, controller.signal)
      if (!alive || sequence !== listSequence || selectedProject.value?.id !== project.id) return
      if (result.projectId !== project.id) throw new LanClientError('INVALID_RESPONSE', '会话列表目标不匹配。')
      sessions.value = result.sessions; remainingSessions.value = result.remaining; sessionLimit.value = result.limit
      activeSessions.value = result.activeSessions ?? []
    } catch (failure) {
      if (!silent && alive && sequence === listSequence && selectedProject.value?.id === project.id) markFailure(failure)
    } finally {
      if (!silent && alive && sequence === listSequence) loadingSessions.value = false
    }
  }
  /** 预读只提供技能，绑定后替换为会话实际资源；同一目标不随每个输入字符重复读取。 */
  async function loadCommands(force = false): Promise<void> {
    const project = selectedProject.value
    if (!alive || !project || connection.value !== 'connected' || (!newSessionDraft.value && !selectedSession.value)) return
    const ref = newSessionDraft.value ? null : target.value
    if (!newSessionDraft.value && (!ref || sync.value !== 'synced')) return
    const context = ref ? `${project.id}:${ref.sessionId}:${ref.target.runId}:${ref.target.runtimeId}` : `${project.id}:preview`
    if (!force && commandsContext === context) return
    const own = scope; const sequence = ++commandsSequence
    commandsContext = context; commandsLoading.value = true; commandsError.value = ''; commands.value = []; commandsTruncated.value = null
    try {
      const command = ref ? { operation: 'commands' as const, ...ref }
        : { operation: 'commandPreview' as const, projectId: project.id, force }
      const result = await client.request(client.prepare(command), isLanCommands, controller.signal)
      if (!alive || own !== scope || sequence !== commandsSequence) return
      if (ref && (target.value?.sessionId !== ref.sessionId || target.value.target.runId !== ref.target.runId
        || target.value.target.runtimeId !== ref.target.runtimeId)) return
      if (result.projectId !== project.id || result.sessionId !== (ref?.sessionId ?? null)
        || result.runtimeId !== (ref?.target.runtimeId ?? null)) throw new LanClientError('INVALID_RESPONSE', '命令清单目标不匹配，请刷新候选。')
      commands.value = result.entries; commandsTruncated.value = result.truncated
    } catch (failure) {
      if (!alive || own !== scope || sequence !== commandsSequence) return
      commandsError.value = errorMessage(failure)
      if (requiresPairing(failure)) markFailure(failure)
    } finally { if (alive && own === scope && sequence === commandsSequence) commandsLoading.value = false }
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
      try {
        // 已连接过的浏览器优先复用身份，重复扫码不再登记一台新设备。
        await client.connect(controller.signal)
      } catch (failure) {
        if (!alive || own !== scope) return
        if (!requiresPairing(failure) || !pairCode.value) throw failure
        pairBusy.value = true
        await client.pair(pairCode.value.trim(), controller.signal)
      }
      if (!alive || own !== scope) return
      connection.value = 'connected'; pairCode.value = ''; error.value = ''
      // 成功后再移除链接中的连接码，网络失败时刷新页面仍可继续自动连接。
      if (location.hash) window.history.replaceState(null, '', `${location.pathname}${location.search}`)
      await loadProjects()
      if (!alive || own !== scope) return
      const project = selectedProject.value; const session = selectedSession.value
      if (!project) { error.value = ''; return }
      if (!session) { if (!newSessionDraft.value) await loadSessions(); return }
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
    finally {
      if (recoveringScope === own) { recoveringScope = null; if (alive) pairBusy.value = false }
    }
  }
  function chooseProject(project: LanProjectSummary): void {
    if (actionBusy.value) return
    resetView(); selectedProject.value = project; selectedSession.value = null; newSessionDraft.value = false; sessions.value = []; sessionLimit.value = SESSION_PAGE_SIZE; remainingSessions.value = 0; draft.value = ''
    void recover()
  }
  function chooseSession(session: SessionSummary): void {
    if (actionBusy.value || !selectedProject.value) return
    resetView(); selectedSession.value = session; newSessionDraft.value = false; draft.value = drafts.get(key()) ?? ''
    void recover()
  }
  function startNewSession(): void {
    if (!canCreateSession.value) return
    resetView(); selectedSession.value = null; newSessionDraft.value = true; draft.value = drafts.get(key()) ?? ''
  }
  function back(): void {
    if (actionBusy.value) return
    const wasSession = selectedSession.value !== null || newSessionDraft.value
    resetView(); selectedSession.value = null; newSessionDraft.value = false; draft.value = ''
    if (!wasSession) selectedProject.value = null
    if (selectedProject.value) void recover()
  }
  function acceptPromptData(value: unknown): value is { readonly disposition: 'started' | 'queued' | 'handled' } {
    return isPromptResult({ ok: true, data: value })
  }
  /** 先接管真实会话再继续同步；首条消息被拒绝时保留正文，后续发送不重新创建。 */
  function adoptCreatedSession(pending: PendingWrite, created: LanCreatedSession, message: string): void {
    if (created.projectId !== pending.project.id) throw new LanClientError('INVALID_RESPONSE', '新建结果的项目归属不匹配，请核对原项目中的结果。', 0, true)
    const originalDraft = pending.sessionKey === key() ? draft.value : drafts.get(pending.sessionKey) ?? message
    const alreadyAdopted = pending.session?.sessionId === created.sessionId
    const projectChanged = selectedProject.value?.id !== pending.project.id
    resetView(); selectedProject.value = pending.project; selectedSession.value = { sessionId: created.sessionId }; newSessionDraft.value = false
    drafts.delete(pending.sessionKey)
    draft.value = created.prompt.ok
      ? (originalDraft === message ? '' : originalDraft)
      : alreadyAdopted ? originalDraft : [message, originalDraft === message ? '' : originalDraft].filter(Boolean).join('\n')
    if (projectChanged) { sessions.value = []; sessionLimit.value = SESSION_PAGE_SIZE; remainingSessions.value = 0 }
    const promptFailure = created.prompt.ok ? null : new LanClientError(created.prompt.error.code, created.prompt.error.message, 409)
    const uncertain = isUncertainWriteFailure(promptFailure)
    pendingWrite.value = uncertain ? { ...pending, session: selectedSession.value, sessionKey: key(), uncertain: true } : null
    notice.value = uncertain ? '新会话已创建，但首条消息结果未知。请先核对会话消息；重试原请求不会再次创建会话。'
      : created.prompt.ok ? '新会话已创建，首条消息已受理，实际进展以会话消息为准。'
        : `新会话已创建，但首条消息未受理：${created.prompt.error.message} 输入已保留，重试发送不会重复创建会话。`
    if (created.target.runtimeId === null) {
      sync.value = 'paused'; error.value = '会话运行目标尚未就绪，请重新连接后重试发送。'
      return
    }
    const ref: LanSessionTarget = { projectId: created.projectId, sessionId: created.sessionId,
      target: { runId: created.target.runId, runtimeId: created.target.runtimeId } }
    target.value = ref
    if (document.hidden || !navigator.onLine) { sync.value = 'paused'; return }
    subscribe(ref, scope)
  }
  async function sendPending(pending: PendingWrite): Promise<void> {
    if (actionBusy.value) return
    actionBusy.value = true; error.value = ''; notice.value = ''
    try {
      const command = pending.request.command
      if (command.operation === 'create') {
        const created = await client.request(pending.request, isLanCreatedSession)
        if (alive) adoptCreatedSession(pending, created, command.message)
        return
      }
      if (command.operation === 'prompt') await client.request(pending.request, acceptPromptData)
      else if (command.operation === 'abort' || command.operation === 'compact') await client.request(pending.request, isRuntimeStatus)
      else if (command.operation === 'respond') await client.request(pending.request, isExtensionUiSnapshot)
      else throw new LanClientError('INVALID_REQUEST', '待确认操作类型无效。')
      if (!alive) return
      if (pending.sessionKey === key() && ((command.operation === 'prompt' && draft.value === command.message)
        || (command.operation === 'compact' && draft.value === pending.inputDraft))) draft.value = ''
      pendingWrite.value = null
      notice.value = command.operation === 'compact' ? '压缩操作已结束，结果以会话中的压缩记录为准。'
        : `${pending.sessionKey === key() ? '' : `${pending.project.name} 的原会话：`}${pending.label}已受理，实际进展以会话消息为准。`
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
  async function createSession(): Promise<void> {
    const project = selectedProject.value
    if (!project || !newSessionDraft.value || !canSend.value) return
    try {
      const pending: PendingWrite = { request: client.prepare({ operation: 'create', projectId: project.id, message: draft.value }),
        label: '新建会话', sessionKey: key(), project, session: null, uncertain: false }
      pendingWrite.value = pending; await sendPending(pending)
    } catch (failure) { error.value = errorMessage(failure) }
  }
  /** 界面命令不进入模型消息；手机新建只离开当前展示，不结束可能被桌面使用的原会话。 */
  async function submitInput(): Promise<void> {
    const text = draft.value.trim()
    if (/^\/(?:new|compact)(?:\s|$)/.test(text)) {
      if (actionBusy.value || pendingWrite.value || connection.value !== 'connected') {
        notice.value = '当前操作尚未收敛或连接已中断，命令未执行，输入已保留。'
        return
      }
      if (/^\/new(?:\s|$)/.test(text)) {
        if (text !== '/new') { notice.value = '/new 不接受参数；输入已保留。'; return }
        if (newSessionDraft.value) { draft.value = ''; notice.value = '当前已经是新对话。'; return }
        if (!canCreateSession.value) return
        draft.value = ''; startNewSession(); notice.value = '已进入新对话；原会话及电脑上的任务保持不变。'
        return
      }
      const ref = target.value; const project = selectedProject.value; const session = selectedSession.value
      if (newSessionDraft.value || !ref || !project || !session) {
        notice.value = '压缩需要已有会话上下文；先发送一条消息开始对话。'
        return
      }
      if (sync.value !== 'synced' || isRunning.value || status.value?.info?.isCompacting) {
        notice.value = '当前会话不空闲或尚未同步，压缩未发起；输入已保留。'
        return
      }
      const instructions = text.slice('/compact'.length).trim()
      if (instructions.length > COMPACT_INSTRUCTIONS_MAX_CHARS) {
        notice.value = '压缩说明过长，请缩短后重试；输入已保留。'
        return
      }
      try {
        const pending: PendingWrite = { request: client.prepare({ operation: 'compact', ...ref, instructions: instructions || null }),
          label: '上下文压缩', sessionKey: key(), project, session, uncertain: false, inputDraft: draft.value }
        pendingWrite.value = pending; await sendPending(pending)
      } catch (failure) { error.value = errorMessage(failure) }
      return
    }
    if (newSessionDraft.value) await createSession()
    else await act('prompt')
  }
  function visitPending(): void {
    const pending = pendingWrite.value
    if (!pending || actionBusy.value) return
    resetView(); selectedProject.value = pending.project; selectedSession.value = pending.session; newSessionDraft.value = false
    sessions.value = []; sessionLimit.value = SESSION_PAGE_SIZE; remainingSessions.value = 0; draft.value = drafts.get(key()) ?? ''
    void recover()
  }
  function acknowledgeUnknown(): void {
    if (actionBusy.value) return
    pendingWrite.value = null; error.value = ''; notice.value = '已解除保护；未重新发送上一条操作。'
  }
  let pollTimer: ReturnType<typeof setInterval> | null = null
  function stopPoll(): void {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }
  /** 仅在停留在列表页（项目或会话列表）且页面处于前台可见时静默轮询运行状态，离开列表或切入后台时停止。 */
  function startPoll(): void {
    stopPoll()
    pollTimer = setInterval(() => {
      if (!alive || document.hidden || !navigator.onLine || connection.value !== 'connected' || actionBusy.value) return
      if (selectedSession.value || newSessionDraft.value) return
      if (selectedProject.value) void loadSessions(false, true)
      else void loadProjects(true)
    }, 4_000)
  }
  function resume(): void {
    if ((pairCode.value || connection.value !== 'unpaired') && connection.value !== 'blocked') void recover()
  }
  function visibility(): void {
    if (document.hidden) { closeStream(); cancelRetry(); sync.value = 'paused'; stopPoll() }
    else { resume(); startPoll() }
  }
  function offline(): void { closeStream(); cancelRetry(); stopPoll(); connection.value = 'offline'; sync.value = 'paused'; error.value = '手机已离线；断开不会中断电脑上的任务。' }
  onMounted(() => {
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('online', resume); window.addEventListener('offline', offline)
    watchdog = setInterval(() => { if (source && !document.hidden && Date.now() - lastEventAt > 45_000) scheduleRetry() }, 5_000)
    startPoll()
    if (!navigator.onLine) offline()
    else void recover()
  })
  onBeforeUnmount(() => {
    alive = false; controller.abort(); closeStream(); cancelRetry(); stopPoll()
    if (watchdog) clearInterval(watchdog)
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('online', resume); window.removeEventListener('offline', offline)
    pendingWrite.value = null; drafts.clear(); pairCode.value = ''
  })
  return { connection, sync, projects, sessions, activeSessions, selectedProject, selectedSession, projection, status, interaction,
    loadingSessions, remainingSessions, sessionLimit, draft, error, notice, actionBusy, pendingWrite, pairBusy,
    newSessionDraft, canCreateSession, startNewSession, commands, commandsLoading, commandsError, commandsTruncated, loadCommands,
    history, messages, tools, canSend, isRunning, recover, chooseProject, chooseSession, back, loadSessions,
    loadEarlier: historyCache.loadEarlier, loadTurn: historyCache.loadTurn, loadChunk: historyCache.loadChunk,
    setHistoryVisibility: historyCache.setVisibility, sessionKey: key,
    send: submitInput, stop: () => act('abort'),
    respond: (dialogId: string, value: ExtensionDialogResponseInput) => act('respond', { dialogId, value }),
    retryWrite: () => pendingWrite.value ? sendPending(pendingWrite.value) : Promise.resolve(), acknowledgeUnknown, visitPending }
}
