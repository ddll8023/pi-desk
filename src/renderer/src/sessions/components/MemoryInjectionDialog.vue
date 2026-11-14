<!-- 会话内记忆注入卡片：按段列出最近一次请求注入了哪些记忆，点击条目展开正文。
     数据只来自会话里的注入审计条目，不执行命令、不扫描记忆库；被截断的条目按需读取全文
     （记录按 ID、画像按领域），没有审计时明确说明而不是显示空白。 -->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue'
import type {
  MemoryInjectionEntry, MemoryInjectionProfileEntry, MemoryInjectionSnapshot, RuntimeTarget
} from '../../../../shared/runtime-api'
import type { MemoryProfileDomain } from '../../../../shared/memory-api'
import { readMemoryInjection } from '../services/runtime'
import { readMemoryProfiles, readMemoryRecords } from '../../memory/services/memory'
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
const expandedKey = ref<string | null>(null)
const bodies = ref<Record<string, string>>({})
const bodyLoadingKey = ref<string | null>(null)
const bodyError = ref<string | null>(null)
/** 换代计数：关闭或重开后，迟到的读取结果不能覆盖新一轮状态。 */
let loadSequence = 0
let bodySequence = 0

const TYPE_LABELS: Record<string, string> = {
  decision: '决定', constraint: '约束', fact: '事实',
  progress: '进展', issue: '问题', preference_evidence: '偏好证据'
}
/** 类型与画像领域决定徽标色：颜色是类型信息的第二通道，文字仍各自可读。 */
const TYPE_TONES: Record<string, Tone> = {
  decision: 'accent', constraint: 'accent', issue: 'danger',
  progress: 'success', preference_evidence: 'warning', fact: 'muted'
}
const DOMAIN_LABELS: Record<string, string> = {
  communication: '沟通', coding: '编码', learning: '学习', workflow: '流程'
}
const STATUS_LABELS: Record<string, string> = {
  provided: '已注入', unavailable: '不可用', not_requested: '未请求',
  disabled: '已停用', no_project: '无当前项目', none: '未使用'
}

type Tone = 'accent' | 'danger' | 'success' | 'warning' | 'muted'
type SegmentKey = 'profiles' | 'resident' | 'notes'
interface Row {
  readonly key: string
  readonly id: string
  readonly kind: 'record' | 'profile'
  readonly domain: string | null
  readonly badge: string
  readonly tone: Tone
  readonly title: string
  readonly meta: string
  readonly excerpt: string
  readonly truncated: boolean
}

/** 分段顺序与背景注入顺序一致：画像、常驻、近况。 */
const SEGMENTS: readonly { readonly key: SegmentKey; readonly label: string }[] = [
  { key: 'profiles', label: '适用偏好' },
  { key: 'resident', label: '常驻约定' },
  { key: 'notes', label: '当前项目近况' }
]

/** 读取最近一次注入审计；没有审计与读取失败分开表达。 */
async function load(): Promise<void> {
  const sequence = ++loadSequence
  loading.value = true
  error.value = null
  injection.value = null
  expandedKey.value = null
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
  if (result.ok) {
    injection.value = result.data.injection
    focusDefaultSegment()
  } else error.value = result.error.message
}

function recordRow(entry: MemoryInjectionEntry): Row {
  return {
    key: `record:${entry.id}`,
    id: entry.id,
    kind: 'record',
    domain: null,
    badge: TYPE_LABELS[entry.type] ?? entry.type,
    tone: TYPE_TONES[entry.type] ?? 'muted',
    title: entry.title !== '' ? entry.title : entry.topic !== '' ? entry.topic : entry.rule_key,
    meta: entry.date,
    excerpt: entry.excerpt,
    truncated: entry.truncated
  }
}

