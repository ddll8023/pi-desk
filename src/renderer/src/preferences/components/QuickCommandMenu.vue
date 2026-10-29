<!--
  快捷命令菜单：按作用域分组列出当前可用的命令（当前项目在前，全局在后），点一条就在终端里运行。

  作用域由组头表达，行内不再重复范围标记：项目命令是更具体的上下文，排在前面；全局命令是兜底。
  菜单由标签栏的「命令」按钮或终端内右键按需打开，锚点就是触发元素，定位、翻转与收边都交给共用的锚定浮层；
  样式复用侧栏菜单的类。每条命令一行：主体是运行入口，右侧是编辑与删除两个小动作，避免把菜单做成两级。
  菜单本身不写配置也不碰终端：运行、编辑、删除、添加、管理都上抛给调用方，由它决定落到哪里。
  终端里右键打开时额外提供「关闭全部终端」：终端由守护进程常驻，需要一个明确的清理入口；
  该入口默认不出现在标签栏的菜单里，由调用方用 `showCloseAll` 控制。
-->
<script setup lang="ts">
import { computed, nextTick } from 'vue'
import type { QuickCommand, QuickCommandScope } from '../../../../shared/quick-commands-api'
import { useAnchoredPopup } from '../../ui/anchored-popup'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  /** 当前可用的命令；组内顺序即展示顺序，调用方已按「项目命令在前、全局命令在后」排好，组顺序由作用域决定。 */
  readonly commands: readonly QuickCommand[]
  /** 当前项目路径；为空时项目级添加入口禁用。 */
  readonly projectPath: string | null
  /** 当前项目名；取不到时项目组标题退回「当前项目」，路径仍作为提示。 */
  readonly projectName: string | null
  /** 是否提供「关闭全部终端」：只在终端内右键菜单里为真。 */
  readonly showCloseAll?: boolean
}>()

const emit = defineEmits<{
  run: [command: QuickCommand]
  edit: [command: QuickCommand]
  remove: [command: QuickCommand]
  add: [scope: QuickCommandScope]
  manage: []
  /** 关闭全部终端（含其他项目）；只在 showCloseAll 时由菜单底部触发。 */
  closeAll: []
  /** 菜单展开状态变化；触发按钮据此维护 aria-expanded（点击外部收起也会上报）。 */
  openChange: [open: boolean]
}>()

/** 菜单宽度：按「在此项目添加」与命令行的标签加两个动作按钮留位。 */
const MENU_WIDTH = 264

/** 项目命令：只在当前项目可用，排在前面。 */
const projectCommands = computed(() => props.commands.filter((command) => command.scope === 'project'))
/** 全局命令：兜底范围，排在项目命令之后。 */
const globalCommands = computed(() => props.commands.filter((command) => command.scope === 'global'))
/** 项目组标题：有项目名就用项目名，取不到时退回「当前项目」，路径始终在提示里给出。 */
const projectGroupTitle = computed(() => props.projectName ?? '当前项目')

/** 打开菜单的触发元素；关闭时把焦点还给它。 */
let anchor: HTMLElement | null = null
/** 右键菜单的临时锚点；只在按指针位置打开时存在，收起时一并移除。 */
let pointAnchor: HTMLElement | null = null

const menu = useAnchoredPopup({
  width: MENU_WIDTH,
  align: 'start',
  onClose: () => {
    anchor = null
    pointAnchor?.remove()
    pointAnchor = null
    emit('openChange', false)
  }
})
const { trigger: menuTrigger, popup: menuPopup, isOpen: menuOpen, position: menuPosition, open: openPopup, close: closePopup } = menu
/** 落点直接取共用锚定工具的结果：浮层高度由工具按实测值参与定位，调用点不再自行补偿。 */
const menuStyle = computed(() => {
  const position = menuPosition.value
  return {
    left: `${position.left}px`, top: `${position.top}px`,
    width: `${position.width}px`, maxHeight: `${position.maxHeight}px`
  }
})

