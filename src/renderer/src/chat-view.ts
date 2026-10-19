/**
 * 把 Runtime 投影映射为聊天区渲染项：块按 contentIndex 排序、工具调用块按 toolCallId 关联执行条目、
 * 失败文案与 AI 消息生成计时只取投影已给的字段。
 *
 * 渲染项分两层：消息层按块展开（`toMessages`），轮层以用户消息为界把消息分组（`toTurns`）。
 * 折叠、展开与大纲跳转都以轮为单位，因此轮层一并算好条数、响应计时、最后一次调用的用量与
 * 本轮交付的界面数。
 *
 * 不猜测缺失内容，也不读取磁盘；来源为宿主实时投影与当前分支历史回读副本。投影按消息 copy-on-write
 * （只替换被改动的消息与工具条目对象），因此这里缓存上一次的渲染项：消息对象与其工具条目对象都没变
 * 时直接复用，避免每个批次都重建整段历史的块对象；缓存只保留仍在投影里的消息，不持有已丢弃内容。
 * 用户消息的图片附件块经 `ChatTextBlock.image` 原样透传；工具卡片所需的字段（含 Diff）原样
 * 来自投影，本模块不计算耗时、不整理非文本内容，也不解析变更。工具调用交付的生成式界面
 * 同样只做透传：载荷校验已在投影层完成，这里不重复判断也不补造。
 *
 * 用户消息里被 Pi 展开的技能调用块在这里解析成 `ChatTextBlock.skill`，`text` 只保留追加在技能块
 * 之后的用户文本；同样由 Pi 注入的图片坐标说明行也在这里剥离——两者都不是用户输入，不应进入
 * 气泡、摘要与复制内容。本轮响应计时（`turn`）与单次调用用量（`usage`）只做透传，口径与数值都由投影决定。
 * 压缩记录（`role === 'compaction'`）同样只做透传：它的摘要与 token 数来自投影，不由本模块推算。
 * `userMessagePayload` 反向把一条用户消息还原成可再次提交的输入（文本与附件），供复制、修改预填与回退回填共用。
 *
 * 生成式界面只有一份可交互：同一 `documentId` 取已加载记录与宿主给出的完整分支最高版本，其余版本标上
 * `supersededBy` 由界面折叠成只读记录。这个判定只在本模块做一次，渲染组件不各自推断；
 * 因此缓存有效性除了消息与工具条目，还要比对每个界面当前应得的 `supersededBy`。
 * 该比对在稳态下不分配：取代状态与上一次一致时直接复用同一个 refs 数组，只有变了才重建。
 */
import { PROMPT_IMAGE_MAX_CHARS, PROMPT_IMAGE_MAX_COUNT } from '../../shared/runtime-api'
import type { MessageUsage, ProjectionBlock, ProjectionCompaction, ProjectionMessage, PromptImageInput, ToolExecution } from '../../shared/runtime-api'
import type { GenuiPayload } from '../../shared/genui-api'
import { parseSkillBlock, stripImageMarkerLines } from '../../shared/user-message-text'

/** 工具调用块的渲染项；`execution` 为 null 表示该工具调用没有对应执行条目（尚未到达或历史中没有结果）。 */
export interface ChatToolBlock {
  readonly contentIndex: number
  readonly toolCallId: string | null
  readonly kind: 'toolcall'
  readonly key: string
  readonly toolName: string
  readonly execution: ToolExecution | null
  /**
   * 该工具调用交付的生成式界面；null 表示没有界面或载荷未通过校验。
   * 只从执行条目透传，本模块不解析、不补造。
   */
  readonly ui: GenuiPayload | null
  /**
   * 该界面已被更高版本取代时给出那个版本号，否则 null。
   * 取代判定按 `documentId` 取当前投影里的最高 `revision`，只在本模块算一次。
   */
  readonly supersededBy: number | null
}

