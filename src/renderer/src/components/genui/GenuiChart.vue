<!-- 图表：把分类标签与数据交给 chart-geometry 算出图元，再交给共用的图元渲染器。
     bar/line 支持 1~3 条序列，pie/donut 只画一条序列的占比；饼与环的图例是切片 + 百分比。
     刻度取整、扇形路径与占比都在几何层收口，这里不碰数学。
     悬停提示是本组件唯一的交互：只读、不改数据、不参与参数提交，离开即消失，不做动画；
     热区与文案都由几何层的 hotspots 给出，这里只负责当前命中哪一条、浮层贴在锚点的哪一侧。
     浮层不参与布局也不参与无障碍树：读屏用户需要的数值已在 aria-label 与结论里全量给出。
     图表不绑定参数：数据是静态事实，需要随参数变化时用 diagram，而不是把图表变成计算器。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { GenuiChartNode } from '../../../../shared/genui-api'
import { formatShare, layoutBarChart, layoutLineChart, layoutPieChart } from '../../genui/chart-geometry'
import { SVG_CANVAS_WIDTH } from '../../genui/svg-shapes'
import type { SvgLayout } from '../../genui/svg-shapes'
import GenuiSvgShapes from './GenuiSvgShapes.vue'

const props = defineProps<{
  readonly node: GenuiChartNode
}>()

/**
 * 锚点纵向低于画布这个比例时把浮层翻到锚点下方。
 * 柱顶与折点常贴在绘图区上沿，浮层向上会超出画布、盖住标题与图例。
 */
const TOOLTIP_FLIP_RATIO = 0.28

/** 浮层与锚点之间留的间距；与 CSS 里的 translate 保持同一个数值。 */
const TOOLTIP_GAP = '8px'

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

/** 当前悬停的分类下标；离开图区即清空，不记忆上一次命中。 */
const activeIndex = ref<number | null>(null)

/** 当前悬停的热区；布局换了（节点改动）时下标可能越界，因此按可选值取。 */
const activeSpot = computed(() => {
  const index = activeIndex.value
  return index === null ? null : layout.value.hotspots?.[index] ?? null
})

/**
 * 浮层定位：以锚点在画布内的百分比为准，容器宽高变化时跟着缩放。
 * 横向靠右时改用右边缘对齐、纵向靠上时翻到下方，因此浮层始终向画布内侧展开、不会出框，
 * 也不需要测量浮层尺寸（测量会引入一次回流，且首帧拿不到尺寸）。
 */
const tooltipStyle = computed<Record<string, string> | null>(() => {
  const spot = activeSpot.value
  if (spot === null) return null
  const ratioX = spot.anchor.x / SVG_CANVAS_WIDTH
  const ratioY = spot.anchor.y / layout.value.height
  const alignRight = ratioX >= 0.5
  const below = ratioY < TOOLTIP_FLIP_RATIO
  return {
    left: `${Math.round(ratioX * 1000) / 10}%`,
    top: `${Math.round(ratioY * 1000) / 10}%`,
    '--genui-tooltip-x': alignRight ? `calc(-100% - ${TOOLTIP_GAP})` : TOOLTIP_GAP,
    '--genui-tooltip-y': below ? TOOLTIP_GAP : `calc(-100% - ${TOOLTIP_GAP})`
  }
})

function onHotspotEnter(index: number): void {
  activeIndex.value = index
}

function onHotspotLeave(): void {
  activeIndex.value = null
}

// 文档改版后热区换了口径，旧的悬停下标可能指向不存在的分类，一并清掉。
watch(() => props.node, () => { activeIndex.value = null })
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
      :hotspots="layout.hotspots"
      :active-hotspot="activeIndex"
      @hotspot-enter="onHotspotEnter"
      @hotspot-leave="onHotspotLeave"
    >
      <template #overlay>
        <div
          v-if="activeSpot !== null && tooltipStyle !== null"
          class="genui-chart-tooltip"
          :style="tooltipStyle"
          aria-hidden="true"
        >
          <p class="genui-chart-tooltip-title">{{ activeSpot.title }}</p>
          <p v-for="(line, index) in activeSpot.lines" :key="index" class="genui-chart-tooltip-line">{{ line }}</p>
        </div>
      </template>
    </GenuiSvgShapes>
  </section>
</template>
