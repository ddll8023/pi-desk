/**
 * 机制图解的几何计算：把零件、齿数、力矢量、电路参数与剖面层厚这类静态事实，换算成可直接画出的 SVG 图元。
 *
 * 纯函数、不依赖 Vue、不读参数状态：调用方把当前绑定值传进来，这里只负责几何。
 * 协议里没有表达式也没有脚本，传动比、齿速比与活塞位移都由这里的公式算出，
 * 因此不需要受限求值器，也不存在 `eval` / `new Function` 的路径。
 *
 * 所有外部数值进来先过有限性守卫并夹到区间：模型给出的极值不能把图元算成 NaN 或 Infinity，
 * 也不能让图形溢出画布。
 *
 * 图元类型、画布宽度与数值守卫在 `svg-shapes.ts`：图表几何（`chart-geometry.ts`）与这里
 * 输出同一套 `SvgShape`，因此渲染组件只需一份。
 */
import { SVG_CANVAS_WIDTH, clampNumber, round2 } from './svg-shapes'
import type { SvgLayout, SvgShape } from './svg-shapes'

/** 齿轮图的画布高度；固定值便于多份图解并排时视觉一致。 */
const GEAR_HEIGHT = 240

/** 曲柄图的画布高度；行程越大占用越高，因此按行程算出后再夹到区间。 */
const CRANK_MIN_HEIGHT = 160
const CRANK_MAX_HEIGHT = 300

/** 装配拆解图的最小画布高度与间距区间；间距由 spread 在区间内插值。 */
const EXPLODED_MIN_HEIGHT = 200
const EXPLODED_MIN_GAP = 6
const EXPLODED_MAX_GAP = 22

/** 齿轮绘制：节圆半径按齿数线性映射到该区间，避免 6 齿与 60 齿尺寸差 10 倍。 */
const GEAR_MIN_RADIUS = 26
const GEAR_MAX_RADIUS = 52

/**
 * 画齿数文字的最小半径：再小就与相邻齿轮的数字叠在一起。
 * 齿数本身仍进 `notes`，所以不画不会丢信息。
 */
const GEAR_TEETH_TEXT_MIN_RADIUS = 18

/** 齿轮标签至少保留的字符数；实际保留量按直径估算，窄齿轮不会写出满屏标签。 */
const GEAR_LABEL_MIN_CHARS = 4

/** 字号 11px 下每个字符大致占的宽度（按汉字估，英文标签会更宽裕）。 */
const GEAR_LABEL_CHAR_WIDTH = 11

/** 标签截断：按可用直径估算能放下几个字，超出补省略号；不做逐字测宽。 */
function truncateLabel(label: string, maxWidth: number): string {
  const maxChars = Math.max(GEAR_LABEL_MIN_CHARS, Math.floor(maxWidth / GEAR_LABEL_CHAR_WIDTH))
  if (label.length <= maxChars) return label
  return `${label.slice(0, Math.max(1, maxChars - 1))}…`
}

/** 装配拆解：纵向堆叠零件块，右侧标签，中间用引线连到块。 */
export function layoutExploded(
  parts: readonly { readonly label: string; readonly note?: string }[],
  spread: number
): SvgLayout {
  const ratio = clampNumber(spread, 0, 1, 0)
  const gap = EXPLODED_MIN_GAP + (EXPLODED_MAX_GAP - EXPLODED_MIN_GAP) * ratio
  const shapes: SvgShape[] = []
  const blockWidth = 120
  const blockHeight = 24
  const blockX = 28
  let y = 20

  for (const [index, part] of parts.entries()) {
    shapes.push({ kind: 'rect', x: blockX, y, width: blockWidth, height: blockHeight, radius: 6 })
    shapes.push({
      kind: 'text',
      x: blockX + blockWidth / 2,
      y: y + blockHeight / 2 + 4,
      text: String(index + 1),
      anchor: 'middle',
      muted: true
    })
    // 引线从块的右缘拉到标签左缘，标签纵向与块对齐。
    shapes.push({ kind: 'line', x1: blockX + blockWidth, y1: y + blockHeight / 2, x2: blockX + blockWidth + 18, y2: y + blockHeight / 2, muted: true })
    shapes.push({ kind: 'text', x: blockX + blockWidth + 24, y: y + 12, text: part.label, anchor: 'start', muted: false })
    if (part.note !== undefined) {
      shapes.push({ kind: 'text', x: blockX + blockWidth + 24, y: y + 24, text: part.note, anchor: 'start', muted: true })
    }
    y += blockHeight + gap
  }

  return {
    height: Math.max(EXPLODED_MIN_HEIGHT, y + 12),
    shapes,
    notes: [`${parts.length} 个零件`, `拆解间距 ${Math.round(ratio * 100)}%`]
  }
}