export interface ChatTextBlock {
  readonly contentIndex: number
  readonly kind: 'text'
  readonly key: string
  readonly text: string
  readonly truncated: boolean
  /** 图片附件描述；非图片块为 null。来自投影的 data URL，直接用于 <img>。 */
  readonly image: { readonly dataUrl: string; readonly mimeType: string; readonly bytes: number } | null
  /**
   * 该块文本由投影生成（当前只有超出展示上限的附件说明）；展示仍可见，但不属于用户输入，
   * 不进复制、摘要与修改预填。
   */
  readonly notice: boolean
  /**
   * 该块被 Pi 展开的技能调用；非技能消息为 null。命中时 `text` 只含用户追加文本，
   * `content` 是技能正文，由界面单独折叠展示。
   */
  readonly skill: { readonly name: string; readonly location: string; readonly content: string } | null
}

export interface ChatThinkingBlock {
  readonly contentIndex: number
  readonly kind: 'thinking'
  readonly key: string
  readonly text: string
  readonly truncated: boolean
}

export type ChatBlock = ChatTextBlock | ChatThinkingBlock | ChatToolBlock

/**
 * 一轮对话：以用户消息为界，其后到下一个用户消息之前的 AI 消息与压缩记录都属于这一轮。
 * 折叠、展开与跳转都以轮为单位，因此这里把折叠所需的聚合量（条数、计时、用量）一次算好，
 * 界面不再自己遍历成员消息。
 */
export interface ChatTurnView {
  /** 轮标识：用户消息 id；会话开头没有用户消息的前置轮用固定键，不会与消息 id 相同。 */
  readonly key: string
  readonly historyId: string | null
  readonly user: ChatMessageView | null
  readonly responses: readonly ChatMessageView[]
  /** 轮内 AI 消息条数；折叠摘要用它说明收起了几条。 */
  readonly responseCount: number
  /** 本轮交付的界面个数（按块计，不是按文档去重）；大纲据此在刻度上标一枚圆点。 */
  readonly uiCount: number
  /** 本轮响应计时（挂在用户消息上）；前置轮与历史轮次为 null。 */
  readonly turn: ChatMessageView['turn']
  /** 轮内最后一次调用的用量；全部缺失时为 null，不编造 0。 */
  readonly usage: MessageUsage | null
}

export interface ChatMessageView {
  readonly id: string
  readonly entryId: string | null
  readonly recoverable: boolean
  readonly turnEntryId: string | null
  readonly role: 'user' | 'assistant' | 'compaction'
  readonly blocks: readonly ChatBlock[]
  /** 整条消息的失败文案；非 null 时界面按错误提示展示。 */
  readonly failure: string | null
  readonly time: string | null
  readonly generation: ProjectionMessage['generation']
  /** 本次模型调用的用量；仅 AI 消息可能非 null，由投影给出，这里只透传。 */
  readonly usage: MessageUsage | null
  /** 本轮响应计时；只在用户消息上出现，历史轮次为 null。 */
  readonly turn: ProjectionMessage['turn']
  /** 压缩记录；仅压缩消息非 null，界面据此渲染压缩卡片。 */
  readonly compaction: ProjectionCompaction | null
}

/**
 * 用户消息的可编辑载荷：复制、修改预填与回退回填共用这一份还原规则。
 * `skippedImages` 是无法还原的附件数：超出 prompt 上限，或投影已丢弃本体只留说明。
 */
export interface UserMessagePayload {
  readonly text: string
  readonly images: readonly PromptImageInput[]
  readonly skippedImages: number
}

/**
 * 把一条用户消息还原成可再次提交的输入：技能块还原为 `/skill:<名称> <追加文本>`，
 * 附件说明与图片块不计入文本；图片从投影的 data URL 取回 base64，并按主进程同一份上限裁剪。
 */
