<!--
  提交区的动作组：左边是「提交」主按钮，右边是 ⌄ 开关，菜单里放提交类与远端类动作。

  形状照 Orca 的源代码管理：一个 split 按钮而不是几个并列按钮——左半是主操作（提交信息为空或没有
  暂存内容时禁用），右半始终可点，菜单里能看到全部动作以及每个动作此刻为什么不可用。远端动作与提交
  放在同一个菜单里，是因为它们本来就是一条流水线（提交 → 推送 / 拉取后再推送），分成两处会让人反复找。

  组件只派发意图：提交、提交并推送、拉取、推送都上抛给面板，由面板调 store 并决定要不要刷新历史。
  远端动作的禁用理由按仓库现状给出：没有远端不能推；没有上游且远端不止一个时不能自动发布分支。

  按钮五态与尺寸约定（这些值写在 `main.css` 的 `.git-split-*`，不在组件里）：
  默认中性描边（透明底 + `--panel-ink` 文字）/ 悬停 `--panel-hover` / 按下 8% 墨色 / 禁用只降为
  `--panel-muted` 文字、保留形状 / 焦点 2px 强调色描边。高度 26px、字号 12px，与改动行行高和分支行一致。
  两个按钮都用 `variant="unstyled"`：尺寸与颜色完全由 `.git-split-*` 决定，不与全局 `control-button-*`
  争优先级；强调色只用于页签下划线、选中文字与焦点环，不要再改回实心填充。
-->
<script setup lang="ts">
import { computed, nextTick } from 'vue'
import type { GitUpstream } from '../../../shared/git-api'
import { useAnchoredPopup } from '../ui/anchored-popup'
import AppButton from '../ui/AppButton.vue'

const props = defineProps<{
  /** 已暂存的改动数；为 0 时提交类动作不可用。 */
  readonly stagedCount: number
  /** 提交信息是否已填写（去空白后非空）。 */
  readonly messageReady: boolean
  readonly committing: boolean
  /** 正在执行的远端操作；null 表示空闲。 */
  readonly remoteBusy: 'pull' | 'push' | null
  readonly upstream: GitUpstream | null
  readonly remotes: readonly string[]
}>()

const emit = defineEmits<{
  commit: []
  commitAndPush: []
  pull: []
  push: []
}>()

/** 菜单宽度：按最长的一条「有多个远端，先在终端执行 git push -u 设置上游」量算。 */
const MENU_WIDTH = 248

const { trigger: menuTrigger, popup: menuPopup, isOpen: menuOpen, position: menuPosition, open: openPopup, close: closePopup } = useAnchoredPopup({ width: MENU_WIDTH, align: 'end' })
/** 菜单由父组件的按钮作为锚点；这里不做额外补偿，落点直接用共用工具的结果。 */
const menuStyle = computed(() => {
  const position = menuPosition.value
  return {
    left: `${position.left}px`,
    top: `${position.top}px`,
    width: `${position.width}px`,
    maxHeight: `${position.maxHeight}px`
  }
})

/** 任何动作在飞（提交或远端）时，整个动作组都不再接受新的动作。 */
const busy = computed(() => props.committing || props.remoteBusy !== null)
const hasRemote = computed(() => props.remotes.length > 0)
/** 没有上游时只有「恰好一个远端」才能自动发布分支；多个远端要用户先自己设置。 */
const canPublish = computed(() => props.upstream === null && props.remotes.length === 1)

/** 提交信息缺失时的原因；两个提交类动作共用。 */
const messageReason = computed(() => (
  props.messageReady ? null : '先填写提交信息再提交。'
))
const stagedReason = computed(() => (
  props.stagedCount === 0 ? '没有已暂存的改动，先暂存再提交。' : null
))

const commitDisabled = computed(() => busy.value || stagedReason.value !== null || messageReason.value !== null)
const commitTitle = computed(() => (
  props.committing ? '正在提交…' : stagedReason.value ?? messageReason.value ?? '提交已暂存的改动'
))

const commitPushDisabled = computed(() => (
  commitDisabled.value || (!hasRemote.value) || (props.upstream === null && props.remotes.length !== 1)
))
const commitPushTitle = computed(() => {
  if (stagedReason.value !== null) return stagedReason.value
  if (messageReason.value !== null) return messageReason.value
  if (!hasRemote.value) return '这个仓库还没有配置远端，先添加远端再推送。'
  if (!canPublish.value) return '仓库有多个远端，先在终端执行 git push -u <远端> <分支> 设置上游。'
  if (props.upstream === null) return `提交后推送到 ${props.remotes[0]} 并设置上游。`
  if (props.upstream.behind > 0) return '提交后推送；远端有更新时 git 会拒绝，先拉取再试。'
  return `提交后推送到 ${props.upstream.name}。`
})

const pullDisabled = computed(() => busy.value || props.upstream === null)
const pullTitle = computed(() => {
  if (props.upstream === null) return '当前分支还没有上游，没有可拉取的内容。'
  return `从 ${props.upstream.name} 拉取，合并还是变基沿用你的 git 配置。`
})

