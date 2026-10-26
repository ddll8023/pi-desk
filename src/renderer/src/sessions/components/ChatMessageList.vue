<!-- 待发送消息独立于权威投影展示；首次启动也立即呈现输入，收到正式用户消息后交接，不提供历史操作。
     原位新建时保持消息区挂载与阅读留底，但隐藏旧内容、暂停旧会话操作并收起浮层。
     消息区：按投影渲染、粘底与对话内跳转；承接用户消息回退确认与修改提交，回退会新建会话（列表折叠为一条），项目文件不回退；回退把原消息文本与可还原的附件交回输入框，修改重试在没能重发时交回修改后的文本。
     每一轮的用户输入摘要与当前所在轮由这里发布给顶部栏的跳转列表，跳转意图也回到这里执行，滚动与折叠仍只有本组件一处权威。
     渲染与折叠都以轮为单位：当前轮与上一轮始终完整展开，更早的轮次只留用户输入、其后的 AI 回答与过程压成一行摘要（见 ChatTurnItem）；开合状态按会话保存，顶部开关控制全局默认。
     卡片（思考、工具、技能、压缩摘要、旧版界面）的手动展开由子组件上报，收到后停止粘底：摘要行留在原处，内容从它下面长出来，只有外层滚动范围变大。
     滚动位置仍只由本组件决定，子组件不持有滚动逻辑。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createChatViewCache, userMessagePayload } from '../chat-view'
import type { ChatMessageView, ChatTurnView, UserMessagePayload } from '../chat-view'
import type { RuntimeRewindRequest } from '../../../../shared/runtime-api'
import { useProjectStore } from '../../projects/stores/project'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionStore } from '../stores/session'
import { useChatNavigationStore } from '../stores/chat-navigation'
import { isSessionKey, useSessionViewStore } from '../stores/session-view'
import type { SessionReading } from '../stores/session-view'
import ChatTurnItem from './ChatTurnItem.vue'
import HistoryLoadSentinel from './HistoryLoadSentinel.vue'
import AppButton from '../../ui/AppButton.vue'
import ConfirmDialog from '../../ui/ConfirmDialog.vue'

/** 距底部多少像素内仍视为"停在底部"，避免流式更新时与用户上滚互相争夺。 */
const STICK_THRESHOLD_PX = 24
/** 跳转列表里每轮摘要的字数上限；列表项是两行文字，超出按字符截断。 */
const NAV_SUMMARY_CHARS = 160
const READING_OFFSET_PX = 20

const props = withDefaults(defineProps<{ readonly hidden?: boolean }>(), { hidden: false })
const projectStore = useProjectStore()
const runtimeStore = useRuntimeStore()
const sessionStore = useSessionStore()
const sessionViewStore = useSessionViewStore()
const chatNavigation = useChatNavigationStore()
const { view: runtimeView, displayMessages: messages, displayTools: tools, history, projectionSync, projectionTruncated, droppedMessages, droppedTools,
  promptView, preparingPrompt, modelSwitchView, rewindView } = storeToRefs(runtimeStore)
/** 会话视图的稳定键：宿主被回收（挂起）时仍指向同一会话，消息组件不重建。 */
const conversationKey = computed(() => runtimeStore.conversationKey)

const scroller = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const stickToBottom = ref(true)
const historyIntent = ref(false)
const activeNavId = ref<string | null>(null)
/** 跳转与展开定位保持阅读位置，不被程序滚动或内容收缩产生的 scroll 事件重新开启粘底。 */
let navTargetId: string | null = null
let lastScrollTop = 0
/**
 * 用户滚动意图：滚轮与阅读键按方向记录一帧，拖动滚动条与触摸在整个手势期间有效。
 * 只有它允许把"位置下移"判定为用户上滚，程序滚动（内容收缩回夹、视口变高、恢复位置）不会暂停跟随。
 */
let userScrollFrame: 'up' | 'down' | null = null
let userScrollWasAtBottom = false
let userGesture = false
let userScrollFrameHandle: number | null = null
/** 待恢复的滚动位置：投影分批到达时反复应用，同步完成后再结束恢复。 */
let pendingRestore: number | null = null
let pendingAnchor: SessionReading['anchor'] = undefined
let scrollFrame: number | null = null
let navFrame: number | null = null
let resizeObserver: ResizeObserver | null = null
/** 投影映射缓存：流式期间每个批次只重建真正变化的条目，见 chat-view.ts。 */
const viewCache = createChatViewCache()

const turns = computed(() => viewCache.toTurns(messages.value, tools.value))
const pendingPrompt = computed(() => sessionViewStore.pendingPrompt)
const showPendingPrompt = computed(() => pendingPrompt.value !== null
  && !sessionViewStore.hasPendingMessage(pendingPrompt.value))

/**
 * 一轮是否展开：手动开合优先，其次是默认——当前轮与上一轮始终展开，更早的轮次看顶部全局开关。
 * 留上一轮是为了让刚结束的回答仍可直接阅读；最后一条消息可能还在生成，
 * 所以「最后一轮」而不是「最后一个完成的轮」才是当前轮。
 */
function isTurnExpanded(turn: ChatTurnView, index: number): boolean {
  const override = sessionViewStore.turnExpansion(sessionViewStore.key, turn.key)
  if (override !== null) return override
  return index >= turns.value.length - 2 ? true : sessionViewStore.historyExpanded
}

/**
 * 顶部栏跳转列表的入口：以每轮的用户消息为落点，前置轮（没有用户消息）不参与。
 * 顺序始终按正文（旧→新）；顶部栏要新的在前时由它自己倒序展示，这里不承担展示顺序。
 * 时间只随摘要透传，缺失时为 null，不参与排序也不补造。
 */