export function userMessagePayload(message: ChatMessageView): UserMessagePayload {
  const parts: string[] = []
  const images: PromptImageInput[] = []
  let skippedImages = 0
  for (const block of message.blocks) {
    if (block.kind !== 'text') continue
    if (block.image !== null) {
      const data = base64OfDataUrl(block.image.dataUrl)
      if (images.length < PROMPT_IMAGE_MAX_COUNT && data.length <= PROMPT_IMAGE_MAX_CHARS) {
        images.push({ name: `附件${images.length + 1}.${extensionOf(block.image.mimeType)}`, mimeType: block.image.mimeType, data })
      } else {
        skippedImages += 1
      }
      continue
    }
    // 投影生成的附件说明不是用户输入，只表示这条消息带过一张无法还原的图片。
    if (block.notice) {
      skippedImages += 1
      continue
    }
    parts.push(block.skill === null ? block.text : skillCommandText(block.skill.name, block.text))
  }
  return { text: parts.join('\n'), images, skippedImages }
}

/** 技能消息的提交形态：Pi 收到后会重新展开技能，改写不会静默丢掉技能调用。 */
function skillCommandText(name: string, userText: string): string {
  return userText === '' ? `/skill:${name}` : `/skill:${name} ${userText}`
}

/** 取 data URL 里的 base64 本体；没有分隔符时按整串处理，不猜结构。 */
function base64OfDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1)
}

/** 还原附件用的文件扩展名；MIME 不含子类型时退回 `png`。 */
function extensionOf(mimeType: string): string {
  const subtype = mimeType.split('/')[1] ?? ''
  return subtype === '' ? 'png' : subtype.replace(/[^A-Za-z0-9]/g, '')
}

/** 一条消息引用到的工具条目；复用判定要求工具条目对象也未变化。 */
interface ToolRef {
  readonly toolCallId: string
  readonly execution: ToolExecution | undefined
}

/** 一条消息里出现的界面及其应得的取代状态；取代版本变化时该消息必须重建。 */
interface UiRef {
  readonly documentId: string
  readonly supersededBy: number | null
}

/** 没有界面的消息共用同一份空数组：长会话里每条消息每批都新建空数组是无谓分配。 */
const NO_UI_REFS: readonly UiRef[] = Object.freeze([])

interface CacheEntry {
  readonly source: ProjectionMessage
  readonly toolRefs: readonly ToolRef[]
  readonly uiRefs: readonly UiRef[]
  readonly view: ChatMessageView
}

interface BuiltMessage {
  readonly view: ChatMessageView
  readonly toolRefs: readonly ToolRef[]
  readonly uiRefs: readonly UiRef[]
}

/** 轮缓存：成员消息视图对象都没变时整轮复用，避免流式期间重建整段历史。 */
interface TurnCacheEntry {
  readonly members: readonly ChatMessageView[]
  readonly view: ChatTurnView
}

export interface ChatViewCache {
  /** 把投影映射为渲染项；未变化的条目复用上一次的结果。 */
  toMessages(messages: readonly ProjectionMessage[], tools: readonly ToolExecution[]): ChatMessageView[]
  /** 在消息渲染项之上按轮分组；轮内成员未变化时整轮复用。 */
  toTurns(messages: readonly ProjectionMessage[], tools: readonly ToolExecution[]): ChatTurnView[]
}

/** Pi 的停止原因里只有这两类属于失败；其他取值不为凑文案而冒充错误。 */
const FAILURE_STOP_REASONS: Readonly<Record<string, string>> = {
  error: 'Agent 响应以错误结束。',
  aborted: '本次操作已中止。'
}

const UNKNOWN_TOOL_NAME = '未知工具'

/**
 * 每份界面当前应得的最高版本：按 `documentId` 聚合所有消息块携带的界面载荷。
 * 只读 `revision` 字段，不做校验（载荷已在投影层校验过）。
 */
function latestRevisions(
  messages: readonly ProjectionMessage[],
  toolsById: ReadonlyMap<string, ToolExecution>
): ReadonlyMap<string, number> {
  const latest = new Map<string, number>()
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind !== 'toolcall' || block.toolCallId === null) continue
      const ui = toolsById.get(block.toolCallId)?.ui
      if (ui === undefined || ui === null) continue
      const current = latest.get(ui.documentId)
      const revision = Math.max(ui.revision, toolsById.get(block.toolCallId)?.latestRevision ?? ui.revision)
      if (current === undefined || revision > current) latest.set(ui.documentId, revision)
    }
  }
  return latest
}

