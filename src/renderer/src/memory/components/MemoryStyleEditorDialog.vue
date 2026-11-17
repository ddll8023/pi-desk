<!-- 风格编辑对话框：改名称、适用场景、要点与原句样本（可删、可补录）。
     保存总是带上本条 ID 作为替换目标：名称不变时覆盖本条，改名时替换本条并落成新 ID。
     原句样本逐字保留，手工补录的样本来源会话记为 manual。 -->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue'
import { MEMORY_STYLE_NAME_MAX, MEMORY_STYLE_POINTS_MAX, MEMORY_STYLE_QUOTE_MAX, MEMORY_STYLE_SAMPLE_MAX, MEMORY_STYLE_SCENE_MAX } from '../../../../shared/memory-api'
import type { MemoryStyleReadRecord } from '../../../../shared/memory-api'
import AppButton from '../../ui/AppButton.vue'
import { saveMemoryStyle } from '../services/memory'

const props = defineProps<{
  readonly open: boolean
  readonly styleRecord: MemoryStyleReadRecord | null
  /** 库里已有的全部风格名称：用于挡下「改名成另一条已有名称」。 */
  readonly takenNames: readonly string[]
}>()

const emit = defineEmits<{ cancel: []; saved: [] }>()

/** 手工补录样本的来源标识：原句不是从会话取样来的，来源如实记为 manual。 */
const MANUAL_SOURCE = 'manual'

interface SampleDraft {
  /** 本地行标识：样本在库里没有稳定 ID，删除一行不能让下一行的输入框被复用。 */
  readonly key: number
  quote: string
  sourceSession: string
  sourceDate: string
}

/** 样本行的本地自增键；只在本次编辑会话内递增，不写入库。 */
let nextSampleKey = 0

const panel = ref<HTMLElement | null>(null)
const titleId = useId()
/** 打开前的焦点元素；关闭后把焦点还给触发它的「编辑」按钮。 */
let opener: HTMLElement | null = null

const name = ref('')
const scene = ref('')
const points = ref('')
const samples = ref<SampleDraft[]>([])
const saving = ref(false)
const saveError = ref<string | null>(null)

/** 日期按本地自然日补零，与引擎的 YYYY-MM-DD 一致。 */
function today(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function reset(): void {
  const style = props.styleRecord
  name.value = style?.name ?? ''
  scene.value = style?.scene ?? ''
  points.value = style?.points ?? ''
  samples.value = (style?.samples ?? []).map(sample => ({
    key: ++nextSampleKey,
    quote: sample.quote, sourceSession: sample.source_session, sourceDate: sample.source_date
  }))
  saveError.value = null
}

const canAddSample = computed(() => samples.value.length < MEMORY_STYLE_SAMPLE_MAX)

function addSample(): void {
  if (!canAddSample.value) return
  samples.value = [...samples.value, { key: ++nextSampleKey, quote: '', sourceSession: MANUAL_SOURCE, sourceDate: today() }]
}

function removeSample(index: number): void {
  samples.value = samples.value.filter((_, position) => position !== index)
}

/** 保存前的本地校验：名称冲突、必填与样本形态先挡下，避免引擎整批拒绝后才反馈。 */
function validate(): string | null {
  const trimmedName = name.value.trim()
  if (trimmedName === '') return '名称不能为空。'
  const conflict = props.takenNames.some(item => item === trimmedName && item !== props.styleRecord?.name)
  if (conflict) return `已有同名风格「${trimmedName}」，换一个名称或改回原名。`
  if (scene.value.trim() === '') return '适用场景不能为空。'
  if (points.value.trim() === '') return '要点不能为空。'
  if (samples.value.length === 0) return '至少保留一条原句样本。'
  if (samples.value.length > MEMORY_STYLE_SAMPLE_MAX) return `原句样本最多 ${MEMORY_STYLE_SAMPLE_MAX} 条。`
  for (const sample of samples.value) {
    if (sample.quote.trim() === '') return '原句样本不能为空。'
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sample.sourceDate)) return '样本日期需为 YYYY-MM-DD。'
  }
  return null
}

