<!-- 会话内卡片：present_card 工具交付的载荷，按随包枚举渲染固定外壳（标题、字段、正文、能力勾选、主次按钮）。
     卡片只是数据展示与动作转发：按钮按动作 ID 调既有业务通道（保存专家走 desktop:expert-save，复制走剪贴板），
     不在渲染层拼装写入规则、不写文件；动作是否成立仍由主进程判定，失败原因就地显示。
     能力段的候选与默认基线来自能力候选通道，勾选换算与设置页编辑对话框共用 capability-selection 里的同一套规则。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { ExpertSaveRequest } from '../../../../shared/experts-api'
import type { PresentCardView } from '../../../../shared/present-card-view'
import { copyText } from '../../ui/clipboard'
import { saveExpert } from '../../experts/services/expert'
import { useExpertStore } from '../../experts/stores/expert'
import { baseIds, restoreSelection, selectionState, toSelectionFields } from '../../experts/capability-selection'
import type { CapabilitySelectionMode } from '../../experts/capability-selection'
import { skillSourceLabel } from '../../experts/skill-source-label'
import ExpertCapabilityPicker from '../../experts/components/ExpertCapabilityPicker.vue'
import { useSessionStore } from '../stores/session'

const props = defineProps<{
  /** 一份已通过跨进程契约校验的卡片；字段都是纯文本，界面不解析 Markdown。 */
  readonly card: PresentCardView
}>()

/** 展开正文时上报，让消息列表停止粘底；收起不上报。 */
const emit = defineEmits<{ userExpand: [] }>()

const sessionStore = useSessionStore()
const expertStore = useExpertStore()

/** 能力候选行：来源或停用状态进 label，差异标记进 state，与设置页同一套呈现。 */
interface CapabilityRow {
  readonly id: string
  readonly label: string
  readonly unavailable: boolean
  readonly state: string
}

/** 主次动作共享一个终态：已保存或已复制后不再重复提交，失败可重试。 */
const phase = ref<'idle' | 'busy' | 'saved' | 'copied' | 'failed'>('idle')
const notice = ref('')
const errorText = ref('')
/** 保存成功后的专家标识；有值时说明这张卡片已经落过盘，重启后不保留。 */
const savedExpertId = ref<string | null>(null)

/** 能力候选是否已读；读到之前不渲染勾选格，避免空白框看着像「一项都没有」。 */
const capabilityReady = computed(() => expertStore.capabilities !== null)

const skillsMode = ref<CapabilitySelectionMode>(props.card.capability?.skillsMode ?? 'inherit')
const mcpMode = ref<CapabilitySelectionMode>(props.card.capability?.mcpMode ?? 'inherit')
const selectedSkills = ref<readonly string[]>(props.card.capability?.skillIds ?? [])
const selectedMcp = ref<readonly string[]>(props.card.capability?.mcpServerIds ?? [])

const baselineSkills = computed(() => expertStore.capabilities?.defaults.skills ?? null)
const baselineMcp = computed(() => expertStore.capabilities?.defaults.mcpServers ?? null)
const allSkillIds = computed(() => (expertStore.capabilities?.skills ?? []).map(item => item.id))
const allMcpNames = computed(() => (expertStore.capabilities?.mcpServers ?? []).map(item => item.name))

const skillRows = computed<readonly CapabilityRow[]>(() => {
  const rows: { id: string; label: string; unavailable: boolean }[] = (expertStore.capabilities?.skills ?? [])
    .map(item => ({ id: item.id, label: item.source === 'shared' ? '' : skillSourceLabel(item.source), unavailable: false }))
  const known = new Set(rows.map(row => row.id))
  for (const id of props.card.capability?.skillIds ?? []) {
    if (known.has(id)) continue
    known.add(id)
    rows.push({ id, label: '当前不可用', unavailable: true })
  }
  const base = baseIds(baselineSkills.value, allSkillIds.value)
  return rows.map(row => ({
    ...row,
    state: selectionState({
      unavailable: row.unavailable,
      mode: skillsMode.value,
      checked: selectedSkills.value.includes(row.id),
      inBaseline: base.includes(row.id)
    })
  }))
})

const mcpRows = computed<readonly CapabilityRow[]>(() => {
  const rows: { id: string; label: string; unavailable: boolean }[] = (expertStore.capabilities?.mcpServers ?? [])
    .map(item => ({ id: item.name, label: item.enabled ? '' : '配置里已停用', unavailable: false }))
  const known = new Set(rows.map(row => row.id))
  for (const name of props.card.capability?.mcpServerIds ?? []) {
    if (known.has(name)) continue
    known.add(name)
    rows.push({ id: name, label: '当前不可用', unavailable: true })
  }
  const base = baseIds(baselineMcp.value, allMcpNames.value)
  return rows.map(row => ({
    ...row,
    state: selectionState({
      unavailable: row.unavailable,
      mode: mcpMode.value,
      checked: selectedMcp.value.includes(row.id),
      inBaseline: base.includes(row.id)
    })
  }))
})

/** 保存后勾选就是专家实际生效的范围；技能白名单为空时界面先拦，主进程也会拒。 */
const skillsEmpty = computed(() => skillsMode.value === 'only' && selectedSkills.value.length === 0)

