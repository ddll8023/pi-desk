<!-- 生成式界面的节点渲染器：按类型提供不同的信息层级，分栏随容器宽度收敛。
     表格（含长表折叠、排序、筛选）整体交给 GenuiTable，这里只做分派，不再内联表格状态。
     容器递归复用本组件，图形与参数仍交给各自组件，不推断内容的业务状态。
     steps 表达先后顺序（序号），timeline 表达具体时刻（时间列），两者不互相代替。 -->
<script setup lang="ts">
// 类型名加别名，避免与模板里的递归组件同名。
import type { GenuiNode as GenuiNodeModel, GenuiTone } from '../../../../shared/genui-api'
import GenuiChart from './GenuiChart.vue'
import GenuiControls from './GenuiControls.vue'
import GenuiDiagram from './GenuiDiagram.vue'
import GenuiTable from './GenuiTable.vue'

defineProps<{
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

/** 列数是上限；最小列宽与插入间距由局部 CSS 计算，小容器自动减列。 */
function rowStyle(columns: number | undefined): Record<string, string> {
  return { '--genui-columns': String(columns ?? 4) }
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

  <GenuiTable v-else-if="node.type === 'table'" :node="node" />

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
