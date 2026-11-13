<!-- 会话内记忆注入卡片：按段列出最近一次请求注入了哪些记录，点击条目展开摘要，被截断时按需读取全文。
     数据只来自会话里的注入审计条目，不执行命令、不扫描记忆库；没有审计时明确说明而不是显示空白。 -->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue'
import type { MemoryInjectionEntry, MemoryInjectionSnapshot, RuntimeTarget } from '../../../../shared/runtime-api'
import { readMemoryInjection } from '../services/runtime'
import { readMemoryRecords } from '../../memory/services/memory'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  /** 常驻挂载，`open` 控制读取、焦点与 Escape 生命周期。 */
  readonly open: boolean
  /** 当前会话的运行目标；未就绪时为 null，卡片只说明原因而不发起请求。 */
  readonly target: RuntimeTarget | null
}>()

const emit = defineEmits<{ close: [] }>()

const panel = ref<HTMLElement | null>(null)
const titleId = useId()
const loading = ref(false)
const error = ref<string | null>(null)
const injection = ref<MemoryInjectionSnapshot | null>(null)
const expandedId = ref<string | null>(null)
const bodies = ref<Record<string, string>>({})
const bodyLoadingId = ref<string | null>(null)
const bodyError = ref<string | null>(null)
/** 换代计数：关闭或重开后，迟到的读取结果不能覆盖新一轮状态。 */
let loadSequence = 0
let bodySequence = 0

const TYPE_LABELS: Record<string, string> = {
  decision: '决定', constraint: '约束', fact: '事实',
  progress: '进展', issue: '问题', preference_evidence: '偏好证据'
}

/** 读取最近一次注入审计；没有审计与读取失败分开表达。 */
async function load(): Promise<void> {
  const sequence = ++loadSequence
  loading.value = true
  error.value = null
  injection.value = null
  expandedId.value = null
  bodies.value = {}
  bodyError.value = null
  const target = props.target
  if (target === null) {
    loading.value = false
    error.value = '当前会话还没有运行实例；开始一次对话后再查看。'
    return
  }
  const result = await readMemoryInjection(target)
  if (sequence !== loadSequence || !props.open) return
  loading.value = false
  if (result.ok) injection.value = result.data.injection
  else error.value = result.error.message
}

const groups = computed(() => {
  const value = injection.value
  if (value === null) return []
  return [
    { key: 'resident', label: '常驻约定', entries: value.entries.resident },
    { key: 'notes', label: '当前项目近况', entries: value.entries.notes },
    { key: 'recall', label: '任务召回', entries: value.entries.recall }
  ].filter(group => group.entries.length > 0)
})

const meta = computed<readonly string[]>(() => {
  const value = injection.value
  if (value === null) return []
  const parts = [new Date(value.at).toLocaleString('zh-CN', { hour12: false })]
  if (value.cwd !== null) parts.push(value.cwd.split(/[\\/]/).filter(Boolean).slice(-1).join(''))
  parts.push(value.status === 'provided' ? '已注入' : value.status === 'disabled' ? '已停用' : '不可用')
  return parts
})

/** 只列审计里真实存在的段状态；没有来源的段不写占位行。 */
const segmentNotes = computed<readonly string[]>(() => {
  const segments = injection.value?.segments ?? {}
  const lines: string[] = []
  const profiles = segments.profiles
  if (profiles !== undefined && typeof profiles.status === 'string') {
    lines.push(`适用偏好 ${profiles.status === 'provided' ? '已提供' : '不可用'}`)
  }
  const errors = segments.errors
  if (errors !== undefined && typeof errors.status === 'string') {
    lines.push(`报错召回 ${errors.status === 'provided' ? '已提供' : '未使用'}`)
  }
  return lines
})

const skipped = computed(() => injection.value !== null && injection.value.status !== 'provided')
const empty = computed(() => injection.value !== null && injection.value.status === 'provided' && groups.value.length === 0)

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type
}

function entryTitle(entry: MemoryInjectionEntry): string {
  return entry.title !== '' ? entry.title : entry.topic !== '' ? entry.topic : entry.rule_key
}

/** 摘要即全文时不读库；只有被截断的条目才按需读取。 */
function toggle(entry: MemoryInjectionEntry): void {
  bodyError.value = null
  if (expandedId.value === entry.id) {
    expandedId.value = null
    return
  }
  expandedId.value = entry.id
  if (entry.truncated && bodies.value[entry.id] === undefined && bodyLoadingId.value === null) void readBody(entry.id)
}