/**
 * 遍历一条消息里携带界面的工具块，按出现顺序回调 `(documentId, supersededBy)`。
 * 抽成回调是为了让「先比对、再构造」两遍扫描共用同一套取值逻辑；各写一份必然漂移。
 * 回调返回 false 时提前结束，比对阶段一旦发现不一致就不用继续扫。
 */
function scanUiRefs(
  message: ProjectionMessage,
  toolsById: ReadonlyMap<string, ToolExecution>,
  latest: ReadonlyMap<string, number>,
  visit: (documentId: string, supersededBy: number | null) => boolean
): void {
  for (const block of message.blocks) {
    if (block.kind !== 'toolcall' || block.toolCallId === null) continue
    const ui = toolsById.get(block.toolCallId)?.ui
    if (ui === undefined || ui === null) continue
    const max = latest.get(ui.documentId)
    const supersededBy = max === undefined || max <= ui.revision ? null : max
    if (!visit(ui.documentId, supersededBy)) return
  }
}

/**
 * 一条消息的界面取代状态：只有低于最高版本的那些才标出取代它的版本。
 *
 * `previous` 是上一次为这条消息算出的结果：完全一致时返回同一个数组引用，
 * 让流式期间每批都跑一遍的映射在稳态下零分配。代价是多扫一遍块列表，
 * 但那一遍只读字段、不建对象，比每条消息每批新建一个数组便宜。
 */
function uiRefsOf(
  message: ProjectionMessage,
  toolsById: ReadonlyMap<string, ToolExecution>,
  latest: ReadonlyMap<string, number>,
  previous: readonly UiRef[]
): readonly UiRef[] {
  let index = 0
  let same = true
  scanUiRefs(message, toolsById, latest, (documentId, supersededBy) => {
    const existing = previous[index]
    index += 1
    if (existing !== undefined && existing.documentId === documentId && existing.supersededBy === supersededBy) {
      return true
    }
    same = false
    return false
  })
  // 长度也要一致：消息里的界面少了，比对的项数会少于旧数组。
  if (same && index === previous.length) return previous

  const refs: UiRef[] = []
  scanUiRefs(message, toolsById, latest, (documentId, supersededBy) => {
    refs.push({ documentId, supersededBy })
    return true
  })
  // 共用空数组：缓存命中判定按长度与逐项比对，共用不影响正确性。
  return refs.length === 0 ? NO_UI_REFS : refs
}

/** 缓存命中时，该消息每个界面的取代状态都必须与当前一致。 */
function sameUiRefs(previous: readonly UiRef[], next: readonly UiRef[]): boolean {
  // 稳态下 `uiRefsOf` 直接复用旧数组，这里先走引用相等这条快路径。
  if (previous === next) return true
  if (previous.length !== next.length) return false
  return previous.every((ref, index) => {
    const other = next[index]
    return other !== undefined && other.documentId === ref.documentId && other.supersededBy === ref.supersededBy
  })
}

