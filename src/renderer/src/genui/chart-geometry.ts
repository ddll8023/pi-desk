/**
 * 图表几何：把分类数据点换算成柱或折线的 SVG 图元，并给出坐标轴与刻度。
 *
 * 与机制图解同一套做法：纯函数、不依赖 Vue、不读参数状态，输出 `svg-shapes.ts` 里定义的
 * `SvgShape`，因此渲染组件只需一份。
 *
 * 只画单序列：多序列对比请用 table。这里不做图例、不做交互、不做动画，
 * 刻度取整与坐标映射都在本模块内收口，组件不碰数学。
 */
import { SVG_CANVAS_WIDTH, clampNumber, round2 } from './svg-shapes'
import type { SvgLayout, SvgShape } from './svg-shapes'

/** 绘图区在画布内的留白：左侧给刻度文字、下方给分类标签、上方给数值标注。 */
const PAD_LEFT = 34
const PAD_RIGHT = 10
const PAD_TOP = 18
const PAD_BOTTOM = 22

/** 绘图区高度；固定值，分类很多时靠压缩柱宽而不是拉高画布。 */
const PLOT_HEIGHT = 120

/** 目标刻度格数；1/2/5 取整后实际格数会落在这个范围内。 */
const TARGET_TICKS = 5

/** 分类标签超过这个字符数就截断，完整值仍进无障碍说明。 */
const LABEL_MAX_CHARS = 4

/** 一个数据点；与协议里的 `GenuiChartPoint` 同形，这里不复用类型以免几何层依赖协议层。 */
export interface ChartPoint {
  readonly label: string
  readonly value: number
}

/** 取整后的坐标轴：`min`/`max` 是轴端点，`step` 是刻度间隔，`ticks` 是刻度值列表。 */
interface AxisScale {
  readonly min: number
  readonly max: number
  readonly step: number
  readonly ticks: readonly number[]
}

/**
 * 把数据范围取整成「好看」的刻度。
 * 规则：先按 1/2/5 × 10ⁿ 选步长，再向外扩展到步长整数倍；全零或单点时给一个可用的非零区间，
 * 避免除零与零高度。
 */
function niceScale(dataMin: number, dataMax: number): AxisScale {
  // 轴端点总包含 0，柱状图才能看出增减；折线图也因此有基线。
  const low = Math.min(0, dataMin)
  const high = Math.max(0, dataMax)
  if (low === high) {
    // 全零或全部同值时给 [0, 1]，刻度与柱高都有意义。
    return { min: low === 0 ? 0 : low, max: low === 0 ? 1 : low, step: 1, ticks: [low, low + 1] }
  }

  const roughStep = (high - low) / TARGET_TICKS
  const magnitude = 10 ** Math.floor(Math.log10(Math.abs(roughStep)))
  const normalized = roughStep / magnitude
  const niceStep = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude

  const start = Math.floor(low / niceStep) * niceStep
  const end = Math.ceil(high / niceStep) * niceStep
  const ticks: number[] = []
  // 浮点累加会漂，按索引算值再收口到 6 位小数。
  const count = Math.round((end - start) / niceStep)
  for (let index = 0; index <= count; index += 1) {
    ticks.push(Number((start + index * niceStep).toFixed(6)))
  }
  return { min: start, max: end, step: niceStep, ticks }
}

/** 数值到绘图区纵坐标的映射；`max === min` 已在 `niceScale` 里排除。 */
function makeY(scale: AxisScale): (value: number) => number {
  const span = scale.max - scale.min
  return (value: number) => PAD_TOP + PLOT_HEIGHT - ((value - scale.min) / span) * PLOT_HEIGHT
}

/** 刻度文字的展示形态：整数直接输出，小数最多 2 位。 */
function formatTick(value: number): string {
  return Number.isInteger(value) ? String(value) : String(round2(value))
}

/** 分类标签：超过上限截断，避免相邻标签重叠。 */
function shortLabel(label: string): string {
  return label.length <= LABEL_MAX_CHARS ? label : `${label.slice(0, LABEL_MAX_CHARS)}…`
}

/** 坐标轴与网格：刻度线、刻度值、零线与分类标签。 */
function axisShapes(scale: AxisScale, points: readonly ChartPoint[]): SvgShape[] {
  const toY = makeY(scale)
  const shapes: SvgShape[] = []
  const plotLeft = PAD_LEFT
  const plotRight = SVG_CANVAS_WIDTH - PAD_RIGHT
  for (const tick of scale.ticks) {
    const y = toY(tick)
    shapes.push({ kind: 'line', x1: plotLeft, y1: y, x2: plotRight, y2: y, muted: true })
    shapes.push({ kind: 'text', x: plotLeft - 4, y: y + 4, text: formatTick(tick), anchor: 'end', muted: true })
  }
  // 零线比普通网格线稍重，正负柱的分界一眼可见。
  if (scale.min < 0 && scale.max > 0) {
    const zeroY = toY(0)
    shapes.push({ kind: 'line', x1: plotLeft, y1: zeroY, x2: plotRight, y2: zeroY, muted: false })
  }
  const slotWidth = (plotRight - plotLeft) / Math.max(points.length, 1)
  for (const [index, point] of points.entries()) {
    const centerX = plotLeft + slotWidth * (index + 0.5)
    shapes.push({
      kind: 'text',
      x: centerX,
      y: PAD_TOP + PLOT_HEIGHT + 15,
      text: shortLabel(point.label),
      anchor: 'middle',
      muted: true
    })
  }
  return shapes
}

