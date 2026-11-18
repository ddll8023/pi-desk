<!-- 记忆资产的只读查看弹窗：画像显示完整正文，风格显示要点与全部原句。
     列表行只放标题与元信息，正文长度不可控且保留换行，放进弹窗比铺在列表里可读；
     这里不提供保存，「编辑」只把记录转交给对应的编辑对话框，写入仍走那两处。 -->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue'
import type { MemoryProfileReadRecord, MemoryStyleReadRecord } from '../../../../shared/memory-api'
import { MEMORY_BASIS_LABELS, MEMORY_DOMAIN_LABELS, memoryScopeLabel } from '../labels'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  readonly open: boolean
  /** 两类资产共用一个弹窗外壳：正文结构不同，标题、元信息与底部动作一致。 */
  readonly kind: 'profile' | 'style'
  readonly profile: MemoryProfileReadRecord | null
  readonly styleRecord: MemoryStyleReadRecord | null
}>()

const emit = defineEmits<{ cancel: []; edit: [] }>()

const panel = ref<HTMLElement | null>(null)
const titleId = useId()
/** 打开前的焦点元素；关闭后把焦点还给触发它的列表行。 */
let opener: HTMLElement | null = null

const title = computed(() => {
  if (props.kind === 'profile') {
    const record = props.profile
    if (record === null) return ''
    return record.title !== '' ? record.title : memoryScopeLabel(record.scope)
  }
  return props.styleRecord?.name ?? ''
})

/** 标题下的一行元信息：只放库里已有的事实，不在这里再解释资产是什么。 */
const subtitle = computed(() => {
  if (props.kind === 'profile') {
    const record = props.profile
    if (record === null) return ''
    const parts = [
      MEMORY_DOMAIN_LABELS[record.domain] ?? record.domain,
      memoryScopeLabel(record.scope),
      MEMORY_BASIS_LABELS[record.basis] ?? record.basis
    ]
    if (record.source_record_ids.length > 0) parts.push(`来源 ${record.source_record_ids.length} 条`)
    return parts.join(' · ')
  }
  const record = props.styleRecord
  if (record === null) return ''
  return [record.scene, `${record.samples.length} 句`, record.date].filter(part => part !== '').join(' · ')
})

const samples = computed(() => props.kind === 'style' ? props.styleRecord?.samples ?? [] : [])

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
    emit('cancel')
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
    <div v-if="props.open" class="dialog-overlay" @click.self="emit('cancel')">
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
              <h2 :id="titleId" class="dialog-title">{{ title }}</h2>
              <p v-if="subtitle !== ''" class="dialog-subtitle">{{ subtitle }}</p>
            </div>
            <AppButton variant="ghost" aria-label="关闭查看" @click="emit('cancel')">×</AppButton>
          </div>

          <div class="dialog-body">
            <p v-if="props.kind === 'profile'" class="memory-detail-text">{{ props.profile?.content ?? '' }}</p>
            <template v-else>
              <div>
                <p class="text-2xs text-desk-muted">要点</p>
                <p class="memory-detail-text mt-1">{{ props.styleRecord?.points ?? '' }}</p>
              </div>
              <div>
                <p class="text-2xs text-desk-muted">原句 · {{ samples.length }} 句</p>
                <div class="memory-detail-quotes mt-1.5">
                  <blockquote
                    v-for="(sample, index) in samples"
                    :key="`${index}-${sample.source_date}`"
                    class="memory-detail-quote"
                  >
                    <p class="memory-detail-text">{{ sample.quote }}</p>
                    <p class="mt-0.5 text-2xs text-desk-muted">{{ sample.source_date }}</p>
                  </blockquote>
                </div>
              </div>
            </template>
          </div>

          <div class="dialog-footer">
            <p class="mr-auto text-2xs text-desk-muted">只读查看</p>
            <AppButton variant="ghost" @click="emit('cancel')">关闭</AppButton>
            <AppButton variant="primary" @click="emit('edit')">编辑</AppButton>
          </div>
        </div>
      </Transition>
    </div>
  </Transition>
</template>