const navEntries = computed(() => turns.value.flatMap(turn => (
  turn.user === null
    ? []
    : [{ id: turn.user.id, label: navLabel(turn.user), time: turn.user.time, uiCount: turn.uiCount }]
)))
const runtimeInfo = computed(() => (
  runtimeView.value.phase === 'ready' ? runtimeView.value.snapshot.info : null
))
const streaming = computed(() => runtimeInfo.value?.isStreaming === true)
/** 当前展示来自会话日志：内容由文件解析得到，可执行会话尚未绑定。 */
const logActive = computed(() => runtimeStore.logSessionId !== null)
/** 压缩进行中：运行提示改成压缩文案，但不改变粘底与停止键的行为。 */
const compacting = computed(() => runtimeInfo.value?.isCompacting === true)
const pendingRewind = ref<{ request: RuntimeRewindRequest; refill: UserMessagePayload } | null>(null)
/** 修改重试进行中：回退与重发期间用它区分提示文案。 */
const pendingEdit = ref(false)
/** 回退后没能恢复的附件说明；一次性展示，不常驻。 */
const refillNotice = ref<string | null>(null)
let refillNoticeTimer: ReturnType<typeof setTimeout> | null = null
/** 新建隐藏发生过就作废旧消息动作的收尾，即使期间已经恢复或绑定另一会话。 */
let displayVersion = 0
watch(() => props.hidden, (hidden) => {
  displayVersion += 1
  if (hidden) {
    pendingRewind.value = null
    historyIntent.value = false
    activeNavId.value = null
    chatNavigation.clear(sessionViewStore.key)
  } else scheduleNavigationUpdate()
}, { flush: 'sync' })

/**
 * 不可回退的具体原因；为空表示可以回退。
 * 操作栏的禁用态与 tooltip 都取自它，用户能看到在等什么，而不是只有一个灰按钮。
 */
const rewindBlockReason = computed<string | null>(() => {
  if (props.hidden) return '当前为新对话，原会话操作已暂停。'
  if (runtimeView.value.phase !== 'ready') return '当前没有可回退的会话。'
  if (runtimeInfo.value?.sessionId == null) return '会话尚未建立，暂时不能回退。'
  if (streaming.value) return 'Agent 正在运行；先停止当前轮次再回退。'
  if (projectionSync.value !== 'synced') return '消息仍在与主进程同步，稍后再回退。'
  if (preparingPrompt.value) return '正在读取附件并提交输入，稍后再回退。'
  if (promptView.value.phase === 'sending') return '正在发送消息，稍后再回退。'
  if (modelSwitchView.value.phase === 'switching') return '正在切换模型，稍后再回退。'
  if (rewindView.value.phase === 'requesting') return '正在回退对话。'
  if (rewindView.value.phase === 'error' && rewindView.value.blocked) return '上次回退结果未知；请重新打开会话。'
  if (sessionStore.opening) return '正在打开会话，稍后再回退。'
  if (sessionStore.awaitingTrust) return '等待项目信任确认，暂时不能回退。'
  if (sessionStore.awaitingInterrupt) return '等待当前操作确认，暂时不能回退。'
  return null
})
const canRewind = computed(() => rewindBlockReason.value === null)
const rewindDetail = computed(() => '回退会新建一条会话继续，原会话保留在本机但不再单独列出。仅回退对话，不撤销项目文件改动；原消息文本会回到输入框。')

/** 目标消息的可提交内容（文本与可还原附件）；目标已不在投影里时返回 null，调用方据此不发起回退。 */
function userMessagePayloadOf(messageId: string): UserMessagePayload | null {
  for (const turn of turns.value) {
    if (turn.user !== null && turn.user.id === messageId) {
      if (turn.user.blocks.some(block => block.kind === 'text' && block.truncated)) return null
      return userMessagePayload(turn.user)
    }
  }
  return null
}

/**
 * 把回退拿回的消息内容交回输入框；无法还原的附件只在这里说明，不静默丢。
 * `action` 决定文案说的是回退还是修改重试。
 */
function handBack(refill: UserMessagePayload, action: '回退' | '修改重试'): void {
  if (props.hidden) return
  sessionViewStore.requestInput(refill.text, refill.images)
  if (refill.skippedImages === 0) return
  refillNotice.value = `${action}完成；${refill.skippedImages} 张超出大小上限或已被投影丢弃的图片附件未恢复。`
  if (refillNoticeTimer !== null) clearTimeout(refillNoticeTimer)
  refillNoticeTimer = setTimeout(() => {
    refillNotice.value = null
    refillNoticeTimer = null
  }, 8_000)
}

/** 发起确认时固定目标（运行实例、代际与会话）并捕获要交回输入框的原消息内容；用户确认前不会改变历史。 */
function requestRewind(messageId: string): void {
  if (!canRewind.value || runtimeView.value.phase !== 'ready') return
  const runId = runtimeView.value.snapshot.runId
  const runtimeId = runtimeView.value.snapshot.runtimeId
  const sessionId = runtimeInfo.value?.sessionId
  if (runId === null || runtimeId === null || sessionId == null) return
  const refill = userMessagePayloadOf(messageId)
  if (refill === null) return
  pendingRewind.value = { request: { runId, runtimeId, sessionId, messageId }, refill }
}

/** 直接回退：成功后把原消息内容交回输入框；仅权威成功才刷新会话列表。 */
async function confirmRewind(): Promise<void> {
  const pending = pendingRewind.value
  pendingRewind.value = null
  if (pending === null || !canRewind.value) return
  const version = displayVersion
  if (!await runtimeStore.rewind(pending.request) || version !== displayVersion) return
  handBack(pending.refill, '回退')
  await sessionStore.refresh()
}

