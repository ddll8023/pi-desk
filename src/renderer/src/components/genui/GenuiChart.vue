<!-- 图表：把分类标签与数据交给 chart-geometry 算出图元，再交给共用的图元渲染器。
     bar/line 支持 1~3 条序列，pie/donut 只画一条序列的占比；饼与环的图例是切片 + 百分比。
     不做交互与动画；刻度取整、扇形路径与占比都在几何层收口，这里不碰数学。
     图表不绑定参数：数据是静态事实，需要随参数变化时用 diagram，而不是把图表变成计算器。 -->
<script setup lang="ts">
import { computed } from 'vue'
import type { GenuiChartNode } from '../../../../shared/genui-api'
import { formatShare, layoutBarChart, layoutLineChart, layoutPieChart } from '../../genui/chart-geometry'
import { SVG_CANVAS_WIDTH } from '../../genui/svg-shapes'
import type { SvgLayout } from '../../genui/svg-shapes'
import GenuiSvgShapes from './GenuiSvgShapes.vue'

const props = defineProps<{
  readonly node: GenuiChartNode
}>()

/** 种类文案；四种 kind 都要有名字，aria 与标题回落共用。 */
const KIND_TEXT: Readonly<Record<GenuiChartNode['kind'], string>> = {
  bar: '柱状图',
  line: '折线图',
  pie: '饼图',
  donut: '环形图'
}

const kindText = computed(() => KIND_TEXT[props.node.kind])

/** 是否占比图；饼与环共用同一份数据与标注口径。 */
const isShare = computed(() => props.node.kind === 'pie' || props.node.kind === 'donut')

/**
 * 几何分派：显式按 kind 走，不做 `bar ? … : …` 的二选一。
 * 二选一会在新增种类时把新图静默画成折线图，而类型检查不会报错。
 */
const layout = computed<SvgLayout>(() => {
  const { node } = props
  switch (node.kind) {
    case 'bar': return layoutBarChart(node.labels, node.series, node.unit)
    case 'line': return layoutLineChart(node.labels, node.series, node.unit)
    case 'pie':
    case 'donut':
      return layoutPieChart(node.labels, node.series[0]?.values ?? [], node.unit, node.kind === 'donut')
  }
})

/**
 * 图例条目：占比图按切片出（切片标签 + 百分比），柱/折线按序列名出。
 * 单序列的柱/折线不出图例——一条序列的图例只是噪音，且几何层单序列用中性色，两者会不一致。
 */
const legend = computed(() => {
  const { node } = props
  if (isShare.value) {
    const values = node.series[0]?.values ?? []
    const total = values.reduce((sum, value) => sum + value, 0)
    return node.labels.map((label, index) => ({
      name: label,
      detail: formatShare(values[index] ?? 0, total),
      className: `genui-series-${(index % 6) + 1}`
    }))
  }
  if (node.series.length <= 1) return []
  return node.series.map((series, index) => ({
    name: series.name ?? `序列 ${index + 1}`,
    detail: '',
    className: `genui-series-${(index % 3) + 1}`
  }))
})

/** 无障碍说明：标题（若有）+ 图表种类 + 序列名或切片 + 结论；信息不能只靠颜色传达。 */
const ariaLabel = computed(() => {
  const title = props.node.title === undefined ? '' : `${props.node.title}，`
  const names = isShare.value
    ? `切片：${props.node.labels.join('、')}。`
    : `序列：${props.node.series.map((series, index) => series.name ?? `序列 ${index + 1}`).join('、')}。`
  return `${title}${kindText.value}。${names}${layout.value.notes.join('；')}`
})
</script>

<template>
  <section class="genui-chart" :aria-label="node.title ?? kindText">
    <h4 v-if="node.title !== undefined" class="genui-chart-title">{{ node.title }}</h4>
    <ul v-if="legend.length > 0" class="genui-chart-legend">
      <li v-for="(item, index) in legend" :key="`${index}-${item.name}`" class="genui-chart-legend-item">
        <span class="genui-chart-swatch" :class="item.className" aria-hidden="true" />
        <span>{{ item.name }}</span>
        <span v-if="item.detail !== ''" class="genui-chart-legend-detail">{{ item.detail }}</span>
      </li>
    </ul>
    <GenuiSvgShapes
      :shapes="layout.shapes"
      :width="SVG_CANVAS_WIDTH"
      :height="layout.height"
      :aria-label="ariaLabel"
      :caption="node.caption"
      :notes="layout.notes"
    />
  </section>
</template>