function profileRow(entry: MemoryInjectionProfileEntry): Row {
  const isDomainScope = entry.scope.startsWith('domain:')
  return {
    key: `profile:${entry.id}`,
    id: entry.id,
    kind: 'profile',
    domain: entry.domain,
    badge: DOMAIN_LABELS[entry.domain] ?? entry.domain,
    tone: 'muted',
    title: entry.title !== '' ? entry.title : entry.scope,
    meta: isDomainScope ? '领域' : '全局',
    excerpt: entry.excerpt,
    truncated: entry.truncated
  }
}

/** 画像领域只可能是四个固定值；不认识的值不发起读取，避免把字段当命令参数透传。 */
function profileDomain(value: string | null): MemoryProfileDomain | null {
  const domains: readonly MemoryProfileDomain[] = ['communication', 'coding', 'learning', 'workflow']
  return domains.find(item => item === value) ?? null
}

function segmentTone(status: string | undefined): Tone {
  if (status === 'provided') return 'accent'
  if (status === 'unavailable' || status === 'disabled') return 'danger'
  return 'muted'
}

const segments = computed(() => {
  const value = injection.value
  if (value === null) return []
  const entries = value.entries
  const rows: Record<SegmentKey, readonly Row[]> = {
    profiles: entries.profiles.map(profileRow),
    resident: entries.resident.map(recordRow),
    notes: entries.notes.map(recordRow)
  }
  return SEGMENTS.map(segment => {
    const status = value.segments[segment.key]?.status
    const tone = segmentTone(typeof status === 'string' ? status : undefined)
    const count = rows[segment.key].length
    return {
      key: segment.key,
      label: segment.label,
      tone,
      count,
      rows: rows[segment.key],
      /** 有条目给条数；无条目时不能说「已注入」，否则会被读成「已加载但打不开」。 */
      summary: count > 0
        ? `${count} 条`
        : (typeof status === 'string' ? STATUS_LABELS[status] : undefined) ?? '无条目'
    }
  })
})

/** 当前段：视图状态，不落盘；打开时在 load 里重置为第一个有内容的段。 */
const activeKey = ref<SegmentKey>('resident')
const activeSegment = computed(() => {
  const list = segments.value
  return list.find(segment => segment.key === activeKey.value) ?? list[0] ?? null
})

const meta = computed<readonly string[]>(() => {
  const value = injection.value
  if (value === null) return []
  const parts = [new Date(value.at).toLocaleString('zh-CN', { hour12: false })]
  if (value.cwd !== null) parts.push(value.cwd.split(/[\\/]/).filter(Boolean).slice(-1).join(''))
  parts.push(value.status === 'provided' ? '已注入' : value.status === 'disabled' ? '已停用' : '不可用')
  return parts
})

const skipped = computed(() => injection.value !== null && injection.value.status !== 'provided')

/** 打开或换审计时落在第一个有内容的段；都没有内容时留在常驻约定。 */
function focusDefaultSegment(): void {
  activeKey.value = segments.value.find(segment => segment.rows.length > 0)?.key ?? 'resident'
}

/** 段 tab 的方向键导航：与 WAI-ARIA 自动激活模式一致，焦点与选中同步移动。 */
async function onTabKeydown(event: KeyboardEvent): Promise<void> {
  const keys = segments.value.map(segment => segment.key)
  const index = keys.indexOf(activeKey.value)
  if (index < 0) return
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  const next = step !== 0
    ? (index + step + keys.length) % keys.length
    : event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : -1
  if (next < 0) return
  const key = keys[next]
  if (key === undefined) return
  event.preventDefault()
  activeKey.value = key
  await nextTick()
  panel.value?.querySelector<HTMLElement>(`#memory-injection-tab-${key}`)?.focus()
}

/** 摘要即全文时不读库；只有被截断的条目才按需读取（记录按 ID、画像按领域）。 */
function toggle(row: Row): void {
  bodyError.value = null
  if (expandedKey.value === row.key) {
    expandedKey.value = null
    return
  }
  expandedKey.value = row.key
  if (row.truncated && bodies.value[row.key] === undefined && bodyLoadingKey.value === null) void readBody(row)
}

