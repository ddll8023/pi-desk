/**
 * 按会话保存输入与阅读状态：草稿、待发送附件、粘底与滚动位置，以及未绑定草稿时挑选的目标模型。
 *
 * 待发送消息按标签保存，独立于权威投影；受理后有限核对同步，未确认时保留输入，不自动重发。
 * 恢复期间锁定原目标并记住正式消息是否到达，避免结束运行后把已发送内容重复交回输入。
 * 草稿选中的模型按输入键隔离，不写入全局 settings.json，新会话绑定就绪后才应用并清空。
 * 状态只在内存中保留，不写磁盘；渲染层同一时刻只显示当前会话的那一份，离开会话时写入、
 * 切回时取走，因此切换会话不会把上一个会话的草稿、附件或阅读位置带进下一个会话。
 *
 * 已绑定会话与 `/new` 的独立草稿分别留底；新草稿不随旧实例的关闭状态变化，失败后可再次取回。
 * 未提交的普通空闲与未绑定草稿仍由视图原样带走。附件的 objectUrl 由本模块创建与释放：
 * 应用关闭、状态替换或新草稿所属标签消失时统一释放，视图暂时卸载不使预览失效。
 *
 * 会话键取自前台实例报告的会话身份，并在同一实例暂时失去会话身份（宿主失败、关闭中）时沿用上一次：
 * 否则一次宿主故障就会把用户输入判给另一个会话。跨应用重启保留草稿与图片不在本任务范围内。
 *
 * 另有一条不挂在会话键上的通道：回退与修改重试把原消息文本与附件交回输入区，
 * 它跨越回退新建的会话身份变化，因此只保留一份、由输入区消费一次。
 *
 * 对话折叠分两层：全局开关只决定「非当前轮是否收起」，所有会话共用一份，也不写磁盘；
 * 用户单独开合某一轮属于阅读状态，按会话键分开保存，切会话不串，重启后回到默认视图。
 */
import { defineStore } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'
import type { WatchStopHandle } from 'vue'
import type { ModelIdentity, PromptImageInput, RuntimeTarget } from '../../../../shared/runtime-api'
import { cloneImageAnnotations } from '../../../../shared/image-annotation'
import type { ImageAnnotationDocument } from '../../../../shared/image-annotation'
import { useRuntimeStore } from './runtime'
import { NEW_CHAT_INPUT_PREFIX, useWorkspaceTabsStore } from '../../workspace/stores/workspace-tabs'

/** 图片附件：发送前读取 base64；objectUrl 随输入移交待发送状态，结束时释放，恢复输入时移交而不释放。 */
export interface PendingImage {
  readonly file: File
  readonly objectUrl: string
  readonly annotations?: ImageAnnotationDocument
}

/** 一个会话的输入状态；`images` 随取走交给调用方接管，因此不是只读数组。 */
export interface SessionInput {
  readonly draft: string
  readonly images: PendingImage[]
}

/** 点击发送时固定的本地提交、同步核对与恢复快照；不生成正式投影消息或历史身份。 */
export interface PendingPrompt {
  readonly id: number
  readonly projectPath: string
  readonly tabKey: string
  readonly inputKey: string
  readonly input: SessionInput
  readonly phase: 'starting' | 'sending' | 'accepted' | 'unconfirmed' | 'recovering' | 'cancelled'
  readonly target: RuntimeTarget | null
  readonly sessionId: string | null
  readonly previousUserIds: readonly string[]
  readonly checking: boolean
  readonly notice: string | null
  /** 恢复期间即使原投影被清空，也不能忘记已经观察到的正式消息。 */
  readonly projected: boolean
}

/** 一个会话的阅读状态：粘底时不需要滚动位置，离开底部时按保存的像素位置恢复。 */
export interface SessionReading {
  readonly stickToBottom: boolean
  readonly scrollTop: number
  /** 分页或详情改变高度时优先恢复稳定轮身份与视口内偏移。 */
  readonly anchor?: { readonly turnKey: string; readonly offset: number }
}

