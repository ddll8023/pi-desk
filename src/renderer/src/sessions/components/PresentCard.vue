<!-- 会话内卡片：present_card 工具交付的载荷，按随包枚举渲染固定外壳（标题、字段、正文、主次按钮）。
     卡片只是数据展示与动作转发：按钮按动作 ID 调既有业务通道（保存专家走 desktop:expert-save，复制走剪贴板），
     不在渲染层拼装写入规则、不写文件；动作是否成立仍由主进程判定，失败原因就地显示。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ExpertSaveRequest } from '../../../../shared/experts-api'
import type { PresentCardView } from '../../../../shared/present-card-view'
import { copyText } from '../../ui/clipboard'
import { saveExpert } from '../../experts/services/expert'
import { useSessionStore } from '../stores/session'

const props = defineProps<{
  /** 一份已通过跨进程契约校验的卡片；字段都是纯文本，界面不解析 Markdown。 */
  readonly card: PresentCardView
}>()

/** 展开正文时上报，让消息列表停止粘底；收起不上报。 */
const emit = defineEmits<{ userExpand: [] }>()

const sessionStore = useSessionStore()

/** 主次动作共享一个终态：已保存或已复制后不再重复提交，失败可重试。 */
const phase = ref<'idle' | 'busy' | 'saved' | 'copied' | 'failed'>('idle')
const notice = ref('')
const errorText = ref('')
/** 保存成功后的专家标识；有值时说明这张卡片已经落过盘，重启后不保留。 */
const savedExpertId = ref<string | null>(null)

const hasBody = computed(() => props.card.body !== null && props.card.body !== '')
const busy = computed(() => phase.value === 'busy')
const saveDisabled = computed(() => busy.value || savedExpertId.value !== null)

function onToggle(event: Event): void {
  const target = event.target
  if (target instanceof HTMLDetailsElement && target.open) emit('userExpand')
}

/**
 * 由草案组装保存请求：标题即显示名称、副标题即简介、正文即定义正文；
 * 技能与 MCP 一律继承默认基线——收窄范围需要逐项确认，属于设置页的工作。
 */
function toSaveRequest(): ExpertSaveRequest {
  return {
    expertId: null,
    displayName: props.card.title,
    summary: props.card.subtitle ?? '',
    skillIds: [],
    body: props.card.body ?? '',
    skillsMode: 'inherit',
    skillAddIds: [],
    skillRemoveIds: [],
    mcpMode: 'inherit',
    mcpServerIds: [],
    mcpAddIds: [],
    mcpRemoveIds: []
  }
}

async function saveExpertDefinition(): Promise<void> {
  if (saveDisabled.value) return
  phase.value = 'busy'
  errorText.value = ''
  notice.value = ''
  const result = await saveExpert(toSaveRequest())
  if (!result.ok) {
    phase.value = 'failed'
    errorText.value = result.error.message
    return
  }
  savedExpertId.value = result.data.expertId
  phase.value = 'saved'
  const unavailable = [
    result.data.unavailableSkillIds.length > 0 ? `技能 ${result.data.unavailableSkillIds.join('、')}` : null,
    result.data.unavailableMcpServers.length > 0 ? `MCP 服务器 ${result.data.unavailableMcpServers.join('、')}` : null
  ].filter((item): item is string => item !== null)
  notice.value = unavailable.length > 0
    ? `已保存 ${result.data.expertId}；当前不可用的引用：${unavailable.join('；')}。`
    : `已保存 ${result.data.expertId}，新建会话即可召唤。`
  // 输入坞的专家菜单读的是会话域的清单，保存后立刻重读，避免菜单里看不到新专家。
  await sessionStore.loadExperts()
}

async function copyBody(): Promise<void> {
  if (busy.value) return
  phase.value = 'busy'
  errorText.value = ''
  const copied = await copyText(props.card.body ?? '')
  if (!copied) {
    phase.value = 'failed'
    errorText.value = '复制失败，请手动选中正文复制。'
    return
  }
  phase.value = 'copied'
  notice.value = '正文已复制到剪贴板。'
}

function runAction(id: PresentCardView['primaryAction']['id']): void {
  if (id === 'expert.save') {
    void saveExpertDefinition()
    return
  }
  void copyBody()
}

