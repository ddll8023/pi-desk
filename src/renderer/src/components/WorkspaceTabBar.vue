<!--
  工作区标签条：对话、终端与文件标签同处一组，顺序可拖动调整，横向滚动不换行，新建按钮紧跟最后一个标签。

  标签只负责展示与派发意图：标签清单、活动标签、顺序与标题都来自工作区标签状态，重命名与顺序只在
  页面内生效、不回传主进程。重命名有两个入口：双击标签，或右键标签打开菜单选「重命名」；编辑态用
  输入框替换按钮（避免把输入框嵌在按钮里），Enter 或失焦提交、Esc 取消。
  拖动调整先后顺序（落点显示在目标标签左侧）；「+」按类型新建对话或终端，位置跟在标签之后（与 Orca 一致）。
  后台对话结束一轮回复时，它的标签用强调色标题加一个圆点提示「有新回复」，切到该标签即清除。
  方向键与 Home/End 在同组标签间移动活动标签，顺序与视觉顺序一致。
  「命令」按钮固定在标签条右端（与 Orca 同侧）打开快捷命令菜单：菜单数据由父级传入，运行、编辑、删除、添加与管理都上抛。
-->
<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import { computed, nextTick, ref, watch } from 'vue'
import type { QuickCommand, QuickCommandScope } from '../../../shared/quick-commands-api'
import { useAnchoredPopup } from '../anchored-popup'
import type { WorkspaceTabKind, WorkspaceTabView } from '../stores/workspace-tabs'
import AppButton from './ui/AppButton.vue'
import QuickCommandMenu from './QuickCommandMenu.vue'

const props = defineProps<{
  readonly tabs: readonly WorkspaceTabView[]
  /** 活动标签；没有标签时为空，界面据此不标记任何标签。 */
  readonly activeTab: string | null
  /** 终端创建中：新建菜单的终端项据此禁用，避免重复提交。 */
  readonly creating: boolean
  /** 当前可用的快捷命令；顺序由父级决定（项目命令在前，全局命令在后）。 */
  readonly quickCommands: readonly QuickCommand[]
  /** 当前项目路径；为空时快捷菜单的项目级入口禁用。 */
  readonly projectPath: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
  close: [id: string]
  create: [kind: WorkspaceTabKind]
  rename: [id: string, title: string]
  move: [id: string, toIndex: number]
  runCommand: [command: QuickCommand]
  editCommand: [command: QuickCommand]
  removeCommand: [command: QuickCommand]
  addCommand: [scope: QuickCommandScope]
  manageCommands: []
}>()

/** 标签操作菜单的宽度；只放一个动作，窄一点更贴近标签。 */
const TAB_MENU_WIDTH = 160
/** 新建菜单的宽度；两个动作，按最长文案留位。 */
const CREATE_MENU_WIDTH = 176

/** 正在重命名的标签；同一时刻只编辑一个标签。 */
const editingId = ref<string | null>(null)
const draft = ref('')
const strip = ref<HTMLElement | null>(null)

