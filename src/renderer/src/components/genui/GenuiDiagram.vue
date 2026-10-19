<!-- 机制图解：把 exploded / gear / crank / vector / circuit / section 六种图示交给几何函数，再交给共用的图元渲染器。
     几何全部由 diagram-geometry 的纯函数算出，这里只负责取绑定值、调布局与写无障碍说明。
     没有动效：参数变化直接重算几何，避免长会话里多份图解同时跑动画。
     绑定值来自参数上下文；参数缺失时回落默认值（spread 取 0、angle 取 0°、voltage 取 0 由几何层夹到下限），不阻断渲染。 -->
<script setup lang="ts">
import { computed } from 'vue'
import type { GenuiDiagramKind, GenuiDiagramNode } from '../../../../shared/genui-api'
import { useGenuiParams, readGenuiBinding } from '../../genui/param-state'
import {
  layoutCircuit,
  layoutCrank,
  layoutExploded,
  layoutGearTrain,
  layoutSection,
  layoutVectors
} from '../../genui/diagram-geometry'
import { SVG_CANVAS_WIDTH } from '../../genui/svg-shapes'
import type { SvgLayout } from '../../genui/svg-shapes'
import GenuiSvgShapes from './GenuiSvgShapes.vue'

const props = defineProps<{
  readonly node: GenuiDiagramNode
}>()

const context = useGenuiParams()

/** 各图示在无障碍说明里的称呼；用映射而不是三元链，新增种类时编译器会提醒补齐。 */
const DIAGRAM_KIND_TITLES: Readonly<Record<GenuiDiagramKind, string>> = {
  exploded: '装配拆解图',
  gear: '齿轮传动图',
  crank: '曲柄连杆图',
  vector: '力矢量图',
  circuit: '串联电路图',
  section: '剖面图'
}

/** 取一个绑定参数的数值；未绑定、参数不存在或类型不符时返回 null，由调用方决定回落。 */
function boundValue(id: string | undefined): number | null {
  return context === null ? null : readGenuiBinding(context.values, id)
}

/** 角度绑定的默认值：0°，即机构处于初始位置。 */
const angle = computed(() => boundValue(props.node.binds?.angle) ?? 0)
/** 拆解间距绑定的默认值：0，即最小间距。 */
const spread = computed(() => boundValue(props.node.binds?.spread) ?? 0)
/** 电压绑定的默认值：0 会被几何层夹到下限，等价于「未绑定」。 */
const voltage = computed(() => boundValue(props.node.binds?.voltage) ?? 0)

const layout = computed<SvgLayout>(() => {
  const node = props.node
  switch (node.kind) {
    case 'exploded':
      return layoutExploded(node.parts, spread.value)
    case 'gear':
      return layoutGearTrain(node.gears, angle.value)
    case 'crank':
      return layoutCrank(node.crank, node.rod, angle.value, node.unit)
    case 'vector':
      return layoutVectors(node.vectors, node.unit, angle.value)
    case 'circuit':
      return layoutCircuit(voltage.value > 0 ? voltage.value : node.voltage, node.components)
    case 'section':
      return layoutSection(node.layers, node.unit)
  }
})

/** 无障碍说明：把图解的结论写成一句话，读屏用户不必看图也能得到同样的信息。 */
const ariaLabel = computed(() => `${DIAGRAM_KIND_TITLES[props.node.kind]}：${layout.value.notes.join('；')}`)
</script>

<template>
  <GenuiSvgShapes
    :shapes="layout.shapes"
    :width="SVG_CANVAS_WIDTH"
    :height="layout.height"
    :aria-label="ariaLabel"
    :caption="node.caption"
    :notes="layout.notes"
  />
</template>