/** 齿轮布局的中间结果；渲染端只需要形状与结论，但传动比要在这里算出来。 */
interface GearPlacement {
  readonly cx: number
  readonly cy: number
  readonly r: number
  readonly teeth: number
  readonly label: string
}

/** 齿轮传动：节圆半径正比齿数，相邻齿轮相切，齿圈用虚线节距画出。 */
export function layoutGearTrain(
  gears: readonly { readonly label: string; readonly teeth: number }[],
  angleDeg: number
): SvgLayout {
  const teethList = gears.map((gear) => clampNumber(gear.teeth, 1, 200, 12))
  const maxTeeth = Math.max(...teethList, 1)
  const radiusOf = (teeth: number): number => (
    GEAR_MIN_RADIUS + (GEAR_MAX_RADIUS - GEAR_MIN_RADIUS) * (teeth / maxTeeth)
  )

  // 先按比例算半径，再整体缩放到画布内：齿数差很大时也不会溢出。
  const rawRadii = teethList.map(radiusOf)
  const totalWidth = rawRadii.reduce((sum, r) => sum + r * 2, 0)
  const scale = totalWidth > SVG_CANVAS_WIDTH - 24 ? (SVG_CANVAS_WIDTH - 24) / totalWidth : 1
  const radii = rawRadii.map((r) => r * scale)

  const placements: GearPlacement[] = []
  let cursor = 12
  for (const [index, gear] of gears.entries()) {
    const r = radii[index] ?? GEAR_MIN_RADIUS
    placements.push({ cx: cursor + r, cy: GEAR_HEIGHT / 2, r, teeth: teethList[index] ?? 12, label: gear.label })
    cursor += r * 2
  }

  const shapes: SvgShape[] = []
  for (const placement of placements) {
    // 齿数越多节距越小，虚线密度随之变化，视觉上就是「齿」。
    const dash = Math.max(2, (2 * Math.PI * placement.r) / Math.max(placement.teeth, 1) / 2)
    shapes.push({ kind: 'circle', cx: placement.cx, cy: placement.cy, r: placement.r, dash })
    // 级数多时单个齿轮变小，齿数文字会互相压住；小到画不下就不画，齿数仍在结论与无障碍说明里。
    if (placement.r >= GEAR_TEETH_TEXT_MIN_RADIUS) {
      shapes.push({
        kind: 'text',
        x: placement.cx,
        y: placement.cy + 4,
        text: String(placement.teeth),
        anchor: 'middle',
        muted: false
      })
    }
    shapes.push({
      kind: 'text',
      x: placement.cx,
      y: placement.cy + placement.r + 18,
      text: truncateLabel(placement.label, 2 * placement.r),
      anchor: 'middle',
      muted: true
    })
  }

  // 主动轮画一条半径线表示驱动角；角度只影响这条线，不影响齿数关系。
  const driver = placements[0]
  if (driver !== undefined) {
    const theta = (clampNumber(angleDeg, 0, 360, 0) * Math.PI) / 180
    shapes.push({
      kind: 'line',
      x1: driver.cx,
      y1: driver.cy,
      x2: driver.cx + driver.r * Math.cos(theta),
      y2: driver.cy - driver.r * Math.sin(theta),
      muted: false
    })
  }

  const notes: string[] = []
  for (let index = 1; index < teethList.length; index += 1) {
    const prev = teethList[index - 1] ?? 1
    const current = teethList[index] ?? 1
    // 转速比 = 上一级齿数 / 本级齿数，方向交替。
    notes.push(`${index}→${index + 1} 级转速比 ${round2(prev / current)}，转向${index % 2 === 1 ? '相反' : '相同'}`)
  }
  const first = teethList[0] ?? 1
  const last = teethList[teethList.length - 1] ?? 1
  if (teethList.length > 1) notes.push(`总传动比 ${round2(last / first)}`)
  notes.push(`驱动角 ${Math.round(clampNumber(angleDeg, 0, 360, 0))}°`)

  return { height: GEAR_HEIGHT, shapes, notes }
}