/** 新建与切换只滚动越界标签，避免高亮已变化但标签仍藏在横向滚动区之外。 */
watch(() => [props.activeTab, props.tabs.map(tab => tab.id).join(','), props.projectPath], async () => {
  await nextTick()
  const host = strip.value
  if (host === null) return
  const tab = [...host.querySelectorAll<HTMLElement>('[data-tab-id]')]
    .find(element => element.dataset.tabId === props.activeTab)
  if (tab === undefined) return
  const viewport = host.getBoundingClientRect()
  const bounds = tab.getBoundingClientRect()
  if (bounds.left < viewport.left || bounds.right > viewport.right) {
    tab.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
}, { flush: 'post' })
/** 重命名输入框：在 v-for 内渲染，用函数 ref 取当前那一个。 */
let renameInput: HTMLInputElement | null = null

/** 右键菜单指向的标签；null 表示菜单已收起。 */
const menuTargetId = ref<string | null>(null)
const renameMenu = useAnchoredPopup({
  width: TAB_MENU_WIDTH,
  align: 'start',
  onClose: () => { menuTargetId.value = null }
})
const { trigger: renameTrigger, popup: renamePopup, isOpen: renameOpen, position: renamePosition } = renameMenu
/** 落点直接取共用锚定工具的结果：浮层高度由工具按实测值参与定位，调用点不再自行补偿。 */
const renameMenuStyle = computed(() => {
  const position = renamePosition.value
  return {
    left: `${position.left}px`, top: `${position.top}px`,
    width: `${position.width}px`, maxHeight: `${position.maxHeight}px`
  }
})

/** 新建菜单：紧跟标签的「+」的两项动作，与标签的右键菜单共用同一套定位与收起规则。 */
const createMenu = useAnchoredPopup({
  width: CREATE_MENU_WIDTH,
  align: 'start',
  onClose: () => {}
})
const { trigger: createTrigger, popup: createPopup, isOpen: createOpen, position: createPosition } = createMenu
const createMenuStyle = computed(() => {
  const position = createPosition.value
  return {
    left: `${position.left}px`, top: `${position.top}px`,
    width: `${position.width}px`, maxHeight: `${position.maxHeight}px`
  }
})

/** 正在拖动的标签；null 表示没有进行中的拖动。 */
const dragId = ref<string | null>(null)
/** 拖动落点：插到该索引的标签之前；null 表示没有有效落点。 */
const dropIndex = ref<number | null>(null)

/** 快捷命令菜单；打开时锚定「命令」按钮。 */
const commandMenu = ref<InstanceType<typeof QuickCommandMenu> | null>(null)
/** 菜单是否展开；由菜单上报（点击外部收起也会同步），只用于按钮的 aria-expanded。 */
const commandMenuOpen = ref(false)

/** 展开或收起快捷命令菜单：已展开时收起，否则锚定「命令」按钮展开。 */
function toggleCommandMenu(event: MouseEvent): void {
  const host = event.currentTarget
  if (!(host instanceof HTMLElement)) return
  renameMenu.close()
  createMenu.close()
  if (commandMenuOpen.value) {
    commandMenu.value?.close()
    return
  }
  commandMenu.value?.open(host)
}

function setRenameInput(element: Element | ComponentPublicInstance | null): void {
  renameInput = element instanceof HTMLInputElement ? element : null
}

async function startRename(tab: WorkspaceTabView): Promise<void> {
  editingId.value = tab.id
  draft.value = tab.title
  await nextTick()
  renameInput?.focus()
  renameInput?.select()
}

function commitRename(): void {
  const id = editingId.value
  if (id === null) return
  editingId.value = null
  emit('rename', id, draft.value)
}

function cancelRename(): void {
  editingId.value = null
}

/** 打开标签操作菜单：锚定被右键的那个标签，与侧栏的菜单同一套定位与收起规则。 */
function openTabMenu(tab: WorkspaceTabView, event: MouseEvent): void {
  const host = event.currentTarget
  if (!(host instanceof HTMLElement)) return
  createMenu.close()
  renameMenu.close()
  commandMenu.value?.close()
  menuTargetId.value = tab.id
  renameTrigger.value = host
  renameMenu.open()
  void nextTick(() => {
    if (renameOpen.value) renamePopup.value?.querySelector<HTMLButtonElement>('button')?.focus()
  })
}

/** 菜单里选「重命名」：先收起菜单，再把该标签切到编辑态。 */
function renameFromMenu(): void {
  const tab = props.tabs.find(candidate => candidate.id === menuTargetId.value) ?? null
  renameMenu.close()
  if (tab !== null) void startRename(tab)
}

/** 展开新建菜单：锚定紧跟标签的「+」按钮，并把焦点交给第一项。 */
function toggleCreateMenu(event: MouseEvent): void {
  const host = event.currentTarget
  if (!(host instanceof HTMLElement)) return
  renameMenu.close()
  commandMenu.value?.close()
  if (createOpen.value) {
    createMenu.close()
    return
  }
  createTrigger.value = host
  createMenu.open()
  void nextTick(() => {
    if (createOpen.value) createPopup.value?.querySelector<HTMLButtonElement>('button')?.focus()
  })
}

function createTab(kind: WorkspaceTabKind): void {
  createMenu.close()
  emit('create', kind)
}

function onDragStart(tab: WorkspaceTabView, event: DragEvent): void {
  // 编辑态与右键菜单期间不进入拖动，避免与输入框交互冲突。
  if (editingId.value !== null) {
    event.preventDefault()
    return
  }
  renameMenu.close()
  dragId.value = tab.id
  dropIndex.value = null
  if (event.dataTransfer === null) return
  event.dataTransfer.effectAllowed = 'move'
  // 部分平台不写入数据就不触发拖动；内容只用于让拖动成立。
  event.dataTransfer.setData('text/plain', tab.id)
}

function onDragOver(index: number, event: DragEvent): void {
  if (dragId.value === null) return
  event.preventDefault()
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
  dropIndex.value = index
}

/** 落下：把被拖动的标签移动到目标索引；落点语义是「插到目标标签之前」。 */
function onDrop(index: number, event: DragEvent): void {
  event.preventDefault()
  const id = dragId.value
  dragId.value = null
  dropIndex.value = null
  if (id !== null) emit('move', id, index)
}

function onDragEnd(): void {
  dragId.value = null
  dropIndex.value = null
}

/** 键盘顺序即视觉顺序：活动标签在标签组里的前后就是左右方向。 */
function tabIds(): string[] {
  return props.tabs.map(tab => tab.id)
}

function onTablistKeydown(event: KeyboardEvent): void {
  if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]') !== null) return
  const ids = tabIds()
  const current = props.activeTab === null ? -1 : ids.indexOf(props.activeTab)
  if (current < 0) return
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  const isBoundary = event.key === 'Home' || event.key === 'End'
  if (step === 0 && !isBoundary) return
  event.preventDefault()
  const target = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : current + step
  const id = ids[target]
  if (id !== undefined) emit('select', id)
}