async function readBody(row: Row): Promise<void> {
  const sequence = ++bodySequence
  bodyLoadingKey.value = row.key
  if (row.kind === 'profile') {
    const domain = profileDomain(row.domain)
    if (domain === null) {
      bodyLoadingKey.value = null
      bodyError.value = '画像领域无法识别，未发起读取。'
      return
    }
    const result = await readMemoryProfiles(domain)
    if (sequence !== bodySequence || !props.open) return
    bodyLoadingKey.value = null
    if (!result.ok) {
      bodyError.value = result.error.message
      return
    }
    const profile = result.data.profiles.find(item => item.id === row.id)
    if (profile === undefined) {
      bodyError.value = '画像已变化，未取回正文。'
      return
    }
    bodies.value = { ...bodies.value, [row.key]: profile.content }
    return
  }
  const result = await readMemoryRecords([row.id])
  if (sequence !== bodySequence || !props.open) return
  bodyLoadingKey.value = null
  if (!result.ok) {
    bodyError.value = result.error.message
    return
  }
  const record = result.data.records[0]
  if (record !== undefined) bodies.value = { ...bodies.value, [row.key]: record.content }
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
      bodyLoadingKey.value = null
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
          class="dialog-panel memory-injection-panel max-w-3xl"
        >
          <div class="dialog-header">
            <div class="min-w-0">
              <h2 :id="titleId" class="dialog-title">记忆注入</h2>
              <p v-if="meta.length > 0" class="memory-injection-meta">{{ meta.join(' · ') }}</p>
            </div>
            <AppButton variant="ghost" aria-label="关闭记忆注入" @click="emit('close')">×</AppButton>
          </div>

          <div class="dialog-body">
            <p v-if="loading" role="status" class="memory-injection-note">读取中…</p>

            <template v-else-if="error !== null">
              <p role="alert" class="status-notice status-notice-error">{{ error }}</p>
              <AppButton class="mt-3" variant="ghost" @click="load">重新读取</AppButton>
            </template>

            <p v-else-if="injection === null" class="memory-injection-note">
              本会话还没有注入记录；记忆启用后的第一次请求才会写入。
            </p>

            <template v-else>
              <p v-if="skipped" class="status-notice status-notice-warn">
                {{ injection?.reason ?? '本次请求没有装配记忆背景' }}
              </p>

              <template v-else>
                <div class="memory-injection-tabbed">
                  <div class="memory-injection-tabs" role="tablist" aria-label="注入分段" @keydown="onTabKeydown">
                    <button
                      v-for="segment in segments"
                      :id="`memory-injection-tab-${segment.key}`"
                      :key="segment.key"
                      type="button"
                      role="tab"
                      class="memory-injection-tab"
                      :aria-selected="activeKey === segment.key"
                      :aria-controls="`memory-injection-panel-${segment.key}`"
                      :tabindex="activeKey === segment.key ? 0 : -1"
                      @click="activeKey = segment.key"
                    >
                      <span class="memory-injection-dot" :class="`is-${segment.tone}`" aria-hidden="true"></span>
                      <span class="memory-injection-tab-label">{{ segment.label }}</span>
                      <span class="memory-injection-tab-count">{{ segment.summary }}</span>
                    </button>
                  </div>

                  <div
                    v-if="activeSegment !== null"
                    :id="`memory-injection-panel-${activeSegment.key}`"
                    role="tabpanel"
                    :aria-labelledby="`memory-injection-tab-${activeSegment.key}`"
                    tabindex="0"
                    class="memory-injection-panel-body"
                  >
                    <ul v-if="activeSegment.rows.length > 0" class="memory-injection-list">
                      <li v-for="row in activeSegment.rows" :key="row.key" class="memory-injection-item">
                        <button
                          type="button"
                          class="memory-injection-row"
                          :aria-expanded="expandedKey === row.key"
                          @click="toggle(row)"
                        >
                          <span class="memory-injection-badge" :class="`tone-${row.tone}`">{{ row.badge }}</span>
                          <span class="memory-injection-row-main">
                            <span class="memory-injection-row-title">{{ row.title }}</span>
                            <span v-if="expandedKey !== row.key" class="memory-injection-row-excerpt">{{ row.excerpt }}</span>
                          </span>
                          <span class="memory-injection-row-meta">{{ row.meta }}</span>
                          <span class="memory-injection-chevron" aria-hidden="true"></span>
                        </button>

                        <div v-if="expandedKey === row.key" class="memory-injection-expanded">
                          <p class="memory-injection-text">{{ bodies[row.key] ?? row.excerpt }}</p>
                          <p v-if="bodyLoadingKey === row.key" role="status" class="memory-injection-note">读取全文…</p>
                          <p v-else-if="bodyError !== null" role="alert" class="memory-injection-error">{{ bodyError }}</p>
                          <p v-else-if="row.truncated && bodies[row.key] === undefined" class="memory-injection-note">
                            摘要已截断
                          </p>
                        </div>
                      </li>
                    </ul>
                    <p v-else class="memory-injection-empty">{{ activeSegment.label }}：{{ activeSegment.summary }}</p>
                  </div>
                </div>
              </template>
            </template>
          </div>
        </div>
      </Transition>
    </div>
  </Transition>
</template>

<style scoped>
/* 头部元信息比标题轻一档，只交代时间、来源与总体状态。 */
.memory-injection-meta {
  margin-top: 0.25rem;
  color: var(--color-desk-muted);
  font-size: var(--text-2xs);
}
/* 面板高度与内容量无关：段多段少都保持同一尺寸，扫读位置不会跳动。 */
.memory-injection-panel {
  height: min(72vh, 640px);
}
.memory-injection-note {
  color: var(--color-desk-muted);
  font-size: var(--text-xs);
  line-height: 1.6;
}
.memory-injection-error {
  color: var(--color-desk-danger);
  font-size: var(--text-2xs);
}
/* tab 行：横向铺开三段，选中项用底部强调线标记；窄窗口横向滚动而不换行。 */
.memory-injection-tabbed {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.memory-injection-tabs {
  display: flex;
  gap: 0.125rem;
  overflow-x: auto;
  border-bottom: 1px solid var(--color-desk-line);
  scrollbar-width: none;
}
.memory-injection-tabs::-webkit-scrollbar {
  display: none;
}
.memory-injection-tab {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 0.375rem;
  margin-bottom: -1px;
  padding: 0.5rem 0.625rem;
  border-bottom: 2px solid transparent;
  color: var(--color-desk-muted);
  font-size: var(--text-xs);
  white-space: nowrap;
  transition: color var(--default-transition-duration) ease,
    border-color var(--default-transition-duration) ease,
    background-color var(--default-transition-duration) ease;
}
.memory-injection-tab:hover {
  color: var(--color-desk-ink);
  background: var(--color-desk-surface-subtle);
}
.memory-injection-tab[aria-selected="true"] {
  border-bottom-color: var(--color-desk-accent);
  background: color-mix(in srgb, var(--color-desk-accent-soft) 70%, var(--color-desk-surface));
  color: var(--color-desk-ink);
}
.memory-injection-tab[aria-selected="true"] .memory-injection-tab-label {
  font-weight: 600;
}
.memory-injection-tab:focus-visible {
  outline: 2px solid var(--color-desk-accent);
  outline-offset: -2px;
}
.memory-injection-tab-label {
  font-weight: 500;
}
.memory-injection-tab-count {
  color: var(--color-desk-muted);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
}
.memory-injection-dot {
  width: 0.375rem;
  height: 0.375rem;
  flex: none;
  border-radius: 999px;
  background: var(--color-desk-line-strong);
}
.memory-injection-dot.is-accent {
  background: var(--color-desk-accent);
}
.memory-injection-dot.is-warning {
  background: var(--color-desk-warning);
}
.memory-injection-dot.is-danger {
  background: var(--color-desk-danger);
}
/* 面板只放当前段：描边卡包住列表，空段给一行状态说明。 */
.memory-injection-panel-body {
  overflow: hidden;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-md);
  background: var(--color-desk-surface);
}
.memory-injection-panel-body:focus-visible {
  outline: 2px solid var(--color-desk-accent);
  outline-offset: 2px;
}
.memory-injection-empty {
  padding: 0.75rem;
  color: var(--color-desk-muted);
  font-size: var(--text-xs);
}
.memory-injection-list {
  display: flex;
  flex-direction: column;
}
.memory-injection-item + .memory-injection-item {
  border-top: 1px solid var(--color-desk-line);
}
.memory-injection-row {
  display: flex;
  width: 100%;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  text-align: left;
  transition: background-color var(--default-transition-duration) ease;
}
.memory-injection-row:hover,
.memory-injection-row[aria-expanded="true"] {
  background: var(--color-desk-surface-subtle);
}
.memory-injection-row:focus-visible {
  outline: 2px solid var(--color-desk-accent);
  outline-offset: -2px;
}
/* 徽标同时承载类型文字与语义色，颜色不是唯一信息通道。 */
.memory-injection-badge {
  flex: none;
  padding: 0.0625rem 0.375rem;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-surface);
  color: var(--color-desk-muted);
  font-size: var(--text-2xs);
  line-height: 1.6;
  white-space: nowrap;
}
.memory-injection-badge.tone-accent {
  border-color: color-mix(in srgb, var(--color-desk-accent) 38%, var(--color-desk-line));
  color: var(--color-desk-accent);
}
.memory-injection-badge.tone-danger {
  border-color: color-mix(in srgb, var(--color-desk-danger) 34%, var(--color-desk-line));
  color: var(--color-desk-danger);
}
.memory-injection-badge.tone-success {
  border-color: color-mix(in srgb, var(--color-desk-success) 34%, var(--color-desk-line));
  color: var(--color-desk-success);
}
.memory-injection-badge.tone-warning {
  border-color: color-mix(in srgb, var(--color-desk-warning) 34%, var(--color-desk-line));
  color: var(--color-desk-warning);
}
.memory-injection-row-main {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 0.125rem;
}
.memory-injection-row-title {
  color: var(--color-desk-ink);
  font-size: var(--text-md);
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.memory-injection-row-excerpt {
  overflow: hidden;
  color: var(--color-desk-muted);
  font-size: var(--text-xs);
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.memory-injection-row-meta {
  flex: none;
  padding-top: 0.125rem;
  color: var(--color-desk-muted);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
}
/* 展开指示：纯 CSS 绘制的转折线，与关闭按钮同一做法，不引入图标库。 */
.memory-injection-chevron {
  flex: none;
  width: 0.4375rem;
  height: 0.4375rem;
  margin-top: 0.4375rem;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  color: var(--color-desk-muted);
  transform: rotate(-45deg);
  transition: transform var(--default-transition-duration) ease;
}
.memory-injection-row[aria-expanded="true"] .memory-injection-chevron {
  transform: rotate(45deg);
}
/* 展开区用沉陷底区分正文与列表行，正文保持正文色，不再用弱化色。 */
.memory-injection-expanded {
  margin: 0 0.75rem 0.75rem 2.25rem;
  padding: 0.5rem 0.625rem;
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-canvas-sunken);
  animation: memory-injection-reveal var(--motion-duration-fast) var(--motion-ease-entrance) both;
}
.memory-injection-text {
  color: var(--color-desk-ink);
  font-size: var(--text-xs);
  line-height: 1.75;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
@keyframes memory-injection-reveal {
  from {
    opacity: 0;
    transform: translateY(-2px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .memory-injection-expanded {
    animation: none;
  }
  .memory-injection-chevron {
    transition: none;
  }
}
</style>
