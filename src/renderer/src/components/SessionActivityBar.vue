<!-- 会话活动摘要条：对话区顶部的一行窄带，把当前会话读过与改过的文件、调用的 Skill、MCP 与扩展（插件）工具归纳成四类计数，每类一枚胶囊；点胶囊展开这一类明细，明细是浮在消息区之上的浮层，一次只列一类，不占对话的内容空间，也不改变正文的滚动与粘底判定。
     窄带本身不画底色，底线只画在消息列宽内，与下方消息卡片左右同边。
     同一行右端还承载早期对话的整体折叠开关：非当前轮只留用户输入与一行 AI 摘要；两者共用一条窄带，不为单个开关再占一行高度。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useAnchoredPopup } from '../anchored-popup'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionViewStore } from '../stores/session-view'
import { useWorkspaceTabsStore } from '../stores/workspace-tabs'
import AppButton from './ui/AppButton.vue'

/** MCP 行里最多列出的工具名个数；其余只报总数，避免一条行被长清单撑开。 */
const MCP_TOOL_PREVIEW = 3

/** 浮层高度上限：明细按需滚动，超出不挤压消息区，也不把浮层拉到窗口外。 */
const POPUP_MAX_HEIGHT_PX = 420

/**
 * 浮层宽度：明细是「徽标 + 文件名 + 目录 + 次数」四段，跟消息列宽走会摊成一条一米宽的空壳，
 * 太窄又会把文件名挤断；因此取固定宽度左对齐展开，窗口更窄时由锚定工具按视窗宽度收边。
 */
const POPUP_WIDTH_PX = 640

/** 四类活动；窄带上胶囊的顺序即展示顺序，空分类不出胶囊。 */
type ActivityCategory = 'files' | 'skills' | 'mcp' | 'plugins'

/** 行首的一枚操作徽标；只表达操作类型，次数放到行尾，徽标列宽度才不会随次数变化。 */
interface ActivityBadge {
  readonly label: string
  readonly tone: 'write' | 'read'
}

/**
 * 展开后的一行：`badges` 是行首固定列里的操作徽标（只有文件行有）；`dir` 是文件行的目录后缀，
 * 排在文件名之后并单独变暗，超出宽度时尾部省略；`meta` 是右对齐的次要信息；`title` 是截断时的完整文本。
 */
interface ActivityRow {
  readonly key: string
  readonly badges: readonly ActivityBadge[]
  readonly dir: string | null
  readonly label: string
  readonly meta: string | null
  readonly title: string | null
}

/** 一个分类：窄带上的一枚胶囊，加它的明细行；空分类整条不渲染，因此不会出现空胶囊。 */
interface ActivitySection {
  readonly key: ActivityCategory
  readonly label: string
  readonly count: number
  readonly rows: readonly ActivityRow[]
}

const runtimeStore = useRuntimeStore()
const workspaceTabsStore = useWorkspaceTabsStore()
const sessionViewStore = useSessionViewStore()
const { displayMessages: messages } = storeToRefs(runtimeStore)

/**
 * 是否存在可折叠的历史轮：轮以用户消息为界，会话开头没有用户输入的 AI 消息也算一轮前置轮。
 * 当前轮与上一轮默认就展开，所以少于三轮时没有可收起的内容，开关整块不渲染。
 */
const hasHistoryTurn = computed(() => {
  const userCount = messages.value.filter(message => message.role === 'user').length
  const leadTurn = messages.value.length > 0 && messages.value[0]?.role !== 'user'
  return userCount + (leadTurn ? 1 : 0) > 2
})
/** 全局默认展开当前轮与上一轮；更早轮次的默认开合由它控制，单轮的手动开合按会话保存在 session-view。 */
const historyExpanded = computed(() => sessionViewStore.historyExpanded)

/** 轻量累计事实由宿主提供，不受工具卡片的最近100条展示窗口影响。 */
const activity = computed(() => runtimeStore.activity ?? {
  files: [], skills: [], mcp: [], plugins: [], fileCount: 0, skillCount: 0, mcpCount: 0, pluginCount: 0, empty: true, incomplete: false
})