/**
 * 曲柄连杆：活塞位移 x = r·cosθ + √(l² − r²sin²θ)。
 * 协议已保证 `rod > crank`，这里仍再夹一次，避免外部直接调用时算出 NaN。
 */
export function layoutCrank(
  crank: number,
  rod: number,
  angleDeg: number,
  unit?: string
): SvgLayout {
  const r = clampNumber(crank, 1, 400, 60)
  const l = clampNumber(rod, r + 1, 800, r * 2)
  const theta = (clampNumber(angleDeg, 0, 360, 0) * Math.PI) / 180

  const crankPinX = r * Math.cos(theta)
  const crankPinY = -r * Math.sin(theta)
  const pistonX = crankPinX + Math.sqrt(Math.max(0, l * l - crankPinY * crankPinY))

  // 世界坐标（以曲柄中心为原点、向右为 +x）映射到画布：留出左侧曲柄半径与右侧连杆长度。
  const padding = 16
  const worldMinX = -r - padding
  const worldMaxX = r + l + padding
  const span = Math.max(worldMaxX - worldMinX, 1)
  const scale = (SVG_CANVAS_WIDTH - 8) / span
  const toX = (worldX: number): number => 4 + (worldX - worldMinX) * scale
  const height = clampNumber(
    r * 2 * scale + 90,
    CRANK_MIN_HEIGHT,
    CRANK_MAX_HEIGHT,
    CRANK_MIN_HEIGHT
  )
  const centerY = height / 2
  const toY = (worldY: number): number => centerY - worldY * scale

  const shapes: SvgShape[] = []
  // 曲柄圆与导轨只作参照，弱化显示。
  shapes.push({ kind: 'circle', cx: toX(0), cy: toY(0), r: r * scale })
  shapes.push({ kind: 'line', x1: toX(pistonX), y1: toY(r), x2: toX(pistonX), y2: toY(-r), muted: true })
  // 曲柄、连杆、活塞三个实体件。
  shapes.push({ kind: 'line', x1: toX(0), y1: toY(0), x2: toX(crankPinX), y2: toY(crankPinY), muted: false })
  shapes.push({ kind: 'line', x1: toX(crankPinX), y1: toY(crankPinY), x2: toX(pistonX), y2: toY(0), muted: false })
  shapes.push({
    kind: 'rect',
    x: toX(pistonX) - 6,
    y: toY(0) - 14,
    width: 12,
    height: 28,
    radius: 3
  })

  const suffix = unit === undefined ? '' : ` ${unit}`
  shapes.push({ kind: 'text', x: toX(0), y: toY(0) + 4, text: 'O', anchor: 'middle', muted: true })
  shapes.push({
    kind: 'text',
    x: toX(pistonX),
    y: height - 8,
    text: `x=${round2(pistonX)}${suffix}`,
    anchor: 'middle',
    muted: true
  })

  return {
    height,
    shapes,
    notes: [
      `曲柄 r=${round2(r)}${suffix}，连杆 l=${round2(l)}${suffix}`,
      `曲柄角 ${Math.round(clampNumber(angleDeg, 0, 360, 0))}°，活塞位移 x=${round2(pistonX)}${suffix}`,
      `行程 ${round2(2 * r)}${suffix}`
    ]
  }
}


/** 矢量图的画布高度与箭头尺寸；箭头固定尺寸，不随矢量长度缩放。 */
const VECTOR_HEIGHT = 220
const VECTOR_ARROW_LENGTH = 9
const VECTOR_ARROW_HALF_WIDTH = 4

/** 把角度归一化到 0..360，仅用于展示。 */
function normalizeAngle(deg: number): number {
  const wrapped = deg % 360
  return wrapped < 0 ? wrapped + 360 : wrapped
}