/** 每个组件实例持有自己的缓存；缓存不跨实例共享，也不进全局状态。 */
export function createChatViewCache(): ChatViewCache {
  let entries = new Map<string, CacheEntry>()
  let turnEntries = new Map<string, TurnCacheEntry>()

  function toMessages(
    messages: readonly ProjectionMessage[],
    tools: readonly ToolExecution[]
  ): ChatMessageView[] {
    const toolsById = new Map(tools.map((tool) => [tool.toolCallId, tool]))
    // 先算一次当前最高版本，再逐条消息比对缓存：修改发生后旧版能立刻变成只读。
    const latest = latestRevisions(messages, toolsById)
    const kept = new Map<string, CacheEntry>()
    const views = messages.map((message) => {
      const cached = entries.get(message.id)
      // 把上一次的结果传进去：一致时拿回同一个数组，不一致才新建。
      const uiRefs = uiRefsOf(message, toolsById, latest, cached === undefined ? NO_UI_REFS : cached.uiRefs)
      if (cached !== undefined && isReusable(cached, message, toolsById) && sameUiRefs(cached.uiRefs, uiRefs)) {
        kept.set(message.id, cached)
        return cached.view
      }

      const built = buildMessageView(message, toolsById, uiRefs)
      kept.set(message.id, { source: message, toolRefs: built.toolRefs, uiRefs: built.uiRefs, view: built.view })
      return built.view
    })
    // 只保留当前仍存在的消息，避免缓存继续持有已被投影丢弃的大块文本。
    entries = kept
    return views
  }

  return {
    toMessages,
    toTurns(messages, tools) {
      const views = toMessages(messages, tools)
      const groups = groupTurns(views)
      const kept = new Map<string, TurnCacheEntry>()
      const turns = groups.map((group) => {
        const members = group.user === null ? group.responses : [group.user, ...group.responses]
        const cached = turnEntries.get(group.key)
        if (cached !== undefined && sameMembers(cached.members, members)) {
          kept.set(group.key, cached)
          return cached.view
        }
        const view = buildTurnView(group)
        kept.set(group.key, { members, view })
        return view
      })
      turnEntries = kept
      return turns
    }
  }
}

/** 会话开头没有用户消息的前置轮；固定键与投影消息 id 不会重复。 */
const LEAD_TURN_KEY = '__lead__'

/** 分组中间态：`user` 为 null 表示会话开头那段没有用户输入的前置轮。 */
interface TurnGroup {
  readonly key: string
  readonly user: ChatMessageView | null
  readonly responses: readonly ChatMessageView[]
}

/** 按用户消息切轮：压缩记录与 AI 消息都归入它前面的那一轮，不单独成轮。 */
function groupTurns(views: readonly ChatMessageView[]): TurnGroup[] {
  const groups: TurnGroup[] = []
  let current: { key: string; user: ChatMessageView | null; responses: ChatMessageView[] } | null = null
  for (const view of views) {
    if (view.role === 'user') {
      current = { key: view.id, user: view, responses: [] }
      groups.push(current)
      continue
    }
    if (current === null) {
      current = { key: LEAD_TURN_KEY, user: null, responses: [] }
      groups.push(current)
    }
    current.responses.push(view)
  }
  return groups
}

/** 轮内成员逐个同一对象才算可复用：任一成员被替换，摘要里的条数与用量都可能变。 */
function sameMembers(previous: readonly ChatMessageView[], next: readonly ChatMessageView[]): boolean {
  if (previous.length !== next.length) return false
  return previous.every((member, index) => member === next[index])
}

/** 轮内最后一次调用的用量：多轮工具往返时只取最后一次，不把每次调用的输入重复相加。 */
function lastUsage(responses: readonly ChatMessageView[]): MessageUsage | null {
  for (let index = responses.length - 1; index >= 0; index -= 1) {
    const usage = responses[index]?.usage ?? null
    if (usage !== null) return usage
  }
  return null
}

function buildTurnView(group: TurnGroup): ChatTurnView {
  return {
    key: group.key,
    historyId: group.user?.entryId ?? group.responses[0]?.turnEntryId ?? null,
    user: group.user,
    responses: group.responses,
    responseCount: group.responses.length,
    // 在轮缓存里算一次：渲染期不重扫块，也不必给每条消息另存计数。
    uiCount: countTurnUi(group.responses),
    turn: group.user?.turn ?? null,
    usage: lastUsage(group.responses)
  }
}

/** 本轮交付的界面个数：只数带载荷的工具块，载荷已由投影层校验过。 */
function countTurnUi(responses: readonly ChatMessageView[]): number {
  let count = 0
  for (const response of responses) {
    for (const block of response.blocks) {
      if (block.kind === 'toolcall' && block.ui !== null) count += 1
    }
  }
  return count
}

/** 消息对象未替换，且它引用的每个工具条目仍是同一个对象时，可以直接复用。 */
function isReusable(
  entry: CacheEntry,
  message: ProjectionMessage,
  toolsById: ReadonlyMap<string, ToolExecution>
): boolean {
  if (entry.source !== message) return false
  for (const ref of entry.toolRefs) {
    if (toolsById.get(ref.toolCallId) !== ref.execution) return false
  }
  return true
}