/**
 * 明细浮层：定位、翻转与收边交给共用锚定工具，渲染到 body，因此既不被工作区的
 * `overflow: hidden` 裁掉，也不会像内联展开那样把消息区挤短。锚点是顶部整条窄带（不是被点的
 * 那枚胶囊），因此无论点哪一类，浮层都从消息列左边缘的同一位置展开。
 */
const {
  trigger: popupTrigger,
  popup: popupElement,
  isOpen: popupOpen,
  position: popupPosition,
  open: openPopup,
  update: updatePopup,
  close: closePopup
} = useAnchoredPopup({
  align: 'start',
  gap: 2,
  width: POPUP_WIDTH_PX,
  minHeight: 120,
  maxHeightCap: POPUP_MAX_HEIGHT_PX
})

const popupStyle = computed(() => {
  const position = popupPosition.value
  return {
    left: `${position.left}px`,
    top: `${position.top}px`,
    width: `${position.width}px`,
    maxHeight: `${position.maxHeight}px`
  }
})

/**
 * 浮层展开期间盯住窄带整行的尺寸：侧栏折叠、右侧面板开关或窗口变化都会改消息列宽度，
 * 锚定工具只监听视窗缩放与滚动，这里补上触发元素自身的尺寸变化，浮层左边缘始终与消息列对齐。
 */
let triggerObserver: ResizeObserver | null = null
watch(popupOpen, (open) => {
  triggerObserver?.disconnect()
  triggerObserver = null
  const element = popupTrigger.value
  if (!open || element === null) return
  triggerObserver = new ResizeObserver(() => updatePopup())
  triggerObserver.observe(element)
})

/** 切到终端、文件标签或设置页时对话面板不再可见：浮层渲染在 body 上，必须随之收起。 */
watch(
  () => workspaceTabsStore.isChatActive,
  (active) => { if (!active) closePopup() }
)

/**
 * 同一对话标签内换会话（侧栏点另一会话、输入区 `/new` 就地替换、回退新建分支）后，
 * 浮层里已经是另一个会话的活动：与切标签一致地收起，不让旧位置的浮层看上去仍属于上一个会话。
 */
watch(
  () => runtimeStore.conversationKey,
  () => closePopup()
)

/** 活动清空（例如回退到会话开头）后窄带整行不渲染，浮层也不能留在页面上。 */
watch(
  () => activity.value.empty,
  (empty) => { if (empty) closePopup() }
)

onBeforeUnmount(() => {
  triggerObserver?.disconnect()
  triggerObserver = null
})

const sections = computed<readonly ActivitySection[]>(() => {
  const current = activity.value
  const result: ActivitySection[] = []

  if (current.files.length > 0) {
    result.push({
      key: 'files',
      label: '文件',
      count: current.fileCount,
      rows: current.files.map(file => {
        const path = splitPath(file.label)
        return {
          key: file.key,
          badges: fileBadges(file.reads, file.writes),
          dir: path.dir,
          label: path.label,
          meta: fileCounts(file.reads, file.writes),
          title: file.label
        }
      })
    })
  }

  if (current.skills.length > 0) {
    result.push({
      key: 'skills',
      label: '技能',
      count: current.skillCount,
      rows: current.skills.map(skill => ({
        key: `${skill.source}:${skill.name}`,
        badges: [],
        dir: null,
        label: skill.name,
        meta: skillMeta(skill.source, skill.count),
        title: skill.location ?? null
      }))
    })
  }

  if (current.mcp.length > 0) {
    result.push({
      key: 'mcp',
      label: 'MCP',
      count: current.mcpCount,
      rows: current.mcp.map(server => ({
        key: server.server,
        badges: [],
        dir: null,
        label: server.server,
        meta: mcpMeta(server.tools, server.count),
        title: server.tools.length === 0
          ? null
          : server.tools.map(tool => `${tool.name} ×${tool.count}`).join('、')
      }))
    })
  }

  if (current.plugins.length > 0) {
    result.push({
      key: 'plugins',
      label: '插件',
      count: current.pluginCount,
      rows: current.plugins.map(plugin => ({
        key: plugin.toolName,
        badges: [],
        dir: null,
        label: plugin.toolName,
        meta: plugin.count > 1 ? `×${plugin.count}` : null,
        title: '来自扩展注册的工具'
      }))
    })
  }

  return result
})

