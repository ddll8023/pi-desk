<!-- 画像编辑对话框：改作用域、依据、标题与正文。
     领域锁定（引擎只允许同领域替换），保存等价于「新增一条并替换旧条目」；来源记录沿用原条目，已不存在的来源在保存时剔除并如实提示，本页不编辑来源。 -->
<script setup lang="ts">
import { nextTick, onUnmounted, ref, useId, watch } from 'vue'
import { MEMORY_CONTENT_MAX, MEMORY_PROFILE_DOMAINS, MEMORY_PROFILE_TITLE_MAX } from '../../../../shared/memory-api'
import type { MemoryProfileBasis, MemoryProfileDomain, MemoryProfileReadRecord } from '../../../../shared/memory-api'
import { MEMORY_BASIS_OPTIONS, MEMORY_DOMAIN_LABELS } from '../labels'
import AppButton from '../../ui/AppButton.vue'
import { saveMemoryProfile } from '../services/memory'

const props = defineProps<{
  readonly open: boolean
  readonly profile: MemoryProfileReadRecord | null
}>()

const emit = defineEmits<{ cancel: []; saved: [result: { readonly droppedSources: number }] }>()

const panel = ref<HTMLElement | null>(null)
const titleId = useId()
/** 打开前的焦点元素；关闭后把焦点还给触发它的「编辑」按钮。 */
let opener: HTMLElement | null = null

const scope = ref<'global' | 'domain'>('global')
const basis = ref<MemoryProfileBasis>('explicit')
const title = ref('')
const content = ref('')
const saving = ref(false)
const saveError = ref<string | null>(null)

/** 领域只认四个固定值：不认识的值不提交，也不猜测。 */
function profileDomain(value: string): MemoryProfileDomain | null {
  return (MEMORY_PROFILE_DOMAINS as readonly string[]).includes(value) ? value as MemoryProfileDomain : null
}

function reset(): void {
  const profile = props.profile
  scope.value = profile !== null && profile.scope.startsWith('domain:') ? 'domain' : 'global'
  basis.value = profile?.basis === 'inferred_confirmed' ? 'inferred_confirmed' : 'explicit'
  title.value = profile?.title ?? ''
  content.value = profile?.content ?? ''
  saveError.value = null
}

async function save(): Promise<void> {
  const profile = props.profile
  if (profile === null || saving.value) return
  const domain = profileDomain(profile.domain)
  if (domain === null) {
    saveError.value = '画像领域无法识别，未提交。'
    return
  }
  if (title.value.trim() === '' || content.value.trim() === '') {
    saveError.value = '标题与正文都不能为空。'
    return
  }
  saving.value = true
  saveError.value = null
  const result = await saveMemoryProfile({
    domain,
    scope: scope.value === 'global' ? 'global' : `domain:${domain}`,
    basis: basis.value,
    title: title.value.trim(),
    content: content.value.trim(),
    sourceRecordIds: profile.source_record_ids,
    replaceProfileIds: [profile.id]
  })
  saving.value = false
  if (!result.ok) {
    saveError.value = result.error.message
    return
  }
  emit('saved', { droppedSources: result.data.droppedSourceIds.length })
}

/** 关闭入口统一走这里：保存中不响应关闭，迟到的保存结果不会关掉下一次编辑。 */
function requestClose(): void {
  if (saving.value) return
  emit('cancel')
}

