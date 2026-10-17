<!-- 会话活动摘要条：对话区顶部的一行窄带，把当前会话读过与改过的文件、调用的 Skill、MCP 与扩展（插件）工具归纳成四类计数；展开的明细是浮在消息区之上的浮层，四类各占一个页签，不占对话的内容空间，也不改变正文的滚动与粘底判定。
     同一行右端还承载早期对话的整体折叠开关：非当前轮只留用户输入与一行 AI 摘要；两者共用一条窄带，不为单个开关再占一行高度。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useAnchoredPopup } from '../anchored-popup'
import { createSessionActivityCache } from '../session-activity'
import { useProjectStore } from '../stores/project'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionViewStore } from '../stores/session-view'
import { useWorkspaceTabsStore } from '../stores/workspace-tabs'
import AppButton from './ui/AppButton.vue'

/** MCP 行里最多列出的工具名个数；其余只报总数，避免一条行被长清单撑开。 */
const MCP_TOOL_PREVIEW = 3

/** 浮层高度上限：明细按需滚动，超出不挤压消息区，也不把浮层拉到窗口外。 */
const POPUP_MAX_HEIGHT_PX = 420

/** 四类活动；页签顺序即展示顺序，空分类不出页签。 */
type ActivityCategory = 'files' | 'skills' | 'mcp' | 'plugins'

/** 展开后的一行：`meta` 是右对齐的次要信息，`openPath` 非空时整行可点开。 */
interface ActivityRow {
  readonly key: string
  readonly label: string
  readonly meta: string | null
  readonly title: string | null
  readonly openPath: string | null
}

/** 一个分类的页签与它的明细行；空分类整条不渲染，因此不会出现空页签。 */
interface ActivitySection {
  readonly key: ActivityCategory
  readonly label: string
  readonly count: number
  readonly rows: readonly ActivityRow[]
}

const runtimeStore = useRuntimeStore()
const projectStore = useProjectStore()
const workspaceTabsStore = useWorkspaceTabsStore()
const sessionViewStore = useSessionViewStore()
const { messages, tools } = storeToRefs(runtimeStore)
const { currentProject } = storeToRefs(projectStore)

/**
 * 是否存在可折叠的历史轮：轮以用户消息为界，会话开头没有用户输入的 AI 消息也算一轮前置轮。
 * 只有一轮时没有可收起的内容，开关整块不渲染。
 */
const hasHistoryTurn = computed(() => {
  const userCount = messages.value.filter(message => message.role === 'user').length
  const leadTurn = messages.value.length > 0 && messages.value[0]?.role !== 'user'
  return userCount + (leadTurn ? 1 : 0) > 1
})
/** 全局默认只展开最后一轮；单轮的手动开合按会话保存在 session-view。 */
const historyExpanded = computed(() => sessionViewStore.historyExpanded)

/** 派生缓存属于本组件实例：流式期间每个批次只重新解析变化的条目，见 session-activity.ts。 */
const cache = createSessionActivityCache()
const activity = computed(() => cache.derive(messages.value, tools.value, currentProject.value?.path ?? null))

/**
 * 明细浮层：定位、翻转与收边交给共用锚定工具，渲染到 body，因此既不被工作区的
 * `overflow: hidden` 裁掉，也不会像内联展开那样把消息区挤短。锚点是顶部的折叠行。
 */
const {
  trigger: popupTrigger,
  popup: popupElement,
  isOpen: popupOpen,
  position: popupPosition,
  open: openPopup,
  update: updatePopup,
  close: closePopup
} = useAnchoredPopup({ align: 'start', gap: 2, minHeight: 120, maxHeightCap: POPUP_MAX_HEIGHT_PX })

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
 * 浮层展开期间盯住折叠行的尺寸：侧栏折叠、右侧面板开关或窗口变化都会改消息列宽度，
 * 锚定工具只监听视窗缩放与滚动，这里补上触发元素自身的尺寸变化，浮层始终贴着消息列。
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

