<!-- 表格文件预览：统一支持 Excel 多工作表切换与纯文本表格（CSV/TSV）解析，提供只读结构化网格、排序与搜索。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type {
  ProjectFileSpreadsheetContent,
  ProjectFileSpreadsheetSheet
} from '../../../../shared/project-file-api'

const props = defineProps<{
  readonly path: string
  readonly active: boolean
  readonly text?: string | null
  readonly spreadsheet?: ProjectFileSpreadsheetContent | null
}>()

/** 解析纯文本分隔符表格（CSV / TSV / PSV），遵循 RFC 4180 双引号与换行转义规则。 */
function parseDelimitedText(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const len = text.length

  while (i < len) {
    const char = text[i]
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < len && text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        } else {
          inQuotes = false
          i++
          continue
        }
      } else {
        field += char
        i++
        continue
      }
    } else {
      if (char === '"') {
        inQuotes = true
        i++
        continue
      } else if (char === delimiter) {
        row.push(field)
        field = ''
        i++
        continue
      } else if (char === '\r' || char === '\n') {
        if (char === '\r' && i + 1 < len && text[i + 1] === '\n') i++
        row.push(field)
        rows.push(row)
        row = []
        field = ''
        i++
        continue
      } else {
        field += char
        i++
        continue
      }
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** 按文件扩展名判定文本分隔符。 */
function delimiterForPath(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.tsv') || lower.endsWith('.tab')) return '\t'
  if (lower.endsWith('.psv')) return '|'
  return ','
}

/** 当前解析出的所有工作表。Excel 自带多 Sheet，文本表格生成单一 Sheet。 */
const allSheets = computed<readonly ProjectFileSpreadsheetSheet[]>(() => {
  if (props.spreadsheet && props.spreadsheet.sheets.length > 0) {
    return props.spreadsheet.sheets
  }
  if (props.text !== undefined && props.text !== null) {
    const delimiter = delimiterForPath(props.path)
    const rawRows = parseDelimitedText(props.text, delimiter)
    let totalColumns = 0
    for (const r of rawRows) {
      if (r.length > totalColumns) totalColumns = r.length
    }
    const paddedRows = rawRows.map((r) => {
      if (r.length >= totalColumns) return r
      const next = [...r]
      while (next.length < totalColumns) next.push('')
      return next
    })
    return [{
      name: '表格',
      rows: paddedRows,
      totalRows: paddedRows.length,
      totalColumns,
      truncated: false
    }]
  }
  return []
})

const activeSheetIndex = ref(0)
const keyword = ref('')
type SortDirection = 'asc' | 'desc'
interface SortState {
  readonly colIndex: number
  readonly direction: SortDirection
}
const sort = ref<SortState | null>(null)

// 切换文件或工作表时重置页内交互状态
watch(() => props.path, () => {
  activeSheetIndex.value = 0
  keyword.value = ''
  sort.value = null
})

watch(activeSheetIndex, () => {
  keyword.value = ''
  sort.value = null
})

const currentSheet = computed<ProjectFileSpreadsheetSheet | null>(() => {
  if (allSheets.value.length === 0) return null
  return allSheets.value[activeSheetIndex.value] ?? allSheets.value[0] ?? null
})

const isEmpty = computed(() => !currentSheet.value || currentSheet.value.rows.length === 0)

/** 提取表头（第 0 行）与表体（后续行）；若仅有 1 行则表体为空。 */
const headers = computed<readonly string[]>(() => {
  const sheet = currentSheet.value
  if (!sheet || sheet.rows.length === 0) return []
  const first = sheet.rows[0]
  if (sheet.totalColumns <= 0) return []
  const result: string[] = []
  for (let c = 0; c < sheet.totalColumns; c++) {
    const val = first?.[c]?.trim()
    result.push(val && val.length > 0 ? val : `列 ${c + 1}`)
  }
  return result
})

interface TableRowItem {
  readonly row: readonly string[]
  readonly originalIndex: number
}

const sourceBodyRows = computed<TableRowItem[]>(() => {
  const sheet = currentSheet.value
  if (!sheet || sheet.rows.length <= 1) return []
  return sheet.rows.slice(1).map((row, index) => ({
    row,
    originalIndex: index + 1
  }))
})

/** 判断某一列是否几乎全为纯数字，以此决定列右对齐与数字比较。 */
const numericColumns = computed(() => {
  const sheet = currentSheet.value
  if (!sheet || sheet.totalColumns <= 0) return new Set<number>()
  const set = new Set<number>()
  const rows = sourceBodyRows.value
  if (rows.length === 0) return set

  for (let c = 0; c < sheet.totalColumns; c++) {
    let nonEmptyCount = 0
    let numericCount = 0
    for (const item of rows) {
      const val = item.row[c]?.trim() ?? ''
      if (val === '') continue
      nonEmptyCount++
      if (!Number.isNaN(Number(val)) && !Number.isNaN(parseFloat(val))) {
        numericCount++
      }
    }
    if (nonEmptyCount > 0 && numericCount === nonEmptyCount) {
      set.add(c)
    }
  }
  return set
})

function isNumericColumn(colIndex: number): boolean {
  return numericColumns.value.has(colIndex)
}

function compareCells(left: string, right: string, numeric: boolean): number {
  if (left === '' && right === '') return 0
  if (left === '') return 1
  if (right === '') return -1
  if (numeric) {
    const numLeft = Number(left)
    const numRight = Number(right)
    if (!Number.isNaN(numLeft) && !Number.isNaN(numRight)) {
      return numLeft - numRight
    }
  }
  return left.localeCompare(right, 'zh-CN', { numeric: true })
}

/** 排序结果：空单元格始终置底，三态切换。 */
const sortedRows = computed<TableRowItem[]>(() => {
  const base = sourceBodyRows.value
  const current = sort.value
  if (!current) return base
  const { colIndex, direction } = current
  const numeric = isNumericColumn(colIndex)
  const factor = direction === 'asc' ? 1 : -1

  return [...base].sort((a, b) => {
    const valA = (a.row[colIndex] ?? '').trim()
    const valB = (b.row[colIndex] ?? '').trim()
    return compareCells(valA, valB, numeric) * factor
  })
})

/** 筛选结果：子串不区分大小写匹配。 */
const filteredRows = computed<TableRowItem[]>(() => {
  const needle = keyword.value.trim().toLocaleLowerCase('zh-CN')
  if (needle === '') return sortedRows.value
  return sortedRows.value.filter((item) =>
    item.row.some((cell) => cell.toLocaleLowerCase('zh-CN').includes(needle))
  )
})

function toggleSort(colIndex: number): void {
  if (sort.value?.colIndex === colIndex) {
    if (sort.value.direction === 'asc') {
      sort.value = { colIndex, direction: 'desc' }
    } else {
      sort.value = null
    }
  } else {
    sort.value = { colIndex, direction: 'asc' }
  }
}
</script>

<template>
  <div class="file-table-preview">
    <!-- 顶部工具条：统计、截断提示与即时搜索 -->
    <header class="file-table-toolbar">
      <div class="file-table-meta">
        <span v-if="currentSheet" class="file-table-badge" role="status">
          共 {{ currentSheet.totalRows }} 行 · {{ currentSheet.totalColumns }} 列
        </span>
        <span v-if="keyword.trim()" class="file-table-badge is-filter" role="status">
          匹配 {{ filteredRows.length }} 行
        </span>
        <span v-if="currentSheet?.truncated" class="file-table-badge is-truncated" title="避免过大 DOM 阻塞，仅读取并展示前 1000 行">
          已截取前 1000 行展示
        </span>
      </div>
      <div v-if="!isEmpty" class="file-table-search">
        <input
          v-model="keyword"
          type="search"
          class="file-table-search-input"
          placeholder="筛选表格内容…"
          aria-label="筛选表格内容"
        />
        <button
          v-if="keyword"
          type="button"
          class="file-table-search-clear"
          aria-label="清空筛选词"
          @click="keyword = ''"
        >
          ×
        </button>
      </div>
    </header>

    <!-- 表格滚动渲染区 -->
    <div class="file-table-viewport scroll-area" tabindex="0" role="region" aria-label="数据表格，可横纵向滚动">
      <div v-if="isEmpty" class="file-table-empty" role="status">
        <p>表格内容为空或无有效行列数据。</p>
      </div>
      <table v-else class="file-table-grid">
        <thead>
          <tr>
            <th class="file-table-col-num" aria-label="行号">#</th>
            <th
              v-for="(header, colIndex) in headers"
              :key="colIndex"
              class="file-table-th"
              :class="{
                'is-numeric': isNumericColumn(colIndex),
                'is-sorted': sort?.colIndex === colIndex
              }"
              role="columnheader"
              :aria-sort="sort?.colIndex === colIndex ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'"
              tabindex="0"
              @click="toggleSort(colIndex)"
              @keydown.enter.prevent="toggleSort(colIndex)"
              @keydown.space.prevent="toggleSort(colIndex)"
            >
              <div class="file-table-th-inner">
                <span class="file-table-th-title">{{ header }}</span>
                <span class="file-table-sort-indicator" aria-hidden="true">
                  <span v-if="sort?.colIndex === colIndex && sort.direction === 'asc'">▲</span>
                  <span v-else-if="sort?.colIndex === colIndex && sort.direction === 'desc'">▼</span>
                  <span v-else class="is-idle">↕</span>
                </span>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in filteredRows" :key="item.originalIndex" class="file-table-row">
            <td class="file-table-col-num" aria-hidden="true">{{ item.originalIndex }}</td>
            <td
              v-for="(cell, cIdx) in item.row"
              :key="cIdx"
              class="file-table-cell"
              :class="{ 'is-numeric': isNumericColumn(cIdx) }"
              :title="cell"
            >
              {{ cell }}
            </td>
          </tr>
          <tr v-if="filteredRows.length === 0 && keyword.trim()" class="file-table-no-match">
            <td :colspan="headers.length + 1">
              没有匹配「{{ keyword }}」的行。
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 底部工作表（Sheet）标签切换栏（多 Sheet 时展示） -->
    <footer v-if="allSheets.length > 1" class="file-table-sheets" role="tablist" aria-label="工作表切换">
      <button
        v-for="(sheet, sIndex) in allSheets"
        :key="sheet.name + sIndex"
        type="button"
        role="tab"
        class="file-table-sheet-item"
        :class="{ 'is-active': activeSheetIndex === sIndex }"
        :aria-selected="activeSheetIndex === sIndex"
        @click="activeSheetIndex = sIndex"
      >
        <span class="file-table-sheet-name">{{ sheet.name }}</span>
        <span class="file-table-sheet-count">{{ sheet.totalRows }} 行</span>
      </button>
    </footer>
  </div>
</template>
