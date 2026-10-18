<!-- 图元渲染器：把 diagram-geometry / chart-geometry 算出的形状画成内联 SVG。
     机制图解与图表共用这一份模板，避免两处各写一套 rect/circle/line/text 分发而逐渐漂移。
     这里不含任何数学与状态：只按 shape.kind 出标签，外加 caption 与结论文本。
     每个分支都精确匹配 kind 而不留 v-else 兜底：新增图元却漏改模板时，类型检查会报错，
     而不是被当成文本静默画成空白。 -->
<script setup lang="ts">
import type { SvgShape } from '../../genui/svg-shapes'

defineProps<{
  readonly shapes: readonly SvgShape[]
  readonly width: number
  readonly height: number
  /** 无障碍说明：图解/图表的关键结论，读屏用户不必看图也能得到同样的信息。 */
  readonly ariaLabel: string
  readonly caption?: string
  /** 推导结论；以文本同时给出，复制与读屏场景都不该只拿到图形。 */
  readonly notes: readonly string[]
}>()
</script>

<template>
  <figure class="genui-figure">
    <svg
      class="genui-figure-canvas"
      :viewBox="`0 0 ${width} ${height}`"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      :aria-label="ariaLabel"
    >
      <template v-for="(shape, index) in shapes" :key="index">
        <rect
          v-if="shape.kind === 'rect'"
          :x="shape.x"
          :y="shape.y"
          :width="shape.width"
          :height="shape.height"
          :rx="shape.radius"
          class="fill-desk-surface-subtle stroke-desk-line-strong"
          stroke-width="1.2"
        />
        <circle
          v-else-if="shape.kind === 'circle'"
          :cx="shape.cx"
          :cy="shape.cy"
          :r="shape.r"
          :stroke-dasharray="shape.dash === undefined ? undefined : `${shape.dash} ${shape.dash}`"
          class="fill-none stroke-desk-accent"
          :stroke-width="shape.dash === undefined ? 1 : 1.6"
        />
        <line
          v-else-if="shape.kind === 'line'"
          :x1="shape.x1"
          :y1="shape.y1"
          :x2="shape.x2"
          :y2="shape.y2"
          :class="shape.muted ? 'stroke-desk-line-strong' : 'stroke-desk-ink'"
          :stroke-width="shape.muted ? 1 : 2"
          stroke-linecap="round"
        />
        <text
          v-else-if="shape.kind === 'text'"
          :x="shape.x"
          :y="shape.y"
          :text-anchor="shape.anchor"
          :class="shape.muted ? 'fill-desk-muted' : 'fill-desk-ink'"
          font-size="11"
        >{{ shape.text }}</text>
      </template>
    </svg>
    <figcaption v-if="caption !== undefined" class="genui-caption">
      {{ caption }}
    </figcaption>
    <p v-if="notes.length > 0" class="genui-figure-notes">{{ notes.join('；') }}</p>
  </figure>
</template>