/**
 * 打开菜单：锚定触发元素并把焦点交给第一项；已展开时先收起再展开，
 * 否则锚定工具会因为「已经展开」而跳过重新定位，菜单会停在上一处。
 */
function openMenu(anchorElement: HTMLElement): void {
  closePopup()
  anchor = anchorElement
  menuTrigger.value = anchorElement
  openPopup()
  emit('openChange', true)
  void nextTick(() => {
    if (!menuOpen.value) return
    const first = menuPopup.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    if (first) first.focus()
    else menuPopup.value?.focus()
  })
}

/** 收起菜单；明确的键盘关闭才把焦点还给触发元素，点击外部收起不抢占焦点。 */
function closeMenu(restoreFocus = false): void {
  const element = anchor
  const wasOpen = closePopup()
  if (restoreFocus && wasOpen) {
    void nextTick(() => {
      if (element?.isConnected) element.focus()
    })
  }
}

defineExpose({ open: openMenu, close: closeMenu, openAtPoint })

/**
 * 按指针位置打开：右键菜单没有现成的触发元素，这里在指针处造一个不可见的 1px 锚点，
 * 定位、翻转与收边仍交给锚定工具；锚点随菜单收起一起移除，不留在页面里。
 */
function openAtPoint(x: number, y: number): void {
  // 先收起当前菜单：已展开时收起会清掉旧锚点，避免新锚点被当成旧锚点删掉。
  closePopup()
  const marker = document.createElement('div')
  marker.style.position = 'fixed'
  marker.style.left = `${x}px`
  marker.style.top = `${y}px`
  marker.style.width = '1px'
  marker.style.height = '1px'
  marker.style.pointerEvents = 'none'
  document.body.appendChild(marker)
  pointAnchor = marker
  openMenu(marker)
}

/** 动作统一先收起菜单再上抛：菜单不再挡在结果提示与终端前面。 */
function run(command: QuickCommand): void {
  closeMenu()
  emit('run', command)
}

function edit(command: QuickCommand): void {
  closeMenu()
  emit('edit', command)
}

function remove(command: QuickCommand): void {
  closeMenu()
  emit('remove', command)
}

function add(scope: QuickCommandScope): void {
  closeMenu()
  emit('add', scope)
}

function manage(): void {
  closeMenu()
  emit('manage')
}

/** 关闭全部终端：与运行命令一样先收起菜单，再由调用方执行并提示结果。 */
function closeAll(): void {
  closeMenu()
  emit('closeAll')
}

/** 命令的提示：命令文本可能多行，只取首行做 tooltip。 */
function commandHint(command: QuickCommand): string {
  return command.command.split('\n')[0] ?? command.command
}