/** 实心箭头：末端点为顶点，向后张开两翼；方向向量已换算到屏幕坐标。 */
function arrowPath(tipX: number, tipY: number, dirX: number, dirY: number): string {
  const length = Math.sqrt(dirX * dirX + dirY * dirY)
  // 零长度方向没有可指的方向：返回空路径，调用方据此不画箭头。
  if (length === 0) return ''
  const ux = dirX / length
  const uy = dirY / length
  const baseX = tipX - ux * VECTOR_ARROW_LENGTH
  const baseY = tipY - uy * VECTOR_ARROW_LENGTH
  // 垂直方向用于张开两翼。
  const px = -uy * VECTOR_ARROW_HALF_WIDTH
  const py = ux * VECTOR_ARROW_HALF_WIDTH
  return `M ${round2(tipX)} ${round2(tipY)} L ${round2(baseX + px)} ${round2(baseY + py)}`
    + ` L ${round2(baseX - px)} ${round2(baseY - py)} Z`
}

/**
 * 力矢量：所有矢量共起点，末端画实心箭头，标签落在末端外侧。
 *
 * 方向角以度为单位，0 表示向右、逆时针为正，与曲柄角同口径；换算到屏幕时 y 取反，
 * 因此传入方不需要关心 SVG 的 y 轴朝下。`rotateDeg` 是整体旋转偏移，用来让力系整体可转。
 * 合力由分量求和得出；模长小到可以忽略时写「合力为 0」，不输出一个没有意义的虚假角度。
 */
export function layoutVectors(
  vectors: readonly { readonly label: string; readonly magnitude: number; readonly angle: number }[],
  unit?: string,
  rotateDeg = 0
): SvgLayout {
  const suffix = unit === undefined ? '' : ` ${unit}`
  const rotate = (clampNumber(rotateDeg, -360, 360, 0) * Math.PI) / 180
  const items = vectors.map((vector) => {
    const magnitude = clampNumber(vector.magnitude, 0.01, 1e6, 1)
    const theta = (vector.angle * Math.PI) / 180 + rotate
    return {
      label: vector.label,
      magnitude,
      dx: magnitude * Math.cos(theta),
      dy: magnitude * Math.sin(theta)
    }
  })

  const maxMagnitude = Math.max(...items.map((item) => item.magnitude), 1)
  // 画布内可用半径：留出箭头与标签的余量，避免最长的那条顶到边框。
  const usableRadius = Math.min(VECTOR_HEIGHT, SVG_CANVAS_WIDTH) / 2 - 28
  const scale = usableRadius / maxMagnitude
  const originX = SVG_CANVAS_WIDTH / 2
  const originY = VECTOR_HEIGHT / 2

  const shapes: SvgShape[] = []
  // 参照十字：弱化显示，说明方向以「右为 0°、逆时针为正」。
  shapes.push({ kind: 'line', x1: originX - usableRadius, y1: originY, x2: originX + usableRadius, y2: originY, muted: true })
  shapes.push({ kind: 'line', x1: originX, y1: originY - usableRadius, x2: originX, y2: originY + usableRadius, muted: true })

  for (const item of items) {
    const endX = originX + item.dx * scale
    const endY = originY - item.dy * scale
    shapes.push({ kind: 'line', x1: originX, y1: originY, x2: endX, y2: endY, muted: false })
    // 箭头方向取该矢量自身方向；屏幕坐标下 y 分量取反，箭头才指向线的末端。
    const arrow = arrowPath(endX, endY, item.dx, -item.dy)
    if (arrow !== '') shapes.push({ kind: 'path', d: arrow, fill: 'solid' })
    shapes.push({
      kind: 'text',
      x: endX + (item.dx >= 0 ? 12 : -12),
      y: endY - 6,
      text: `${item.label} ${round2(item.magnitude)}${suffix}`,
      anchor: item.dx >= 0 ? 'start' : 'end',
      muted: true
    })
  }

  // 合力：分量求和后换算回方向角；模长小到可忽略时按平衡处理。
  const sumX = items.reduce((sum, item) => sum + item.dx, 0)
  const sumY = items.reduce((sum, item) => sum + item.dy, 0)
  const resultant = Math.sqrt(sumX * sumX + sumY * sumY)
  const balanced = resultant <= maxMagnitude * 0.01
  if (!balanced) {
    const endX = originX + sumX * scale
    const endY = originY - sumY * scale
    shapes.push({ kind: 'line', x1: originX, y1: originY, x2: endX, y2: endY, muted: true })
  }

  const notes: string[] = [
    `${items.length} 个力，分量和 ΣFx=${round2(sumX)}${suffix}、ΣFy=${round2(sumY)}${suffix}`
  ]
  notes.push(balanced
    ? '合力为 0（受力平衡）'
    : `合力 ${round2(resultant)}${suffix}，方向 ${round2(normalizeAngle((Math.atan2(sumY, sumX) * 180) / Math.PI))}°`)
  if (rotateDeg !== 0) notes.push(`整体旋转 ${round2(normalizeAngle(rotateDeg))}°`)

  return { height: VECTOR_HEIGHT, shapes, notes }
}