/** 活动清空（例如回退到会话开头）后折叠行整块不渲染，浮层也不能留在页面上。 */
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
      rows: current.files.map(file => ({
        key: file.key,
        label: file.label,
        meta: fileMeta(file.reads, file.writes),
        title: file.openPath === null
          ? `${file.label}（不在当前项目内，无法在此打开）`
          : `在编辑器中打开 ${file.label}`,
        openPath: file.openPath
      }))
    })
  }

  if (current.skills.length > 0) {
    result.push({
      key: 'skills',
      label: '技能',
      count: current.skillCount,
      rows: current.skills.map(skill => ({
        key: `${skill.source}:${skill.name}`,
        label: skill.name,
        meta: skillMeta(skill.source, skill.count),
        title: skill.location ?? null,
        openPath: null
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
        label: server.server,
        meta: mcpMeta(server.tools, server.count),
        title: server.tools.length === 0
          ? null
          : server.tools.map(tool => `${tool.name} ×${tool.count}`).join('、'),
        openPath: null
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
        label: plugin.toolName,
        meta: plugin.count > 1 ? `×${plugin.count}` : null,
        title: '来自扩展注册的工具',
        openPath: null
      }))
    })
  }

  return result
})

/** 顶部摘要：只列非零分类，全部为零时整块不显示。 */
const summary = computed(() => sections.value.map(section => `${section.label} ${section.count}`).join(' · '))

/**
 * 当前页签：记住上一次的选择，收起再展开仍停在同一类；
 * 该类消失（例如回退到没有工具调用的位置）时退回第一个非空分类。
 */
const selectedCategory = ref<ActivityCategory>('files')
const activeSection = computed<ActivitySection | null>(() => (
  sections.value.find(section => section.key === selectedCategory.value) ?? sections.value[0] ?? null
))
/** 模板用的非空投影：页签与面板的 id、当前行清单都从同一份结果派生。 */
const activeKey = computed(() => activeSection.value?.key ?? null)
const activeRows = computed<readonly ActivityRow[]>(() => activeSection.value?.rows ?? [])

function tabDomId(category: ActivityCategory): string {
  return `session-activity-tab-${category}`
}

function panelDomId(category: ActivityCategory): string {
  return `session-activity-panel-${category}`
}

/** 文件行的次数：修改在前，读取在后，只显示非零项。 */
function fileMeta(reads: number, writes: number): string | null {
  const parts: string[] = []
  if (writes > 0) parts.push(`修改 ×${writes}`)
  if (reads > 0) parts.push(`读取 ×${reads}`)
  return parts.length === 0 ? null : parts.join(' · ')
}

/** 技能行的来源：显式命令与读取技能文件分开标注，不把隐式加载说成用户下的命令。 */
function skillMeta(source: 'command' | 'file', count: number): string {
  const label = source === 'command' ? '技能命令' : '读取 SKILL.md'
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
 * 点折叠行：记下触发元素再开合。浮层以它为锚点定位，宽度也取它的宽度，
 * 因此浮层与消息列左右对齐，窗口变窄时由锚定工具按视窗宽度收边。
 */
function onToggle(event: MouseEvent): void {
  const element = event.currentTarget
  if (!(element instanceof HTMLElement)) return
  popupTrigger.value = element
  if (popupOpen.value) {
    closePopup()
    return
  }
  openPopup()
  // 展开后把焦点交给当前页签：方向键可直接换类，Esc 能就地收起。
  void nextTick(() => focusSelectedTab())
}

/** 把焦点落到当前页签；页签还没渲染时退回浮层本身。 */
function focusSelectedTab(): void {
  const tab = tabElementOf(activeSection.value?.key ?? null)
  if (tab !== null) tab.focus()
  else popupElement.value?.focus()
}

function tabElementOf(category: ActivityCategory | null): HTMLElement | null {
  if (category === null) return null
  return popupElement.value?.querySelector<HTMLElement>(`[data-activity-tab="${category}"]`) ?? null
}

/** 点页签：只换当前分类，不收起浮层；键盘切换走同一个入口。 */
function selectCategory(category: ActivityCategory): void {
  selectedCategory.value = category
}

/** Esc 收起并把焦点还给折叠行；点击外部收起不抢焦点，由指针自己决定落点。 */
function onEscape(): void {
  if (!popupOpen.value) return
  const element = popupTrigger.value
  closePopup()
  void nextTick(() => {
    if (element?.isConnected) element.focus()
  })
}

/** 页签键盘：方向键循环、Home/End 直达首尾，切换后焦点跟着走；Tab 正常离开页签栏。 */
function onTabsKeydown(event: KeyboardEvent): void {
  const list = sections.value
  if (list.length === 0) return
  const currentIndex = Math.max(0, list.findIndex(section => section.key === activeSection.value?.key))
  let nextIndex: number
  if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % list.length
  else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + list.length) % list.length
  else if (event.key === 'Home') nextIndex = 0
  else if (event.key === 'End') nextIndex = list.length - 1
  else return

  event.preventDefault()
  const target = list[nextIndex]
  if (target === undefined) return
  selectCategory(target.key)
  void nextTick(() => tabElementOf(target.key)?.focus())
}