/** 菜单内键盘：Esc 收起并还焦点，方向键与 Home/End 在菜单项间移动，Tab 只在菜单内循环。 */
function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeMenu(true)
    return
  }
  const buttons = Array.from(menuPopup.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
  if (buttons.length === 0) return
  if (event.key === 'Tab') {
    event.preventDefault()
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.shiftKey
      ? (index <= 0 ? buttons.length - 1 : index - 1)
      : (index === buttons.length - 1 ? 0 : index + 1)
    buttons[next]?.focus()
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[index]?.focus()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="pop-motion">
      <div
        v-if="menuOpen"
        ref="menuPopup"
        class="project-sidebar-menu flex flex-col"
        :style="menuStyle"
        role="dialog"
        tabindex="-1"
        aria-label="快捷命令"
        @keydown="onMenuKeydown"
      >
        <div class="sidebar-menu-details">
          <p class="sidebar-menu-title">快捷命令</p>
          <p v-if="props.projectPath === null" class="sidebar-menu-path">
            当前没有项目，只能使用全局命令。
          </p>
        </div>

        <p v-if="props.commands.length === 0" class="quick-command-empty">
          还没有快捷命令，先在下方添加一条。
        </p>

        <!-- 项目组：只在当前项目有命令时出现；空组不占位置，添加入口在底部。 -->
        <section
          v-if="props.projectPath !== null && projectCommands.length > 0"
          class="quick-command-group is-project"
          aria-label="当前项目的快捷命令"
        >
          <p class="quick-command-group-head" :title="props.projectPath">
            <span class="scope-dot is-project" aria-hidden="true"></span>
            <span class="quick-command-group-title">{{ projectGroupTitle }}</span>
            <span class="quick-command-group-count">{{ projectCommands.length }}</span>
          </p>
          <div v-for="command in projectCommands" :key="command.id" class="quick-command-row">
            <AppButton
              variant="unstyled"
              class="project-sidebar-menu-item quick-command-run"
              :title="commandHint(command)"
              @click="run(command)"
            >
              <span class="quick-command-label">{{ command.label }}</span>
            </AppButton>
            <AppButton
              variant="unstyled"
              class="project-sidebar-menu-item quick-command-action"
              :aria-label="`编辑 ${command.label}`"
              :title="`编辑 ${command.label}`"
              @click="edit(command)"
            >
              编辑
            </AppButton>
            <AppButton
              variant="unstyled"
              class="project-sidebar-menu-item quick-command-action is-danger"
              :aria-label="`删除 ${command.label}`"
              :title="`删除 ${command.label}`"
              @click="remove(command)"
            >
              删除
            </AppButton>
          </div>
        </section>

        <!-- 全局组：所有项目可用，标题弱一档，不与项目命令争注意力。 -->
        <section
          v-if="globalCommands.length > 0"
          class="quick-command-group is-global"
          aria-label="全局快捷命令"
        >
          <p class="quick-command-group-head">
            <span class="scope-dot" aria-hidden="true"></span>
            <span class="quick-command-group-title">全局</span>
            <span class="quick-command-group-count">{{ globalCommands.length }}</span>
          </p>
          <div v-for="command in globalCommands" :key="command.id" class="quick-command-row">
            <AppButton
              variant="unstyled"
              class="project-sidebar-menu-item quick-command-run"
              :title="commandHint(command)"
              @click="run(command)"
            >
              <span class="quick-command-label">{{ command.label }}</span>
            </AppButton>
            <AppButton
              variant="unstyled"
              class="project-sidebar-menu-item quick-command-action"
              :aria-label="`编辑 ${command.label}`"
              :title="`编辑 ${command.label}`"
              @click="edit(command)"
            >
              编辑
            </AppButton>
            <AppButton
              variant="unstyled"
              class="project-sidebar-menu-item quick-command-action is-danger"
              :aria-label="`删除 ${command.label}`"
              :title="`删除 ${command.label}`"
              @click="remove(command)"
            >
              删除
            </AppButton>
          </div>
        </section>

        <div class="quick-command-menu-divider" role="separator"></div>

        <AppButton variant="unstyled" class="project-sidebar-menu-item" @click="add('global')">
          添加全局命令
        </AppButton>
        <AppButton
          variant="unstyled"
          class="project-sidebar-menu-item"
          :disabled="props.projectPath === null"
          :title="props.projectPath === null ? '当前没有项目' : '保存后只在这个项目可用'"
          @click="add('project')"
        >
          在此项目添加
        </AppButton>
        <AppButton variant="unstyled" class="project-sidebar-menu-item" @click="manage">
          管理快捷命令…
        </AppButton>

        <!-- 终端常驻后的清理入口：只在终端内右键菜单出现，不与快捷命令的添加入口混在一起。 -->
        <template v-if="props.showCloseAll === true">
          <div class="quick-command-menu-divider" role="separator"></div>
          <AppButton
            variant="unstyled"
            class="project-sidebar-menu-item is-danger"
            title="结束全部终端及其中的进程（含其他项目）"
            @click="closeAll"
          >
            关闭全部终端
          </AppButton>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>