/**
 * 修改提交：回退成功后立即用修改后的文本与原附件重发；
 * 发送没被受理、或回退返回失败但分叉确已发生时，把内容交回输入框，不让已从分支移除的消息成为唯一副本。
 */
async function handleSubmitEdit(messageId: string, text: string): Promise<void> {
  if (!canRewind.value || runtimeView.value.phase !== 'ready') return
  const runId = runtimeView.value.snapshot.runId
  const runtimeId = runtimeView.value.snapshot.runtimeId
  const sessionId = runtimeInfo.value?.sessionId
  if (runId === null || runtimeId === null || sessionId == null) return
  const refill = userMessagePayloadOf(messageId)
  if (refill === null) return
  const request: RuntimeRewindRequest = { runId, runtimeId, sessionId, messageId }
  const version = displayVersion
  pendingEdit.value = true
  try {
    // 回退失败时保持编辑态，用户可再次尝试；但会话身份已变说明分叉确已发生，
    // 修改后的文本不能只留在已从分支移除的消息里，先交回输入框。
    const rewound = await runtimeStore.rewind(request)
    if (version !== displayVersion) return
    if (!rewound) {
      if (runtimeInfo.value?.sessionId !== sessionId) {
        handBack({ text, images: refill.images, skippedImages: refill.skippedImages }, '修改重试')
      }
      return
    }
    const before = promptView.value
    await runtimeStore.send(text, refill.images)
    if (version !== displayVersion) return
    if (promptView.value === before || promptView.value.phase !== 'accepted') {
      handBack({ text, images: refill.images, skippedImages: refill.skippedImages }, '修改重试')
    }
    await sessionStore.refresh()
  } finally {
    pendingEdit.value = false
  }
}

const syncNotice = computed(() => {
  if (projectionSync.value === 'synced') return null
  return projectionSync.value === 'stale'
    ? '消息已失去同步，正在重新取得快照。'
    : '正在与主进程同步消息，暂不显示增量内容。'
})
const truncationNotice = computed(() => {
  const parts: string[] = []
  if (droppedMessages.value > 0) parts.push(`省略较早 AI 响应 ${droppedMessages.value} 条`)
  if (projectionTruncated.value) parts.push('较早的响应过程与超长内容已收缩')
  if (droppedTools.value > 0) parts.push(`省略较早工具记录 ${droppedTools.value} 条`)
  if (parts.length === 0) return null
  return `当前展示窗口已收缩：${parts.join('，')}。可加载更早消息，展开对应轮次读取原始记录；这不改变模型上下文。`
})

/**
 * 空状态只表达当前可用动作，不替主进程判断会话是否真的存在。
 * Runtime 异常退出时给出常规重试入口：恢复路径就在出错的第一现场，不需要用户再去设置页找。
 */
const emptyState = computed(() => {
  if (projectStore.currentProject === null) {
    return { title: '先选择一个项目', description: '项目决定 Pi 的工作目录；在左侧项目列表选择或添加项目后即可开始。', action: null }
  }
  const current = runtimeView.value
  if (current.phase === 'starting') {
    return { title: '正在启动 Pi', description: '正在以当前项目启动 Runtime 并准备会话。', action: null }
  }
  if (current.phase === 'stopping') {
    return { title: '正在关闭 Runtime', description: '关闭完成后可以打开或新建会话。', action: null }
  }
  if (current.phase === 'failed') {
    return {
      title: 'Runtime 异常退出',
      description: `${current.error.message}；可再次点击发送重试启动；若怀疑是某个 Extension 导致启动失败，请先停用该扩展。`,
      action: 'new-session' as const
    }
  }
  if (current.phase === 'ready') {
    return { title: '可以开始对话', description: '在下方输入内容并发送；Enter 发送，Shift+Enter 换行。', action: null }
  }
  // 挂起（宿主已回收）与关闭中不同：发送会先恢复原会话，不是重新开始。
  if (runtimeStore.suspendedSessionId !== null) {
    return {
      title: '会话已回收',
      description: '空闲后已释放执行环境以节省资源；发送新内容会先恢复这个会话。',
      action: null
    }
  }
  // idle 与 closed 是同一份提示；放在最后作为兜底返回，计算式不会返回 undefined。
  return {
    title: '准备开始对话',
    description: '输入内容并发送后才会启动 Pi；首次启动期间会保留输入。',
    action: null
  }
})

/** 摘要只取用户已有的文本，不解析 Markdown；技能调用、纯图片与没有可展示文本的消息分别标明。 */
function navLabel(message: ChatMessageView): string {
  const parts: string[] = []
  const skillNames: string[] = []
  let hasImage = false
  for (const block of message.blocks) {
    if (block.kind !== 'text') continue
    if (block.image !== null) {
      hasImage = true
      continue
    }
    // 投影生成的附件说明不是用户输入；它出现说明这条消息带了图片，按图片消息处理。
    if (block.notice) {
      hasImage = true
      continue
    }
    // 技能消息的 `text` 只含用户追加文本，技能调用本身只用名称占位，不把正文当摘要。
    if (block.skill !== null) skillNames.push(block.skill.name)
    const text = block.text.trim()
    if (text !== '') parts.push(text)
  }
  const text = parts.join(' ').replace(/\s+/g, ' ')
  if (text === '') {
    if (skillNames.length > 0) return `技能：${skillNames.join('、')}`
    return hasImage ? '图片消息' : '用户消息'
  }
  return text.length > NAV_SUMMARY_CHARS ? `${text.slice(0, NAV_SUMMARY_CHARS)}…` : text
}