function buildMessageView(
  message: ProjectionMessage,
  toolsById: ReadonlyMap<string, ToolExecution>,
  uiRefs: readonly UiRef[]
): BuiltMessage {
  const toolRefs: ToolRef[] = []
  // 投影本身按 contentIndex 排序；这里再排一次，保证渲染顺序不依赖上游的插入方式。
  const blocks = [...message.blocks]
    .sort((left, right) => left.contentIndex - right.contentIndex)
    .map((block) => toChatBlock(message, block, toolsById, toolRefs, uiRefs))

  return {
    view: {
      id: message.entryId ? `history:${message.entryId}` : message.id,
      entryId: message.entryId ?? null,
      recoverable: message.recoverable === true,
      turnEntryId: message.turnEntryId ?? null,
      role: message.role,
      blocks,
      failure: messageFailureText(message),
      time: formatMessageTime(message.timestamp),
      generation: message.generation,
      usage: message.usage,
      turn: message.turn,
      compaction: message.compaction
    },
    toolRefs,
    uiRefs
  }
}

function toChatBlock(
  message: ProjectionMessage,
  block: ProjectionBlock,
  toolsById: ReadonlyMap<string, ToolExecution>,
  toolRefs: ToolRef[],
  uiRefs: readonly UiRef[]
): ChatBlock {
  const key = `${message.id}-${block.contentIndex}`
  if (block.kind === 'text') {
    // 技能调用只可能出现在用户消息：图片附件块的 text 是占位描述，助理正文也不是命令展开，都不判定。
    const skill = message.role === 'user' && block.image === null ? parseSkillBlock(block.text) : null
    // 命中技能块时只留追加文本；图片坐标说明行同属 Pi 注入，用户气泡与复制都不带它们。
    const userText = skill === null ? block.text : skill.userMessage ?? ''
    return {
      kind: 'text',
      contentIndex: block.contentIndex,
      key,
      text: message.role === 'user' ? stripImageMarkerLines(userText) : userText,
      truncated: block.truncated,
      image: block.image,
      // 附件说明由投影生成，按块上的标记原样透传，不靠文本前缀猜。
      notice: block.notice,
      skill: skill === null
        ? null
        : { name: skill.name, location: skill.location, content: skill.content }
    }
  }
  if (block.kind === 'thinking') {
    return { kind: 'thinking', contentIndex: block.contentIndex, key, text: block.text, truncated: block.truncated }
  }

  const execution = block.toolCallId === null ? undefined : toolsById.get(block.toolCallId)
  if (block.toolCallId !== null) toolRefs.push({ toolCallId: block.toolCallId, execution })
  const ui = execution?.ui ?? null
  // 取代状态按界面而非块位置匹配：一份界面在一段历史里可能出现多次，逐份比对即可。
  const superseded = ui === null
    ? null
    : uiRefs.find((ref) => ref.documentId === ui.documentId)?.supersededBy ?? null
  return {
    kind: 'toolcall',
    contentIndex: block.contentIndex,
    toolCallId: block.toolCallId,
    key,
    toolName: firstNonEmpty(block.toolName, execution?.toolName) ?? UNKNOWN_TOOL_NAME,
    execution: execution ?? null,
    ui,
    supersededBy: superseded
  }
}

function firstNonEmpty(...values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/** 只按投影字段判断失败：`errorMessage` 优先，其次是可识别的停止原因。 */
function messageFailureText(message: ProjectionMessage): string | null {
  if (message.role !== 'assistant') return null
  const explicit = firstNonEmpty(message.errorMessage)
  if (explicit !== null) return explicit
  if (message.stopReason === null) return null
  return FAILURE_STOP_REASONS[message.stopReason] ?? null
}

/** 消息时间来自 Pi 的时间戳；缺失时返回 null，界面不编造时间。 */
function formatMessageTime(timestamp: number | null): string | null {
  if (timestamp === null) return null
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
}