/** 会话键前缀；只有这类键的状态需要按会话留底，空闲与未绑定实例的键不带前缀。 */
const SESSION_KEY_PREFIX = 'session:'
/** 受理后只安排一次补读；等待到期只表示结果未确认，不表示输入未执行。 */
const PENDING_SYNC_WAIT_MS = 10_000

/** 该键是否代表一个已绑定会话；空闲与未绑定实例的键不是会话键。 */
export function isSessionKey(key: string): boolean {
  return key.startsWith(SESSION_KEY_PREFIX)
}

/** 已绑定会话与独立新草稿需要保存输入；阅读状态仍只按实际会话保存。 */
export function isSavedInputKey(key: string): boolean {
  return isSessionKey(key) || key.startsWith(NEW_CHAT_INPUT_PREFIX)
}

export const useSessionViewStore = defineStore('session-view', () => {
  const runtime = useRuntimeStore()
  const workspace = useWorkspaceTabsStore()
  /** 当前前台实例最近一次报告的运行身份与会话身份；后者在宿主失败时保留。 */
  const boundRunId = ref<number | null>(null)
  const boundSessionId = ref<string | null>(null)
  /** 会话与独立新草稿的输入留底；阅读状态只按实际会话保存，切回时取走。 */
  const inputs = new Map<string, SessionInput>()
  /** 用户在未绑定或新草稿状态挑选的临时模型；按输入键隔离，不修改全局默认。 */
  const draftModels = ref<Record<string, ModelIdentity>>({})
  /** 当前活动输入上下文选中的草稿模型；未显式选过时为 null。 */
  const currentDraftModel = computed<ModelIdentity | null>(() => draftModels.value[key.value] ?? null)
  const readings = new Map<string, SessionReading>()
  const pendingPrompts = ref<readonly PendingPrompt[]>([])
  let promptSequence = 0
  const pendingSyncTimers = new Map<number, ReturnType<typeof setTimeout>>()
  const pendingSyncCancels = new Map<number, () => void>()
  const pendingPrompt = computed(() => pendingPrompts.value.find(prompt => prompt.tabKey === workspace.activeTab) ?? null)
  /**
   * 由界面动作（回退、修改重试未被受理）交回输入区的待填内容。
   * 它跨越会话身份变化（回退会新建会话），因此不挂在会话键上；输入区消费一次后不再保留。
   */
  const requestedInput = ref<SessionInput | null>(null)
  /**
   * 已加载的早期对话是否整体展开。默认 false：当前轮与上一轮展开，更早轮次收起成摘要，
   * 用户点顶部开关后铺开已加载轮次，缺失详情按可见区域回读。
   */
  const historyExpanded = ref(false)
  /**
   * 用户对单轮的单独开合，按会话键分组：外层是会话，内层是轮标识到展开状态的映射。
   * 读时按会话取，切会话不会把上一个会话的展开选择带进来。
   */
  const turnExpansions = reactive(new Map<string, Map<string, boolean>>())
  let stopRuntimeWatch: WatchStopHandle | null = null
  let stopDraftWatch: WatchStopHandle | null = null
  let stopPendingWatch: WatchStopHandle | null = null

  /** 前台实例报告的会话身份；未就绪或宿主失败时为空。 */
  const reportedSessionId = computed(() => (
    runtime.view.phase === 'ready' ? runtime.view.snapshot.info?.sessionId ?? null : null
  ))

  /**
   * 先同步当前身份，再订阅后续变化；身份必须在视图读取前更新，
   * 因此身份 watch 使用同步 flush，草稿回收则等待输入框完成旧身份留底。
   */
  function initialize(): void {
    if (stopRuntimeWatch !== null) return
    applyIdentity()
    stopRuntimeWatch = watch(() => [runtime.foregroundRunId, reportedSessionId.value] as const, applyIdentity,
      { flush: 'sync' })
    // 等输入框完成旧身份留底后再清理，避免迟到的保存把已关闭标签的附件重新留下。
    stopDraftWatch = watch(() => workspace.newChatInputKeys, keys => {
      for (const [inputKey, input] of inputs) {
        if (!inputKey.startsWith(NEW_CHAT_INPUT_PREFIX) || keys.has(inputKey)) continue
        releaseImages(input.images)
        inputs.delete(inputKey)
      }
      for (const inputKey of Object.keys(draftModels.value)) {
        if (!inputKey.startsWith(NEW_CHAT_INPUT_PREFIX) || keys.has(inputKey)) continue
        clearDraftModel(inputKey)
      }
    }, { flush: 'post' })
    stopPendingWatch = watch(() => [runtime.messages, runtime.view, pendingPrompts.value, workspace.tabs] as const, () => {
      for (const prompt of pendingPrompts.value) {
        if (!workspace.hasChatTabKey(prompt.projectPath, prompt.tabKey)) {
          finishPendingPrompt(prompt.id)
        } else if (hasPendingMessage(prompt)) {
          if (prompt.phase === 'recovering') {
            if (!prompt.projected) updatePendingPrompt(prompt.id, { projected: true })
          } else if (prompt.phase === 'accepted' || prompt.phase === 'unconfirmed') {
            finishPendingPrompt(prompt.id)
          }
        }
      }
    }, { flush: 'post' })
  }

  /** 页面卸载时释放订阅与全部附件预览地址。 */
  function dispose(): void {
    stopRuntimeWatch?.()
    stopRuntimeWatch = null
    stopDraftWatch?.()
    stopDraftWatch = null
    stopPendingWatch?.()
    stopPendingWatch = null
    for (const timer of pendingSyncTimers.values()) clearTimeout(timer)
    pendingSyncTimers.clear()
    for (const cancel of [...pendingSyncCancels.values()]) cancel()
    for (const prompt of pendingPrompts.value) releaseImages(prompt.input.images)
    pendingPrompts.value = []
    for (const input of inputs.values()) releaseImages(input.images)
    inputs.clear()
    draftModels.value = {}
    readings.clear()
    if (requestedInput.value !== null) {
      releaseImages(requestedInput.value.images)
      requestedInput.value = null
    }
  }

  /** 换实例时重置会话身份；同一实例仍报告同一会话时保持，暂时失去会话身份时沿用上一次。 */
  function applyIdentity(): void {
    const runId = runtime.foregroundRunId
    if (runId === null) {
      boundRunId.value = null
      boundSessionId.value = null
      return
    }
    if (runId !== boundRunId.value) {
      boundRunId.value = runId
      boundSessionId.value = reportedSessionId.value
      return
    }
    const sessionId = reportedSessionId.value
    if (sessionId !== null) boundSessionId.value = sessionId
  }

  /** 新建期间以草稿身份隔离旧实例；其余按实际会话、未绑定实例或空闲状态区分。 */
  const key = computed(() => {
    if (workspace.newChatInputKey !== null) return workspace.newChatInputKey
    if (boundRunId.value === null) return 'idle'
    return boundSessionId.value === null ? `run:${boundRunId.value}` : `${SESSION_KEY_PREFIX}${boundSessionId.value}`
  })

  /** 按输入身份取走留底，支持新草稿绑定后的身份映射；调用方接管，不保留副本。 */
  function takeInput(sessionKey: string): SessionInput | null {
    // 输入框可能在首次绑定期间卸载；实际身份建立后仍能取回原位新建时保存的输入。
    const binding = workspace.newChatInputBindings.find(state => state.sessionId !== null
      ? sessionKey === `${SESSION_KEY_PREFIX}${state.sessionId}`
      : state.runId !== null && sessionKey === `run:${state.runId}`)
    const sourceKey = inputs.has(sessionKey) ? sessionKey : binding?.inputKey ?? sessionKey
    const saved = inputs.get(sourceKey)
    if (saved === undefined) return null
    inputs.delete(sourceKey)
    return saved
  }

  /** 按输入身份存回草稿与附件；替换留底时释放旧附件预览地址。 */
  function saveInput(sessionKey: string, input: SessionInput): void {
    const previous = inputs.get(sessionKey)
    if (previous !== undefined) releaseImages(previous.images)
    inputs.set(sessionKey, input)
  }

  /** 同一标签只允许一份在途输入；附件预览的所有权随输入一起从输入框移交。 */
  function beginPendingPrompt(projectPath: string, tabKey: string, inputKey: string, input: SessionInput): PendingPrompt | null {
    if (pendingPrompts.value.some(prompt => prompt.tabKey === tabKey)) return null
    // 标注也必须固定快照，后续编辑不能改变已经点击发送的这份资料。
    const snapshot: SessionInput = { draft: input.draft, images: input.images.map(image => ({ ...image,
      ...(image.annotations === undefined ? {} : { annotations: cloneImageAnnotations(image.annotations) }) })) }
    const prompt: PendingPrompt = { id: ++promptSequence, projectPath, tabKey, inputKey, input: snapshot,
      phase: 'starting', target: null, sessionId: null, previousUserIds: [], checking: false, notice: null, projected: false }
    pendingPrompts.value = [...pendingPrompts.value, prompt]
    return prompt
  }

  function updatePendingPrompt(id: number, update: Partial<Pick<PendingPrompt,
    'phase' | 'input' | 'inputKey' | 'target' | 'sessionId' | 'previousUserIds' | 'checking' | 'notice' | 'projected'>>): void {
    pendingPrompts.value = pendingPrompts.value.map(prompt => prompt.id === id ? { ...prompt, ...update } : prompt)
    if (update.phase === 'accepted' && getPendingPrompt(id) !== null && !pendingSyncTimers.has(id)) {
      pendingSyncTimers.set(id, setTimeout(() => {
        pendingSyncTimers.delete(id)
        void checkPendingPrompt(id)
      }, PENDING_SYNC_WAIT_MS))
    }
  }

  /** 本地待提交输入也占用原标签，不依赖正式消息是否已经写入投影。 */
  function hasPendingPrompt(projectPath: string, tabKey: string): boolean {
    return pendingPrompts.value.some(prompt => prompt.projectPath === projectPath && prompt.tabKey === tabKey)
  }

  /** 只按原有投影身份判断交接，不拿文本比较或伪造的消息 id 去重。 */
  function hasPendingMessage(prompt: PendingPrompt): boolean {
    if (prompt.projected) return true
    const target = prompt.target
    if (target === null || runtime.view.phase !== 'ready'
      || runtime.view.snapshot.runId !== target.runId || runtime.view.snapshot.runtimeId !== target.runtimeId) return false
    const previous = new Set(prompt.previousUserIds)
    return runtime.messages.some(message => message.role === 'user' && !previous.has(message.id))
  }

  function getPendingPrompt(id: number): PendingPrompt | null {
    return pendingPrompts.value.find(prompt => prompt.id === id) ?? null
  }

  /** 只核对原标签正在展示的原绑定，切走后不把其他会话的快照当作提交结果。 */
  function pendingTargetIsCurrent(prompt: PendingPrompt): boolean {
    const view = runtime.view
    return prompt.target !== null && workspace.activeTab === prompt.tabKey
      && workspace.hasChatTabKey(prompt.projectPath, prompt.tabKey) && view.phase === 'ready'
      && view.snapshot.runId === prompt.target.runId && view.snapshot.runtimeId === prompt.target.runtimeId
      && (view.snapshot.info?.sessionId ?? null) === prompt.sessionId
  }

  /** 补读只重同步投影，不再次提交输入；超时或无正式消息都保留为未确认。 */
  async function checkPendingPrompt(id: number): Promise<void> {
    const prompt = getPendingPrompt(id)
    if (prompt === null || prompt.checking || (prompt.phase !== 'accepted' && prompt.phase !== 'unconfirmed')) return
    const timer = pendingSyncTimers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    pendingSyncTimers.delete(id)
    if (hasPendingMessage(prompt)) {
      finishPendingPrompt(id)
      return
    }
    if (!pendingTargetIsCurrent(prompt)) {
      updatePendingPrompt(id, { phase: 'unconfirmed', notice: '原会话未连接或绑定已变化；输入已保留，不会自动重发。' })
      return
    }
    updatePendingPrompt(id, { checking: true, notice: null })
    const completed = await new Promise<boolean>(resolve => {
      let finished = false
      const finish = (value: boolean): void => {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        pendingSyncCancels.delete(id)
        resolve(value)
      }
      const timeout = setTimeout(() => finish(false), PENDING_SYNC_WAIT_MS)
      pendingSyncCancels.set(id, () => finish(false))
      void runtime.syncProjection(prompt.target?.runtimeId ?? undefined).then(() => finish(true), () => finish(false))
    })
    const current = getPendingPrompt(id)
    if (current === null || (current.phase !== 'accepted' && current.phase !== 'unconfirmed')) return
    if (hasPendingMessage(current)) {
      finishPendingPrompt(id)
      return
    }
    const synced = completed && pendingTargetIsCurrent(current) && runtime.projectionSync === 'synced'
    updatePendingPrompt(id, { phase: 'unconfirmed', checking: false, notice: synced
      ? '尚未找到这条正式消息，提交结果未确认；原输入已保留，不会自动重发。'
      : '消息同步未完成，提交结果未确认；可重新同步，或结束原运行后恢复输入。' })
  }

  /** 移除后由调用方接管附件，用于失败恢复而不是释放。 */
  function takePendingPrompt(id: number): PendingPrompt | null {
    const prompt = getPendingPrompt(id)
    const timer = pendingSyncTimers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    pendingSyncTimers.delete(id)
    pendingSyncCancels.get(id)?.()
    pendingPrompts.value = pendingPrompts.value.filter(candidate => candidate.id !== id)
    return prompt
  }

  function finishPendingPrompt(id: number): void {
    const prompt = takePendingPrompt(id)
    if (prompt !== null) releaseImages(prompt.input.images)
  }

  /** 核对批注交付目标的标签、内容与输入身份；仅返回匹配结果，不写入草稿。 */
  function annotationTargetMatches(projectPath: string, tabKey: string, identity: string, inputKey: string): boolean {
    return workspace.activeTab === tabKey && workspace.hasChatTabKey(projectPath, tabKey)
      && workspace.isChatInteractive && workspace.annotationTargetIdentity(projectPath, tabKey) === identity
      && key.value === inputKey
  }

  function getDraftModel(inputKey: string): ModelIdentity | null {
    return draftModels.value[inputKey] ?? null
  }

  function setDraftModel(inputKey: string, model: ModelIdentity | null): void {
    if (model === null) {
      if (draftModels.value[inputKey] !== undefined) {
        const next = { ...draftModels.value }
        delete next[inputKey]
        draftModels.value = next
      }
    } else {
      draftModels.value = { ...draftModels.value, [inputKey]: model }
    }
  }

  function clearDraftModel(inputKey: string): void {
    setDraftModel(inputKey, null)
  }

  /** 后台失败恢复到原输入身份；已有草稿与新附件均保留，不被旧提交覆盖。 */
  function restoreInput(inputKey: string, input: SessionInput): void {
    const current = inputs.get(inputKey)
    inputs.set(inputKey, { draft: [input.draft, current?.draft ?? ''].filter(Boolean).join('\n'),
      images: [...input.images, ...(current?.images ?? [])] })
  }

  /** 取走某个会话的阅读状态；未记录过时为 null，调用方按默认粘底处理。 */
  function takeReading(sessionKey: string): SessionReading | null {
    const saved = readings.get(sessionKey)
    if (saved === undefined) return null
    readings.delete(sessionKey)
    return saved
  }

  function saveReading(sessionKey: string, reading: SessionReading): void {
    readings.set(sessionKey, reading)
  }

  /** 建立一份待发送附件：预览地址与附件条目一起交给调用方，释放也经本模块。 */
  function createImage(file: File, annotations?: ImageAnnotationDocument): PendingImage {
    return { file, objectUrl: URL.createObjectURL(file),
      ...(annotations === undefined ? {} : { annotations: cloneImageAnnotations(annotations) }) }
  }

  /**
   * 交回一份待填输入：附件按 base64 还原成本地文件与预览地址。
   * 同一时刻只保留最后一次请求，被替换的未消费预览在这里释放。
   */
  function requestInput(draft: string, images: readonly PromptImageInput[]): void {
    if (requestedInput.value !== null) releaseImages(requestedInput.value.images)
    requestedInput.value = { draft, images: images.map(toPendingImage) }
  }

  /** 取走待填输入；输入区消费一次后这里不再保留副本。 */
  function consumeRequestedInput(): SessionInput | null {
    const value = requestedInput.value
    requestedInput.value = null
    return value
  }

  /** 切换早期对话的整体展开；改的是全局默认，并清掉当前会话的手动开合，回到一致状态。 */
  function toggleHistoryExpanded(): void {
    historyExpanded.value = !historyExpanded.value
    turnExpansions.delete(key.value)
  }

  /** 某一轮的手动开合；未手动调过时为 null，由全局开关与「是否为最后一轮」决定。 */
  function turnExpansion(sessionKey: string, turnKey: string): boolean | null {
    return turnExpansions.get(sessionKey)?.get(turnKey) ?? null
  }

  /** 记录某一轮的手动开合；同一会话内按轮标识覆盖，不影响其他轮与会话。 */
  function setTurnExpansion(sessionKey: string, turnKey: string, expanded: boolean): void {
    const perSession = turnExpansions.get(sessionKey)
    if (perSession === undefined) turnExpansions.set(sessionKey, new Map([[turnKey, expanded]]))
    else perSession.set(turnKey, expanded)
  }

  /** base64 附件还原为本地文件；名称只用于提示与预览，不保留原始文件名。 */
  function toPendingImage(image: PromptImageInput, index: number): PendingImage {
    const binary = atob(image.data)
    const bytes = new Uint8Array(binary.length)
    for (let offset = 0; offset < binary.length; offset += 1) bytes[offset] = binary.charCodeAt(offset)
    return createImage(new File([bytes], image.name === '' ? `附件${index + 1}` : image.name, { type: image.mimeType }), image.annotations)
  }

  /** 释放附件预览地址；重复释放同一地址没有副作用。 */
  function releaseImages(images: readonly PendingImage[]): void {
    for (const image of images) URL.revokeObjectURL(image.objectUrl)
  }

  return {
    key,
    requestedInput,
    pendingPrompt,
    hasPendingPrompt,
    checkPendingPrompt,
    beginPendingPrompt,
    updatePendingPrompt,
    hasPendingMessage,
    getPendingPrompt,
    takePendingPrompt,
    finishPendingPrompt,
    restoreInput,
    annotationTargetMatches,
    historyExpanded,
    initialize,
    dispose,
    takeInput,
    saveInput,
    takeReading,
    saveReading,
    requestInput,
    consumeRequestedInput,
    toggleHistoryExpanded,
    turnExpansion,
    setTurnExpansion,
    createImage,
    releaseImages,
    draftModels,
    currentDraftModel,
    getDraftModel,
    setDraftModel,
    clearDraftModel
  }
})