/** 判断滚动位置距底部是否在粘底阈值内。 */
function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_THRESHOLD_PX
}

/**
 * 记录一次用户滚动输入：方向与"输入时刻是否已在底部"都取输入当时的状态。
 * 意图只对下一帧派发的 scroll 事件有效，因此不会把随后的程序滚动一起算成用户输入。
 */
function armUserScroll(direction: 'up' | 'down'): void {
  const element = scroller.value
  userScrollFrame = direction
  userScrollWasAtBottom = element !== null && isNearBottom(element)
  if (userScrollFrameHandle !== null) return
  userScrollFrameHandle = requestAnimationFrame(() => {
    userScrollFrameHandle = null
    userScrollFrame = null
  })
}

/** 位置相对上次记录下移且来源是用户输入时，才算用户上滚；程序滚动不改变跟随状态。 */
function isUserScrollUp(element: HTMLElement): boolean {
  if (element.scrollTop >= lastScrollTop) return false
  return userScrollFrame === 'up' || (userScrollFrame === null && userGesture)
}

/** 恢复跟随并补一次粘底；已经在跟随时不重复排队。 */
function attachFollow(): void {
  if (stickToBottom.value) return
  stickToBottom.value = true
  scheduleScrollToBottom()
}

/** 位置回到阈值内就恢复跟随：误锁，以及用户回到底部但判定已落后于新内容，都能自愈。 */
function reattachIfAtBottom(): void {
  if (pendingRestore !== null || stickToBottom.value) return
  const element = scroller.value
  if (element === null || !isNearBottom(element)) return
  attachFollow()
}

/** 当前会话的阅读状态：粘底时位置无关紧要，离开底部时按最后一次滚动位置恢复。 */
function currentReading(): SessionReading {
  const host = scroller.value
  const anchor = host ? topVisibleTurn(host) : null
  return { stickToBottom: stickToBottom.value, scrollTop: lastScrollTop,
    ...(anchor?.dataset.turnKey && host ? { anchor: { turnKey: anchor.dataset.turnKey,
      offset: anchor.getBoundingClientRect().top - host.getBoundingClientRect().top } } : {}) }
}

/**
 * 阅读位置按会话保存：离开会话时存回，切回时取走。空闲与未绑定实例没有独立历史，状态原样带走。
 * 调用点必须在视图换成新会话之前执行：晚读会把新会话的滚动位置当成旧会话的位置。
 */
function applySessionReading(nextKey: string, previousKey: string | null): void {
  if (previousKey !== null && isSessionKey(previousKey)) {
    sessionViewStore.saveReading(previousKey, currentReading())
  }
  const restored = isSessionKey(nextKey) ? sessionViewStore.takeReading(nextKey) : null
  if (restored !== null) {
    stickToBottom.value = restored.stickToBottom
    pendingRestore = restored.stickToBottom ? null : restored.scrollTop
    pendingAnchor = restored.stickToBottom ? undefined : restored.anchor
    return
  }
  // 会话之间必须隔离：目标会话没有留底时按默认贴底处理，不沿用上一个会话的位置。
  if (previousKey !== null && isSessionKey(previousKey)) {
    stickToBottom.value = true
    pendingRestore = null
    pendingAnchor = undefined
  }
}

/** 会话切换：先存回原会话的阅读位置，再取走目标会话的位置。 */
watch(() => sessionViewStore.key, (next, previous) => applySessionReading(next, previous ?? null), { flush: 'pre' })

/** 恢复中的滚动位置：内容还在长高时反复应用，投影同步后确认位置并结束恢复。 */
function applyPendingRestore(): void {
  if (pendingRestore === null) return
  const element = scroller.value
  if (element === null) return
  if (pendingAnchor) {
    const anchor = content.value?.querySelector<HTMLElement>(`.chat-turn[data-turn-key="${CSS.escape(pendingAnchor.turnKey)}"]`)
    if (anchor) {
      element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - pendingAnchor.offset
      pendingAnchor = undefined
      pendingRestore = element.scrollTop
    } else if (history.value.before !== null) {
      if (!history.value.loading && history.value.error === null) void runtimeStore.loadEarlierHistory()
      return
    } else pendingAnchor = undefined
  }
  element.scrollTop = pendingRestore
  lastScrollTop = element.scrollTop
  if (projectionSync.value !== 'synced') return
  pendingRestore = null
  // 恢复结束的那一帧就重判一次：目标位置若已在底部，直接回到跟随。
  reattachIfAtBottom()
}

/** 内容变高造成底部距离增加，不等于用户上滚；只有用户输入造成的实际向上移动才暂停跟随。 */
function onScroll(): void {
  const element = scroller.value
  if (element === null) return
  // 恢复期间的位置由目标值决定：不让中间态改写粘底判定，也不让被裁剪的位置覆盖目标。
  if (pendingRestore === null) {
    if (navTargetId === null) {
      if (isNearBottom(element)) attachFollow()
      else if (userScrollFrame === 'down' && userScrollWasAtBottom) attachFollow()
      else if (isUserScrollUp(element)) stickToBottom.value = false
    }
    // 始终记录实际位置：缓存过期会让程序滚动被误判成用户上滚。
    lastScrollTop = element.scrollTop
  }
  scheduleNavigationUpdate()
}

