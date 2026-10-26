<!--
  单文件差异视图：统一视图、只读、行号与增删计数都在头部。
  支持就地暂存/取消暂存/丢弃、上一个/下一个改动快捷遍历，以及跳转至编辑器。

  差异由主进程给出两侧内容（`GitTextDiff`），行级对齐与增删统计在渲染端算（`git-diff.ts`）：
  这样既不用把补丁文本再解析一遍，也不需要在主进程里塞一个 diff 库。二进制与超大文件只给提示，
  不提供内容；两侧内容都为 null 时同样按提示处理，不假装「没有差异」。

  同一个视图服务两处：工作区改动（对比索引/HEAD）与历史里的提交（对比父提交）。
  两处的区别只有头部标签与「能否在编辑器里打开当前文件」，因此用 `label` 与 `openable` 表达。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import type { DesktopError } from '../../../../shared/desktop-api'
import type { GitTextDiff } from '../../../../shared/git-api'
import { buildDiffRows } from '../git-diff'
import AppButton from '../../ui/AppButton.vue'

const props = withDefaults(defineProps<{
  readonly path: string
  /** 头部右侧的标签：工作区差异是区域名，历史里是短哈希。 */
  readonly label: string
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly diff: GitTextDiff | null
  readonly error: DesktopError | null
  /** 能否把当前文件交给编辑器打开；历史里的旧版本文件可能已经不存在，因此默认允许、按需关掉。 */
  readonly openable?: boolean
  readonly hasNext?: boolean
  readonly hasPrev?: boolean
  readonly indexLabel?: string
  readonly canStage?: boolean
  readonly canUnstage?: boolean
  readonly canDiscard?: boolean
  readonly busy?: boolean
}>(), {
  openable: true,
  hasNext: false,
  hasPrev: false,
  indexLabel: '',
  canStage: false,
  canUnstage: false,
  canDiscard: false,
  busy: false
})

const emit = defineEmits<{
  back: []
  open: []
  next: []
  prev: []
  stage: []
  unstage: []
  discard: []
}>()

const text = computed(() => (props.diff?.kind === 'text' ? props.diff : null))
const rows = computed(() => (
  text.value === null ? null : buildDiffRows(text.value.originalText, text.value.modifiedText)
))

const baseName = computed(() => {
  const slash = props.path.lastIndexOf('/')
  return slash < 0 ? props.path : props.path.slice(slash + 1)
})
const directory = computed(() => {
  const slash = props.path.lastIndexOf('/')
  return slash < 0 ? '' : props.path.slice(0, slash)
})

function onKeydown(event: KeyboardEvent): void {
  // 避免在文本输入控件中按键时误触发导航
  if (['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement)?.tagName)) return

  if (event.key === 'Escape') {
    event.preventDefault()
    emit('back')
  } else if (event.altKey && (event.key === 'ArrowUp' || event.key === '[')) {
    event.preventDefault()
    if (props.hasPrev) emit('prev')
  } else if (event.altKey && (event.key === 'ArrowDown' || event.key === ']')) {
    event.preventDefault()
    if (props.hasNext) emit('next')
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="git-diff">
    <header class="git-diff-header">
      <div class="git-diff-nav">
        <AppButton variant="unstyled" class="git-diff-back" aria-label="返回列表 (Esc)" title="返回列表 (Esc)" @click="emit('back')">
          <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
        </AppButton>
        <template v-if="props.indexLabel !== ''">
          <AppButton
            variant="unstyled"
            class="git-diff-nav-btn"
            :disabled="!props.hasPrev"
            aria-label="上一个更改 (Alt+↑)"
            title="上一个更改 (Alt+↑)"
            @click="emit('prev')"
          >
            <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6" /></svg>
          </AppButton>
          <AppButton
            variant="unstyled"
            class="git-diff-nav-btn"
            :disabled="!props.hasNext"
            aria-label="下一个更改 (Alt+↓)"
            title="下一个更改 (Alt+↓)"
            @click="emit('next')"
          >
            <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </AppButton>
          <span class="git-diff-nav-count">{{ props.indexLabel }}</span>
        </template>
      </div>

      <span class="git-diff-title" :title="props.path">
        <span class="git-diff-name">{{ baseName }}</span>
        <span v-if="directory !== ''" class="git-diff-dir">{{ directory }}</span>
      </span>

      <span class="git-diff-area">{{ props.label }}</span>

      <div class="git-diff-actions">
        <AppButton
          v-if="props.canStage"
          variant="unstyled"
          class="git-diff-action-btn"
          :disabled="props.busy"
          aria-label="暂存此更改"
          title="暂存此更改"
          @click="emit('stage')"
        >
          <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </AppButton>
        <AppButton
          v-if="props.canUnstage"
          variant="unstyled"
          class="git-diff-action-btn"
          :disabled="props.busy"
          aria-label="取消暂存"
          title="取消暂存此更改"
          @click="emit('unstage')"
        >
          <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14" /></svg>
        </AppButton>
        <AppButton
          v-if="props.canDiscard"
          variant="unstyled"
          class="git-diff-action-btn is-danger"
          :disabled="props.busy"
          aria-label="丢弃此更改"
          title="丢弃此更改"
          @click="emit('discard')"
        >
          <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /><path d="M6 7l1 13h10l1-13" /></svg>
        </AppButton>
        <AppButton
          v-if="props.openable"
          variant="unstyled"
          class="git-diff-open"
          aria-label="在编辑器中打开"
          title="在编辑器中打开"
          @click="emit('open')"
        >
          <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></svg>
        </AppButton>
      </div>
    </header>

    <div class="git-diff-scroll scroll-area">
      <p v-if="props.phase === 'loading' || props.phase === 'idle'" class="git-diff-notice">正在读取差异…</p>
      <p v-else-if="props.phase === 'error'" class="git-diff-notice is-error">{{ props.error?.message ?? '读取差异失败。' }}</p>

      <template v-else-if="props.diff !== null">
        <p v-if="props.diff.kind === 'binary'" class="git-diff-notice">这是二进制文件，不展示行级差异。</p>
        <p v-else-if="props.diff.kind === 'too-large'" class="git-diff-notice">文件过大，不展示行级差异；可以在编辑器中打开查看。</p>
        <p v-else-if="rows !== null && rows.rows.length === 0" class="git-diff-notice">两侧内容相同，没有可展示的差异。</p>

        <template v-else-if="rows !== null">
          <div class="git-diff-stats">
            <span class="git-diff-stat is-add">+{{ rows.added }}</span>
            <span class="git-diff-stat is-remove">−{{ rows.removed }}</span>
            <span v-if="rows.truncated" class="git-diff-stat is-muted">仅显示前 5000 行</span>
          </div>
          <div class="git-diff-lines" role="table" aria-label="差异内容">
            <div
              v-for="(row, index) in rows.rows"
              :key="index"
              class="git-diff-line"
              :class="`is-${row.kind}`"
              role="row"
            >
              <span class="git-diff-gutter" role="cell">{{ row.oldLine ?? '' }}</span>
              <span class="git-diff-gutter" role="cell">{{ row.newLine ?? '' }}</span>
              <span class="git-diff-sign" role="cell">{{ row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : '' }}</span>
              <span class="git-diff-code" role="cell">{{ row.text === '' ? ' ' : row.text }}</span>
            </div>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>