/** 串联电路的画布尺寸与符号尺寸；回路为矩形，元件沿上下边交替排布。 */
const CIRCUIT_HEIGHT = 200
const CIRCUIT_LEFT = 44
const CIRCUIT_RIGHT = SVG_CANVAS_WIDTH - 24
const CIRCUIT_TOP = 44
const CIRCUIT_BOTTOM = CIRCUIT_HEIGHT - 44
const CIRCUIT_SYMBOL_WIDTH = 28

/** 一个电路元件符号：电阻折线、灯泡圆加叉、开关斜线；全部只描边不填充。 */
function circuitSymbol(kind: 'resistor' | 'lamp' | 'switch', x: number, y: number): SvgShape[] {
  const half = CIRCUIT_SYMBOL_WIDTH / 2
  if (kind === 'resistor') {
    // 锯齿折线：把元件所在位置的直线遮住，用折线表示电阻。
    const segments = 6
    const points: string[] = [`M ${round2(x - half)} ${round2(y)}`]
    for (let index = 1; index <= segments; index += 1) {
      const px = x - half + (CIRCUIT_SYMBOL_WIDTH / segments) * index
      const py = y + (index % 2 === 0 ? -5 : 5)
      points.push(`L ${round2(px)} ${round2(py)}`)
    }
    points.push(`L ${round2(x + half)} ${round2(y)}`)
    return [{ kind: 'path', d: points.join(' '), fill: 'none' }]
  }
  if (kind === 'lamp') {
    return [
      { kind: 'circle', cx: x, cy: y, r: 8 },
      { kind: 'line', x1: round2(x - 5.7), y1: round2(y - 5.7), x2: round2(x + 5.7), y2: round2(y + 5.7), muted: false },
      { kind: 'line', x1: round2(x - 5.7), y1: round2(y + 5.7), x2: round2(x + 5.7), y2: round2(y - 5.7), muted: false }
    ]
  }
  // 开关默认画成断开：真实状态写在结论里，不在图上假装闭合。
  return [
    { kind: 'circle', cx: round2(x - half), cy: y, r: 2.5 },
    { kind: 'circle', cx: round2(x + half), cy: y, r: 2.5 },
    { kind: 'line', x1: round2(x - half), y1: y, x2: round2(x + half * 0.6), y2: y - 10, muted: false }
  ]
}

/**
 * 串联电路：单一回路，电源画在左边，元件沿上下两边交替串入。
 *
 * 只支持串联纯阻性元件，因此每条结论都成立：R总 = ΣR、I = U/R总、各元件压降 Uᵢ = I·Rᵢ。
 * 回路里有断开的开关时，电流为 0、不输出压降与功率——那才是真实结果，而不是除以零。
 */
