<!--
  能力选择器：设置页「默认能力」与专家编辑对话框共用。

  两种形态：默认能力用 `grid`（一屏看全、直接点选），专家编辑用默认的 `list`
  （逐行要显示「基线默认／额外启用／已排除」等状态，网格放不下）。
  `mode` 可选：不传时只呈现一份勾选集合，不渲染分段与说明——那种场景没有「继承／白名单」两个口径。
  可选折叠：收起后只留标题行与计数，展开再渲染候选；默认展开由调用方决定。
  列表行是自绘勾选控件（role=checkbox 的按钮 + 方块与对勾），不用原生复选框：
  整行可点、键盘 Space/Enter 可切换、焦点环内缩不压容器边框。
  行尾状态文本由调用方给出（例如基线默认、已排除），本组件只按文本决定用警示色还是次级灰。
-->
<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import AppButton from '../../ui/AppButton.vue'

/** 列表形态下候选超过这个数量才出现筛选框：少量时多一个输入框反而碍事。 */
const LIST_SEARCH_THRESHOLD = 8
/** 网格形态一屏能看全更多项，阈值放宽；到需要滚动时才给筛选。 */
const GRID_SEARCH_THRESHOLD = 24

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
  /** 呈现形态；`grid` 用于只编辑一份集合的场景。 */
  readonly layout?: 'list' | 'grid'
  /** 分段按钮组的无障碍名称；只有传入 `mode` 时才需要。 */
  readonly groupLabel?: string
  /** 两种口径；省略时不分段，只编辑当前集合。 */
  readonly mode?: 'inherit' | 'only'
  readonly selected: readonly string[]
  readonly rows: readonly CapabilityPickerRow[]
  /** 单份定义可引用的上限；只在用默认计数时需要。 */
  readonly maxRefs?: number
  /** 计数文案的替代值；省略时用「已选 N / 最多 M」。 */
  readonly countText?: string
  readonly inheritLabel?: string
  readonly onlyLabel?: string
  readonly inheritHint?: string
  readonly onlyHint?: string
  readonly searchPlaceholder: string
  /** 筛选无结果时的提示。 */
  readonly emptyText: string
  /** 一个候选都没有时的提示；省略时沿用 `emptyText`。 */
  readonly noRowsText?: string
  /** 候选是否已读；读到之前不渲染列表，避免空白框看着像「一项都没有」。 */
  readonly ready: boolean
  readonly disabled?: boolean
  /** 继承模式下是否仍展示候选（编辑专家时要展示，用来加减；默认基线不需要）。 */
  readonly listInInherit?: boolean
  /** 「全选」动作的文案；省略时不提供该动作。 */
  readonly selectAllLabel?: string
  /** 是否提供展开／收起；省略时内容始终展开。 */
  readonly collapsible?: boolean
  /** 收起状态；只在 `collapsible` 下生效，由调用方持有，便于连内容外的说明一起隐藏。 */
  readonly collapsed?: boolean
}>()

const emit = defineEmits<{
  'update:mode': [mode: 'inherit' | 'only']
  'update:selected': [ids: readonly string[]]
  'select-all': []
  'toggle-collapse': []
}>()

const bodyId = `${useId()}-body`

const query = ref('')

const searchThreshold = computed(() => (props.layout === 'grid' ? GRID_SEARCH_THRESHOLD : LIST_SEARCH_THRESHOLD))
const visibleRows = computed<readonly CapabilityPickerRow[]>(() => {
  const keyword = query.value.trim().toLowerCase()
  if (keyword === '') return props.rows
  return props.rows.filter(row => row.id.toLowerCase().includes(keyword))
})

/** 没有 `mode` 就没有口径分段；这时集合本身就是范围。 */
const showMode = computed(() => props.mode !== undefined)
const hint = computed(() => {
  if (props.mode === undefined) return ''
  return (props.mode === 'inherit' ? props.inheritHint : props.onlyHint) ?? ''
})
/** 改默认基线时只关心子集，继承模式下没有可挑的；编辑专家时两种口径都要看。 */
const showList = computed(() => props.layout === 'grid'
  || props.listInInherit === true || props.mode === 'only')
const noRowsText = computed(() => props.noRowsText ?? props.emptyText)

const count = computed(() => {
  if (props.countText !== undefined) return props.countText
  if (props.maxRefs === undefined) return ''
  return `已选 ${props.selected.length} / 最多 ${props.maxRefs}`
})
/** 已全选时不再提供「全选」动作。 */
const canSelectAll = computed(() => props.selectAllLabel !== undefined && props.selected.length < props.rows.length)
/** 收起时只保留标题行：计数仍可见，展开后再渲染候选。 */
const bodyVisible = computed(() => props.collapsible !== true || props.collapsed !== true)

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
      <div class="flex items-center gap-2">
        <span v-if="count !== ''" class="text-2xs text-desk-muted">{{ count }}</span>
        <button
          v-if="canSelectAll"
          type="button"
          class="rounded-desk-sm text-2xs text-desk-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-desk-accent"
          :disabled="disabled"
          @click="emit('select-all')"
        >
          {{ selectAllLabel }}
        </button>
        <button
          v-if="collapsible"
          type="button"
          class="rounded-desk-sm p-0.5 text-desk-muted hover:text-desk-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-desk-accent"
          :aria-expanded="bodyVisible"
          :aria-controls="bodyId"
          @click="emit('toggle-collapse')"
        >
          <span class="sr-only">{{ bodyVisible ? '收起' : '展开' }}{{ title }}</span>
          <svg
            class="h-3.5 w-3.5 transition-transform"
            :class="{ 'rotate-90': bodyVisible }"
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <path
              d="M6 3.5 10.5 8 6 12.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>

    <div v-show="bodyVisible" :id="bodyId" class="space-y-2">
      <div v-if="showMode" class="segment" role="group" :aria-label="groupLabel">
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

    <p v-if="hint !== ''" class="hint-text">{{ hint }}</p>

    <p v-if="!ready" class="text-xs text-desk-muted">正在读取能力候选…</p>
    <template v-else-if="showList">
      <p v-if="rows.length === 0" class="text-xs text-desk-muted">{{ noRowsText }}</p>
      <template v-else>
        <label v-if="rows.length > searchThreshold" class="block">
          <span class="sr-only">{{ searchPlaceholder }}</span>
          <input
            v-model="query"
            type="text"
            class="text-control"
            :placeholder="searchPlaceholder"
            :disabled="disabled"
          >
        </label>

        <div v-if="layout === 'grid'" class="grid grid-cols-2 gap-1.5 md:grid-cols-3">
          <button
            v-for="row in visibleRows"
            :key="row.id"
            type="button"
            role="checkbox"
            class="check-cell"
            :aria-checked="selected.includes(row.id)"
            :title="row.id"
            :disabled="disabled"
            @click="toggle(row.id)"
          >
            <span class="check-mark" :class="{ 'is-on': selected.includes(row.id) }" aria-hidden="true">
              <svg v-if="selected.includes(row.id)" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2.5 6.4 4.9 8.8 9.5 3.6" />
              </svg>
            </span>
            <span
              class="min-w-0 truncate font-mono"
              :class="row.unavailable ? 'text-desk-warning' : 'text-desk-ink'"
            >{{ row.id }}</span>
            <span v-if="row.label !== ''" class="ml-auto shrink-0 text-2xs text-desk-muted">{{ row.label }}</span>
          </button>
        </div>

        <ul v-else class="max-h-56 divide-y divide-desk-line overflow-y-auto scroll-area rounded-desk-md border border-desk-line">
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
                v-if="row.label !== ''"
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
  </div>
</template>