async function save(): Promise<void> {
  const style = props.styleRecord
  if (style === null || saving.value) return
  const invalid = validate()
  if (invalid !== null) {
    saveError.value = invalid
    return
  }
  saving.value = true
  saveError.value = null
  const result = await saveMemoryStyle({
    styles: [{
      name: name.value.trim(),
      scene: scene.value.trim(),
      points: points.value.trim(),
      samples: samples.value.map(sample => ({
        quote: sample.quote, sourceSession: sample.sourceSession, sourceDate: sample.sourceDate
      })),
      replaceStyleIds: [style.id]
    }]
  })
  saving.value = false
  if (!result.ok) {
    saveError.value = result.error.message
    return
  }
  emit('saved')
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
              <h2 :id="titleId" class="dialog-title">编辑语气风格</h2>
              <p class="dialog-subtitle">
                要点与全部原句会随每轮背景注入；名称不变时覆盖本条，改名时替换本条。
              </p>
            </div>
            <AppButton variant="ghost" aria-label="关闭风格编辑" :disabled="saving" @click="requestClose">×</AppButton>
          </div>

          <div class="dialog-body">
            <label class="block space-y-1">
              <span class="field-label">名称</span>
              <input
                v-model="name"
                class="text-control"
                type="text"
                :maxlength="MEMORY_STYLE_NAME_MAX"
                :disabled="saving"
              >
            </label>

            <label class="block space-y-1">
              <span class="field-label">适用场景</span>
              <input
                v-model="scene"
                class="text-control"
                type="text"
                :maxlength="MEMORY_STYLE_SCENE_MAX"
                :disabled="saving"
              >
            </label>

            <label class="block space-y-1">
              <span class="field-label">要点</span>
              <textarea
                v-model="points"
                class="text-control"
                rows="6"
                :maxlength="MEMORY_STYLE_POINTS_MAX"
                :disabled="saving"
              ></textarea>
            </label>

            <div class="space-y-2">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="field-label">原句样本 · {{ samples.length }} / {{ MEMORY_STYLE_SAMPLE_MAX }}</span>
                <AppButton variant="compact" :disabled="saving || !canAddSample" @click="addSample">
                  补录一句
                </AppButton>
              </div>

              <p v-if="samples.length === 0" class="hint-text">至少要有一条原句样本。</p>
              <div v-for="(sample, index) in samples" :key="sample.key" class="memory-style-sample">
                <textarea
                  v-model="sample.quote"
                  class="text-control"
                  rows="2"
                  :maxlength="MEMORY_STYLE_QUOTE_MAX"
                  :disabled="saving"
                  :aria-label="`第 ${index + 1} 条原句`"
                ></textarea>
                <div class="flex flex-wrap items-center gap-2">
                  <input
                    v-model="sample.sourceDate"
                    class="text-control memory-style-date"
                    type="date"
                    :disabled="saving"
                    :aria-label="`第 ${index + 1} 条原句日期`"
                  >
                  <span class="memory-style-source">
                    {{ sample.sourceSession === MANUAL_SOURCE ? '手工补录' : `来源 ${sample.sourceSession}` }}
                  </span>
                  <AppButton
                    variant="ghost"
                    class="ml-auto"
                    :disabled="saving"
                    :aria-label="`删除第 ${index + 1} 条原句`"
                    @click="removeSample(index)"
                  >
                    删除
                  </AppButton>
                </div>
              </div>
            </div>
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
/* 样本块之间留出间距并加细线分隔，避免多条原句连成一片。 */
.memory-style-sample {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0.5rem;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-canvas-sunken);
}
.memory-style-date {
  width: 10rem;
}
.memory-style-source {
  color: var(--color-desk-muted);
  font-size: var(--text-2xs);
}
</style>
