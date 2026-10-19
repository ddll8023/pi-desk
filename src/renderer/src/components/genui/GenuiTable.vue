<!-- 表格：把同类记录排成可排序、可筛选的表，长表默认只展示前几行。
     排序与筛选都是视图状态：不写回文档、不参与参数提交，也不改变复制出的 Markdown（那里始终是全量、文档顺序）。
     排序做三态循环（原始 → 升 → 降 → 原始）而不是两态：模型给的原始行序常常本身就有意义（按时间、按优先级），
     一旦只能升/降，用户就没有办法回到它。
     空单元格恒定排在最后、不随升降序翻转：缺失不是「最小的值」，让它占据首行会被读成「最靠前」。
     行 key 用文档里的原始下标：排序与筛选只改变渲染顺序，不改变行的身份，否则复用节点会错位。
     列宽口径按数据形态推断（数值/短枚举/长文本），不根据列名猜测含义。 -->
<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import type { GenuiTableCell, GenuiTableNode, GenuiTableRow } from '../../../../shared/genui-api'
import AppButton from '../ui/AppButton.vue'

const props = defineProps<{
  readonly node: GenuiTableNode
}>()

/** 折叠预览的行数；展开后显示筛选与排序后的全部行。 */
const TABLE_PREVIEW_ROWS = 6

/** 列宽口径：数值右对齐等宽，短枚举紧凑，长文本换行。 */
type ColumnKind = 'numeric' | 'compact' | 'text'

type SortDirection = 'asc' | 'desc'

interface SortState {
  readonly key: string
  readonly direction: SortDirection
}

/** 一行及其文档下标；下标是行身份，排序与筛选都不改它。 */
interface TableRowEntry {
  readonly row: GenuiTableRow
  readonly index: number
}

const expanded = ref(false)
const keyword = ref('')
const sort = ref<SortState | null>(null)
const bodyId = useId()
const searchId = useId()

/** 列定义加上推断出的口径；列顺序始终是文档声明顺序，不随排序改变。 */
const columns = computed(() => props.node.columns.map((column) => {
  const values = props.node.rows.map((row) => row[column.key])
    .filter((value): value is GenuiTableCell => value !== undefined && value !== '')
  const numeric = values.length > 0 && values.every((value) => typeof value === 'number')
  const compact = !numeric && column.label.length <= 8
    && values.every((value) => String(value).length <= 12 && !String(value).includes('\n'))
  const kind: ColumnKind = numeric ? 'numeric' : compact ? 'compact' : 'text'
  return { ...column, kind }
}))

/** 原始行序：筛选与排序都从这份快照派生，保证「原始」态真的能回到文档顺序。 */
const sourceRows = computed<TableRowEntry[]>(() => props.node.rows.map((row, index) => ({ row, index })))

/** 筛选词；去空白并统一小写，中文不做大小写转换也不受影响。 */
const trimmedKeyword = computed(() => keyword.value.trim().toLocaleLowerCase('zh-CN'))

/**
 * 筛选结果：在所有列的展示文本里做子串匹配。
 * 不做列级筛选——界面里没有地方让用户挑列，而单列筛选会让「搜不到但其实在别的列」变成谜。
 */
const filteredRows = computed<TableRowEntry[]>(() => {
  const needle = trimmedKeyword.value
  if (needle === '') return sourceRows.value
  return sourceRows.value.filter((entry) => props.node.columns.some(
    (column) => cellText(entry.row[column.key]).toLocaleLowerCase('zh-CN').includes(needle)
  ))
})

/** 单元格是否为空；空值参与排序时单独处理，不参与比较。 */
function isEmptyCell(value: GenuiTableCell | undefined): boolean {
  return value === undefined || value === ''
}

/** 单元格比较：两侧都是数字按数值，其余按中文排序规则（数字串按数值比，避免「10」排在「9」前）。 */
function compareCells(left: GenuiTableCell, right: GenuiTableCell): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right
  return String(left).localeCompare(String(right), 'zh-CN', { numeric: true })
}

/** 排序结果：先筛后排，空值恒在末尾。 */
const sortedRows = computed<TableRowEntry[]>(() => {
  const current = sort.value
  if (current === null) return filteredRows.value
  const factor = current.direction === 'asc' ? 1 : -1
  return [...filteredRows.value].sort((left, right) => {
    const a = left.row[current.key]
    const b = right.row[current.key]
    if (a === undefined || a === '' || b === undefined || b === '') {
      const emptyA = isEmptyCell(a)
      const emptyB = isEmptyCell(b)
      return emptyA === emptyB ? 0 : emptyA ? 1 : -1
    }
    return compareCells(a, b) * factor
  })
})

/** 实际渲染的行：折叠时取前几行，展开时全量。 */
const visibleRows = computed(() => (
  expanded.value ? sortedRows.value : sortedRows.value.slice(0, TABLE_PREVIEW_ROWS)
))

