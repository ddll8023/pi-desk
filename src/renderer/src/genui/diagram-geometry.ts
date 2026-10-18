/**
 * 机制图解的几何计算：把零件、齿数与曲柄长度这类静态事实，换算成可直接画出的 SVG 图元。
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
    shapes.push({
      kind: 'text',
      x: placement.cx,
      y: placement.cy + 4,
      text: String(placement.teeth),
      anchor: 'middle',
      muted: false
    })
    shapes.push({
      kind: 'text',
      x: placement.cx,
      y: placement.cy + placement.r + 18,
      text: placement.label,
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