/** 数据点的数值标注；只给首尾与极值标，避免每根柱都写数字把图挤满。 */
function markedIndexes(points: readonly ChartPoint[]): ReadonlySet<number> {
  if (points.length <= 4) return new Set(points.map((_, index) => index))
  let maxIndex = 0
  let minIndex = 0
  for (const [index, point] of points.entries()) {
    if (point.value > (points[maxIndex]?.value ?? 0)) maxIndex = index
    if (point.value < (points[minIndex]?.value ?? 0)) minIndex = index
  }
  return new Set([0, maxIndex, minIndex, points.length - 1])
}

/** 数值文本；带单位时附在后面。 */
function valueText(value: number, unit: string | undefined): string {
  const text = formatTick(round2(value))
  return unit === undefined ? text : `${text}${unit}`
}

/** 结论摘要：范围与首尾，给无障碍与可见说明共用。 */
function chartNotes(points: readonly ChartPoint[], unit: string | undefined): string[] {
  const values = points.map((point) => point.value)
  const max = Math.max(...values)
  const min = Math.min(...values)
  const first = points[0]
  const last = points[points.length - 1]
  const notes = [`${points.length} 个数据点，范围 ${valueText(min, unit)} ~ ${valueText(max, unit)}`]
  if (first !== undefined && last !== undefined && points.length > 1) {
    notes.push(`${first.label} ${valueText(first.value, unit)} → ${last.label} ${valueText(last.value, unit)}`)
  }
  return notes
}

/** 柱状图：柱从零线起算，正负方向相反。 */
export function layoutBarChart(points: readonly ChartPoint[], unit?: string): SvgLayout {
  const values = points.map((point) => clampNumber(point.value, -1e9, 1e9, 0))
  const safePoints = points.map((point, index) => ({ label: point.label, value: values[index] ?? 0 }))
  const scale = niceScale(Math.min(...values), Math.max(...values))
  const toY = makeY(scale)
  const shapes = axisShapes(scale, safePoints)

  const plotLeft = PAD_LEFT
  const plotRight = SVG_CANVAS_WIDTH - PAD_RIGHT
  const slotWidth = (plotRight - plotLeft) / Math.max(safePoints.length, 1)
  // 柱宽占槽位的 60%，柱多时自动变窄，不裁数据。
  const barWidth = Math.max(2, slotWidth * 0.6)
  const zeroY = toY(0)
  const marked = markedIndexes(safePoints)

  for (const [index, point] of safePoints.entries()) {
    const centerX = plotLeft + slotWidth * (index + 0.5)
    const valueY = toY(point.value)
    shapes.push({
      kind: 'rect',
      x: centerX - barWidth / 2,
      y: Math.min(valueY, zeroY),
      width: barWidth,
      height: Math.max(1, Math.abs(zeroY - valueY)),
      radius: 2
    })
    if (marked.has(index)) {
      shapes.push({
        kind: 'text',
        x: centerX,
        y: point.value >= 0 ? Math.min(valueY, zeroY) - 4 : Math.max(valueY, zeroY) + 11,
        text: valueText(point.value, unit),
        anchor: 'middle',
        muted: true
      })
    }
  }

  return {
    height: PAD_TOP + PLOT_HEIGHT + PAD_BOTTOM,
    shapes,
    notes: chartNotes(safePoints, unit)
  }
}

/** 折线图：按槽位中心连线，折点用小圆标出。 */
export function layoutLineChart(points: readonly ChartPoint[], unit?: string): SvgLayout {
  const values = points.map((point) => clampNumber(point.value, -1e9, 1e9, 0))
  const safePoints = points.map((point, index) => ({ label: point.label, value: values[index] ?? 0 }))
  const scale = niceScale(Math.min(...values), Math.max(...values))
  const toY = makeY(scale)
  const shapes = axisShapes(scale, safePoints)

  const plotLeft = PAD_LEFT
  const plotRight = SVG_CANVAS_WIDTH - PAD_RIGHT
  const slotWidth = (plotRight - plotLeft) / Math.max(safePoints.length, 1)
  const marked = markedIndexes(safePoints)

  let previous: { x: number; y: number } | null = null
  for (const [index, point] of safePoints.entries()) {
    const x = plotLeft + slotWidth * (index + 0.5)
    const y = toY(point.value)
    if (previous !== null) {
      shapes.push({ kind: 'line', x1: previous.x, y1: previous.y, x2: x, y2: y, muted: false })
    }
    // 折点小圆半径固定 2.5；点数多时视觉上仍然是一条可读的线。
    shapes.push({ kind: 'circle', cx: x, cy: y, r: 2.5 })
    if (marked.has(index)) {
      shapes.push({ kind: 'text', x, y: y - 6, text: valueText(point.value, unit), anchor: 'middle', muted: true })
    }
    previous = { x, y }
  }

  return {
    height: PAD_TOP + PLOT_HEIGHT + PAD_BOTTOM,
    shapes,
    notes: chartNotes(safePoints, unit)
  }
}

