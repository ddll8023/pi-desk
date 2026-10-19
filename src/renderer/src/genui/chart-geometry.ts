/**
 * 图表几何：把分类标签与数据换算成柱、折线、扇形或环形的 SVG 图元，并给出坐标轴与刻度。
 *
 * 与机制图解同一套做法：纯函数、不依赖 Vue、不读参数状态，输出 `svg-shapes.ts` 里定义的
 * `SvgShape`，因此渲染组件只需一份。
 *
 * 色槽是 0..5 的下标，具体颜色由 CSS 令牌给出，几何层不写死色值；
 * 柱/折线单序列不给色槽，沿用图元默认的中性填充，饼/环图逐片取色。
 * 这里不做交互、不做动画，刻度取整、扇形路径与占比都在本模块内收口，组件不碰数学。
 */
import { SVG_CANVAS_WIDTH, clampNumber, round2 } from './svg-shapes'
import type { SvgLayout, SvgSeriesSlot, SvgShape } from './svg-shapes'

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

/** 一条序列；与协议里的 `GenuiChartSeries` 同形，这里不复用类型以免几何层依赖协议层。 */
export interface ChartSeries {
  readonly name?: string
  readonly values: readonly number[]
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
 * 规则：先按 1/2/5 × 10ⁿ 选步长，再向外扩展到步长整数倍；全零时给 [0, 1]，
 * 避免除零与零高度。轴端点总包含 0，柱状图才能看出增减，折线图也因此有基线。
 */
function niceScale(dataMin: number, dataMax: number): AxisScale {
  const low = Math.min(0, dataMin)
  const high = Math.max(0, dataMax)
  // 轴端点必含 0，因此 low === high 只可能是全零；给 [0, 1] 让刻度与柱高都有意义。
  if (low === high) return { min: 0, max: 1, step: 1, ticks: [0, 1] }

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

/** 数值文本；带单位时附在后面。 */
function valueText(value: number, unit: string | undefined): string {
  const text = formatTick(round2(value))
  return unit === undefined ? text : `${text}${unit}`
}

/**
 * 序列的色槽：单序列返回 undefined，沿用图元默认中性色；多序列按下标取 0..2。
 * 协议已把条数限在 3 以内，这里仍取模，避免将来放宽上限时下标越界画成无色。
 */
function seriesSlot(seriesCount: number, index: number): SvgSeriesSlot | undefined {
  if (seriesCount <= 1) return undefined
  return (index % 3) as SvgSeriesSlot
}

/** 序列名；无名序列（旧形状归一化或单序列）统一叫「数值」，供说明与复制文本使用。 */
function seriesName(series: ChartSeries, index: number): string {
  return series.name ?? (index === 0 ? '数值' : `序列 ${index + 1}`)
}

/** 全部序列取值的安全副本：非有限值回落 0，并夹到可绘制区间。 */
function safeSeries(series: readonly ChartSeries[]): ChartSeries[] {
  return series.map((item) => ({
    ...(item.name === undefined ? {} : { name: item.name }),
    values: item.values.map((value) => clampNumber(value, -1e9, 1e9, 0))
  }))
}

/** 所有序列的取值拉平，用于统一取整刻度。 */
function allValues(series: readonly ChartSeries[]): number[] {
  return series.flatMap((item) => item.values)
}

/** 刻度区间：无数据时退回 [0, 0]，由 `niceScale` 兜成 [0, 1]。 */
function scaleOf(values: readonly number[]): AxisScale {
  return values.length === 0 ? niceScale(0, 0) : niceScale(Math.min(...values), Math.max(...values))
}

/** 坐标轴与网格：刻度线、刻度值、零线与分类标签。 */
function axisShapes(scale: AxisScale, labels: readonly string[]): SvgShape[] {
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
  const slotWidth = (plotRight - plotLeft) / Math.max(labels.length, 1)
  for (const [index, label] of labels.entries()) {
    const centerX = plotLeft + slotWidth * (index + 0.5)
    shapes.push({
      kind: 'text',
      x: centerX,
      y: PAD_TOP + PLOT_HEIGHT + 15,
      text: shortLabel(label),
      anchor: 'middle',
      muted: true
    })
  }
  return shapes
}

/** 单序列的数值标注位置：只给首尾与极值标，避免每根柱都写数字把图挤满。 */
function markedIndexes(values: readonly number[]): ReadonlySet<number> {
  if (values.length <= 4) return new Set(values.map((_, index) => index))
  let maxIndex = 0
  let minIndex = 0
  for (const [index, value] of values.entries()) {
    if (value > (values[maxIndex] ?? 0)) maxIndex = index
    if (value < (values[minIndex] ?? 0)) minIndex = index
  }
  return new Set([0, maxIndex, minIndex, values.length - 1])
}

/** 单序列结论摘要：范围与首尾，给无障碍与可见说明共用。 */
function singleNotes(labels: readonly string[], values: readonly number[], unit: string | undefined): string[] {
  const max = Math.max(...values)
  const min = Math.min(...values)
  const first = labels[0]
  const last = labels[labels.length - 1]
  const notes = [`${values.length} 个数据点，范围 ${valueText(min, unit)} ~ ${valueText(max, unit)}`]
  if (first !== undefined && last !== undefined && values.length > 1) {
    notes.push(
      `${first} ${valueText(values[0] ?? 0, unit)} → ${last} ${valueText(values[values.length - 1] ?? 0, unit)}`
    )
  }
  return notes
}

/**
 * 多序列结论摘要：逐条给范围与首末。
 * 画布只有 320px，多序列不标每点数值（会互相压住），结论只能靠这段文字与图例承载，
 * 因此这里必须写全，不能只说「见图」。
 */
function multiNotes(labels: readonly string[], series: readonly ChartSeries[], unit: string | undefined): string[] {
  const notes = [`${labels.length} 个分类，${series.length} 条序列`]
  for (const [index, item] of series.entries()) {
    const max = Math.max(...item.values)
    const min = Math.min(...item.values)
    const first = labels[0]
    const last = labels[labels.length - 1]
    const range = `范围 ${valueText(min, unit)} ~ ${valueText(max, unit)}`
    const ends = first === undefined || last === undefined || item.values.length < 2
      ? ''
      : `，${valueText(item.values[0] ?? 0, unit)} → ${valueText(item.values[item.values.length - 1] ?? 0, unit)}`
    notes.push(`${seriesName(item, index)}：${range}${ends}`)
  }
  return notes
}

/** 结论摘要；按序列条数切换口径，单序列保持与旧版一致的文案。 */
function chartNotes(labels: readonly string[], series: readonly ChartSeries[], unit: string | undefined): string[] {
  const first = series[0]
  if (first === undefined) return []
  return series.length === 1 ? singleNotes(labels, first.values, unit) : multiNotes(labels, series, unit)
}

/** 柱状图：柱从零线起算，正负方向相反；多序列在同一分类内分组并列。 */
export function layoutBarChart(
  labels: readonly string[],
  series: readonly ChartSeries[],
  unit?: string
): SvgLayout {
  const safe = safeSeries(series)
  const scale = scaleOf(allValues(safe))
  const toY = makeY(scale)
  const shapes = axisShapes(scale, labels)

  const plotLeft = PAD_LEFT
  const plotRight = SVG_CANVAS_WIDTH - PAD_RIGHT
  const slotWidth = (plotRight - plotLeft) / Math.max(labels.length, 1)
  const count = Math.max(safe.length, 1)
  // 分类槽位再按序列数分栏；柱宽占子槽位的 70%，并保底 1px，否则多序列时柱会窄到看不见。
  const subSlot = slotWidth / count
  const barWidth = Math.max(1, subSlot * 0.7)
  const zeroY = toY(0)
  const marked = safe.length === 1 ? markedIndexes(safe[0]?.values ?? []) : null

  for (const [seriesIndex, item] of safe.entries()) {
    const slot = seriesSlot(safe.length, seriesIndex)
    for (const [index, value] of item.values.entries()) {
      const centerX = plotLeft + slotWidth * index + subSlot * (seriesIndex + 0.5)
      const valueY = toY(value)
      shapes.push({
        kind: 'rect',
        x: centerX - barWidth / 2,
        y: Math.min(valueY, zeroY),
        width: barWidth,
        height: Math.max(1, Math.abs(zeroY - valueY)),
        radius: 2,
        ...(slot === undefined ? {} : { series: slot })
      })
      // 多序列不标点值：相邻柱太窄，数字会互相压住；结论改由 notes 与图例给出。
      if (marked !== null && marked.has(index)) {
        shapes.push({
          kind: 'text',
          x: centerX,
          y: value >= 0 ? Math.min(valueY, zeroY) - 4 : Math.max(valueY, zeroY) + 11,
          text: valueText(value, unit),
          anchor: 'middle',
          muted: true
        })
      }
    }
  }

  return {
    height: PAD_TOP + PLOT_HEIGHT + PAD_BOTTOM,
    shapes,
    notes: chartNotes(labels, safe, unit)
  }
}

/** 折线图：按槽位中心连线，折点用小圆标出；多序列各画一条。 */
export function layoutLineChart(
  labels: readonly string[],
  series: readonly ChartSeries[],
  unit?: string
): SvgLayout {
  const safe = safeSeries(series)
  const scale = scaleOf(allValues(safe))
  const toY = makeY(scale)
  const shapes = axisShapes(scale, labels)

  const plotLeft = PAD_LEFT
  const plotRight = SVG_CANVAS_WIDTH - PAD_RIGHT
  const slotWidth = (plotRight - plotLeft) / Math.max(labels.length, 1)
  const marked = safe.length === 1 ? markedIndexes(safe[0]?.values ?? []) : null

  for (const [seriesIndex, item] of safe.entries()) {
    const slot = seriesSlot(safe.length, seriesIndex)
    let previous: { x: number; y: number } | null = null
    for (const [index, value] of item.values.entries()) {
      const x = plotLeft + slotWidth * (index + 0.5)
      const y = toY(value)
      if (previous !== null) {
        shapes.push({
          kind: 'line',
          x1: previous.x,
          y1: previous.y,
          x2: x,
          y2: y,
          muted: false,
          ...(slot === undefined ? {} : { series: slot })
        })
      }
      // 折点小圆半径固定 2.5；点数多时视觉上仍然是一条可读的线。
      shapes.push({ kind: 'circle', cx: x, cy: y, r: 2.5, ...(slot === undefined ? {} : { series: slot }) })
      if (marked !== null && marked.has(index)) {
        shapes.push({ kind: 'text', x, y: y - 6, text: valueText(value, unit), anchor: 'middle', muted: true })
      }
      previous = { x, y }
    }
  }

  return {
    height: PAD_TOP + PLOT_HEIGHT + PAD_BOTTOM,
    shapes,
    notes: chartNotes(labels, safe, unit)
  }
}

/** 饼图与环形图的画布：外半径、内半径与留白。整张图居中，不设坐标轴。 */
const PIE_RADIUS = 62
const PIE_INNER_RADIUS = 38
const PIE_PAD = 8

/** 切片占比低于这个比例时不标百分比：320px 画布上更小的扇区放不下数字。 */
const PIE_MIN_LABEL_SHARE = 0.1

/**
 * 占比文本：整数百分比，不足 1% 的写成 <1%，避免显示成 0% 与真实值矛盾。
 * 几何层、图例与复制的 Markdown 共用这一个函数，三处不会因为各写一份而漂。
 */
export function formatShare(value: number, total: number): string {
  if (total <= 0) return '—'
  const share = value / total
  if (share > 0 && share < 0.01) return '<1%'
  return `${Math.round(share * 100)}%`
}

/** 极坐标转直角坐标；`angle` 以 12 点方向为 0、顺时针增长（弧度）。 */
function polarPoint(cx: number, cy: number, radius: number, angle: number): { x: number; y: number } {
  return { x: cx + radius * Math.sin(angle), y: cy - radius * Math.cos(angle) }
}

/**
 * 扇形或环形扇形的路径。
 * 占满整圈时单段弧的起点与终点重合，SVG 会把它画成一条退化的线，
 * 因此整圈拆成两个半圆；其余情况按「外弧 → 内弧回退」拼成闭合路径。
 */
function slicePath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  startAngle: number,
  endAngle: number
): string {
  const span = endAngle - startAngle
  if (span >= Math.PI * 2 - 1e-6) {
    const top = `${cx} ${cy - outer}`
    const bottom = `${cx} ${cy + outer}`
    const outerCircle = `M ${top} A ${outer} ${outer} 0 1 1 ${bottom} A ${outer} ${outer} 0 1 1 ${top} Z`
    if (inner <= 0) return outerCircle
    const innerTop = `${cx} ${cy - inner}`
    const innerBottom = `${cx} ${cy + inner}`
    return `${outerCircle} M ${innerTop} A ${inner} ${inner} 0 1 0 ${innerBottom} A ${inner} ${inner} 0 1 0 ${innerTop} Z`
  }
  const startOuter = polarPoint(cx, cy, outer, startAngle)
  const endOuter = polarPoint(cx, cy, outer, endAngle)
  // 大弧标志：超过半圈时必须置 1，否则会走短边把扇区画反。
  const largeArc = span > Math.PI ? 1 : 0
  const outerArc = `M ${round2(startOuter.x)} ${round2(startOuter.y)} `
    + `A ${outer} ${outer} 0 ${largeArc} 1 ${round2(endOuter.x)} ${round2(endOuter.y)}`
  if (inner <= 0) return `${outerArc} L ${cx} ${cy} Z`
  const endInner = polarPoint(cx, cy, inner, endAngle)
  const startInner = polarPoint(cx, cy, inner, startAngle)
  // 内弧按相反方向（sweep=0）回退，环形扇区才不会自我交叉。
  return `${outerArc} L ${round2(endInner.x)} ${round2(endInner.y)} `
    + `A ${inner} ${inner} 0 ${largeArc} 0 ${round2(startInner.x)} ${round2(startInner.y)} Z`
}

/**
 * 饼图与环形图：按占比切分圆周，切片色槽按顺序取 0..5。
 * 与柱/折线不同，这里不做「单序列用中性色」的回落——占比图靠颜色区分切片，无色的饼图没有意义。
 */
export function layoutPieChart(
  labels: readonly string[],
  values: readonly number[],
  unit?: string,
  donut = false
): SvgLayout {
  const safe = values.map((value) => clampNumber(value, 0, 1e9, 0))
  const total = safe.reduce((sum, value) => sum + value, 0)
  // 画布宽度与柱/折线图一致（320），只把高度收窄到圆的直径；水平居中后与其它图表对齐。
  const height = PIE_RADIUS * 2 + PIE_PAD * 2
  const cx = SVG_CANVAS_WIDTH / 2
  const cy = height / 2
  const inner = donut ? PIE_INNER_RADIUS : 0
  const shapes: SvgShape[] = []
  const notes: string[] = []

  // 总和非正时只画一个空圆，不硬算占比（除零会得到 NaN 路径）。
  if (total <= 0) {
    shapes.push({ kind: 'circle', cx, cy, r: PIE_RADIUS, series: 0 })
    return { height, shapes, notes: ['所有切片之和为 0，无法计算占比'] }
  }

  let angle = 0
  for (const [index, value] of safe.entries()) {
    const share = value / total
    const end = index === safe.length - 1 ? Math.PI * 2 : angle + share * Math.PI * 2
    const slot = (index % 6) as SvgSeriesSlot
    // 零值切片不画路径（面积为零），但仍要进说明，否则用户会以为数据丢了。
    if (value > 0) {
      shapes.push({ kind: 'path', d: slicePath(cx, cy, PIE_RADIUS, inner, angle, end), series: slot })
    }
    if (share >= PIE_MIN_LABEL_SHARE) {
      const mid = (angle + end) / 2
      const labelRadius = inner > 0 ? (PIE_RADIUS + inner) / 2 : PIE_RADIUS * 0.62
      const point = polarPoint(cx, cy, labelRadius, mid)
      // 百分比压在切片上，用底色描边做光晕，否则深色扇区上的深色字读不出来。
      shapes.push({
        kind: 'text',
        x: point.x,
        y: point.y + 4,
        text: formatShare(value, total),
        anchor: 'middle',
        muted: false,
        halo: true
      })
    }
    const label = labels[index] ?? `分类 ${index + 1}`
    notes.push(`${label} ${formatShare(value, total)}（${valueText(value, unit)}）`)
    angle = end
  }

  // 环形中心写总计：留白就是为了这个，空着反而浪费了最显眼的位置。
  if (donut) {
    shapes.push({ kind: 'text', x: cx, y: cy + 2, text: valueText(total, unit), anchor: 'middle', muted: false, emphasis: true })
    shapes.push({ kind: 'text', x: cx, y: cy + 16, text: '合计', anchor: 'middle', muted: true })
  }

  return { height, shapes, notes: [`总计 ${valueText(total, unit)}`, ...notes] }
}