/**
 * 窄带整行：既是胶囊组的容器，也是明细浮层的锚点（横向对齐取它的左边缘）。
 */
const rowElement = ref<HTMLElement | null>(null)

/**
 * 当前分类：由窄带上的胶囊决定，记住上一次的选择，收起再展开仍停在同一类；
 * 该类消失（例如回退到没有工具调用的位置）时退回第一个非空分类。
 */
const selectedCategory = ref<ActivityCategory>('files')
const activeSection = computed<ActivitySection | null>(() => (
  sections.value.find(section => section.key === selectedCategory.value) ?? sections.value[0] ?? null
))
/** 模板用的非空投影：浮层的标题与当前行清单都从同一份结果派生。 */
const activeKey = computed(() => activeSection.value?.key ?? null)
const activeRows = computed<readonly ActivityRow[]>(() => activeSection.value?.rows ?? [])

/** 文件行的操作徽标：修改在前、读取在后，只给非零项；单字母与右侧面板的文件状态列同规格。 */
function fileBadges(reads: number, writes: number): readonly ActivityBadge[] {
  const badges: ActivityBadge[] = []
  if (writes > 0) badges.push({ label: 'W', tone: 'write' })
  if (reads > 0) badges.push({ label: 'R', tone: 'read' })
  return badges
}

/** 文件行的行尾次数：只发生一次时徽标已经说完，不重复；多次时给出每类的精确次数。 */
function fileCounts(reads: number, writes: number): string | null {
  if (reads + writes <= 1) return null
  const parts: string[] = []
  if (writes > 0) parts.push(`改 ${writes}`)
  if (reads > 0) parts.push(`读 ${reads}`)
  return parts.join(' · ')
}

/** 路径拆成目录与文件名：展示时文件名在前、目录在后，与右侧面板的文件列表一致。 */
function splitPath(path: string): { readonly dir: string | null, readonly label: string } {
  const index = path.lastIndexOf('/')
  if (index < 0) return { dir: null, label: path }
  return { dir: `${path.slice(0, index)}/`, label: path.slice(index + 1) }
}

/** 技能行的来源：显式命令与读取技能文件分开标注，不把隐式加载说成用户下的命令。 */
function skillMeta(source: 'command' | 'file' | 'host', count: number): string {
  const label = source === 'command' ? '用户显式展开' : source === 'host' ? '宿主注入' : '模型完整读取'
  return count > 1 ? `${label} ×${count}` : label
}

/** MCP 行：先给用到的工具名（最多几个），再给调用总次数。 */
function mcpMeta(tools: readonly { readonly name: string }[], count: number): string | null {
  const names = tools.slice(0, MCP_TOOL_PREVIEW).map(tool => tool.name)
  const preview = names.length === 0
    ? null
    : tools.length > MCP_TOOL_PREVIEW ? `${names.join('、')} 等 ${tools.length} 个工具` : names.join('、')
  const total = count > 1 ? `${count} 次` : null
  if (preview === null) return total
  return total === null ? preview : `${preview} · ${total}`
}

/**
 * 点分类胶囊：以整条窄带为锚点打开明细浮层，只列被点的那一类；窄带胶囊本身就是分类选择器，
 * 浮层里不再重复一排页签。再点同一个已展开的分类则收起。
 */
function onOpenCategory(category: ActivityCategory): void {
  const anchor = rowElement.value
  if (anchor === null) return
  popupTrigger.value = anchor
  if (popupOpen.value && selectedCategory.value === category) {
    closePopup()
    return
  }
  selectedCategory.value = category
  openPopup()
  // 展开后把焦点交给浮层本身：Esc 能就地收起，Tab 直接进入清单。
  void nextTick(() => popupElement.value?.focus())
}