const pushDisabled = computed(() => busy.value || !hasRemote.value || (props.upstream === null && !canPublish.value))
const pushTitle = computed(() => {
  if (!hasRemote.value) return '这个仓库还没有配置远端。'
  if (props.upstream === null) {
    return canPublish.value
      ? `首次推送：推送到 ${props.remotes[0]} 并设置上游。`
      : '仓库有多个远端，先在终端执行 git push -u <远端> <分支> 设置上游。'
  }
  return props.upstream.ahead === 0
    ? `本地没有待推送的提交，推送只会确认与 ${props.upstream.name} 一致。`
    : `把 ${props.upstream.ahead} 个提交推送到 ${props.upstream.name}。`
})

/** 「推送」这一项的文案：有领先提交时带上计数，与菜单里其它项保持同一读法。 */
const pushLabel = computed(() => (
  props.upstream !== null && props.upstream.ahead > 0 ? `推送（↑${props.upstream.ahead}）` : '推送'
))
/** 「拉取」这一项的文案：落后数来自状态快照里的上游比较。 */
const pullLabel = computed(() => (
  props.upstream !== null && props.upstream.behind > 0 ? `拉取（↓${props.upstream.behind}）` : '拉取'
))
/** 左半主按钮的文案：忙碌时优先显示进度，其余时候就是「提交」。 */
const primaryLabel = computed(() => {
  if (props.committing) return '提交中…'
  if (props.remoteBusy !== null) return '同步中…'
  return '提交'
})

/** 主按钮只做提交：远端动作在右侧菜单里，避免把两种语义压进一个按钮。 */
function runPrimary(): void {
  if (commitDisabled.value) return
  emit('commit')
}

/**
 * 菜单项统一走这里：emit 是按事件名逐个声明的，联合类型不能直接传，
 * 因此按动作分派到各自的 emit，而不是用断言绕过类型。
 */
function run(action: 'commit' | 'commitAndPush' | 'pull' | 'push'): void {
  closePopup()
  switch (action) {
    case 'commit': emit('commit'); break
    case 'commitAndPush': emit('commitAndPush'); break
    case 'pull': emit('pull'); break
    case 'push': emit('push'); break
  }
}

/**
 * 打开菜单：锚点由事件自己给出（AppButton 的根元素就是那个按钮），不额外维护元素 ref。
 * 已展开时再点一次就收起；展开后焦点交给第一个可用项，键盘用户不用再 Tab 一次。
 */
function openMenu(event: MouseEvent): void {
  if (busy.value) return
  const trigger = event.currentTarget
  if (!(trigger instanceof HTMLElement)) return
  menuTrigger.value = trigger
  if (menuOpen.value) {
    closePopup()
    return
  }
  openPopup()
  void nextTick(() => {
    if (!menuOpen.value) return
    const target = menuPopup.value?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menuPopup.value
    target?.focus()
  })
}

/** 菜单内键盘：Esc 收起并还焦点，方向键与 Home/End 在可用项之间移动。 */
function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closePopup()
    void nextTick(() => menuTrigger.value?.focus())
    return
  }
  const items = Array.from(menuPopup.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
  if (items.length === 0) return
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const current = items.indexOf(document.activeElement as HTMLButtonElement)
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
    : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  items[index]?.focus()
}
</script>

<template>
  <div class="git-commit-actions">
    <span class="git-commit-hint">{{ props.stagedCount }} 个已暂存</span>
    <div class="git-split" role="group" aria-label="提交与远端操作" :aria-busy="busy">
      <AppButton
        variant="unstyled"
        class="git-split-primary"
        :disabled="commitDisabled"
        :title="commitTitle"
        @click="runPrimary"
      >
        <svg v-if="busy" class="git-split-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9" /></svg>
        <span aria-live="polite">{{ primaryLabel }}</span>
      </AppButton>
      <AppButton
        variant="unstyled"
        class="git-split-toggle"
        :disabled="busy"
        aria-haspopup="menu"
        :aria-expanded="menuOpen"
        aria-label="更多提交与远端操作"
        title="更多提交与远端操作"
        @click="openMenu"
      >
        <svg class="git-split-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </AppButton>
    </div>
  </div>

  <Teleport to="body">
    <div
      v-if="menuOpen"
      ref="menuPopup"
      class="project-sidebar-menu flex flex-col"
      :style="menuStyle"
      role="menu"
      tabindex="-1"
      aria-label="提交与远端操作"
      @keydown="onMenuKeydown"
    >
      <AppButton
        variant="unstyled"
        role="menuitem"
        class="project-sidebar-menu-item"
        :disabled="commitDisabled"
        :title="commitTitle"
        @click="run('commit')"
      >提交</AppButton>
      <AppButton
        variant="unstyled"
        role="menuitem"
        class="project-sidebar-menu-item"
        :disabled="commitPushDisabled"
        :title="commitPushTitle"
        @click="run('commitAndPush')"
      >提交并推送</AppButton>

      <div class="git-split-menu-separator" role="separator"></div>

      <AppButton
        variant="unstyled"
        role="menuitem"
        class="project-sidebar-menu-item"
        :disabled="pullDisabled"
        :title="pullTitle"
        @click="run('pull')"
      >{{ pullLabel }}</AppButton>
      <AppButton
        variant="unstyled"
        role="menuitem"
        class="project-sidebar-menu-item"
        :disabled="pushDisabled"
        :title="pushTitle"
        @click="run('push')"
      >{{ props.upstream === null && canPublish ? '发布分支' : pushLabel }}</AppButton>
    </div>
  </Teleport>
</template>
