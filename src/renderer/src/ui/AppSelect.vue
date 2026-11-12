<!-- 公共分组选择器：自绘触发键 + 候选浮层（浮层内容由 AppSelectList 承接，含搜索行与次级动作）。
     inline 模式下不渲染触发键与浮层，把候选列表直接交给外层容器（如输入坞 ＋ 菜单的二级面板）。
     选项、选中值与禁用状态都由调用方控制；展开的几何与监听交给 anchored-popup。 -->
<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useAnchoredPopup } from './anchored-popup'
import AppSelectList from './AppSelectList.vue'
import type { SelectGroup } from './AppSelectList.vue'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  readonly id: string
  readonly label: string
  readonly groups: readonly SelectGroup[]
  readonly modelValue: string
  readonly disabled?: boolean
  readonly searchable?: boolean
  readonly searchPlaceholder?: string
  readonly emptyLabel?: string
  readonly emptyResultsLabel?: string
  /** 触发键里模型名前的 provider 小字；缺失时不渲染，用于分层展示。 */
  readonly selectedMeta?: string | undefined
  /** 触发键首字母徽标；缺失时不渲染。 */
  readonly selectedBadge?: string | undefined
  /** 内嵌模式：不渲染触发键与浮层，直接渲染候选列表。 */
  readonly inline?: boolean
}>(), {
  disabled: false,
  searchable: false,
  searchPlaceholder: '搜索…',
  emptyLabel: '请选择',
  emptyResultsLabel: '没有匹配项',
  inline: false
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  /** 候选项次级动作被触发；动作不改选中值，结果由调用方处理。 */
  'option-action': [value: string]
}>()

const instanceId = useId()
const popupId = `app-select-list-${instanceId}`
// 展开状态与浮层几何由 composable 持有；内嵌模式不会打开浮层，这里的几何只在浮层模式使用。
// 浮层最小宽度 320px：模型名较长时选项不换行截断，仍受视窗约束。
const anchoredPopup = useAnchoredPopup({ minWidth: 320 })
const { trigger, popup, isOpen: expanded, position: popupPosition } = anchoredPopup
const list = ref<InstanceType<typeof AppSelectList> | null>(null)

const selectedOption = computed(() => props.groups
  .flatMap((group) => group.options)
  .find((option) => option.value === props.modelValue))
const selectedLabel = computed(() => selectedOption.value?.label ?? props.emptyLabel)
const popupStyle = computed(() => ({
  left: `${popupPosition.value.left}px`,
  top: `${popupPosition.value.top}px`,
  width: `${popupPosition.value.width}px`,
  maxHeight: `${popupPosition.value.maxHeight}px`
}))
/** 浮层打开后的落点：可搜索时进搜索框，否则落到选中项，保持既有键盘习惯。 */
const listAutofocus = computed(() => (props.searchable ? 'search' as const : 'option' as const))

watch(() => props.disabled, (disabled) => {
  if (disabled) closePopup()
})

function openPopup(): void {
  if (props.disabled || expanded.value) return
  anchoredPopup.open()
}

/** 收起浮层；需要时把焦点还给触发键。几何与监听都由 composable 负责。 */
function closePopup(restoreFocus = false): void {
  const wasOpen = anchoredPopup.close()
  if (restoreFocus && wasOpen) trigger.value?.focus()
}

function togglePopup(): void {
  if (expanded.value) closePopup()
  else openPopup()
}

function onTriggerKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (!expanded.value) openPopup()
    // 已展开时焦点本应在列表里；若被点回触发键，这里把焦点送回列表。
    else list.value?.focusInitial()
    return
  }
  if ((event.key === 'Enter' || event.key === ' ') && expanded.value) {
    event.preventDefault()
    list.value?.chooseActiveOption()
    return
  }
  if (event.key === 'Escape' && expanded.value) {
    event.preventDefault()
    event.stopPropagation()
    closePopup(true)
  }
}
</script>