/** 打开项目内文件：先收起浮层再交给工作区标签，已打开时聚焦已有标签。 */
function openFile(path: string): void {
  closePopup()
  workspaceTabsStore.openFileTab(path)
}
</script>

<template>
  <section v-if="!activity.empty || hasHistoryTurn" class="session-activity" aria-label="对话工具" @keydown.esc="onEscape">
    <!-- 一行两端：左侧会话活动折叠行（点击开明细浮层），右侧早期对话的整体折叠开关。 -->
    <div class="chat-column session-activity-row mx-auto">
      <AppButton
        v-if="!activity.empty"
        variant="unstyled"
        class="session-activity-toggle"
        :aria-expanded="popupOpen"
        aria-controls="session-activity-popup"
        @click="onToggle"
      >
        <span class="disclosure" :class="{ 'is-open': popupOpen }" aria-hidden="true"></span>
        <span class="session-activity-title">会话活动</span>
        <span class="session-activity-summary">{{ summary }}</span>
      </AppButton>
      <AppButton
        v-if="hasHistoryTurn"
        variant="unstyled"
        class="session-activity-process"
        :aria-expanded="historyExpanded"
        :title="historyExpanded ? '收起除最后一轮之外的对话，只留用户输入与一行 AI 摘要' : '展开所有轮次的 AI 回答'"
        @click="sessionViewStore.toggleHistoryExpanded()"
      >
        {{ historyExpanded ? '折叠之前的对话' : '展开全部对话' }}
      </AppButton>
    </div>
  </section>

  <!-- 明细浮层：Teleport 到 body，定位与收边由锚定工具负责，不参与对话区的布局。
       四类各占一个页签，一次只列一类，避免不同来源的条目堆在同一条清单里。 -->
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
        aria-label="会话活动明细"
        @keydown.esc.stop.prevent="onEscape"
      >
        <div class="session-activity-tabs" role="tablist" aria-label="会话活动分类" @keydown="onTabsKeydown">
          <AppButton
            v-for="section in sections"
            :key="section.key"
            variant="unstyled"
            class="session-activity-tab"
            :class="{ 'is-active': section.key === activeKey }"
            role="tab"
            :data-activity-tab="section.key"
            :id="tabDomId(section.key)"
            :aria-selected="section.key === activeKey"
            :aria-controls="panelDomId(section.key)"
            :tabindex="section.key === activeKey ? 0 : -1"
            @click="selectCategory(section.key)"
          >
            <span>{{ section.label }}</span>
            <span class="session-activity-tab-count">{{ section.count }}</span>
          </AppButton>
        </div>

        <div
          :id="activeKey === null ? undefined : panelDomId(activeKey)"
          :key="activeKey ?? 'none'"
          class="session-activity-panel"
          role="tabpanel"
          :aria-labelledby="activeKey === null ? undefined : tabDomId(activeKey)"
          tabindex="0"
        >
          <ul class="session-activity-list">
            <li v-for="row in activeRows" :key="row.key" class="session-activity-item">
              <AppButton
                v-if="row.openPath !== null"
                variant="unstyled"
                class="session-activity-entry is-openable"
                :title="row.title ?? undefined"
                @click="openFile(row.openPath)"
              >
                <span class="session-activity-entry-label">{{ row.label }}</span>
                <span v-if="row.meta !== null" class="session-activity-entry-meta">{{ row.meta }}</span>
              </AppButton>
              <span v-else class="session-activity-entry" :title="row.title ?? undefined">
                <span class="session-activity-entry-label">{{ row.label }}</span>
                <span v-if="row.meta !== null" class="session-activity-entry-meta">{{ row.meta }}</span>
              </span>
            </li>
          </ul>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