/** 标签类型的读屏文案；重命名输入框与标签本身共用。 */
function kindLabel(kind: WorkspaceTabView['kind']): string {
  if (kind === 'chat') return '对话'
  return kind === 'terminal' ? '终端' : '文件'
}

/** 菜单内键盘导航：Esc 收起并把焦点还给触发元素；Tab 只在菜单内循环。 */
function onMenuKeydown(event: KeyboardEvent, close: () => void, popup: HTMLElement | null): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key !== 'Tab') return
  const buttons = [...(popup?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
  if (buttons.length === 0) return
  event.preventDefault()
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.shiftKey
    ? (index <= 0 ? buttons.length - 1 : index - 1)
    : (index === buttons.length - 1 ? 0 : index + 1)
  buttons[next]?.focus()
}
</script>

<template>
  <div class="workspace-tabs">
    <div ref="strip" class="workspace-tabs-strip">
      <div class="workspace-tabs-group" role="tablist" aria-label="工作区标签" @keydown="onTablistKeydown">
        <div
          v-for="(tab, index) in props.tabs"
          :key="tab.id"
          :data-tab-id="tab.id"
          class="workspace-tab"
          :class="[
            { 'is-active': props.activeTab === tab.id, 'is-unseen': tab.unseenCompletion },
            dragId === tab.id ? 'opacity-40' : '',
            dragId !== null && dragId !== tab.id && dropIndex === index
              ? 'shadow-[inset_2px_0_0_0_var(--color-desk-accent)]'
              : ''
          ]"
          :draggable="editingId === null"
          @dragstart="onDragStart(tab, $event)"
          @dragover="onDragOver(index, $event)"
          @drop="onDrop(index, $event)"
          @dragend="onDragEnd"
          @contextmenu.prevent="openTabMenu(tab, $event)"
        >
          <input
            v-if="editingId === tab.id"
            :ref="setRenameInput"
            v-model="draft"
            class="workspace-tab-rename"
            type="text"
            :aria-label="`${kindLabel(tab.kind)}标签标题`"
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="cancelRename"
            @blur="commitRename"
          />
          <button
            v-else
            type="button"
            role="tab"
            class="workspace-tab-main"
            :aria-selected="props.activeTab === tab.id"
            :tabindex="props.activeTab === tab.id ? 0 : -1"
            :title="tab.tooltip"
            @click="emit('select', tab.id)"
            @dblclick="startRename(tab)"
          >
            <!-- 对话标签用气泡图标，终端标签用运行状态点，文件标签用文档图标：三类标签在同一组里仍能一眼区分。 -->
            <svg
              v-if="tab.kind === 'chat'"
              class="workspace-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
            ><path d="M20 12a7 7 0 0 1-7 7H8l-4 3v-5.5A7 7 0 0 1 11 5h2a7 7 0 0 1 7 7Z" /></svg>
            <svg
              v-else-if="tab.kind === 'file'"
              class="workspace-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
            ><path d="M14 3v5h5" /><path d="M6 3h8l5 5v13H6z" /></svg>
            <span
              v-else
              class="workspace-tab-dot"
              :class="tab.terminalStatus === 'exited' ? 'is-exited' : 'is-running'"
              aria-hidden="true"
            ></span>
            <span class="workspace-tab-title">{{ tab.title }}</span>
            <!-- 未保存：实心小圆点与提示；读屏靠后面的隐藏文本表达。 -->
            <span v-if="tab.dirty" class="workspace-tab-dirty" aria-hidden="true"></span>
            <span v-if="tab.dirty" class="sr-only">有未保存修改</span>
            <!-- 有新回复：强调色圆点与标题变色一起提示；读屏靠后面的隐藏文本表达。 -->
            <span v-if="tab.unseenCompletion" class="workspace-tab-dot is-unseen" aria-hidden="true"></span>
            <span v-if="tab.unseenCompletion" class="sr-only">有新回复</span>
          </button>
          <AppButton
            variant="unstyled"
            class="workspace-tab-close"
            :aria-label="`关闭 ${tab.title}`"
            :title="`关闭 ${tab.title}`"
            @click.stop="emit('close', tab.id)"
          >
            <svg class="workspace-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
          </AppButton>
        </div>
      </div>

      <!-- 新建按钮跟在标签之后（Orca 同款位置）：标签少时贴着最后一个标签，溢出时随标签一起滚动。 -->
      <AppButton
        variant="unstyled"
        class="workspace-tab-new"
        aria-label="新建标签"
        aria-haspopup="menu"
        :aria-expanded="createOpen"
        :aria-controls="createOpen ? 'workspace-tab-create' : undefined"
        :title="props.creating ? '正在新建终端' : '新建标签'"
        @click="toggleCreateMenu"
      >
        <svg class="workspace-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      </AppButton>
    </div>

    <!-- 快捷命令：固定在标签条右端，不随标签横向滚动；菜单自带添加与管理入口，空清单时这个按钮仍然有用。 -->
    <AppButton
      variant="unstyled"
      class="workspace-tab-command"
      aria-haspopup="dialog"
      :aria-expanded="commandMenuOpen"
      title="快捷命令"
      @click="toggleCommandMenu"
    >
      <svg class="workspace-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 17 5-5-5-5" /><path d="M12 19h7" /></svg>
      <span class="workspace-tab-command-label">命令</span>
    </AppButton>
  </div>

  <!-- 标签操作菜单：只放重命名，关闭仍用标签上的按钮，避免两个入口重复。 -->
  <Teleport to="body">
    <Transition name="pop-motion">
      <div
        v-if="renameOpen && menuTargetId !== null" ref="renamePopup"
        class="project-sidebar-menu flex flex-col"
        :style="renameMenuStyle" role="dialog" tabindex="-1" aria-label="标签操作"
        @keydown="onMenuKeydown($event, () => renameMenu.close(), renamePopup)"
      >
        <AppButton variant="unstyled" class="project-sidebar-menu-item" @click="renameFromMenu">
          重命名
        </AppButton>
      </div>
    </Transition>
  </Teleport>

  <!-- 新建菜单：对话与终端各一项；终端创建中时禁用终端项，不排队重复创建。 -->
  <Teleport to="body">
    <Transition name="pop-motion">
      <div
        v-if="createOpen" id="workspace-tab-create" ref="createPopup"
        class="project-sidebar-menu flex flex-col"
        :style="createMenuStyle" role="menu" tabindex="-1" aria-label="新建标签"
        @keydown="onMenuKeydown($event, () => createMenu.close(), createPopup)"
      >
        <AppButton variant="unstyled" class="project-sidebar-menu-item" role="menuitem" @click="createTab('chat')">
          新建对话
        </AppButton>
        <AppButton
          variant="unstyled" class="project-sidebar-menu-item" role="menuitem"
          :disabled="props.creating" @click="createTab('terminal')"
        >
          {{ props.creating ? '正在新建终端…' : '新建终端' }}
        </AppButton>
      </div>
    </Transition>
  </Teleport>
  <!-- 快捷命令菜单：Teleport 由组件自己完成，这里只挂载并把动作上抛给页面。 -->
  <QuickCommandMenu
    ref="commandMenu"
    :commands="props.quickCommands"
    :project-path="props.projectPath"
    @run="emit('runCommand', $event)"
    @edit="emit('editCommand', $event)"
    @remove="emit('removeCommand', $event)"
    @add="emit('addCommand', $event)"
    @manage="emit('manageCommands')"
    @open-change="commandMenuOpen = $event"
  />
</template>
