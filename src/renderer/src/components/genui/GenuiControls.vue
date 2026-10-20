<!-- 参数控件组：按文档声明顺序渲染 number / select / toggle / text 四类输入，只读写渲染端内存里的参数取值
     （内存为真源，写入后由 param-persistence.ts 节流回写本机旁路文件）。
     改动参数不发请求、不做派生计算；提交按钮在 UiDocument 底部，由用户显式点击。
     界面被更高版本取代时上下文为只读，四类控件全部禁用，取值仍可查看。
     类型特有字段（min/max/step/options/placeholder）一律经按类型分派的辅助函数取值，模板不做窄化断言。
     文本参数额外持有本地草稿：输入法组合期间只写草稿不写状态，compositionend 才写回状态，
     否则回灌的收敛结果会打断中文输入。
     显示条件（visibleWhen）与分组（group）：前者与提交、复制共用 `isGenuiParamVisible`；
     后者按声明顺序的连续段分块，不相邻的同名组不合并（合并会打乱模型声明的顺序）。
     条件把全部参数都藏起来时，界面不整块消失，而是明说「当前条件下没有可调参数」。 -->
<script setup lang="ts">
import { computed, reactive, useId, watch } from 'vue'
import type {
  GenuiControlsNode,
  GenuiParam,
  GenuiParamValue,
  GenuiSelectOption
} from '../../../../shared/genui-api'
import { GENUI_MAX_PARAM_TEXT_CHARS, isGenuiParamVisible } from '../../../../shared/genui-api'
import { useGenuiParams } from '../../genui/param-state'

const props = defineProps<{
  readonly node: GenuiControlsNode
}>()

const context = useGenuiParams()
/** 只读态：该界面已被更高版本取代，控件不得生效。 */
const readOnly = computed(() => context?.readOnly === true)
/** 控件 id 前缀；label 与控件用同一套 id 关联，多份界面同屏时不撞车。 */
const idBase = useId()

/** 未声明 step 时的滑杆步长：宽区间按 1，窄区间切成 20 份；只决定拖动粒度，状态层只在声明了 step 时做步长对齐。 */
const NARROW_SPAN = 20

/** 渲染哪些参数：节点声明了 params 就按它的顺序，省略时按文档声明顺序渲染全部。 */
const declared = computed<readonly GenuiParam[]>(() => {
  const params = context?.params ?? []
  const ids = props.node.params
  if (ids === undefined) return params
  const byId = new Map(params.map((param) => [param.id, param]))
  return ids
    .map((id) => byId.get(id))
    .filter((param): param is GenuiParam => param !== undefined)
})

/** 当前条件下可见的参数；隐藏的参数仍保留取值，只是不渲染控件。 */
const visible = computed<readonly GenuiParam[]>(() => {
  const values = context?.values ?? {}
  return declared.value.filter((param) => isGenuiParamVisible(param, values))
})

/** 一个分组：标题（无组名为空串）与组内参数。 */
interface ControlGroup {
  readonly title: string
  readonly params: readonly GenuiParam[]
}

/**
 * 按声明顺序的连续段分组：只有相邻且组名相同的参数归到同一块。
 * 不做全局按名聚合：那会打乱模型声明的顺序，与「按声明顺序渲染」的既有语义冲突。
 */
const groups = computed<readonly ControlGroup[]>(() => {
  const result: ControlGroup[] = []
  for (const param of visible.value) {
    const title = param.group ?? ''
    const last = result[result.length - 1]
    if (last !== undefined && last.title === title) {
      result[result.length - 1] = { title, params: [...last.params, param] }
      continue
    }
    result.push({ title, params: [param] })
  }
  return result
})

/** 当前取值；状态里没有该项时回落到参数默认值，界面不显示空值。 */
function current(param: GenuiParam): GenuiParamValue {
  const value = context?.values[param.id]
  return value === undefined ? param.default : value
}

function numberCurrent(param: GenuiParam): number {
  const value = current(param)
  // 类型不符时回落声明默认值而不是 0：0 可能落在区间外，会让滑杆初始值越界。
  return typeof value === 'number' ? value : (param.type === 'number' ? param.default : 0)
}

function selectCurrent(param: GenuiParam): string {
  const value = current(param)
  return typeof value === 'string' ? value : ''
}

function toggleCurrent(param: GenuiParam): boolean {
  return current(param) === true
}

/** 文本参数的本地草稿；组合期间它先于状态更新，让输入框不被收敛结果回灌。 */
const drafts = reactive<Record<string, string>>({})

/** 文本参数的显示值：有草稿用草稿，否则回落到状态值。 */
function textDraft(param: GenuiParam): string {
  const draft = drafts[param.id]
  if (draft !== undefined) return draft
  const value = context?.values[param.id]
  if (typeof value === 'string') return value
  return param.type === 'text' ? param.default : ''
}

/** 占位提示；非文本参数返回 undefined，模板据此不写 placeholder。 */
function textPlaceholder(param: GenuiParam): string | undefined {
  return param.type === 'text' ? param.placeholder : undefined
}

/** 数值展示：最多 6 位小数，去掉浮点尾差，其余按本地化千分位。 */
function formatNumber(value: number): string {
  return Number(value.toFixed(6)).toLocaleString('zh-CN')
}

/** 参数值文本（含单位）；非数值参数返回空串，模板据此不渲染数值行。
 * 同时作为滑杆的 aria-valuetext：读屏只报裸数字时听不到单位。
 * 数值与单位用不换行空格连接，避免窄容器里被拆到两行。 */
