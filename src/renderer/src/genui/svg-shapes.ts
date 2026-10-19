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

/**
 * 图表序列的色槽；具体色值由 CSS 令牌（`--color-desk-chart-1..6`）给出，
 * 图元只带下标，几何层与样式层不互相写死颜色。柱/折线最多用 3 槽，饼图用满 6 槽。
 */
export type SvgSeriesSlot = 0 | 1 | 2 | 3 | 4 | 5

/** 矩形；`radius` 为 0 表示直角，`series` 只在图表里出现。 */
export interface SvgRect {
  readonly kind: 'rect'
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly radius: number
  readonly series?: SvgSeriesSlot
}

/** 圆；`dash` 给出虚线节距时画成虚线圆（齿轮的齿圈用它），`series` 只在图表里出现。 */
export interface SvgCircle {
  readonly kind: 'circle'
  readonly cx: number
  readonly cy: number
  readonly r: number
  readonly dash?: number
  readonly series?: SvgSeriesSlot
}

/** 线段；`muted` 表示参照线一类弱化的线，`series` 只在图表里出现。 */
export interface SvgLine {
  readonly kind: 'line'
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly muted: boolean
  readonly series?: SvgSeriesSlot
}

/**
 * 路径：扇形、环形扇形的弧、箭头头部与电路符号。
 * 几何层算出 `d`，组件只负责输出——把弧线计算放进模板会让每种图形各写一套三角函数。
 * `fill` 决定填充方式：`soft`（默认，淡色填充）用于饼图切片，`solid` 用于实心箭头，
 * `none` 用于只描边的符号（电路元件、剖面圆环）。
 */
export interface SvgPath {
  readonly kind: 'path'
  readonly d: string
  readonly fill?: 'soft' | 'solid' | 'none'
  readonly series?: SvgSeriesSlot
}

/**
 * 文本；`anchor` 是 SVG 的 text-anchor，`muted` 表示注释或尺寸小字，
 * `emphasis` 用于环形中心总计这类主角文字，`halo` 给压在上色图元上的文字加底色描边。
 */
export interface SvgText {
  readonly kind: 'text'
  readonly x: number
  readonly y: number
  readonly text: string
  readonly anchor: 'start' | 'middle' | 'end'
  readonly muted: boolean
  readonly emphasis?: boolean
  readonly halo?: boolean
}

/** 图元联合；新增种类必须同时补渲染组件里的分支，否则解析结果画不出来。 */
export type SvgShape = SvgRect | SvgCircle | SvgLine | SvgPath | SvgText

/**
 * 悬停热区共用的部分：命中区域之外的文案与锚点。
 * `title` 是提示浮层的首行（分类名），`lines` 是逐条数值说明；`anchor` 是画布坐标系里的
 * 提示锚点，组件按它把浮层贴到图元旁边，几何层因此不必知道像素、百分比或容器宽度。
 */
interface SvgHotspotBase {
  readonly title: string
  readonly lines: readonly string[]
  readonly anchor: { readonly x: number; readonly y: number }
}

/** 矩形热区；柱与折线按分类整列覆盖，窄柱与细线也能命中。 */
export interface SvgRectHotspot extends SvgHotspotBase {
  readonly kind: 'rect'
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** 路径热区；饼图与环形图直接用切片自身的路径，环形空心区天然不命中。 */
export interface SvgPathHotspot extends SvgHotspotBase {
  readonly kind: 'path'
  readonly d: string
}

/** 悬停热区联合；只有图表产出，图解不给就等同于没有提示。 */
export type SvgHotspot = SvgRectHotspot | SvgPathHotspot

/** 一次布局的结果：画布高度、图元与推导摘要。 */
export interface SvgLayout {
  readonly height: number
  readonly shapes: readonly SvgShape[]
  /** 推导出的关键结论（传动比、行程、数值范围等）；渲染端写进 aria-label 与可见说明。 */
  readonly notes: readonly string[]
  /** 悬停热区；省略表示这张图没有可悬停的数值（图解都属于这种）。 */
  readonly hotspots?: readonly SvgHotspot[]
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
