/** 生成式界面的机制图解：爆炸图、齿轮、曲柄、矢量、回路与层状剖面，以及图解与参数的绑定。 */

import { GENUI_DIAGRAM_KINDS } from './limits'


/** 图示种类；每种只接受自己的字段，未知 kind 整份拒绝。 */
export type GenuiDiagramKind = (typeof GENUI_DIAGRAM_KINDS)[number]

/** 装配拆解的零件：名称必填，说明可选。 */
export interface GenuiExplodedPart {
  readonly label: string
  readonly note?: string
}

/**
 * 图示的绑定：把一个几何量绑到已声明的数值参数上，参数变化时重算几何。
 * 不是表达式：只有这三个键，且目标必须是 number 参数，因此不需要求值器。
 */
export interface GenuiDiagramBinds {
  /** 曲柄角度、齿轮驱动角或力系的整体旋转偏移，单位度。 */
  readonly angle?: string
  /** 装配拆解的拆解间距系数，取值 0..1。 */
  readonly spread?: string
  /** 串联电路的电源电压；电流与压降随之重算。 */
  readonly voltage?: string
}

/** 装配拆解图：纵向展开的零件序列。 */
export interface GenuiExplodedDiagram {
  readonly type: 'diagram'
  readonly kind: 'exploded'
  readonly parts: readonly GenuiExplodedPart[]
  readonly caption?: string
  readonly binds?: GenuiDiagramBinds
}

/** 齿轮传动图的一个齿轮：标签 + 齿数。 */
export interface GenuiGearSpec {
  readonly label: string
  readonly teeth: number
}

/** 齿轮传动图：节圆半径正比于齿数，传动比由齿数推出。 */
export interface GenuiGearDiagram {
  readonly type: 'diagram'
  readonly kind: 'gear'
  readonly gears: readonly GenuiGearSpec[]
  readonly caption?: string
  readonly binds?: GenuiDiagramBinds
}

/**
 * 曲柄连杆图：曲柄长与连杆长为静态值，必须 `rod > crank`，否则机构不成立。
 * `binds.angle` 可驱动曲柄角度，活塞位置随之算出。
 */
export interface GenuiCrankDiagram {
  readonly type: 'diagram'
  readonly kind: 'crank'
  readonly crank: number
  readonly rod: number
  readonly unit?: string
  readonly caption?: string
  readonly binds?: GenuiDiagramBinds
}

/**
 * 一个力矢量：标签、模长与方向角。
 * `angle` 以度为单位，0 表示向右，逆时针为正（与曲柄角同口径）；
 * 几何层再把它转成屏幕坐标，因此传入方不需要关心 SVG 的 y 轴方向。
 */
export interface GenuiVectorSpec {
  readonly label: string
  readonly magnitude: number
  readonly angle: number
}

/** 力矢量图：多个力共起点，末端画箭头，并给出合力大小与方向。 */
export interface GenuiVectorDiagram {
  readonly type: 'diagram'
  readonly kind: 'vector'
  readonly vectors: readonly GenuiVectorSpec[]
  readonly unit?: string
  readonly caption?: string
  readonly binds?: GenuiDiagramBinds
}

/**
 * 串联电路里允许的元件种类。
 * 只收这三种纯阻性元件：它们的电压电流关系是线性的，推导结论才成立。
 * 电容与电感在直流稳态下不适用 `I = U/R`，加进来只能画图不能给结论，因此不收。
 */
export type GenuiCircuitComponentKind = 'resistor' | 'lamp' | 'switch'

/** 一个串联元件；`value` 是阻值（> 0），开关不接受阻值。 */
export interface GenuiCircuitComponent {
  readonly kind: GenuiCircuitComponentKind
  readonly label: string
  readonly value?: number
}

/**
 * 串联电路图：单一回路，电源在左，元件依次串在回路上。
 * 只做串联：并联需要节点图自动布局，收益远低于成本，而且推导结论会变复杂。
 */
export interface GenuiCircuitDiagram {
  readonly type: 'diagram'
  readonly kind: 'circuit'
  readonly voltage: number
  readonly components: readonly GenuiCircuitComponent[]
  readonly caption?: string
  readonly binds?: GenuiDiagramBinds
}

/** 剖面的一层：由内到外排列，`thickness` 是这一层的厚度。 */
export interface GenuiSectionLayer {
  readonly label: string
  readonly thickness: number
  readonly note?: string
}

/**
 * 剖面图：同心圆环，由内到外逐层包裹。
 * 不做堆叠分层带：那种视觉与 exploded 高度重合，而同心圆环适合电缆、管路、滤芯这类真实剖面。
 */
export interface GenuiSectionDiagram {
  readonly type: 'diagram'
  readonly kind: 'section'
  readonly layers: readonly GenuiSectionLayer[]
  readonly unit?: string
  readonly caption?: string
  readonly binds?: GenuiDiagramBinds
}

/** 图示节点联合；几何由渲染端公式计算，协议里没有表达式也没有脚本。 */
export type GenuiDiagramNode =
  | GenuiExplodedDiagram
  | GenuiGearDiagram
  | GenuiCrankDiagram
  | GenuiVectorDiagram
  | GenuiCircuitDiagram
  | GenuiSectionDiagram