export function layoutCircuit(
  voltage: number,
  components: readonly {
    readonly kind: 'resistor' | 'lamp' | 'switch'
    readonly label: string
    readonly value?: number
  }[]
): SvgLayout {
  const u = clampNumber(voltage, 0.01, 1e6, 12)
  const shapes: SvgShape[] = []
  const midY = CIRCUIT_HEIGHT / 2

  // 回路：上下两条边承载元件，右边是返回线，左边留给电源。
  shapes.push({ kind: 'line', x1: CIRCUIT_LEFT, y1: CIRCUIT_TOP, x2: CIRCUIT_RIGHT, y2: CIRCUIT_TOP, muted: true })
  shapes.push({ kind: 'line', x1: CIRCUIT_LEFT, y1: CIRCUIT_BOTTOM, x2: CIRCUIT_RIGHT, y2: CIRCUIT_BOTTOM, muted: true })
  shapes.push({ kind: 'line', x1: CIRCUIT_RIGHT, y1: CIRCUIT_TOP, x2: CIRCUIT_RIGHT, y2: CIRCUIT_BOTTOM, muted: true })

  // 电源：左侧两条短平行线，长线为正极。
  shapes.push({ kind: 'line', x1: CIRCUIT_LEFT, y1: CIRCUIT_TOP, x2: CIRCUIT_LEFT, y2: midY - 8, muted: true })
  shapes.push({ kind: 'line', x1: CIRCUIT_LEFT, y1: midY + 8, x2: CIRCUIT_LEFT, y2: CIRCUIT_BOTTOM, muted: true })
  shapes.push({ kind: 'line', x1: CIRCUIT_LEFT - 10, y1: midY - 8, x2: CIRCUIT_LEFT + 10, y2: midY - 8, muted: false })
  shapes.push({ kind: 'line', x1: CIRCUIT_LEFT - 5, y1: midY + 8, x2: CIRCUIT_LEFT + 5, y2: midY + 8, muted: false })
  shapes.push({ kind: 'text', x: CIRCUIT_LEFT - 14, y: midY + 4, text: `U=${round2(u)}V`, anchor: 'end', muted: true })

  // 元件沿上下边交替排布：上边从左往右，下边从右往左，构成一条串联路径。
  const span = CIRCUIT_RIGHT - CIRCUIT_LEFT
  const step = span / Math.max(components.length, 1)
  const openSwitches: string[] = []
  const resistances: { label: string; value: number }[] = []

  for (const [index, component] of components.entries()) {
    const onTop = index % 2 === 0
    const x = onTop
      ? CIRCUIT_LEFT + step * (index + 0.5)
      : CIRCUIT_RIGHT - step * (components.length - index - 0.5)
    const y = onTop ? CIRCUIT_TOP : CIRCUIT_BOTTOM
    shapes.push(...circuitSymbol(component.kind, x, y))
    if (component.kind === 'switch') {
      openSwitches.push(component.label)
    } else {
      resistances.push({ label: component.label, value: clampNumber(component.value ?? 1, 0.01, 1e6, 1) })
    }
    shapes.push({
      kind: 'text',
      x,
      y: onTop ? y - 14 : y + 22,
      text: component.label,
      anchor: 'middle',
      muted: true
    })
  }

  const total = resistances.reduce((sum, item) => sum + item.value, 0)
  const notes: string[] = []
  const resistanceText = resistances.map((item) => `${item.label} ${round2(item.value)}Ω`).join('、')
  if (resistanceText !== '') notes.push(`串联总阻 R=${round2(total)}Ω（${resistanceText}）`)
  if (openSwitches.length > 0) {
    // 回路断开：电流为 0，压降与功率都无从谈起，直接说清而不是给一个算出来的假值。
    notes.push(`${openSwitches.join('、')} 断开，回路不通，电流 0`)
    notes.push('电压全部加在断口上，各元件无压降')
  } else {
    const current = total > 0 ? u / total : 0
    notes.push(`电源 U=${round2(u)}V，电流 I=${round2(current)}A`)
    for (const item of resistances) notes.push(`${item.label} 压降 ${round2(current * item.value)}V`)
    notes.push(`总功率 P=${round2(u * current)}W`)
  }

  return { height: CIRCUIT_HEIGHT, shapes, notes }
}

/** 剖面图的画布高度与外圈半径上限；圆心靠左，右侧留给标签。 */
const SECTION_HEIGHT = 220
const SECTION_MAX_RADIUS = 78
/** 层与层之间的视觉间隙；不是数据，纯装饰。 */
const SECTION_RING_GAP = 1