/** 每帧最多粘底一次；写入前再检查上滚，避免排队中的布局回调抢走用户位置。 */
function scheduleScrollToBottom(): void {
  if (!stickToBottom.value || scrollFrame !== null) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null
    const element = scroller.value
    if (element === null || !stickToBottom.value) return
    // 排队期间只有用户上滚才让位；内容收缩或视口变高造成的回夹照常写到底部。
    if (!isNearBottom(element) && isUserScrollUp(element)) {
      stickToBottom.value = false
      lastScrollTop = element.scrollTop
      return
    }
    element.scrollTop = element.scrollHeight
    // 记录程序滚动后的实际位置，不让随后的 scroll 事件把内容增长误判成离开底部。
    lastScrollTop = element.scrollTop
    scheduleNavigationUpdate()
  })
}

function jumpToBottom(): void {
  pendingAnchor = undefined
  navTargetId = null
  pendingRestore = null
  stickToBottom.value = true
  lastScrollTop = scroller.value?.scrollTop ?? 0
  scheduleScrollToBottom()
}

/**
 * 卡片被手动展开：停止粘底，让摘要行留在原处、内容从它下面长出来，只有滚动范围变大。
 * 不在这里定位或补偿——展开不改变摘要行以上的高度；用户停在底部时位置几乎没变，
 * 随后的布局变化会由 `reattachIfAtBottom` 立刻恢复跟随，不需要额外判断。
 * 收起不上报：收起时位置由浏览器钳到新上限，结果与粘底一致。
 */
function pauseFollow(): void {
  stickToBottom.value = false
}

/** 只有明确的手动滚动意图解除跳转保护与待恢复位置；单纯布局变化不代表用户要回到底部。 */
function releaseNavigationJump(): void {
  pendingAnchor = undefined
  navTargetId = null
  pendingRestore = null
}

function onWheel(event: WheelEvent): void {
  if (event.deltaY === 0) return
  if (event.deltaY < 0) historyIntent.value = true
  armUserScroll(event.deltaY < 0 ? 'up' : 'down')
  releaseNavigationJump()
}

function onScrollerPointerDown(event: PointerEvent): void {
  // 原生滚动条的指针事件落在滚动容器；点击正文或复制按钮不解除阅读保护。
  if (event.target !== event.currentTarget) return
  userGesture = true
  releaseNavigationJump()
}

/** 触摸手势期间同样按实际位移判定上滚，手势结束就收回许可。 */
function onUserGestureStart(): void {
  userGesture = true
}

function onUserGestureEnd(): void {
  userGesture = false
}

/** 阅读键按方向记录意图；其余按键不影响滚动判定。 */
function onReadingKey(event: KeyboardEvent): void {
  if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]')) return
  if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) {
    historyIntent.value = true
    armUserScroll('up')
  }
  else if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) armUserScroll('down')
  else return
  releaseNavigationJump()
}

/**
 * 把某个元素对齐到视口顶部：展开后刚出现的内容立刻可见，不用再往上拖。
 * 对齐点就是目标元素的开头；展开、顶部栏跳转与「跳到新版」共用这一套定位规则。
 * `navMessageId` 是要锁定的用户消息（没有时传 null，当前轮继续按位置重算）。
 */
function scrollToElement(target: HTMLElement, navMessageId: string | null): void {
  const element = scroller.value
  if (element === null) return

  if (scrollFrame !== null) cancelAnimationFrame(scrollFrame)
  scrollFrame = null
  pendingRestore = null
  stickToBottom.value = false
  // 跳转跟到这一轮：锁定到它的用户消息，用户上滚前不再按位置重算。
  navTargetId = navMessageId
  if (navMessageId !== null) activeNavId.value = navMessageId
  const top = element.scrollTop + target.getBoundingClientRect().top - element.getBoundingClientRect().top - READING_OFFSET_PX
  element.scrollTop = Math.max(0, top)
  lastScrollTop = element.scrollTop
  scheduleNavigationUpdate()
}

/**
 * 把某一轮对齐到视口顶部；对齐点就是该轮开头（有用户消息时就是用户输入）。
 */
function revealTurn(turn: ChatTurnView): void {
  const target = content.value?.querySelector<HTMLElement>(`.chat-turn[data-turn-key="${CSS.escape(turn.key)}"]`)
  if (target === null || target === undefined) return
  scrollToElement(target, turn.user?.id ?? null)
}

/** 跳转落点的高亮时长；足够看清落在哪，又不至于长期抢视觉重点。 */
const JUMP_HIGHLIGHT_MS = 1600
let jumpHighlightTimer: ReturnType<typeof setTimeout> | null = null

/** 给跳转落点加短暂描边：长会话里滚过去的距离很远，不标一下看不出落点。 */
function highlightJumpTarget(target: HTMLElement): void {
  if (jumpHighlightTimer !== null) clearTimeout(jumpHighlightTimer)
  for (const element of content.value?.querySelectorAll<HTMLElement>('.is-jump-target') ?? []) {
    element.classList.remove('is-jump-target')
  }
  target.classList.add('is-jump-target')
  jumpHighlightTimer = setTimeout(() => {
    jumpHighlightTimer = null
    target.classList.remove('is-jump-target')
  }, JUMP_HIGHLIGHT_MS)
}

/**
 * 跳到某份界面的最新版本：被取代的旧版折叠行用它。
 *
 * 按「包含这个 documentId 且 revision 最大的那一轮」定位，而不是精确匹配 `supersededBy`：
 * 最高版本号可能来自已被截断的工具条目，对应的元素不一定在当前 DOM 里。
 * 目标优先取挂载门的 data 属性（未挂载时占位也在），找不到时退到该轮本身。
 */
