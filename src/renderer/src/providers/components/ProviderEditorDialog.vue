<!-- 供应商条目编辑弹窗：承载 models.json 条目的新增与编辑，表单由 ProviderDefinitionSection 提供。
     未保存的改动不叠加第二层弹窗：关闭请求先在本弹窗内切换确认视图，Escape 只回退本层；
     关闭后把焦点还给打开它的元素，键盘用户不会落回页面顶部。 -->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useModelsConfigStore } from '../stores/models-config'
import AppButton from '../../ui/AppButton.vue'
import ProviderDefinitionSection from './ProviderDefinitionSection.vue'

const props = defineProps<{
  /** 弹层由父级常驻挂载，`open` 控制进入/退出与焦点、快捷键生命周期。 */
  readonly open: boolean
  /** 新建还是编辑既有条目；编辑时供应商 ID 被锁定。 */
  readonly mode: 'create' | 'edit'
  /** 供应商 ID；编辑时是既有条目的 ID，新建时是初始值。 */
  readonly providerId: string
  /** 条目的初始 JSON 文本；新建时由父级给出初始模板。 */
  readonly initialRawText: string
  /** models.json 里已存在的供应商 ID；新建时用它拦下重名。 */
  readonly existingProviderIds: readonly string[]
}>()

const emit = defineEmits<{
  (event: 'saved', providerId: string): void
  (event: 'cancel'): void
}>()

const store = useModelsConfigStore()
const { busy, actionError } = storeToRefs(store)

const panel = ref<HTMLElement | null>(null)
const section = ref<InstanceType<typeof ProviderDefinitionSection> | null>(null)
const titleId = useId()
/** 未保存确认视图：与表单同层切换，不产生第二层焦点陷阱。 */
const confirmingDiscard = ref(false)
/** 打开前的焦点元素；关闭后把焦点还给它。 */
let opener: HTMLElement | null = null

const title = computed(() => {
  if (confirmingDiscard.value) return '放弃未保存的改动？'
  return props.mode === 'create' ? '新增供应商' : `编辑供应商 ${props.providerId}`
})

const subtitle = computed(() => (
  confirmingDiscard.value
    ? '关闭后这次编辑的内容不会写入 models.json。'
    : '只修改 models.json 里这一个供应商条目；其他供应商、其他顶层键与未涉及的字段原样保留。'
))

const canSave = computed(() => section.value?.canSave === true)
const saveBlockReason = computed(() => section.value?.saveBlockReason ?? null)
const submitLabel = computed(() => (props.mode === 'create' ? '新增供应商' : '保存供应商'))

/** 有关闭请求时先确认未保存的改动；确认视图内按 Escape 回到编辑，不直接关闭。 */
function requestClose(): void {
  if (section.value?.dirty === true) {
    confirmingDiscard.value = true
    void nextTick(() => panel.value?.focus())
    return
  }
  emit('cancel')
}

function submit(): void {
  void section.value?.submit()
}

/** 面板内可聚焦元素；隐藏的确认视图不参与循环。 */
function focusableElements(): HTMLElement[] {
  const root = panel.value
  if (root === null) return []
  const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  return [...root.querySelectorAll<HTMLElement>(selector)]
    .filter((element) => element.offsetParent !== null)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    // 只关闭本层：确认视图先退回编辑，再按一次才请求关闭。
    event.stopPropagation()
    if (confirmingDiscard.value) confirmingDiscard.value = false
    else requestClose()
    return
  }
  if (event.key !== 'Tab') return
  const items = focusableElements()
  const first = items[0]
  const last = items[items.length - 1]
  if (first === undefined || last === undefined) return
  const active = document.activeElement
  if (event.shiftKey && (active === first || active === panel.value)) {
    event.preventDefault()
    last.focus()
    return
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

// 打开时接管 Escape 与焦点，关闭时立即归还，避免同一页面多个实例重复响应。
watch(
  () => props.open,
  (open) => {
    if (open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      confirmingDiscard.value = false
      window.addEventListener('keydown', onKeydown)
      void nextTick(() => panel.value?.focus())
      return
    }
    window.removeEventListener('keydown', onKeydown)
    opener?.focus()
    opener = null
  },
  { immediate: true }
)

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div
        v-if="open"
        class="dialog-overlay"
        @click.self="requestClose"
      >
        <Transition name="dialog-panel-motion" appear>
          <div
            ref="panel"
            role="dialog"
            aria-modal="true"
            :aria-labelledby="titleId"
            tabindex="-1"
            class="dialog-panel provider-editor-panel"
            :class="mode === 'edit' ? 'max-w-3xl' : 'max-w-2xl'"
          >
            <div class="provider-editor-header">
              <div>
                <h2 :id="titleId" class="provider-editor-title">{{ title }}</h2>
                <p class="provider-editor-subtitle">{{ subtitle }}</p>
              </div>
            </div>

            <div class="provider-editor-body">
              <p v-if="confirmingDiscard" class="provider-editor-confirmation">
                这个条目的改动还没有保存；放弃后表单会回到上次读取到的内容。
              </p>
              <!-- 表单始终挂载：确认视图只是把它藏起来，避免「继续编辑」丢掉已填内容。 -->
              <div v-show="!confirmingDiscard">
                <ProviderDefinitionSection
                  ref="section"
                  :key="`${mode}-${providerId}`"
                  :mode="mode"
                  :provider-id="providerId"
                  :initial-raw-text="initialRawText"
                  :existing-provider-ids="existingProviderIds"
                  @saved="emit('saved', $event)"
                />
              </div>
            </div>

            <div class="provider-editor-footer">
              <template v-if="confirmingDiscard">
                <AppButton @click="confirmingDiscard = false">继续编辑</AppButton>
                <AppButton variant="danger" @click="emit('cancel')">放弃改动</AppButton>
              </template>
              <template v-else>
                <p v-if="actionError !== null" role="alert" class="mr-auto text-xs text-desk-danger">
                  {{ actionError.message }}
                </p>
                <p v-else-if="saveBlockReason !== null" class="mr-auto hint-text">{{ saveBlockReason }}</p>
                <AppButton :disabled="busy" @click="requestClose">取消</AppButton>
                <AppButton variant="primary" :disabled="!canSave" @click="submit">
                  {{ submitLabel }}
                </AppButton>
              </template>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.provider-editor-panel {
  max-height: min(90vh, 64rem);
  border-color: var(--color-desk-line-strong);
}

.provider-editor-header {
  flex: none;
  border-bottom: 1px solid var(--color-desk-line);
  padding: 1.25rem 1.5rem 1rem;
}

.provider-editor-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 650;
  line-height: 1.4;
  letter-spacing: -0.015em;
}

.provider-editor-subtitle {
  max-width: 50rem;
  margin: 0.375rem 0 0;
  color: var(--color-desk-muted);
  font-size: 0.75rem;
  line-height: 1.55;
}

.provider-editor-body {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 1.25rem 1.5rem;
}

.provider-editor-confirmation {
  max-width: 40rem;
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.6;
}

.provider-editor-footer {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
  border-top: 1px solid var(--color-desk-line);
  background: var(--color-desk-surface);
  padding: 0.75rem 1.5rem;
}

@media (max-width: 560px) {
  .provider-editor-header,
  .provider-editor-body,
  .provider-editor-footer {
    padding-inline: 1rem;
  }

  .provider-editor-footer {
    justify-content: stretch;
  }

  .provider-editor-footer :deep(button) {
    flex: 1 1 auto;
  }
}
</style>