/** 早期对话的整体折叠：先收起明细浮层，避免浮层在整轮折叠后仍停在原位置。 */
function onToggleHistory(): void {
  closePopup()
  sessionViewStore.toggleHistoryExpanded()
}

/** Esc 收起并把焦点还给触发胶囊；点击外部收起不抢焦点，由指针自己决定落点。 */
function onEscape(): void {
  if (!popupOpen.value) return
  const element = popupTrigger.value
  closePopup()
  void nextTick(() => {
    if (element?.isConnected) element.focus()
  })
}
</script>

<template>
  <section v-if="!activity.empty || hasHistoryTurn || activity.incomplete" class="session-activity" aria-label="对话工具" @keydown.esc="onEscape">
    <!-- 一行两端：左侧每类一枚胶囊（点开该类明细），右侧早期对话的整体折叠开关。 -->
    <div ref="rowElement" class="chat-column session-activity-row mx-auto">
      <div v-if="!activity.empty" class="session-activity-chips" role="group" aria-label="会话活动分类">
        <AppButton
          v-for="section in sections"
          :key="section.key"
          variant="unstyled"
          class="session-activity-chip"
          :aria-expanded="popupOpen"
          aria-controls="session-activity-popup"
          :title="`查看${section.label}明细（${section.count} 条）`"
          @click="onOpenCategory(section.key)"
        >
          {{ section.label }}
          <span class="session-activity-chip-count">{{ section.count }}</span>
        </AppButton>
      </div>
      <span v-if="activity.incomplete" class="text-xs text-desk-text-muted" title="SDK曾省略嵌套调用或参数；当前事实不受工具窗口裁剪，但不能恢复从未保存的信息。">嵌套记录不完整，计数可能偏少</span>
      <AppButton
        v-if="hasHistoryTurn"
        variant="unstyled"
        class="session-activity-process"
        :aria-expanded="historyExpanded"
        :title="historyExpanded ? '收起当前轮与上一轮之外的对话，只留用户输入与一行 AI 摘要' : '展开已加载轮次；缺失详情在进入视口时读取'"
        @click="onToggleHistory"
      >
        <span>{{ historyExpanded ? '折叠之前的对话' : '展开已加载对话' }}</span>
        <span aria-hidden="true">{{ historyExpanded ? '⌃' : '⌄' }}</span>
      </AppButton>
    </div>
  </section>

  <!-- 明细浮层：Teleport 到 body，定位与收边由锚定工具负责，不参与对话区的布局。
       只列窄带上被点的那一类；分类选择由窄带胶囊承担，浮层里不重复一排页签。 -->
  <Teleport to="body">
    <Transition name="pop-motion">
      <div
        v-if="popupOpen && activeSection !== null"
        id="session-activity-popup"
        ref="popupElement"
        class="session-activity-pop"
        :style="popupStyle"
        role="dialog"
        tabindex="-1"
        :aria-label="`${activeSection.label}明细`"
        @keydown.esc.stop.prevent="onEscape"
      >
        <div :key="activeKey ?? 'none'" class="session-activity-panel" tabindex="0">
          <ul class="session-activity-list">
            <li v-for="row in activeRows" :key="row.key" class="session-activity-entry" :title="row.title ?? undefined">
              <span v-if="row.badges.length > 0" class="session-activity-badges">
                <span
                  v-for="badge in row.badges"
                  :key="badge.tone"
                  class="session-activity-badge"
                  :class="`is-${badge.tone}`"
                >{{ badge.label }}</span>
              </span>
              <span class="session-activity-entry-path">
                <span class="session-activity-entry-label">{{ row.label }}</span>
                <span v-if="row.dir !== null" class="session-activity-entry-dir">{{ row.dir }}</span>
              </span>
              <span v-if="row.meta !== null" class="session-activity-entry-meta">{{ row.meta }}</span>
            </li>
          </ul>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
