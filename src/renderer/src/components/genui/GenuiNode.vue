<!-- 生成式界面的节点渲染器：按类型提供不同的信息层级，分栏随容器宽度收敛。
     长表只折叠展示行，不改文档数据；展开状态留在组件内，不参与参数提交。
     容器递归复用本组件，图形与参数仍交给各自组件，不推断内容的业务状态。
     steps 表达先后顺序（序号），timeline 表达具体时刻（时间列），两者不互相代替。 -->
<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
// 类型名加别名，避免与模板里的递归组件同名。
import type { GenuiNode as GenuiNodeModel, GenuiTableCell, GenuiTone } from '../../../../shared/genui-api'
import AppButton from '../ui/AppButton.vue'
import GenuiChart from './GenuiChart.vue'
import GenuiControls from './GenuiControls.vue'
import GenuiDiagram from './GenuiDiagram.vue'

const props = defineProps<{
  readonly node: GenuiNodeModel
}>()

const TONE_CLASS: Readonly<Record<GenuiTone, string>> = {
  default: 'genui-tone-default',
  muted: 'genui-tone-muted',
  accent: 'genui-tone-accent',
  success: 'genui-tone-success',
  warning: 'genui-tone-warning',
  danger: 'genui-tone-danger'
}

const SIZE_CLASS: Readonly<Record<'small' | 'body' | 'large', string>> = {
  small: 'genui-text-small',
  body: 'genui-text-body',
  large: 'genui-text-large'
}

const TABLE_PREVIEW_ROWS = 6
const tableExpanded = ref(false)
const tableBodyId = useId()

/** 列宽按实际数据形态区分，不根据列名或文案猜测路径、优先级或成功状态。 */
const tableColumns = computed(() => {
  const node = props.node
  if (node.type !== 'table') return []
  return node.columns.map(column => {
    const values = node.rows.map(row => row[column.key])
      .filter((value): value is GenuiTableCell => value !== undefined && value !== '')
    const numeric = values.length > 0 && values.every(value => typeof value === 'number')
    const compact = !numeric && column.label.length <= 8
      && values.every(value => String(value).length <= 12 && !String(value).includes('\n'))
    return { ...column, kind: numeric ? 'numeric' : compact ? 'compact' : 'text' }
  })
})

const tableRows = computed(() => {
  const node = props.node
  if (node.type !== 'table') return []
  return tableExpanded.value ? node.rows : node.rows.slice(0, TABLE_PREVIEW_ROWS)
})

watch(() => props.node, () => { tableExpanded.value = false })

/** 列数是上限；最小列宽与插入间距由局部 CSS 计算，小容器自动减列。 */
function rowStyle(columns: number | undefined): Record<string, string> {
  return { '--genui-columns': String(columns ?? 4) }
}

function cellText(value: GenuiTableCell | undefined): string {
  if (value === undefined) return ''
  return typeof value === 'number' ? value.toLocaleString('zh-CN') : value
}
</script>

<template>
  <p
    v-if="node.type === 'text'"
    class="genui-text"
    :class="[TONE_CLASS[node.tone ?? 'default'], SIZE_CLASS[node.size ?? 'body']]"
  >{{ node.text }}</p>

  <ol v-else-if="node.type === 'list' && node.ordered === true" class="genui-list genui-list-ordered">
    <li v-for="(item, index) in node.items" :key="index">{{ item }}</li>
  </ol>
  <ul v-else-if="node.type === 'list'" class="genui-list">
    <li v-for="(item, index) in node.items" :key="index">{{ item }}</li>
  </ul>

  <div v-else-if="node.type === 'metric'" class="genui-metric">
    <span class="genui-metric-label">{{ node.label }}</span>
    <span class="genui-metric-reading">
      <span class="genui-metric-value" :class="TONE_CLASS[node.tone ?? 'default']">
        {{ typeof node.value === 'number' ? node.value.toLocaleString('zh-CN') : node.value }}
      </span>
      <span v-if="node.unit !== undefined" class="genui-metric-unit">{{ node.unit }}</span>
    </span>
  </div>

  <figure v-else-if="node.type === 'table'" class="genui-table">
    <div class="genui-table-scroll" role="region" :aria-label="node.caption ?? '数据表格'" tabindex="0">
      <table>
        <thead>
          <tr>
            <th v-for="column in tableColumns" :key="column.key" scope="col" :class="`genui-cell-${column.kind}`">
              {{ column.label }}
            </th>
          </tr>
        </thead>
        <tbody :id="tableBodyId">
          <tr v-for="(row, index) in tableRows" :key="index">
            <td v-for="column in tableColumns" :key="column.key" :class="`genui-cell-${column.kind}`">
              {{ cellText(row[column.key]) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="node.rows.length > TABLE_PREVIEW_ROWS" class="genui-table-footer">
      <span class="genui-table-count">共 {{ node.rows.length }} 行 · 已显示 {{ tableRows.length }} 行</span>
      <AppButton
        variant="unstyled" class="genui-table-expand"
        :aria-expanded="tableExpanded" :aria-controls="tableBodyId"
        @click="tableExpanded = !tableExpanded"
      >
        {{ tableExpanded ? `收起至前 ${TABLE_PREVIEW_ROWS} 行` : `展开全部 ${node.rows.length} 行` }}
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" :class="{ 'is-expanded': tableExpanded }">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </AppButton>
    </div>
    <figcaption v-if="node.caption !== undefined" class="genui-caption">{{ node.caption }}</figcaption>
  </figure>

  <ol v-else-if="node.type === 'steps'" class="genui-steps">
    <li v-for="(item, index) in node.items" :key="index" class="genui-step">
      <span class="genui-step-index" aria-hidden="true">{{ index + 1 }}</span>
      <div class="genui-step-content">
        <p class="genui-step-title">{{ item.title }}</p>
        <p v-if="item.description !== undefined" class="genui-step-description">{{ item.description }}</p>
      </div>
    </li>
  </ol>

  <!-- 时间线：时间列 + 中轴圆点，按数组顺序渲染；时间不解析、不排序，避免擅自重排。 -->
  <ol v-else-if="node.type === 'timeline'" class="genui-timeline">
    <li v-for="(item, index) in node.items" :key="index" class="genui-timeline-item">
      <span class="genui-timeline-time">{{ item.time }}</span>
      <span class="genui-timeline-axis" aria-hidden="true" />
      <div class="genui-timeline-content">
        <p class="genui-timeline-title">{{ item.title }}</p>
        <p v-if="item.description !== undefined" class="genui-timeline-description">{{ item.description }}</p>
      </div>
    </li>
  </ol>

  <section v-else-if="node.type === 'card'" class="genui-card" :aria-label="node.title">
    <h4 v-if="node.title !== undefined" class="genui-card-title">{{ node.title }}</h4>
    <div class="genui-stack">
      <GenuiNode v-for="(child, index) in node.children" :key="index" :node="child" />
    </div>
  </section>

  <div v-else-if="node.type === 'row'" class="genui-row" :style="rowStyle(node.columns)">
    <GenuiNode v-for="(child, index) in node.children" :key="index" :node="child" />
  </div>

  <GenuiControls v-else-if="node.type === 'controls'" :node="node" />
  <GenuiDiagram v-else-if="node.type === 'diagram'" :node="node" />
  <GenuiChart v-else-if="node.type === 'chart'" :node="node" />
</template>