/** 面板内可聚焦元素；Tab 只在弹窗内循环，与 aria-modal 一致。 */
function focusableElements(): HTMLElement[] {
  const root = panel.value
  if (root === null) return []
  const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  return [...root.querySelectorAll<HTMLElement>(selector)].filter(element => element.offsetParent !== null)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    requestClose()
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

watch(
  () => props.open,
  open => {
    if (open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      reset()
      window.addEventListener('keydown', onKeydown)
      void nextTick(() => panel.value?.focus())
    } else {
      window.removeEventListener('keydown', onKeydown)
      opener?.focus()
      opener = null
    }
  }
)

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Transition name="dialog-fade">
    <div v-if="props.open" class="dialog-overlay" @click.self="requestClose">
      <Transition name="dialog-panel-motion" appear>
        <div
          ref="panel"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
          class="dialog-panel max-w-2xl"
        >
          <div class="dialog-header">
            <div class="min-w-0">
              <h2 :id="titleId" class="dialog-title">编辑画像</h2>
              <p class="dialog-subtitle">
                保存后同领域的旧版本被这张新内容替换；领域不可更改。
              </p>
            </div>
            <AppButton variant="ghost" aria-label="关闭画像编辑" :disabled="saving" @click="requestClose">×</AppButton>
          </div>

          <div class="dialog-body space-y-4">
            <div class="flex flex-wrap items-center gap-2">
              <span class="field-label">领域</span>
              <span class="memory-profile-static">
                {{ MEMORY_DOMAIN_LABELS[props.profile?.domain ?? ''] ?? props.profile?.domain ?? '' }}
              </span>
            </div>

            <div class="flex flex-wrap items-center gap-3">
              <span class="field-label">作用范围</span>
              <div class="segment" role="group" aria-label="画像作用范围">
                <AppButton
                  variant="unstyled"
                  class="segment-option"
                  :class="scope === 'global' ? 'is-selected' : ''"
                  :aria-pressed="scope === 'global'"
                  :disabled="saving"
                  @click="scope = 'global'"
                >
                  全库
                </AppButton>
                <AppButton
                  variant="unstyled"
                  class="segment-option"
                  :class="scope === 'domain' ? 'is-selected' : ''"
                  :aria-pressed="scope === 'domain'"
                  :disabled="saving"
                  @click="scope = 'domain'"
                >
                  仅本领域
                </AppButton>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-3">
              <span class="field-label">依据</span>
              <div class="segment" role="group" aria-label="画像依据">
                <AppButton
                  v-for="option in MEMORY_BASIS_OPTIONS"
                  :key="option.value"
                  variant="unstyled"
                  class="segment-option"
                  :class="basis === option.value ? 'is-selected' : ''"
                  :aria-pressed="basis === option.value"
                  :disabled="saving"
                  @click="basis = option.value"
                >
                  {{ option.label }}
                </AppButton>
              </div>
            </div>

            <label class="block space-y-1">
              <span class="field-label">标题</span>
              <input
                v-model="title"
                class="text-control"
                type="text"
                :maxlength="MEMORY_PROFILE_TITLE_MAX"
                :disabled="saving"
              >
            </label>

            <label class="block space-y-1">
              <span class="field-label">正文</span>
              <textarea
                v-model="content"
                class="text-control font-mono"
                rows="10"
                :maxlength="MEMORY_CONTENT_MAX"
                :disabled="saving"
              ></textarea>
            </label>

            <p v-if="(props.profile?.source_record_ids.length ?? 0) > 0" class="hint-text">
              沿用原画像的 {{ props.profile?.source_record_ids.length }} 条来源记录；已不存在的来源会在保存时剔除。
            </p>
          </div>

          <div class="dialog-footer">
            <p v-if="saveError !== null" role="alert" class="mr-auto text-xs text-desk-danger">
              {{ saveError }}
            </p>
            <AppButton variant="ghost" :disabled="saving" @click="requestClose">取消</AppButton>
            <AppButton variant="primary" :disabled="saving" @click="save">
              {{ saving ? '保存中…' : '保存' }}
            </AppButton>
          </div>
        </div>
      </Transition>
    </div>
  </Transition>
</template>

<style scoped>
/* 只读字段与输入框同高，避免「不可改」看起来像可以点。 */
.memory-profile-static {
  padding: 0.25rem 0;
  color: var(--color-desk-muted);
  font-size: var(--text-xs);
}
</style>