async function readBody(id: string): Promise<void> {
  const sequence = ++bodySequence
  bodyLoadingId.value = id
  const result = await readMemoryRecords([id])
  if (sequence !== bodySequence || !props.open) return
  bodyLoadingId.value = null
  if (!result.ok) {
    bodyError.value = result.error.message
    return
  }
  const record = result.data.records[0]
  if (record !== undefined) bodies.value = { ...bodies.value, [id]: record.content }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

// 打开时聚焦面板并接管 Escape；关闭时立即移除，避免与其他弹层重复响应同一个按键。
watch(
  () => props.open,
  (open) => {
    if (open) {
      void load()
      window.addEventListener('keydown', onKeydown)
      void nextTick(() => panel.value?.focus())
    } else {
      loadSequence += 1
      bodySequence += 1
      loading.value = false
      bodyLoadingId.value = null
      window.removeEventListener('keydown', onKeydown)
    }
  },
  { immediate: true }
)

onUnmounted(() => {
  loadSequence += 1
  bodySequence += 1
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Transition name="dialog-fade">
    <div
      v-if="props.open"
      class="dialog-overlay"
      @click.self="emit('close')"
    >
      <Transition name="dialog-panel-motion" appear>
        <div
          ref="panel"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
          class="dialog-panel max-w-2xl"
        >
          <div class="dialog-header flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 :id="titleId" class="dialog-title">记忆注入</h2>
              <p v-if="meta.length > 0" class="mt-1 text-xs text-desk-muted">{{ meta.join(' · ') }}</p>
            </div>
            <AppButton variant="ghost" aria-label="关闭记忆注入" @click="emit('close')">×</AppButton>
          </div>

          <div class="dialog-body scroll-area max-h-[65vh] overflow-y-auto">
            <p v-if="loading" role="status" class="text-sm text-desk-muted">读取中…</p>

            <template v-else-if="error !== null">
              <p role="alert" class="status-notice status-notice-error">{{ error }}</p>
              <AppButton class="mt-3" variant="ghost" @click="load">重新读取</AppButton>
            </template>

            <p v-else-if="injection === null" class="text-sm text-desk-muted">
              本会话还没有注入记录；记忆启用后的第一次请求才会写入。
            </p>

            <template v-else>
              <p v-if="skipped" class="status-notice status-notice-warn">
                {{ injection?.reason ?? '本次请求没有装配记忆背景' }}
              </p>

              <template v-else>
                <p v-if="empty" class="text-sm text-desk-muted">本次请求没有注入任何记忆条目。</p>

                <section v-for="group in groups" :key="group.key" class="mt-4 first:mt-0">
                  <h3 class="text-xs font-semibold text-desk-ink">
                    {{ group.label }}<span class="ml-2 font-normal text-desk-muted">{{ group.entries.length }} 条</span>
                  </h3>
                  <ul class="mt-1 divide-y divide-desk-line">
                    <li v-for="entry in group.entries" :key="entry.id">
                      <button
                        type="button"
                        class="flex w-full items-start gap-2 py-2 text-left hover:bg-desk-surface-subtle"
                        :aria-expanded="expandedId === entry.id"
                        @click="toggle(entry)"
                      >
                        <span class="shrink-0 rounded-desk-sm bg-desk-surface px-1.5 py-0.5 text-[11px] text-desk-muted">
                          {{ typeLabel(entry.type) }}
                        </span>
                        <span class="min-w-0 flex-1 text-sm text-desk-ink">{{ entryTitle(entry) }}</span>
                        <span class="shrink-0 text-xs text-desk-muted">{{ entry.date }}</span>
                      </button>

                      <div v-if="expandedId === entry.id" class="pb-3 pl-1 pr-2">
                        <p class="whitespace-pre-wrap break-words text-sm leading-relaxed text-desk-muted">
                          {{ bodies[entry.id] ?? entry.excerpt }}
                        </p>
                        <p v-if="bodyLoadingId === entry.id" role="status" class="mt-1 text-xs text-desk-muted">读取全文…</p>
                        <p v-else-if="bodyError !== null && bodyLoadingId === null" role="alert" class="mt-1 text-xs text-desk-danger">
                          {{ bodyError }}
                        </p>
                        <p v-else-if="entry.truncated && bodies[entry.id] === undefined" class="mt-1 text-xs text-desk-muted">
                          摘要已截断
                        </p>
                      </div>
                    </li>
                  </ul>
                </section>

                <p v-if="segmentNotes.length > 0" class="mt-4 text-xs text-desk-muted">{{ segmentNotes.join(' · ') }}</p>
              </template>
            </template>
          </div>
        </div>
      </Transition>
    </div>
  </Transition>
</template>