function jumpToGenuiVersion(documentId: string): void {
  let best: { turn: ChatTurnView; messageId: string | null; revision: number } | null = null
  for (const turn of turns.value) {
    for (const message of [...(turn.user === null ? [] : [turn.user]), ...turn.responses]) {
      for (const block of message.blocks) {
        if (block.kind !== 'toolcall' || block.ui === null || block.ui.documentId !== documentId) continue
        if (best !== null && block.ui.revision <= best.revision) continue
        best = { turn, messageId: turn.user?.id ?? null, revision: block.ui.revision }
      }
    }
  }
  if (best === null) return
  const target = best
  const index = turns.value.indexOf(target.turn)
  const locate = (): void => {
    const body = content.value
    if (body === null) return
    const turnElement = body.querySelector<HTMLElement>(`.chat-turn[data-turn-key="${CSS.escape(target.turn.key)}"]`)
    const candidates = turnElement?.querySelectorAll<HTMLElement>(`[data-genui-document-id="${CSS.escape(documentId)}"]`)
    let anchor = turnElement
    let anchorRevision = -1
    for (const candidate of candidates ?? []) {
      const revision = Number(candidate.dataset.genuiRevision ?? '')
      if (!Number.isFinite(revision) || revision <= anchorRevision) continue
      anchor = candidate
      anchorRevision = revision
    }
    if (anchor === null || anchor === undefined) return
    scrollToElement(anchor, target.messageId)
    highlightJumpTarget(anchor)
  }
  // 目标轮被折叠时先展开再定位，否则跳过去只看得到用户输入。
  if (!isTurnExpanded(target.turn, index)) {
    sessionViewStore.setTurnExpansion(sessionViewStore.key, target.turn.key, true)
    void nextTick(locate)
    return
  }
  locate()
}

/** 定位当前投影里的用户消息；目标轮被折叠时先展开再定位。 */
function jumpToMessage(messageId: string): void {
  const index = turns.value.findIndex(turn => turn.user?.id === messageId)
  const turn = turns.value[index]
  if (turn === undefined) return
  if (isTurnExpanded(turn, index)) {
    revealTurn(turn)
    return
  }
  // 先展开再定位：否则跳过去只看得到用户输入，看不到这轮回答。
  sessionViewStore.setTurnExpansion(sessionViewStore.key, turn.key, true)
  void nextTick(() => revealTurn(turn))
}

/** 视口顶部所在的那一轮：折叠改变高度时以它为锚点，阅读位置不跳。 */
function topVisibleTurn(element: HTMLElement): HTMLElement | null {
  const body = content.value
  if (body === null) return null
  const top = element.getBoundingClientRect().top
  for (const turn of body.querySelectorAll<HTMLElement>('.chat-turn')) {
    if (turn.getBoundingClientRect().bottom > top) return turn
  }
  return null
}

/**
 * 收起与顶部开关会改变视口上方的高度，而正文禁用了滚动锚定：先记下顶部可见轮的位置，
 * 更新后按它的位移补偿 scrollTop，阅读位置不跳；贴底时不补偿，交给粘底逻辑跟到最新内容。
 * 展开走的是跳到该轮开头，见 revealTurn。
 */
function withAnchoredLayout(mutate: () => void): void {
  const element = scroller.value
  const anchor = element === null ? null : topVisibleTurn(element)
  const before = anchor?.getBoundingClientRect().top ?? null
  mutate()
  if (anchor === null || before === null) return
  void nextTick(() => {
    const host = scroller.value
    if (host === null || !anchor.isConnected || stickToBottom.value) return
    const delta = anchor.getBoundingClientRect().top - before
    if (delta === 0) return
    host.scrollTop += delta
    // 补偿后的位置就是当前位置：不让随后的 scroll 事件把它当成用户上滚。
    lastScrollTop = host.scrollTop
  })
}

/** 前插历史后补偿原可见轮位移，避免滚动条跳到新页顶部。 */
async function loadEarlier(): Promise<void> {
  if (props.hidden) return
  const version = displayVersion
  const host = scroller.value
  const anchor = host ? topVisibleTurn(host) : null
  const top = anchor?.getBoundingClientRect().top
  const key = conversationKey.value
  stickToBottom.value = false
  await runtimeStore.loadEarlierHistory()
  await nextTick()
  if (version !== displayVersion || key !== conversationKey.value || !host || !anchor?.isConnected || top === undefined) return
  host.scrollTop += anchor.getBoundingClientRect().top - top
  lastScrollTop = host.scrollTop
}

/** 点摘要只负责展开或收起，不暴露缓存维护动作。 */
function toggleTurn(turn: ChatTurnView, index: number): void {
  if (!isTurnExpanded(turn, index)) {
    sessionViewStore.setTurnExpansion(sessionViewStore.key, turn.key, true)
    void nextTick(() => revealTurn(turn))
    return
  }
  // 收起：内容变短，按顶部可见轮的位移补偿，阅读位置不跳。
  withAnchoredLayout(() => {
    sessionViewStore.setTurnExpansion(sessionViewStore.key, turn.key, false)
  })
}

/** 正常阅读按视口顶部所属的用户输入定位；贴底时标记最新输入，跳转受限时仍保留点击目标。 */
function updateActiveNavigation(): void {
  const entries = navEntries.value
  if (navTargetId !== null && !entries.some(entry => entry.id === navTargetId)) navTargetId = null
  if (entries.length === 0) {
    activeNavId.value = null
    return
  }
  if (navTargetId !== null) {
    activeNavId.value = navTargetId
    return
  }
  if (stickToBottom.value) {
    activeNavId.value = entries[entries.length - 1]?.id ?? null
    return
  }

  const element = scroller.value
  const body = content.value
  if (element === null || body === null) return
  const readingTop = element.getBoundingClientRect().top + READING_OFFSET_PX + 1
  let activeId = entries[0]?.id ?? null
  for (const anchor of body.querySelectorAll<HTMLElement>('.chat-message-user[data-message-id]')) {
    if (anchor.getBoundingClientRect().top > readingTop) break
    activeId = anchor.dataset.messageId ?? activeId
  }
  activeNavId.value = activeId
}

