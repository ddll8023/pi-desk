/**
 * 按会话保存输入与阅读状态：草稿、待发送附件、粘底与滚动位置。
 *
 * 状态只在内存中保留，不写磁盘；渲染层同一时刻只显示当前会话的那一份，离开会话时写入、
 * 切回时取走，因此切换会话不会把上一个会话的草稿、附件或阅读位置带进下一个会话。
 *
 * 只登记已绑定会话的状态：空闲与未绑定实例没有独立历史，它们的输入与阅读状态由视图原样带走，
 * 不需要单独留底。附件的 objectUrl 由本模块创建与释放：视图卸载不释放，避免切到设置页或切换
 * 会话时预览失效；应用关闭或状态被替换时统一释放。
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
import type { PromptImageInput } from '../../../shared/runtime-api'
import { useRuntimeStore } from './runtime'

/** 待发送的图片附件：objectUrl 只用于本地预览，发送时读取 base64 并释放。 */
export interface PendingImage {
  readonly file: File
  readonly objectUrl: string
}

/** 一个会话的输入状态；`images` 随取走交给调用方接管，因此不是只读数组。 */
export interface SessionInput {
  readonly draft: string
  readonly images: PendingImage[]
}

/** 一个会话的阅读状态：粘底时不需要滚动位置，离开底部时按保存的像素位置恢复。 */
export interface SessionReading {
  readonly stickToBottom: boolean
  readonly scrollTop: number
}

/** 会话键前缀；只有这类键的状态需要按会话留底，空闲与未绑定实例的键不带前缀。 */
const SESSION_KEY_PREFIX = 'session:'

/** 该键是否代表一个已绑定会话；空闲与未绑定实例的键不是会话键。 */
export function isSessionKey(key: string): boolean {
  return key.startsWith(SESSION_KEY_PREFIX)
}

export const useSessionViewStore = defineStore('session-view', () => {
  const runtime = useRuntimeStore()
  /** 当前前台实例最近一次报告的运行身份与会话身份；后者在宿主失败时保留。 */
  const boundRunId = ref<number | null>(null)
  const boundSessionId = ref<string | null>(null)
  /** 已离开会话的输入与阅读状态；切回时取走，不在视图里保留第二份。 */
  const inputs = new Map<string, SessionInput>()
  const readings = new Map<string, SessionReading>()
  /**
   * 由界面动作（回退、修改重试未被受理）交回输入区的待填内容。
   * 它跨越会话身份变化（回退会新建会话），因此不挂在会话键上；输入区消费一次后不再保留。
   */
  const requestedInput = ref<SessionInput | null>(null)
  /**
   * 早期对话是否整体展开。默认 false：只展开最后一轮，更早的轮次收起成一行摘要，
   * 用户点顶部开关后才把所有轮次都铺开。
   */
  const historyExpanded = ref(false)
  /**
   * 用户对单轮的单独开合，按会话键分组：外层是会话，内层是轮标识到展开状态的映射。
   * 读时按会话取，切会话不会把上一个会话的展开选择带进来。
   */
  const turnExpansions = reactive(new Map<string, Map<string, boolean>>())
  let stopRuntimeWatch: WatchStopHandle | null = null

  /** 前台实例报告的会话身份；未就绪或宿主失败时为空。 */
  const reportedSessionId = computed(() => (
    runtime.view.phase === 'ready' ? runtime.view.snapshot.info?.sessionId ?? null : null
  ))

  /**
   * 先订阅、再取一次当前值：身份由运行状态派生，必须在视图读取之前完成同步，
   * 因此这个 watch 用同步 flush，晚于视图的普通 watch 会让视图先读到上一个会话的状态。
   */
  function initialize(): void {
    if (stopRuntimeWatch !== null) return
    applyIdentity()
    stopRuntimeWatch = watch(() => [runtime.foregroundRunId, reportedSessionId.value] as const, applyIdentity,
      { flush: 'sync' })
  }

  /** 页面卸载时释放订阅与全部附件预览地址。 */
  function dispose(): void {
    stopRuntimeWatch?.()
    stopRuntimeWatch = null
    for (const input of inputs.values()) releaseImages(input.images)
    inputs.clear()
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

  /** 当前输入与阅读状态应归属的键：已绑定会话按会话区分，未绑定实例按运行身份区分，其余为空闲。 */
  const key = computed(() => {
    if (boundRunId.value === null) return 'idle'
    return boundSessionId.value === null ? `run:${boundRunId.value}` : `${SESSION_KEY_PREFIX}${boundSessionId.value}`
  })

  /** 取走某个会话的输入状态：调用方接管这份状态，这里不再保留副本。 */
  function takeInput(sessionKey: string): SessionInput | null {
    const saved = inputs.get(sessionKey)
    if (saved === undefined) return null
    inputs.delete(sessionKey)
    return saved
  }

  /** 存回某个会话的输入状态；同一会话已有留底时以本次为准。 */
  function saveInput(sessionKey: string, input: SessionInput): void {
    const previous = inputs.get(sessionKey)
    if (previous !== undefined) releaseImages(previous.images)
    inputs.set(sessionKey, input)
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
  function createImage(file: File): PendingImage {
    return { file, objectUrl: URL.createObjectURL(file) }
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
    return createImage(new File([bytes], image.name === '' ? `附件${index + 1}` : image.name, { type: image.mimeType }))
  }

  /** 释放附件预览地址；重复释放同一地址没有副作用。 */
  function releaseImages(images: readonly PendingImage[]): void {
    for (const image of images) URL.revokeObjectURL(image.objectUrl)
  }

  return {
    key,
    requestedInput,
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
    releaseImages
  }
})