/** 页脚出现条件：行数本来就超过预览长度，或正在筛选（此时要给命中计数）。 */
const showFooter = computed(() => props.node.rows.length > TABLE_PREVIEW_ROWS || trimmedKeyword.value !== '')

/** 页脚计数：匹配数只在筛选时出现，否则与总行数重复。 */
const countText = computed(() => {
  const parts = [`共 ${props.node.rows.length} 行`]
  if (trimmedKeyword.value !== '') parts.push(`匹配 ${filteredRows.value.length} 行`)
  parts.push(`已显示 ${visibleRows.value.length} 行`)
  return parts.join(' · ')
})

/** 单元格展示文本；数字按千分位，避免长数字难读。 */
function cellText(value: GenuiTableCell | undefined): string {
  if (value === undefined) return ''
  return typeof value === 'number' ? value.toLocaleString('zh-CN') : value
}

/** 三态循环：别的列 → 升序；同列升序 → 降序；同列降序 → 回到原始顺序。 */
function toggleSort(key: string): void {
  const current = sort.value
  if (current === null || current.key !== key) {
    sort.value = { key, direction: 'asc' }
    return
  }
  if (current.direction === 'asc') {
    sort.value = { key, direction: 'desc' }
    return
  }
  sort.value = null
}

/** 表头的排序状态，供 aria-sort 播报；非当前排序列为 none。 */
function ariaSort(key: string): 'ascending' | 'descending' | 'none' {
  const current = sort.value
  if (current === null || current.key !== key) return 'none'
  return current.direction === 'asc' ? 'ascending' : 'descending'
}

/** 表头按钮的提示：写清三态循环的下一步，否则用户只能靠点一下才知道会变成什么。 */
function sortHint(key: string, label: string): string {
  const current = sort.value
  if (current === null || current.key !== key) return `按${label}升序排序`
  if (current.direction === 'asc') return `按${label}降序排序`
  return `取消${label}的排序，恢复原始顺序`
}

function clearKeyword(): void {
  keyword.value = ''
}

// 文档改版后列与行都换了，旧的排序键与筛选词可能已经指不到任何数据，一并重置。
watch(() => props.node, () => {
  expanded.value = false
  keyword.value = ''
  sort.value = null
})
</script>

<template>
  <figure class="genui-table">
    <div class="genui-table-toolbar">
      <label class="genui-table-search" :for="searchId">
        <span class="genui-table-search-label">筛选</span>
        <input
          :id="searchId"
          v-model="keyword"
          class="text-control"
          type="search"
          autocomplete="off"
          :placeholder="`在 ${node.rows.length} 行里查找`"
        >
      </label>
      <AppButton v-if="keyword !== ''" variant="unstyled" class="genui-table-clear" @click="clearKeyword">
        清除筛选
      </AppButton>
    </div>
    <div class="genui-table-scroll" role="region" :aria-label="node.caption ?? '数据表格'" tabindex="0">
      <table>
        <thead>
          <tr>
            <th
              v-for="column in columns"
              :key="column.key"
              scope="col"
              :class="`genui-cell-${column.kind}`"
              :aria-sort="ariaSort(column.key)"
            >
              <button
                type="button"
                class="genui-table-sort"
                :title="sortHint(column.key, column.label)"
                :aria-label="sortHint(column.key, column.label)"
                @click="toggleSort(column.key)"
              >
                <span>{{ column.label }}</span>
                <svg class="genui-table-sort-icon" :class="`is-${ariaSort(column.key)}`" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="m5 6 3-3 3 3" />
                  <path d="m5 10 3 3 3-3" />
                </svg>
              </button>
            </th>
          </tr>
        </thead>
        <tbody :id="bodyId">
          <tr v-for="entry in visibleRows" :key="entry.index">
            <td v-for="column in columns" :key="column.key" :class="`genui-cell-${column.kind}`">
              {{ cellText(entry.row[column.key]) }}
            </td>
          </tr>
          <tr v-if="visibleRows.length === 0">
            <td :colspan="columns.length" class="genui-table-empty">没有匹配的行</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="showFooter" class="genui-table-footer">
      <span class="genui-table-count">{{ countText }}</span>
      <AppButton
        v-if="sortedRows.length > TABLE_PREVIEW_ROWS"
        variant="unstyled"
        class="genui-table-expand"
        :aria-expanded="expanded"
        :aria-controls="bodyId"
        @click="expanded = !expanded"
      >
        {{ expanded ? `收起至前 ${TABLE_PREVIEW_ROWS} 行` : `展开全部 ${sortedRows.length} 行` }}
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" :class="{ 'is-expanded': expanded }">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </AppButton>
    </div>
    <figcaption v-if="node.caption !== undefined" class="genui-caption">{{ node.caption }}</figcaption>
  </figure>
</template>