const hasBody = computed(() => props.card.body !== null && props.card.body !== '')
const busy = computed(() => phase.value === 'busy')
const saveDisabled = computed(() => busy.value || savedExpertId.value !== null || skillsEmpty.value)

onMounted(async () => {
  if (props.card.cardType !== 'expert.draft') return
  // 候选与基线只在卡片需要时读一次；读失败时保持未就绪，保存仍以主进程校验为准。
  if (expertStore.capabilities === null) await expertStore.loadCapabilities()
  applyInitialSelection()
})

function onToggle(event: Event): void {
  const target = event.target
  if (target instanceof HTMLDetailsElement && target.open) emit('userExpand')
}

/** 勾满时只说结论，部分选中才给数量；与设置页同一口径。 */
function selectionCount(rows: readonly CapabilityRow[], selected: readonly string[]): string {
  const total = rows.length
  if (total === 0) return ''
  return selected.length === total ? `${total} 个全部可用` : `已选 ${selected.length} / ${total}`
}

function selectAllSkills(): void {
  selectedSkills.value = skillRows.value.map(row => row.id)
}

function selectAllMcp(): void {
  selectedMcp.value = mcpRows.value.map(row => row.id)
}

/**
 * 由草案组装保存请求：标题即显示名称、副标题即简介、正文即定义正文；
 * 能力范围按当前勾选换算，未给能力段的旧卡片按「继承默认基线」写入。
 */
function toSaveRequest(): ExpertSaveRequest {
  const skills = toSelectionFields({
    mode: skillsMode.value,
    selected: selectedSkills.value,
    baseline: baselineSkills.value,
    all: allSkillIds.value
  })
  const mcp = toSelectionFields({
    mode: mcpMode.value,
    selected: selectedMcp.value,
    baseline: baselineMcp.value,
    all: allMcpNames.value
  })
  return {
    expertId: null,
    displayName: props.card.title,
    summary: props.card.subtitle ?? '',
    body: props.card.body ?? '',
    skillIds: [...skills.onlyIds],
    skillsMode: skills.mode,
    skillAddIds: [...skills.addIds],
    skillRemoveIds: [...skills.removeIds],
    mcpMode: mcp.mode,
    mcpServerIds: [...mcp.onlyIds],
    mcpAddIds: [...mcp.addIds],
    mcpRemoveIds: [...mcp.removeIds]
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

/**
 * 能力段的初始勾选：模型给了名单就按它还原，未给则落在默认基线上。
 * 默认必须是基线的展开而不是空集——空集在继承模式里的含义是「把基线全部排除」。
 */
function applyInitialSelection(): void {
  const capability = props.card.capability
  selectedSkills.value = capability === null
    ? [...baseIds(baselineSkills.value, allSkillIds.value)]
    : restoreSelection({
        mode: capability.skillsMode,
        onlyIds: capability.skillIds,
        addIds: [],
        removeIds: [],
        baseline: baselineSkills.value,
        all: allSkillIds.value
      })
  selectedMcp.value = capability === null
    ? [...baseIds(baselineMcp.value, allMcpNames.value)]
    : restoreSelection({
        mode: capability.mcpMode,
        onlyIds: capability.mcpServerIds,
        addIds: [],
        removeIds: [],
        baseline: baselineMcp.value,
        all: allMcpNames.value
      })
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

    <div v-if="card.cardType === 'expert.draft'" class="present-card-capability">
      <ExpertCapabilityPicker
        title="技能范围"
        group-label="技能范围"
        :mode="skillsMode"
        :selected="selectedSkills"
        :rows="skillRows"
        :count-text="selectionCount(skillRows, selectedSkills)"
        inherit-label="继承默认"
        only-label="仅用选中"
        inherit-hint="勾选记录相对默认基线的增减。"
        only-hint="只装配勾选的技能；至少保留一个。"
        search-placeholder="按名称筛选技能"
        empty-text="没有匹配的技能。"
        no-rows-text="随包、产品目录与共享目录里都没有技能。"
        :ready="capabilityReady"
        :disabled="busy || savedExpertId !== null"
        select-all-label="全选"
        @update:mode="skillsMode = $event"
        @update:selected="selectedSkills = $event"
        @select-all="selectAllSkills"
      />
      <p v-if="skillsEmpty" class="present-card-error" role="alert">「仅用选中」时至少要保留一个技能。</p>
      <ExpertCapabilityPicker
        title="MCP 服务器范围"
        group-label="MCP 服务器范围"
        :mode="mcpMode"
        :selected="selectedMcp"
        :rows="mcpRows"
        :count-text="selectionCount(mcpRows, selectedMcp)"
        inherit-label="继承默认"
        only-label="仅用选中"
        inherit-hint=""
        only-hint="只连接勾选的服务器。"
        search-placeholder="按名称筛选服务器"
        empty-text="没有匹配的服务器。"
        no-rows-text="全局 mcp.json 里还没有服务器。"
        :ready="capabilityReady"
        :disabled="busy || savedExpertId !== null"
        select-all-label="全选"
        @update:mode="mcpMode = $event"
        @update:selected="selectedMcp = $event"
        @select-all="selectAllMcp"
      />
    </div>

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
/* 外壳固定：场景只换标题、字段、正文、能力段与按钮文案，视觉与留白不随场景分叉。 */
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
.present-card-capability {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-top: 0.25rem;
  border-top: 1px solid var(--color-desk-line);
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