<template>
  <button
    v-if="!props.inline"
    v-bind="$attrs"
    :id="props.id"
    ref="trigger"
    type="button"
    class="text-control app-select-trigger"
    :disabled="props.disabled"
    aria-haspopup="listbox"
    :aria-expanded="expanded"
    :aria-controls="popupId"
    @click="togglePopup"
    @keydown="onTriggerKeydown"
  >
    <span class="app-select-value">
      <span
        v-if="props.selectedBadge"
        class="app-select-badge"
        aria-hidden="true"
      >{{ props.selectedBadge }}</span>
      <span v-if="props.selectedMeta" class="app-select-meta">{{ props.selectedMeta }}</span>
      <span class="app-select-name">{{ selectedLabel }}</span>
    </span>
    <svg
      class="app-select-chevron"
      :class="{ 'is-expanded': expanded }"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
    >
      <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

  <Teleport v-if="!props.inline" to="body">
    <div
      v-if="expanded"
      ref="popup"
      class="app-select-popup"
      :style="popupStyle"
      data-app-select-popup
    >
      <AppSelectList
        ref="list"
        :id="popupId"
        :label="props.label"
        :groups="props.groups"
        :model-value="props.modelValue"
        :searchable="props.searchable"
        :search-placeholder="props.searchPlaceholder"
        :empty-results-label="props.emptyResultsLabel"
        :autofocus="listAutofocus"
        @update:model-value="emit('update:modelValue', $event)"
        @option-action="emit('option-action', $event)"
        @dismiss="closePopup"
      />
    </div>
  </Teleport>

  <!-- 内嵌模式：候选常驻在外层面板里，不打开浮层，选完也不收起外层。 -->
  <AppSelectList
    v-else
    ref="list"
    class="app-select-inline"
    :id="popupId"
    :label="props.label"
    :groups="props.groups"
    :model-value="props.modelValue"
    :searchable="props.searchable"
    :search-placeholder="props.searchPlaceholder"
    :empty-results-label="props.emptyResultsLabel"
    :disabled="props.disabled"
    autofocus="none"
    embedded
    @update:model-value="emit('update:modelValue', $event)"
    @option-action="emit('option-action', $event)"
  />
</template>

<style scoped>
.app-select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  text-align: left;
  cursor: pointer;
}

.app-select-trigger:disabled {
  cursor: not-allowed;
}

.app-select-value {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  overflow: hidden;
}

/* provider 小字与模型名分层；模型名用等宽字体，与路径、代码的呈现一致。
   两者只靠 .app-select-value 的 gap 分隔，不再用伪元素插分隔符——分隔符会被读成模型名的一部分。 */
.app-select-meta {
  flex: none;
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
}

.app-select-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 0.71875rem;
  font-weight: 500;
  color: var(--color-desk-ink);
}

.app-select-badge {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 1.125rem;
  height: 1.125rem;
  border-radius: 5px;
  background: var(--color-desk-accent-soft);
  color: var(--color-desk-accent);
  font-size: 0.625rem;
  font-weight: 700;
}

.app-select-chevron {
  flex: none;
  transition: transform var(--motion-duration-fast) var(--motion-ease-entrance);
}

.app-select-chevron.is-expanded {
  transform: rotate(180deg);
}

.app-select-popup {
  position: fixed;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--color-desk-line-strong);
  border-radius: var(--radius-desk-md);
  background: var(--color-desk-surface);
  box-shadow: var(--shadow-desk-pop);
  color: var(--color-desk-ink);
  transform-origin: top;
  animation: app-select-popup-in var(--motion-duration-base) var(--motion-ease-entrance) both;
}

/* 浮层持有焦点（搜索框或选项）时用自身描边表达，替代输入框单独再画一圈焦点环。 */
.app-select-popup:focus-within {
  border-color: var(--color-desk-accent);
}

@keyframes app-select-popup-in {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .app-select-chevron {
    transition: none;
  }

  .app-select-popup {
    animation: none;
  }
}
</style>
