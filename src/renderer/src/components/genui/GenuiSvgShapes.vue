<!-- 图元渲染器：把 diagram-geometry / chart-geometry 算出的形状画成内联 SVG。
     机制图解与图表共用这一份模板，避免两处各写一套 rect/circle/line/path/text 分发而逐渐漂移。
     这里不含任何数学与状态：只按 shape.kind 出标签，外加 caption 与结论文本。
     每个分支都精确匹配 kind 而不留 v-else 兜底：新增图元却漏改模板时，类型检查会报错，
     而不是被当成文本静默画成空白。
     带 series 色槽的图元改用序列色（多序列图表与饼图切片），不带时沿用图解的中性与强调色；
     path 按 fill 分派填充方式（soft 淡色、solid 实心、none 只描边），序列色仍优先。
     悬停热区画在所有图元之后（否则会被柱或文字盖住而点不中），且只在给了 hotspots 时生效：
     有热区时其余图元一律 pointer-events:none，让整列/整片都能命中；提示浮层本身由调用方
     通过 overlay 插槽填进来，因为它的文案与定位属于图表的语义，不属于 SVG 图元层。 -->
<script setup lang="ts">
import { computed } from 'vue'
import type { SvgHotspot, SvgPath, SvgSeriesSlot, SvgShape } from '../../genui/svg-shapes'

const props = defineProps<{
  readonly shapes: readonly SvgShape[]
  readonly width: number
  readonly height: number
  /** 无障碍说明：图解/图表的关键结论，读屏用户不必看图也能得到同样的信息。 */
  readonly ariaLabel: string
  /** 图表/图解的补充说明；未给时不渲染。显式带上 `undefined`，与仓库其他可选 prop 同一口径。 */
  readonly caption?: string | undefined
  /** 推导结论；以文本同时给出，复制与读屏场景都不该只拿到图形。 */
  readonly notes: readonly string[]
  /** 悬停热区；图解不传，等同于没有悬停提示。 */
  readonly hotspots?: readonly SvgHotspot[] | undefined
  /** 当前命中的热区下标；由调用方管理，切换热区时只换高亮，不重建图元。 */
  readonly activeHotspot?: number | null | undefined
}>()

const emit = defineEmits<{
  'hotspot-enter': [index: number]
  'hotspot-leave': []
}>()

defineSlots<{ overlay?: () => unknown }>()

/** 热区列表；未传时为空数组，模板只靠它决定是否开启命中。 */
const hotspotList = computed<readonly SvgHotspot[]>(() => props.hotspots ?? [])

/** 序列色类名；色槽为空时返回 undefined，让模板回落各图元的默认色。 */
function seriesClass(slot: SvgSeriesSlot | undefined): string | undefined {
  return slot === undefined ? undefined : `genui-series-${slot + 1}`
}

/** 路径填充类名：`soft` 保持原样，`solid` 实心，`none` 只描边；序列色优先。 */
function pathClass(shape: SvgPath): string {
  const series = seriesClass(shape.series)
  if (series !== undefined) return series
  switch (shape.fill) {
    case 'solid': return 'fill-desk-ink stroke-desk-ink'
    case 'none': return 'fill-none stroke-desk-ink'
    default: return 'fill-desk-accent-soft stroke-desk-accent'
  }
}
</script>

<template>
  <figure class="genui-figure">
    <div class="genui-figure-canvas-wrap">
      <svg
        class="genui-figure-canvas"
        :class="{ 'has-hotspots': hotspotList.length > 0 }"
        :viewBox="`0 0 ${width} ${height}`"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        :aria-label="ariaLabel"
        @pointerleave="emit('hotspot-leave')"
      >
        <template v-for="(shape, index) in shapes" :key="index">
          <rect
            v-if="shape.kind === 'rect'"
            :x="shape.x"
            :y="shape.y"
            :width="shape.width"
            :height="shape.height"
            :rx="shape.radius"
            :class="seriesClass(shape.series) ?? 'fill-desk-surface-subtle stroke-desk-line-strong'"
            stroke-width="1.2"
          />
          <circle
            v-else-if="shape.kind === 'circle'"
            :cx="shape.cx"
            :cy="shape.cy"
            :r="shape.r"
            :stroke-dasharray="shape.dash === undefined ? undefined : `${shape.dash} ${shape.dash}`"
            :class="seriesClass(shape.series) ?? 'fill-none stroke-desk-accent'"
            :stroke-width="shape.dash === undefined ? 1 : 1.6"
          />
          <line
            v-else-if="shape.kind === 'line'"
            :x1="shape.x1"
            :y1="shape.y1"
            :x2="shape.x2"
            :y2="shape.y2"
            :class="seriesClass(shape.series) ?? (shape.muted ? 'stroke-desk-line-strong' : 'stroke-desk-ink')"
            :stroke-width="shape.muted ? 1 : 2"
            stroke-linecap="round"
          />
          <path
            v-else-if="shape.kind === 'path'"
            :d="shape.d"
            :class="pathClass(shape)"
            stroke-width="1"
          />
          <text
            v-else-if="shape.kind === 'text'"
            :x="shape.x"
            :y="shape.y"
            :text-anchor="shape.anchor"
            :class="[shape.muted ? 'fill-desk-muted' : 'fill-desk-ink', shape.halo === true ? 'genui-text-halo' : undefined]"
            :font-size="shape.emphasis === true ? 15 : 11"
            :font-weight="shape.emphasis === true ? 650 : undefined"
          >{{ shape.text }}</text>
        </template>
        <!-- 热区放在最后：SVG 后画的图元在上层，先画热区会被柱与文字挡住。 -->
        <template v-for="(spot, index) in hotspotList" :key="`hotspot-${index}`">
          <rect
            v-if="spot.kind === 'rect'"
            :x="spot.x"
            :y="spot.y"
            :width="spot.width"
            :height="spot.height"
            class="genui-hotspot"
            :class="{ 'is-active': index === activeHotspot }"
            @pointerenter="emit('hotspot-enter', index)"
          />
          <path
            v-else
            :d="spot.d"
            class="genui-hotspot"
            :class="{ 'is-active': index === activeHotspot }"
            @pointerenter="emit('hotspot-enter', index)"
          />
        </template>
      </svg>
      <slot name="overlay" />
    </div>
    <figcaption v-if="caption !== undefined" class="genui-caption">
      {{ caption }}
    </figcaption>
    <p v-if="notes.length > 0" class="genui-figure-notes">{{ notes.join('；') }}</p>
  </figure>
</template>
