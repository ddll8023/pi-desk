<!--
  能力选择器：设置页「默认能力」与专家编辑对话框共用的技能／MCP 范围选择。

  候选项可能很多，因此是「口径分段 + 计数 + 可选筛选 + 可滚动列表」，不是平铺标签。
  列表行是自绘勾选控件（role=checkbox 的按钮 + 方块与对勾），不用原生复选框：
  整行可点、键盘 Space/Enter 可切换、焦点环内缩不压容器边框。
  行尾状态文本由调用方给出（例如基线默认、已排除），本组件只按文本决定用警示色还是次级灰。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import AppButton from '../../ui/AppButton.vue'

/** 候选超过这个数量才出现筛选框：少量时多一个输入框反而碍事。 */
const SEARCH_THRESHOLD = 8

/** 一行候选；`unavailable` 表示定义里引用了但当前环境没有。 */
interface CapabilityPickerRow {
  readonly id: string
  readonly label: string
  readonly unavailable: boolean
  /** 行尾状态文本；空串表示不显示（例如「仅用选中」模式下勾选已说明状态）。 */
  readonly state: string
}

const props = defineProps<{
  readonly title: string
  /** 分段按钮组的无障碍名称；不叫 aria-label 以免被当成透传的 DOM 属性。 */
  readonly groupLabel: string
  readonly mode: 'inherit' | 'only'
  readonly selected: readonly string[]
  readonly rows: readonly CapabilityPickerRow[]
  /** 单份定义可引用的上限；基线卡片传的是候选总数，没有额外上限。 */
  readonly maxRefs: number
  readonly inheritLabel: string
  readonly onlyLabel: string
  readonly inheritHint: string
  readonly onlyHint: string
  readonly searchPlaceholder: string
  /** 筛选无结果时的提示。 */
  readonly emptyText: string
  /** 一个候选都没有时的提示；省略时沿用 `emptyText`。 */
  readonly noRowsText?: string
  /** 候选是否已读；读到之前不渲染列表，避免空白框看着像「一项都没有」。 */
  readonly ready: boolean
  readonly disabled?: boolean
  /** 继承模式下是否仍展示候选（编辑专家时要展示，用来加减；改默认基线时不需要）。 */
  readonly listInInherit?: boolean
}>()

const emit = defineEmits<{
  'update:mode': [mode: 'inherit' | 'only']
  'update:selected': [ids: readonly string[]]
}>()

const query = ref('')

const visibleRows = computed<readonly CapabilityPickerRow[]>(() => {
  const keyword = query.value.trim().toLowerCase()
  if (keyword === '') return props.rows
  return props.rows.filter(row => row.id.toLowerCase().includes(keyword))
})

const hint = computed(() => (props.mode === 'inherit' ? props.inheritHint : props.onlyHint))
/** 改默认基线时只关心子集，继承模式下没有可挑的；编辑专家时两种口径都要看。 */
const showList = computed(() => props.listInInherit === true || props.mode === 'only')
const noRowsText = computed(() => props.noRowsText ?? props.emptyText)

function toggle(id: string): void {
  const next = props.selected.includes(id)
    ? props.selected.filter(item => item !== id)
    : [...props.selected, id]
  emit('update:selected', next)
}

/** 排除与不可用用警示色，其余保持次级文字的灰度；状态文本始终可见，不只靠颜色。 */
function stateClass(state: string): string {
  return state === '已排除' || state === '当前不可用' ? 'text-desk-warning' : 'text-desk-muted'
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <span class="field-label">{{ title }}</span>
      <span class="text-2xs text-desk-muted">已选 {{ selected.length }} / 最多 {{ maxRefs }}</span>
    </div>

    <div class="segment" role="group" :aria-label="groupLabel">
      <AppButton
        variant="unstyled"
        class="segment-option"
        :class="{ 'is-selected': mode === 'inherit' }"
        :aria-pressed="mode === 'inherit'"
        :disabled="disabled || !ready"
        @click="emit('update:mode', 'inherit')"
      >
        {{ inheritLabel }}
      </AppButton>
      <AppButton
        variant="unstyled"
        class="segment-option"
        :class="{ 'is-selected': mode === 'only' }"
        :aria-pressed="mode === 'only'"
        :disabled="disabled || !ready"
        @click="emit('update:mode', 'only')"
      >
        {{ onlyLabel }}
      </AppButton>
    </div>

    <p class="hint-text">{{ hint }}</p>

    <p v-if="!ready" class="text-xs text-desk-muted">正在读取能力候选…</p>
    <template v-else-if="showList">
      <p v-if="rows.length === 0" class="text-xs text-desk-muted">{{ noRowsText }}</p>
      <template v-else>
        <label v-if="rows.length > SEARCH_THRESHOLD" class="block">
          <span class="sr-only">{{ searchPlaceholder }}</span>
          <input
            v-model="query"
            type="text"
            class="text-control"
            :placeholder="searchPlaceholder"
            :disabled="disabled"
          >
        </label>
        <ul class="max-h-56 divide-y divide-desk-line overflow-y-auto scroll-area rounded-desk-md border border-desk-line">
          <li v-for="row in visibleRows" :key="row.id">
            <button
              type="button"
              role="checkbox"
              class="check-row"
              :aria-checked="selected.includes(row.id)"
              :disabled="disabled"
              @click="toggle(row.id)"
            >
              <span class="check-mark" :class="{ 'is-on': selected.includes(row.id) }" aria-hidden="true">
                <svg v-if="selected.includes(row.id)" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M2.5 6.4 4.9 8.8 9.5 3.6" />
                </svg>
              </span>
              <span
                class="font-mono"
                :class="row.unavailable ? 'text-desk-warning' : 'text-desk-ink'"
              >{{ row.id }}</span>
              <span
                class="rounded-full border px-1.5 py-px text-2xs"
                :class="row.unavailable ? 'border-desk-warning text-desk-warning' : 'border-desk-line text-desk-muted'"
              >{{ row.label }}</span>
              <span v-if="row.state !== ''" class="ml-auto text-2xs" :class="stateClass(row.state)">
                {{ row.state }}
              </span>
            </button>
          </li>
        </ul>
        <p v-if="visibleRows.length === 0" class="text-xs text-desk-muted">{{ emptyText }}</p>
      </template>
    </template>
  </div>
</template>
