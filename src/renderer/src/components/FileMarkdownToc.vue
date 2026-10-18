<!--
  文件预览的目录面板：按标题层级列出文档结构，支持层级过滤、子树折叠与当前标题高亮。

  条目来自预览渲染后的标题扫描（扁平数组，带 level）。面板内部先按 level 还原成树：层级只增不减，
  用栈就能在 O(n) 内确定父子关系，不需要额外的缩进字段。层级过滤取「最多显示到第几级」的语义，
  过滤只影响展示，不改变折叠状态；折叠按标题 id 记录，换文档时整体清空。

  当前标题由父级按滚动位置算出后传入：面板只负责高亮与在必要时把该行滚进可视区，
  不自己监听滚动，避免两个滚动源互相触发。
-->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { FileMarkdownTocEntry } from '../file-markdown'
import AppButton from './ui/AppButton.vue'

const props = defineProps<{
  /** 文档标题清单，顺序与正文一致。 */
  readonly entries: readonly FileMarkdownTocEntry[]
  /** 当前阅读位置的标题 id；为空表示还没进入任何标题。 */
  readonly activeId: string
}>()

const emit = defineEmits<{
  navigate: [id: string]
  close: []
}>()

/** 可选的层级过滤档位；中文文档很少用到 h4 以下，三档足够。 */
const LEVELS = [1, 2, 3] as const

/** 目录节点：只保留展示需要的字段，子节点顺序与正文一致。 */
interface TocNode {
  readonly entry: FileMarkdownTocEntry
  readonly children: TocNode[]
}

/** 渲染行：折叠后可见的条目，`depth` 已按可见父级压缩，缩进不会因为过滤出现空档。 */
interface TocRow {
  readonly id: string
  readonly label: string
  readonly depth: number
  readonly hasChildren: boolean
  readonly collapsed: boolean
}

/** 最多显示到第几级标题；默认三档全开。 */
const maxLevel = ref<number>(3)
/** 折叠的标题 id 集合；整体替换以触发响应式更新。 */
const collapsedIds = ref<ReadonlySet<string>>(new Set<string>())
const list = ref<HTMLElement | null>(null)

/** 扁平条目还原成树：弹掉层级不低于当前项的节点，栈顶就是父节点。 */
const tree = computed<readonly TocNode[]>(() => {
  const roots: TocNode[] = []
  const stack: TocNode[] = []
  for (const entry of props.entries) {
    const node: TocNode = { entry, children: [] }
    while (stack.length > 0 && (stack[stack.length - 1]?.entry.level ?? 0) >= entry.level) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent === undefined) roots.push(node)
    else parent.children.push(node)
    stack.push(node)
  }
  return roots
})

/** 按过滤档位与折叠状态展开成可见行；超档的条目连同子树一起跳过。 */
const rows = computed<readonly TocRow[]>(() => {
  const visible: TocRow[] = []
  const walk = (nodes: readonly TocNode[], depth: number): void => {
    for (const node of nodes) {
      if (node.entry.level > maxLevel.value) continue
      const collapsed = collapsedIds.value.has(node.entry.id)
      visible.push({
        id: node.entry.id,
        label: node.entry.label,
        depth,
        hasChildren: node.children.length > 0,
        collapsed
      })
      if (!collapsed) walk(node.children, depth + 1)
    }
  }
  walk(tree.value, 0)
  return visible
})

// 换文档后旧 id 可能不存在，折叠状态留着没有意义，直接清空。
watch(() => props.entries, () => { collapsedIds.value = new Set<string>() })

// 当前标题变化时把它带进可视区；`nearest` 只在该行越界时滚动，不会打断用户自己翻目录。
watch(() => props.activeId, async (id) => {
  if (id === '') return
  await nextTick()
  const host = list.value
  const row = host?.querySelector<HTMLElement>(`[data-toc-id="${CSS.escape(id)}"]`)
  if (row === null || row === undefined) return
  const bounds = host?.getBoundingClientRect()
  const rowBounds = row.getBoundingClientRect()
  if (bounds === undefined) return
  if (rowBounds.top >= bounds.top && rowBounds.bottom <= bounds.bottom) return
  row.scrollIntoView({ block: 'nearest' })
})

function setMaxLevel(level: number): void {
  maxLevel.value = level
}

/** 折叠/展开一个子树；同一时刻只改一项，其余状态保留。 */
function toggleCollapse(id: string): void {
  const next = new Set(collapsedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsedIds.value = next
}
</script>

<template>
  <nav class="file-markdown-toc" aria-label="文档目录">
    <header class="file-markdown-toc-header">
      <p class="file-markdown-toc-title">目录</p>
      <div class="file-markdown-toc-levels" role="group" aria-label="目录层级">
        <button
          v-for="level in LEVELS"
          :key="level"
          type="button"
          class="file-markdown-toc-level"
          :class="{ 'is-active': maxLevel === level }"
          :aria-pressed="maxLevel === level"
          :title="`最多显示到 ${level} 级标题`"
          @click="setMaxLevel(level)"
        >H{{ level }}</button>
      </div>
      <AppButton
        variant="unstyled"
        class="file-markdown-toc-close"
        aria-label="关闭目录"
        title="关闭目录"
        @click="emit('close')"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </AppButton>
    </header>

    <div v-if="rows.length > 0" ref="list" class="file-markdown-toc-list scroll-area">
      <div
        v-for="row in rows"
        :key="row.id"
        class="file-markdown-toc-row"
        :class="{ 'is-active': row.id === activeId }"
        :data-toc-id="row.id"
        :style="{ paddingLeft: `${row.depth * 12}px` }"
      >
        <button
          v-if="row.hasChildren"
          type="button"
          class="file-markdown-toc-disclosure"
          :aria-expanded="!row.collapsed"
          :aria-label="row.collapsed ? `展开「${row.label}」` : `折叠「${row.label}」`"
          @click="toggleCollapse(row.id)"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" :class="{ 'is-collapsed': row.collapsed }">
            <path d="M6 4l4 4-4 4" />
          </svg>
        </button>
        <span v-else class="file-markdown-toc-disclosure is-empty" aria-hidden="true"></span>
        <button
          type="button"
          class="file-markdown-toc-link"
          :aria-current="row.id === activeId ? 'location' : undefined"
          :title="row.label"
          @click="emit('navigate', row.id)"
        >{{ row.label }}</button>
      </div>
    </div>
    <p v-else class="file-markdown-toc-empty">文档没有可列出的标题。</p>
  </nav>
</template>
