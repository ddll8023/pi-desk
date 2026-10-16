<!--
  工作区标签条：对话与各终端标签同处一组，横向滚动不换行，右端固定新建按钮。

  标签只负责展示与派发意图：终端清单、活动标签与标题都来自终端 store，重命名在页面内生效、不回传主进程。
  双击标签进入重命名（编辑态用输入框替换按钮，避免把输入框嵌在按钮里），Enter 或失焦提交、Esc 取消。
  方向键与 Home/End 在同组标签间移动活动标签，顺序与视觉顺序一致（对话在最前）。
-->
<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import { nextTick, ref } from 'vue'
import type { TerminalSessionInfo } from '../../../shared/terminal-api'
import { CHAT_TAB_ID } from '../stores/terminal'
import AppButton from './ui/AppButton.vue'

const props = defineProps<{
  readonly sessions: readonly TerminalSessionInfo[]
  readonly activeTab: string
  /** 页面内的标题；未记录时回落到主进程给的默认标题。 */
  readonly titles: Readonly<Record<string, string>>
  readonly creating: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  close: [id: string]
  create: []
  rename: [id: string, title: string]
}>()

/** 正在重命名的终端标识；同一时刻只编辑一个标签。 */
const editingId = ref<string | null>(null)
const draft = ref('')
/** 重命名输入框：在 v-for 内渲染，用函数 ref 取当前那一个。 */
let renameInput: HTMLInputElement | null = null

function titleOf(session: TerminalSessionInfo): string {
  const title = props.titles[session.id]
  return title === undefined || title === '' ? session.title : title
}

/** 悬停提示补齐被截断的信息：标题、shell、工作目录与运行状态。 */
function tooltipOf(session: TerminalSessionInfo): string {
  const status = session.status === 'exited' ? `已退出（退出码 ${session.exitCode ?? 0}）` : '运行中'
  return `${titleOf(session)}\n${session.shell}\n${session.cwd}\n${status}`
}

function setRenameInput(element: Element | ComponentPublicInstance | null): void {
  renameInput = element instanceof HTMLInputElement ? element : null
}

async function startRename(session: TerminalSessionInfo): Promise<void> {
  editingId.value = session.id
  draft.value = titleOf(session)
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

/** 键盘顺序即视觉顺序：对话在最前，其余按清单顺序。 */
function tabIds(): string[] {
  return [CHAT_TAB_ID, ...props.sessions.map((session) => session.id)]
}

function onTablistKeydown(event: KeyboardEvent): void {
  const ids = tabIds()
  const current = ids.indexOf(props.activeTab)
  if (current < 0) return
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  const isBoundary = event.key === 'Home' || event.key === 'End'
  if (step === 0 && !isBoundary) return
  event.preventDefault()
  const target = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : current + step
  const id = ids[target]
  if (id !== undefined) emit('select', id)
}
</script>

<template>
  <div class="workspace-tabs">
    <div class="workspace-tabs-strip" role="tablist" aria-label="工作区标签" @keydown="onTablistKeydown">
      <div class="workspace-tab" :class="{ 'is-active': props.activeTab === CHAT_TAB_ID }">
        <button
          type="button"
          role="tab"
          class="workspace-tab-main"
          :aria-selected="props.activeTab === CHAT_TAB_ID"
          :tabindex="props.activeTab === CHAT_TAB_ID ? 0 : -1"
          @click="emit('select', CHAT_TAB_ID)"
        >
          <svg class="workspace-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a7 7 0 0 1-7 7H8l-4 3v-5.5A7 7 0 0 1 11 5h2a7 7 0 0 1 7 7Z" /></svg>
          <span class="workspace-tab-title">对话</span>
        </button>
      </div>

      <div
        v-for="session in props.sessions"
        :key="session.id"
        class="workspace-tab"
        :class="{ 'is-active': props.activeTab === session.id }"
      >
        <input
          v-if="editingId === session.id"
          :ref="setRenameInput"
          v-model="draft"
          class="workspace-tab-rename"
          type="text"
          aria-label="终端标题"
          @keydown.enter.prevent="commitRename"
          @keydown.esc.prevent="cancelRename"
          @blur="commitRename"
        />
        <button
          v-else
          type="button"
          role="tab"
          class="workspace-tab-main"
          :aria-selected="props.activeTab === session.id"
          :tabindex="props.activeTab === session.id ? 0 : -1"
          :title="tooltipOf(session)"
          @click="emit('select', session.id)"
          @dblclick="startRename(session)"
        >
          <span
            class="workspace-tab-dot"
            :class="session.status === 'exited' ? 'is-exited' : 'is-running'"
            aria-hidden="true"
          ></span>
          <span class="workspace-tab-title">{{ titleOf(session) }}</span>
        </button>
        <AppButton
          variant="unstyled"
          class="workspace-tab-close"
          :aria-label="`关闭终端 ${titleOf(session)}`"
          :title="`关闭 ${titleOf(session)}`"
          @click.stop="emit('close', session.id)"
        >
          <svg class="workspace-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
        </AppButton>
      </div>
    </div>

    <AppButton
      variant="unstyled"
      class="workspace-tab-new"
      :disabled="props.creating"
      aria-label="新建终端"
      :title="props.creating ? '正在新建终端' : '新建终端'"
      @click="emit('create')"
    >
      <svg class="workspace-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
    </AppButton>
  </div>
</template>