function actionDisabled(id: PresentCardView['primaryAction']['id']): boolean {
  return id === 'expert.save' ? saveDisabled.value : busy.value
}
</script>

<template>
  <section class="present-card" :aria-label="`卡片：${card.title}`">
    <header class="present-card-head">
      <h3 class="present-card-title">{{ card.title }}</h3>
      <p v-if="card.subtitle !== null" class="present-card-subtitle">{{ card.subtitle }}</p>
    </header>

    <dl v-if="card.fields.length > 0" class="present-card-fields">
      <div v-for="field in card.fields" :key="field.label" class="present-card-field">
        <dt>{{ field.label }}</dt>
        <dd>{{ field.value }}</dd>
      </div>
    </dl>

    <details v-if="hasBody" class="present-card-body" @toggle="onToggle">
      <summary>查看正文</summary>
      <pre class="present-card-body-text">{{ card.body }}</pre>
    </details>

    <div class="present-card-actions">
      <button
        type="button"
        class="present-card-button is-primary"
        :disabled="actionDisabled(card.primaryAction.id)"
        @click="runAction(card.primaryAction.id)"
      >{{ phase === 'busy' ? '处理中…' : card.primaryAction.label }}</button>
      <button
        v-if="card.secondaryAction !== null"
        type="button"
        class="present-card-button"
        :disabled="actionDisabled(card.secondaryAction.id)"
        @click="runAction(card.secondaryAction.id)"
      >{{ card.secondaryAction.label }}</button>
    </div>

    <p v-if="notice !== ''" class="present-card-notice" role="status">{{ notice }}</p>
    <p v-if="errorText !== ''" class="present-card-error" role="alert">{{ errorText }}</p>
  </section>
</template>

<style scoped>
/* 外壳固定：场景只换标题、字段、正文与按钮文案，视觉与留白不随场景分叉。 */
.present-card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  width: 100%;
  max-width: 44rem;
  padding: 0.75rem 0.875rem;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-md);
  background: var(--color-desk-surface);
}
.present-card-head {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.present-card-title {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--color-desk-ink);
}
.present-card-subtitle {
  margin: 0;
  font-size: 0.75rem;
  color: var(--color-desk-muted);
}
.present-card-fields {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin: 0;
  font-size: 0.75rem;
}
.present-card-field {
  display: flex;
  gap: 0.5rem;
}
.present-card-field dt {
  flex: 0 0 auto;
  min-width: 5rem;
  color: var(--color-desk-muted);
}
.present-card-field dd {
  margin: 0;
  color: var(--color-desk-ink);
  overflow-wrap: anywhere;
}
.present-card-body {
  font-size: 0.75rem;
  color: var(--color-desk-muted);
}
.present-card-body summary {
  cursor: pointer;
  color: var(--color-desk-ink);
  list-style: none;
}
.present-card-body summary::-webkit-details-marker {
  display: none;
}
.present-card-body summary::before {
  content: '▸';
  margin-right: 0.375rem;
}
.present-card-body[open] summary::before {
  content: '▾';
}
.present-card-body-text {
  margin: 0.375rem 0 0;
  padding: 0.5rem;
  max-height: 18rem;
  overflow: auto;
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-panel);
  color: var(--color-desk-ink);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.present-card-actions {
  display: flex;
  gap: 0.5rem;
}
.present-card-button {
  padding: 0.25rem 0.75rem;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-sm);
  background: transparent;
  color: var(--color-desk-ink);
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.present-card-button.is-primary {
  border-color: var(--color-desk-accent);
  background: var(--color-desk-accent);
  color: var(--color-desk-surface);
}
.present-card-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.present-card-button:focus-visible {
  outline: 2px solid var(--color-desk-accent);
  outline-offset: 2px;
}
.present-card-notice {
  margin: 0;
  font-size: 0.75rem;
  color: var(--color-desk-muted);
}
.present-card-error {
  margin: 0;
  font-size: 0.75rem;
  color: var(--color-desk-danger);
}
@media (prefers-reduced-motion: reduce) {
  .present-card-button {
    transition: none;
  }
}
</style>