/**
 * 当前位置与入口列表每帧合并算一次，并把结果发布给顶部栏的跳转列表：
 * 只算位置、不量留白，因此不需要关心面板宽度；同一帧内的流式增量与 scroll 事件只跑一次。
 */
function scheduleNavigationUpdate(): void {
  if (navFrame !== null) return
  navFrame = requestAnimationFrame(() => {
    navFrame = null
    updateActiveNavigation()
    chatNavigation.publish(sessionViewStore.key, navEntries.value, activeNavId.value)
  })
}

/**
 * 取走顶部栏发出的跳转意图。入口在发布之后才到的情况（新会话首轮、历史页刚回读）
 * 由下一次发布重新调度，因此这里只消费一次，不在这里等待数据。
 */
function consumeNavigationJump(): void {
  const messageId = chatNavigation.takeJump(sessionViewStore.key)
  if (messageId !== null) jumpToMessage(messageId)
}

watch(() => chatNavigation.pending, consumeNavigationJump, { flush: 'post' })

function onLayoutChange(): void {
  applyPendingRestore()
  // 内容或视口变化时重判：位置已在底部就恢复跟随，不依赖下一个 scroll 事件。
  reattachIfAtBottom()
  scheduleScrollToBottom()
  scheduleNavigationUpdate()
}

function startNewSession(): void {
  // 闲置时空白聊天已经可用，不因点击新建会话启动 Pi；异常退出时保留显式重试入口。
  if (runtimeView.value.phase === 'idle' || runtimeView.value.phase === 'closed') return
  void sessionStore.open(null, false)
}

/** 回读详情替换摘要也会改变视口上方高度，DOM更新前保留稳定轮锚点。 */
watch(turns, () => withAnchoredLayout(() => {}), { flush: 'pre' })

/** DOM 更新与实际尺寸变化都同步粘底与顶部栏跳转；会话切换清除上一次阅读目标。 */
watch([turns, streaming, syncNotice, truncationNotice], onLayoutChange, { flush: 'post' })
/**
 * 顶部开关改的是全局默认：在 DOM 更新前记下锚点、更新后补偿位置，一次展开或收起多轮也不跳屏。
 * 用 pre 才能在补丁前量到旧位置。
 */
watch(() => sessionViewStore.historyExpanded, () => withAnchoredLayout(() => {}), { flush: 'pre' })
/** 点击发送即回到底部，不再等首次启动或 Pi 受理回执。 */
watch(() => pendingPrompt.value?.id, (id) => { if (id !== undefined) jumpToBottom() }, { flush: 'post' })
watch(showPendingPrompt, onLayoutChange, { flush: 'post' })
/** 用户消息被受理即回到底部：发送后不再停在旧阅读位置，随后的流式内容继续跟随。 */
watch(() => promptView.value.phase, (next, previous) => {
  if (next === 'accepted' && previous === 'sending') jumpToBottom()
})
watch(conversationKey, () => {
  historyIntent.value = false
  pendingRewind.value = null
  activeNavId.value = null
  // 同一会话重绑（Runtime 代际变化）没有可恢复的位置：继续贴底，不停在历史开头。
  if (!stickToBottom.value && pendingRestore === null) jumpToBottom()
  scheduleNavigationUpdate()
}, { flush: 'post' })

onMounted(() => {
  // 视图重建（例如从设置页返回）时取回当前会话的阅读位置；没有留底时保持默认贴底。
  applySessionReading(sessionViewStore.key, null)
  resizeObserver = new ResizeObserver(onLayoutChange)
  if (scroller.value !== null) resizeObserver.observe(scroller.value)
  if (content.value !== null) resizeObserver.observe(content.value)
  // 拖动滚动条的指针可能在容器外释放；手势许可在窗口层收回。
  window.addEventListener('pointerup', onUserGestureEnd)
  window.addEventListener('pointercancel', onUserGestureEnd)
  onLayoutChange()
})

onBeforeUnmount(() => {
  // 视图卸载（例如切到设置页）时按会话留底；这里已读不到 DOM，用最后一次已知的滚动位置。
  if (isSessionKey(sessionViewStore.key)) sessionViewStore.saveReading(sessionViewStore.key, currentReading())
  if (refillNoticeTimer !== null) clearTimeout(refillNoticeTimer)
  resizeObserver?.disconnect()
  window.removeEventListener('pointerup', onUserGestureEnd)
  window.removeEventListener('pointercancel', onUserGestureEnd)
  if (scrollFrame !== null) cancelAnimationFrame(scrollFrame)
  if (navFrame !== null) cancelAnimationFrame(navFrame)
  // 卸载（如切到设置页）时撤回登记，顶部栏不再列一个已经不在的会话的入口。
  chatNavigation.clear(sessionViewStore.key)
  if (userScrollFrameHandle !== null) cancelAnimationFrame(userScrollFrameHandle)
  if (jumpHighlightTimer !== null) clearTimeout(jumpHighlightTimer)
})
</script>