function numberText(param: GenuiParam): string {
  if (param.type !== 'number') return ''
  const unit = param.unit === undefined ? '' : `\u00a0${param.unit}`
  return `${formatNumber(numberCurrent(param))}${unit}`
}

function rangeMin(param: GenuiParam): number {
  return param.type === 'number' ? param.min : 0
}

function rangeMax(param: GenuiParam): number {
  return param.type === 'number' ? param.max : 0
}

function rangeStep(param: GenuiParam): number {
  if (param.type !== 'number') return 1
  if (param.step !== undefined) return param.step
  const span = param.max - param.min
  return span >= NARROW_SPAN ? 1 : span / NARROW_SPAN
}

function selectOptions(param: GenuiParam): readonly GenuiSelectOption[] {
  return param.type === 'select' ? param.options : []
}

/** 原生控件取值；类型不符或非有限数字时不做猜测，直接不写。 */
function onNumberInput(param: GenuiParam, event: Event): void {
  if (param.type !== 'number') return
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  const value = target.valueAsNumber
  if (!Number.isFinite(value)) return
  context?.setValue(param.id, value)
}

function onSelectInput(param: GenuiParam, event: Event): void {
  if (param.type !== 'select') return
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  context?.setValue(param.id, target.value)
}

function onToggleInput(param: GenuiParam, event: Event): void {
  if (param.type !== 'toggle') return
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  context?.setValue(param.id, target.checked)
}

/**
 * 文本输入：先把原样内容写进草稿，组合结束后才交给状态层收敛。
 * 组合期间写状态会让截断/折行结果回灌输入框，中文输入法会丢掉正在拼的字符。
 */
function onTextInput(param: GenuiParam, event: Event): void {
  if (param.type !== 'text') return
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  drafts[param.id] = target.value
  if (event instanceof InputEvent && event.isComposing) return
  context?.setValue(param.id, target.value)
}

/** 组合结束：这一次才算真正输入完成，把最终文本交给状态层。 */
function onTextCompositionEnd(param: GenuiParam, event: Event): void {
  if (param.type !== 'text') return
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  drafts[param.id] = target.value
  context?.setValue(param.id, target.value)
}

/** 状态被外部改动（收敛截断、条目重建、重置）时草稿跟随，避免输入框显示已经不存在的旧文本。
    监听声明全集而不是可见集：被条件隐藏的文本参数重新显示时，草稿也要与状态一致。 */
watch(
  () => declared.value.map((param) => context?.values[param.id]),
  (values) => {
    declared.value.forEach((param, index) => {
      const value = values[index]
      if (param.type === 'text' && typeof value === 'string' && drafts[param.id] !== value) {
        drafts[param.id] = value
      }
    })
  }
)
</script>

<template>
  <!-- 声明了参数就渲染这一块：条件把全部参数藏起来时，用一行说明代替整块消失。 -->
  <section v-if="context !== null && declared.length > 0" class="genui-controls" aria-label="调整参数">
    <header class="genui-controls-heading">
      <h4>调整参数</h4>
      <span>{{ readOnly ? '仅供查看' : `${visible.length} 项可调` }}</span>
    </header>
    <p v-if="visible.length === 0" class="genui-controls-empty" role="status">
      当前条件下没有可调参数；先调整上面控制显示条件的选项。
    </p>
    <!-- 分组：有组名的先渲染标题，无组名的直接排进网格；相邻同名组已在 computed 里合并。 -->
    <template v-for="(group, groupIndex) in groups" :key="`${groupIndex}-${group.title}`">
      <h5 v-if="group.title !== ''" class="genui-controls-group-title">{{ group.title }}</h5>
      <div class="genui-controls-grid">
        <div v-for="param in group.params" :key="param.id" class="genui-control" :class="`genui-control-${param.type}`">
          <div class="genui-control-heading">
            <label :for="`${idBase}-${param.id}`" class="genui-control-label">{{ param.label }}</label>
            <span v-if="param.type === 'number'" class="genui-control-value">{{ numberText(param) }}</span>
          </div>

          <input
            v-if="param.type === 'number'"
            :id="`${idBase}-${param.id}`"
            type="range"
            class="genui-range"
            :min="rangeMin(param)"
            :max="rangeMax(param)"
            :step="rangeStep(param)"
            :value="numberCurrent(param)"
            :aria-valuetext="numberText(param)"
            :disabled="readOnly"
            @input="onNumberInput(param, $event)"
          >
          <select
            v-else-if="param.type === 'select'"
            :id="`${idBase}-${param.id}`"
            class="text-control"
            :value="selectCurrent(param)"
            :disabled="readOnly"
            @change="onSelectInput(param, $event)"
          >
            <option v-for="option in selectOptions(param)" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
          <input
            v-else-if="param.type === 'text'"
            :id="`${idBase}-${param.id}`"
            type="text"
            class="text-control"
            :value="textDraft(param)"
            :maxlength="GENUI_MAX_PARAM_TEXT_CHARS"
            :placeholder="textPlaceholder(param)"
            spellcheck="false"
            :disabled="readOnly"
            @input="onTextInput(param, $event)"
            @compositionend="onTextCompositionEnd(param, $event)"
          >
          <div v-else class="genui-toggle">
            <input
              :id="`${idBase}-${param.id}`"
              type="checkbox"
              class="genui-checkbox"
              :checked="toggleCurrent(param)"
              :disabled="readOnly"
              @change="onToggleInput(param, $event)"
            >
            <span>{{ toggleCurrent(param) ? '已启用' : '已关闭' }}</span>
          </div>

          <p v-if="param.description !== undefined" class="genui-control-description">{{ param.description }}</p>
        </div>
      </div>
    </template>
  </section>
</template>
