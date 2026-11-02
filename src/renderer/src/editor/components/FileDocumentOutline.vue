<!-- 文档大纲侧边栏组件：统一呈现 PDF、DOCX 与 DOC 文档的书签与标题大纲，支持多级树折叠、当前条目高亮与快速定位。 -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

export interface DocumentOutlineItem {
  readonly id: string
  readonly label: string
  readonly level: number
  /** PDF 页码（从 1 起始） */
  pageNumber?: number
  /** PDF 目标原始引用或命名目标 */
  readonly dest?: unknown
  /** DOCX/DOC 渲染节点的 DOM ID */
  readonly domId?: string
  readonly children?: readonly DocumentOutlineItem[]
}

interface OutlineRow {
  readonly item: DocumentOutlineItem
  readonly depth: number
  readonly hasChildren: boolean
  readonly collapsed: boolean
}

const props = defineProps<{
  readonly entries: readonly DocumentOutlineItem[]
  readonly activeId: string
  readonly docType: 'pdf' | 'docx' | 'doc' | null
  readonly loading?: boolean
}>()

const emit = defineEmits<{
  navigate: [item: DocumentOutlineItem]
  close: []
}>()

const collapsedIds = ref<ReadonlySet<string>>(new Set<string>())
const listRef = ref<HTMLElement | null>(null)

/** 将多级树按当前折叠状态递归压平为可见行。 */
const rows = computed<readonly OutlineRow[]>(() => {
  const visible: OutlineRow[] = []
  const walk = (items: readonly DocumentOutlineItem[], depth: number): void => {
    for (const item of items) {
      const hasChildren = Boolean(item.children && item.children.length > 0)
      const collapsed = collapsedIds.value.has(item.id)
      visible.push({
        item,
        depth,
        hasChildren,
        collapsed
      })
      if (hasChildren && !collapsed && item.children) {
        walk(item.children, depth + 1)
      }
    }
  }
  walk(props.entries, 0)
  return visible
})

// 监听活动项变化并轻量滚动至可视区
watch(() => props.activeId, async (id) => {
  if (!id) return
  await nextTick()
  const host = listRef.value
  if (!host) return
  const row = host.querySelector<HTMLElement>(`[data-outline-id="${CSS.escape(id)}"]`)
  if (!row) return
  const bounds = host.getBoundingClientRect()
  const rowBounds = row.getBoundingClientRect()
  if (rowBounds.top >= bounds.top && rowBounds.bottom <= bounds.bottom) return
  row.scrollIntoView({ block: 'nearest' })
})

function toggleCollapse(id: string): void {
  const next = new Set(collapsedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsedIds.value = next
}

function onClickItem(item: DocumentOutlineItem): void {
  emit('navigate', item)
}
</script>

<template>
  <aside class="file-document-toc" aria-label="文档大纲">
    <header class="file-document-toc-header">
      <span class="file-document-toc-title">
        <svg viewBox="0 0 16 16" fill="currentColor" class="w-3.5 h-3.5 inline-block mr-1 text-desk-muted" aria-hidden="true">
          <path d="M2 3.75A.75.75 0 0 1 2.75 3h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 3.75zm0 4.25a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 8zm0 4.25a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 0 1.5h-6.5a.75.75 0 0 1-.75-.75z"/>
        </svg>
        文档大纲
      </span>
      <button
        type="button"
        class="file-document-toc-close"
        title="收起大纲"
        aria-label="收起大纲"
        @click="emit('close')"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" class="w-3.5 h-3.5" aria-hidden="true">
          <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z"/>
        </svg>
      </button>
    </header>

    <div ref="listRef" class="file-document-toc-list scroll-area">
      <!-- 加载提示 -->
      <div v-if="loading" class="file-document-toc-empty">
        <p>正在解析文档大纲…</p>
      </div>

      <!-- 大纲条目列表 -->
      <nav v-else-if="rows.length > 0" class="file-document-toc-nav" aria-label="文档大纲结构">
        <div
          v-for="row in rows"
          :key="row.item.id"
          :data-outline-id="row.item.id"
          class="file-document-toc-row"
          :class="{ 'is-active': row.item.id === activeId }"
          :style="{ paddingLeft: `${row.depth * 14 + 6}px` }"
        >
          <!-- 折叠三角展开按钮 -->
          <button
            v-if="row.hasChildren"
            type="button"
            class="file-document-toc-disclosure"
            :aria-label="row.collapsed ? '展开子目录' : '折叠子目录'"
            @click.stop="toggleCollapse(row.item.id)"
          >
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              :class="{ 'is-collapsed': row.collapsed }"
              aria-hidden="true"
            >
              <path d="m4.427 7.427 3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427Z"/>
            </svg>
          </button>
          <span v-else class="file-document-toc-disclosure is-empty" aria-hidden="true"></span>

          <!-- 条目文本链接 -->
          <button
            type="button"
            class="file-document-toc-link"
            :title="row.item.label"
            @click="onClickItem(row.item)"
          >
            <span class="file-document-toc-label">{{ row.item.label }}</span>
            <span v-if="row.item.pageNumber" class="file-document-toc-page">
              P.{{ row.item.pageNumber }}
            </span>
          </button>
        </div>
      </nav>

      <!-- 无大纲空状态提示 -->
      <div v-else class="file-document-toc-empty">
        <p v-if="docType === 'pdf'">该 PDF 未包含内置书签大纲</p>
        <p v-else-if="docType === 'docx'">该文档未检测到标题大纲</p>
        <p v-else>未检测到章节结构</p>
      </div>
    </div>
  </aside>
</template>