/** 圆环路径：外圈与内圈各画一整圈，用奇偶填充规则自然成环。 */
function ringPath(cx: number, cy: number, outerRadius: number, innerRadius: number): string {
  const outer = Math.max(outerRadius - SECTION_RING_GAP, 0.5)
  const outerArc = `M ${round2(cx - outer)} ${round2(cy)}`
    + ` A ${round2(outer)} ${round2(outer)} 0 1 0 ${round2(cx + outer)} ${round2(cy)}`
    + ` A ${round2(outer)} ${round2(outer)} 0 1 0 ${round2(cx - outer)} ${round2(cy)} Z`
  if (innerRadius <= 0) return outerArc
  const innerArc = `M ${round2(cx - innerRadius)} ${round2(cy)}`
    + ` A ${round2(innerRadius)} ${round2(innerRadius)} 0 1 1 ${round2(cx + innerRadius)} ${round2(cy)}`
    + ` A ${round2(innerRadius)} ${round2(innerRadius)} 0 1 1 ${round2(cx - innerRadius)} ${round2(cy)} Z`
  return `${outerArc} ${innerArc}`
}

/**
 * 剖面：同心圆环，由内到外逐层包裹。
 *
 * 层厚是静态事实，外径由前面各层厚度累加得出；结论给各层外径、总外径与环形面积占比。
 * 面积用外圆减内圆算，不把厚度当面积——这是剖面图最容易写错的一处。
 */
export function layoutSection(
  layers: readonly { readonly label: string; readonly thickness: number; readonly note?: string }[],
  unit?: string
): SvgLayout {
  const suffix = unit === undefined ? '' : ` ${unit}`
  const thicknessList = layers.map((layer) => clampNumber(layer.thickness, 0.01, 1e6, 1))
  const totalThickness = thicknessList.reduce((sum, value) => sum + value, 0)
  const centerX = SECTION_MAX_RADIUS + 20
  const centerY = SECTION_HEIGHT / 2

  // 先算各层外径：累计厚度线性映射到半径上限，厚度与视觉半径保持正比。
  const outerRadii: number[] = []
  let accumulated = 0
  for (const thickness of thicknessList) {
    accumulated += thickness
    outerRadii.push((accumulated / totalThickness) * SECTION_MAX_RADIUS)
  }

  const shapes: SvgShape[] = []
  const notes: string[] = []
  const totalRadius = outerRadii[outerRadii.length - 1] ?? 0
  const totalArea = Math.PI * totalRadius * totalRadius
  let innerRadius = 0
  for (const [index, layer] of layers.entries()) {
    const outerRadius = outerRadii[index] ?? 0
    shapes.push({ kind: 'path', d: ringPath(centerX, centerY, outerRadius, innerRadius), fill: 'none' })
    const area = Math.PI * (outerRadius * outerRadius - innerRadius * innerRadius)
    const share = totalArea > 0 ? (area / totalArea) * 100 : 0
    notes.push(
      `第 ${index + 1} 层 ${layer.label}：厚 ${round2(thicknessList[index] ?? 0)}${suffix}，`
      + `外径 ${round2(outerRadius * 2)}${suffix}，面积占比 ${round2(share)}%`
    )
    // 引线从该层环带中部拉到右侧标签，标签纵向按层序均匀铺开，避免互相压住。
    const midRadius = (innerRadius + outerRadius) / 2
    const labelY = centerY - SECTION_MAX_RADIUS + (index + 0.5) * ((SECTION_MAX_RADIUS * 2) / Math.max(layers.length, 1))
    shapes.push({
      kind: 'line',
      x1: round2(centerX + midRadius * 0.4),
      y1: round2(centerY - midRadius),
      x2: centerX + SECTION_MAX_RADIUS + 12,
      y2: round2(labelY),
      muted: true
    })
    shapes.push({
      kind: 'text',
      x: centerX + SECTION_MAX_RADIUS + 16,
      y: round2(labelY + 4),
      text: `${index + 1} ${layer.label}`,
      anchor: 'start',
      muted: false
    })
    if (layer.note !== undefined) {
      shapes.push({
        kind: 'text',
        x: centerX + SECTION_MAX_RADIUS + 16,
        y: round2(labelY + 16),
        text: layer.note,
        anchor: 'start',
        muted: true
      })
    }
    innerRadius = outerRadius
  }

  notes.unshift(`${layers.length} 层，总厚度 ${round2(totalThickness)}${suffix}，外径 ${round2(totalRadius * 2)}${suffix}`)
  return { height: SECTION_HEIGHT, shapes, notes }
}
