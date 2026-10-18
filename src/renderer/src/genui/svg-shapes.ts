/**
 * SVG 图元的共用底座：形状类型、画布宽度与数值守卫。
 *
 * 机制图解（`diagram-geometry.ts`）与图表（`chart-geometry.ts`）都输出同一套 `SvgShape`，
 * 渲染组件（`GenuiSvgShapes.vue`）也只认这一套，因此图元定义放在这里而不是寄居在某个布局模块里。
 *
 * 只放与具体图形无关的东西：这里不出现零件、齿数、坐标轴一类的概念，
 * 也不依赖 Vue、不读状态，任何新的图形类型都可以直接复用。
 */

/** 画布宽度；所有图形共用同一数值，并排展示时视觉一致。 */
export const SVG_CANVAS_WIDTH = 320

/** 矩形；`radius` 为 0 表示直角。 */
export interface SvgRect {
  readonly kind: 'rect'
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly radius: number
}

/** 圆；`dash` 给出虚线节距时画成虚线圆（齿轮的齿圈用它）。 */
export interface SvgCircle {
  readonly kind: 'circle'
  readonly cx: number
  readonly cy: number
  readonly r: number
  readonly dash?: number
}

/** 线段；`muted` 表示参照线一类弱化的线。 */
export interface SvgLine {
  readonly kind: 'line'
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly muted: boolean
}

/** 文本；`anchor` 是 SVG 的 text-anchor，`muted` 表示注释或尺寸小字。 */
export interface SvgText {
  readonly kind: 'text'
  readonly x: number
  readonly y: number
  readonly text: string
  readonly anchor: 'start' | 'middle' | 'end'
  readonly muted: boolean
}

/** 图元联合；新增种类必须同时补渲染组件里的分支，否则解析结果画不出来。 */
export type SvgShape = SvgRect | SvgCircle | SvgLine | SvgText

/** 一次布局的结果：画布高度、图元与推导摘要。 */
export interface SvgLayout {
  readonly height: number
  readonly shapes: readonly SvgShape[]
  /** 推导出的关键结论（传动比、行程、数值范围等）；渲染端写进 aria-label 与可见说明。 */
  readonly notes: readonly string[]
}

/** 数值守卫：非有限值回落 `fallback`，其余夹到区间。 */
export function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** 保留最多 2 位小数，去掉浮点尾差；用于展示尺寸与比例。 */
export function round2(value: number): number {
  return Number(value.toFixed(2))
}