<template>
  <section v-show="!props.hidden || pendingPrompt !== null" class="relative flex min-h-0 flex-1 flex-col bg-desk-canvas-sunken" :inert="props.hidden && pendingPrompt === null" :aria-hidden="props.hidden && pendingPrompt === null">
    <div
      ref="scroller"
      class="scroll-area min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 [overflow-anchor:none]"
      @scroll.passive="onScroll"
      @wheel.passive="onWheel"
      @pointerdown="onScrollerPointerDown"
      @touchstart.passive="onUserGestureStart"
      @touchend.passive="onUserGestureEnd"
      @touchcancel.passive="onUserGestureEnd"
      @touchmove.passive="releaseNavigationJump"
      @keydown="onReadingKey"
    >
      <div ref="content" class="chat-column mx-auto flex flex-col gap-5">
        <div v-show="!props.hidden" class="contents">
        <p v-if="syncNotice" role="status" class="status-notice status-notice-info">{{ syncNotice }}</p>
        <p v-if="truncationNotice" role="status" class="status-notice">{{ truncationNotice }}</p>
        <p v-if="logActive" role="status" class="status-notice status-notice-info">
          已显示该会话的历史；正在连接可执行会话，连接完成前不能发送、回退或压缩。
        </p>
        <p v-if="rewindView.phase === 'requesting'" role="status" class="status-notice status-notice-info">{{ pendingEdit ? '正在回退并重发修改后的消息…' : '正在回退对话并同步历史…' }}</p>
        <p v-else-if="rewindView.phase === 'error'" role="alert" class="status-notice status-notice-error">{{ rewindView.error.message }}</p>
        <p v-else-if="rewindView.phase === 'done' && rewindView.cancelled" role="status" class="status-notice">Pi 扩展取消了回退；原消息文本未交回输入框。</p>
        <p v-if="refillNotice !== null" role="status" class="status-notice">{{ refillNotice }}</p>

        <HistoryLoadSentinel
          v-if="history.before !== null || history.loading || history.error"
          :cursor="history.before ?? 'history-start'"
          :enabled="!props.hidden && runtimeView.phase === 'ready' && projectionSync === 'synced' && (!stickToBottom || historyIntent)"
          :loading="history.loading"
          :error="history.error"
          @load="loadEarlier"
        />

        <ChatTurnItem
          v-for="(turn, index) in turns"
          :key="`${conversationKey}:${turn.key}`"
          :turn="turn"
          :expanded="isTurnExpanded(turn, index)"
          :current="index === turns.length - 1"
          :running="streaming"
          :actions-disabled="!canRewind"
          :disabled-reason="rewindBlockReason"
          :detail="turn.historyId ? history.turns[turn.historyId] : undefined"
          :history-available="!props.hidden && runtimeView.phase === 'ready'"
          :owner-key="conversationKey"
          @visibility="(visible, ownerKey) => turn.historyId && runtimeStore.setHistoryVisibility(turn.historyId, !props.hidden && visible, ownerKey)"
          @load-detail="(more) => !props.hidden && turn.historyId && runtimeStore.loadHistoryTurn(turn.historyId, more)"
          @load-chunk="(chunk) => !props.hidden && turn.historyId && runtimeStore.loadHistoryChunk(turn.historyId, chunk)"
          @toggle="toggleTurn(turn, index)"
          @user-expand="pauseFollow"
          @rewind="requestRewind"
          @submit-edit="handleSubmitEdit"
          @jump-latest="jumpToGenuiVersion"
        />

        <div v-if="turns.length === 0 && pendingPrompt === null" class="empty-state">
          <p class="empty-state-title">{{ emptyState.title }}</p>
          <p class="empty-state-text">{{ emptyState.description }}</p>
          <div v-if="emptyState.action === 'new-session'" class="mt-2 flex flex-wrap items-center justify-center gap-2">
            <AppButton
              variant="primary"
              :disabled="sessionStore.opening"
              @click="startNewSession"
            >
              新建会话
            </AppButton>
          </div>
        </div>

        <p v-if="streaming" role="status" class="status-notice status-notice-info flex items-center gap-2">
          <span class="status-dots text-desk-accent" aria-hidden="true"><span></span><span></span><span></span></span>
          <span>{{ compacting ? '正在压缩上下文；需要中断时在下方停止。' : 'Agent 正在运行；需要中断时在下方停止。' }}</span>
        </p>
        </div>

        <article v-if="showPendingPrompt && pendingPrompt !== null" class="chat-message chat-message-user" aria-label="待发送消息" :aria-busy="pendingPrompt.phase !== 'cancelled'">
          <div v-for="image in pendingPrompt.input.images" :key="image.objectUrl" class="self-end">
            <img :src="image.objectUrl" :alt="image.file.name" class="max-h-64 max-w-full rounded-desk-lg" />
          </div>
          <div v-if="pendingPrompt.input.draft !== ''" class="chat-bubble chat-bubble-user self-end">{{ pendingPrompt.input.draft }}</div>
          <p class="self-end text-xs text-desk-muted" role="status">
            {{ pendingPrompt.phase === 'starting' ? '待发送 · 正在准备会话…' : pendingPrompt.phase === 'sending' ? '正在发送…' : pendingPrompt.phase === 'cancelled' ? '已取消自动发送，正在恢复输入…' : '已提交 · 等待消息同步…' }}
          </p>
        </article>
      </div>
    </div>

    <ConfirmDialog
      :open="!props.hidden && pendingRewind !== null"
      title="回退到这条消息之前？"
      description="当前对话将回到这条用户消息发送之前；该消息及后续内容不再显示在新分支中。"
      :detail="rewindDetail"
      confirm-label="确认回退"
      @confirm="confirmRewind"
      @cancel="pendingRewind = null"
    />

    <div v-if="!stickToBottom" class="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
      <AppButton variant="compact" class="pointer-events-auto" @click="jumpToBottom">
        回到底部
      </AppButton>
    </div>
  </section>
</template>
