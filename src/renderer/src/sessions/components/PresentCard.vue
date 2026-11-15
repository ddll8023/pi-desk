<!-- 会话内卡片：present_card 工具交付的载荷，按随包枚举渲染固定外壳（标题、字段、正文、能力勾选、文件清单、主次按钮）。
     卡片只是数据展示与动作转发：按钮按动作 ID 调既有业务通道（保存专家走 desktop:expert-save，复制走剪贴板），
     不在渲染层拼装写入规则、不写文件；动作是否成立仍由主进程判定，失败原因就地显示。
     所在位置由 ChatMessageItem 定为独立展示行，宽度占满消息列：不做限宽居中，也不套进执行记录面板。
     能力段的候选与默认基线来自能力候选通道，勾选换算与设置页编辑对话框共用 capability-selection 里的同一套规则。
     能力段含技能、MCP 与工具三个维度；工具里的受保护项（技能门禁、待办清单与记忆组）始终保持勾选。
     交付汇总的文件段带行级「定位」：这是类型段的宿主固定行为、不进动作白名单，复用既有 desktop:project-entry-reveal
     通道；工作区目标由当前项目与运行实例推导，日志视图等没有绑定工作区时禁用并说明原因。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref } from 'vue'
import type { ExpertSaveRequest } from '../../../../shared/experts-api'
import type { PresentCardView } from '../../../../shared/present-card-view'
import type { WorkspaceTarget } from '../../../../shared/workspace-api'
import { copyText } from '../../ui/clipboard'
import { revealProjectEntry } from '../../editor/services/project-file'
import { saveExpert } from '../../experts/services/expert'
import { useExpertStore } from '../../experts/stores/expert'
import { baseIds, restoreSelection, selectionState, toSelectionFields } from '../../experts/capability-selection'
import type { CapabilitySelectionMode } from '../../experts/capability-selection'
import { skillSourceLabel } from '../../experts/skill-source-label'
import ExpertCapabilityPicker from '../../experts/components/ExpertCapabilityPicker.vue'
import { useProjectStore } from '../../projects/stores/project'
import { useSessionStore } from '../stores/session'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionRunsStore } from '../stores/session-runs'

const props = defineProps<{
  /** 一份已通过跨进程契约校验的卡片；字段都是纯文本，界面不解析 Markdown。 */
  readonly card: PresentCardView
}>()

/** 展开正文时上报，让消息列表停止粘底；收起不上报。 */
const emit = defineEmits<{ userExpand: [] }>()

const sessionStore = useSessionStore()
const expertStore = useExpertStore()
const runtimeStore = useRuntimeStore()
const sessionRunsStore = useSessionRunsStore()
const projectStore = useProjectStore()

/** 行级定位错误：路径 → 可展示原因；删除组定位已不存在的文件是常见失败，就地显示不弹窗。 */
const rowErrors = ref<Record<string, string>>({})
const revealingPath = ref<string | null>(null)

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
const toolsMode = ref<CapabilitySelectionMode>(props.card.capability?.toolsMode ?? 'inherit')
const selectedSkills = ref<readonly string[]>(props.card.capability?.skillIds ?? [])
const selectedMcp = ref<readonly string[]>(props.card.capability?.mcpServerIds ?? [])
const selectedTools = ref<readonly string[]>(props.card.capability?.toolIds ?? [])

const baselineSkills = computed(() => expertStore.capabilities?.defaults.skills ?? null)
const baselineMcp = computed(() => expertStore.capabilities?.defaults.mcpServers ?? null)
const baselineTools = computed(() => expertStore.capabilities?.defaults.tools ?? null)
const allSkillIds = computed(() => (expertStore.capabilities?.skills ?? []).map(item => item.id))
const allMcpNames = computed(() => (expertStore.capabilities?.mcpServers ?? []).map(item => item.name))
const allToolNames = computed(() => (expertStore.capabilities?.tools ?? []).map(item => item.name))
/** 受保护工具：卡片上的勾选不能取消，保存时主进程也会拒。 */
const requiredToolNames = computed(() => (expertStore.capabilities?.tools ?? [])
  .filter(item => item.required).map(item => item.name))

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

/** 工具行：受保护候选带 `locked`，与设置页编辑对话框同一套呈现。 */
const toolRows = computed<readonly CapabilityRow[]>(() => {
  const rows: { id: string; label: string; unavailable: boolean; locked?: boolean }[]
    = (expertStore.capabilities?.tools ?? [])
      .map(item => ({ id: item.name, label: item.summary, unavailable: false, locked: item.required }))
  const known = new Set(rows.map(row => row.id))
  for (const name of props.card.capability?.toolIds ?? []) {
    if (known.has(name)) continue
    known.add(name)
    rows.push({ id: name, label: '当前不可用', unavailable: true })
  }
  const base = baseIds(baselineTools.value, allToolNames.value)
  return rows.map(row => ({
    ...row,
    state: selectionState({
      unavailable: row.unavailable,
      mode: toolsMode.value,
      checked: selectedTools.value.includes(row.id),
      inBaseline: base.includes(row.id),
      required: row.locked === true
    })
  }))
})

const hasBody = computed(() => props.card.body !== null && props.card.body !== '')
const busy = computed(() => phase.value === 'busy')
const saveDisabled = computed(() => busy.value || savedExpertId.value !== null || skillsEmpty.value)

const { view: runtimeView } = storeToRefs(runtimeStore)

/** 当前会话标识：运行态未就绪或未绑定会话时为 null（只看日志的视图也在这一列）。 */
const sessionId = computed(() => (
  runtimeView.value.phase === 'ready' ? runtimeView.value.snapshot.info?.sessionId ?? null : null
))

/**
 * 定位用的工作区目标：项目路径来自当前项目，工作区标识来自该会话绑定的运行实例。
 * 推导不出（日志视图、会话尚未建立、运行实例未带工作区）时定位按钮禁用并说明原因。
 */
const revealTarget = computed<WorkspaceTarget | null>(() => {
  const projectPath = projectStore.currentProject?.path ?? null
  const id = sessionId.value
  if (projectPath === null || id === null) return null
  const run = sessionRunsStore.runOfSession(projectPath, id)
  return run === null || run.workspaceId === null ? null : { projectPath, workspaceId: run.workspaceId }
})

/** 交付汇总的文件组：只渲染非空组，组序与交付语义一致（改动、删除、受影响）。 */
const fileGroups = computed(() => {
  const files = props.card.files
  if (files === null) return []
  return [
    { label: '改动', paths: files.changed },
    { label: '删除', paths: files.deleted },
    { label: '受影响', paths: files.affected }
  ].filter(group => group.paths.length > 0)
})

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

function selectAllTools(): void {
  selectedTools.value = toolRows.value.map(row => row.id)
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
  const tools = toSelectionFields({
    mode: toolsMode.value,
    selected: selectedTools.value,
    baseline: baselineTools.value,
    all: allToolNames.value
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
    mcpRemoveIds: [...mcp.removeIds],
    toolsMode: tools.mode,
    toolIds: [...tools.onlyIds],
    toolAddIds: [...tools.addIds],
    toolRemoveIds: [...tools.removeIds]
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

/** 复制内容：带文件段的卡片给文本化清单（组名 + 路径，附正文），其余卡片维持只复制正文。 */
function copyContent(): string {
  const files = props.card.files
  if (files === null) return props.card.body ?? ''
  const blocks: string[] = []
  const appendGroup = (label: string, paths: readonly string[]): void => {
    if (paths.length === 0) return
    blocks.push([`${label}：`, ...paths.map(path => `- ${path}`)].join('\n'))
  }
  appendGroup('改动', files.changed)
  appendGroup('删除', files.deleted)
  appendGroup('受影响', files.affected)
  if (props.card.body !== null && props.card.body !== '') blocks.push(props.card.body)
  return blocks.join('\n\n')
}

async function copyBody(): Promise<void> {
  if (busy.value) return
  phase.value = 'busy'
  errorText.value = ''
  const copied = await copyText(copyContent())
  if (!copied) {
    phase.value = 'failed'
    errorText.value = '复制失败，请手动选中内容复制。'
    return
  }
  phase.value = 'copied'
  notice.value = props.card.files === null ? '正文已复制到剪贴板。' : '清单已复制到剪贴板。'
}

/** 定位一行文件：复用既有「在文件管理器中显示」通道；路径是否可达由主进程解析判定。 */
async function revealFile(path: string): Promise<void> {
  if (revealingPath.value !== null) return
  const target = revealTarget.value
  if (target === null) {
    rowErrors.value = { ...rowErrors.value, [path]: '当前视图没有绑定工作区，无法定位。' }
    return
  }
  revealingPath.value = path
  const result = await revealProjectEntry(path, target)
  revealingPath.value = null
  if (!result.ok) {
    rowErrors.value = { ...rowErrors.value, [path]: result.error.message }
    return
  }
  // 成功后清掉该行的旧错误；其余行保留各自的状态。
  const rest = { ...rowErrors.value }
  delete rest[path]
  rowErrors.value = rest
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
  // 受保护工具始终勾上：模型建议里没有它们时也补回，否则保存会被主进程拒。
  selectedTools.value = [...new Set([
    ...(capability === null
      ? [...baseIds(baselineTools.value, allToolNames.value)]
      : restoreSelection({
          mode: capability.toolsMode,
          onlyIds: capability.toolIds,
          addIds: [],
          removeIds: [],
          baseline: baselineTools.value,
          all: allToolNames.value
        })),
    ...requiredToolNames.value
  ])]
}
</script>

<template>
  <section class="present-card" :aria-label="`卡片：${card.title}`">
    <header class="present-card-head">
      <h3 class="present-card-title">{{ card.title }}</h3>
      <p v-if="card.subtitle !== null" class="present-card-subtitle">{{ card.subtitle }}</p>
    </header>

    <div class="present-card-content">
      <dl v-if="card.fields.length > 0" class="present-card-fields">
        <div v-for="field in card.fields" :key="field.label" class="present-card-field">
          <dt>{{ field.label }}</dt>
          <dd>{{ field.value }}</dd>
        </div>
      </dl>

      <div v-if="fileGroups.length > 0" class="present-card-files">
        <section v-for="group in fileGroups" :key="group.label" class="present-card-file-group">
          <h4 class="present-card-file-group-title">{{ group.label }}（{{ group.paths.length }}）</h4>
          <ul class="present-card-file-list">
            <li v-for="path in group.paths" :key="path" class="present-card-file-row">
              <div class="present-card-file-line">
                <code class="present-card-file-path" :title="path">{{ path }}</code>
                <button
                  type="button"
                  class="present-card-file-reveal"
                  :disabled="revealingPath !== null || revealTarget === null"
                  :title="revealTarget === null ? '当前视图没有绑定工作区，无法定位。' : null"
                  :aria-label="`在文件管理器中定位 ${path}`"
                  @click="revealFile(path)"
                >定位</button>
              </div>
              <p v-if="rowErrors[path]" class="present-card-file-error" role="alert">{{ rowErrors[path] }}</p>
            </li>
          </ul>
        </section>
      </div>

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
        <ExpertCapabilityPicker
          title="工具范围"
          group-label="工具范围"
          :mode="toolsMode"
          :selected="selectedTools"
          :rows="toolRows"
          :count-text="selectionCount(toolRows, selectedTools)"
          inherit-label="继承默认"
          only-label="仅用选中"
          inherit-hint="勾选记录相对默认基线的增减；标「必需」的工具始终保留。"
          only-hint="只用勾选的工具；标「必需」的工具不受名单影响。"
          search-placeholder="按名称筛选工具"
          empty-text="没有匹配的工具。"
          no-rows-text="随包清单里还没有工具声明。"
          :ready="capabilityReady"
          :disabled="busy || savedExpertId !== null"
          select-all-label="全选"
          @update:mode="toolsMode = $event"
          @update:selected="selectedTools = $event"
          @select-all="selectAllTools"
        />
      </div>
      <p v-if="skillsEmpty" class="present-card-error" role="alert">「仅用选中」时至少要保留一个技能。</p>

      <details v-if="hasBody" class="present-card-body" @toggle="onToggle">
        <summary>查看正文</summary>
        <pre class="present-card-body-text">{{ card.body }}</pre>
      </details>
    </div>

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
/* 外壳固定：场景只换标题、字段、正文、能力段与按钮文案，视觉与留白不随场景分叉。
   位置与宽度由消息列决定：卡片是成果，占满整列，不靠限宽居中。 */
.present-card {
  display: flex;
  flex-direction: column;
  width: 100%;
  overflow: hidden;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-md);
  background: var(--color-desk-surface);
}
.present-card-head {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  padding: 0.625rem 0.875rem;
  border-bottom: 1px solid var(--color-desk-line);
  background: var(--color-desk-panel);
}
.present-card-title {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.4;
  color: var(--color-desk-ink);
}
.present-card-subtitle {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--color-desk-muted);
}
.present-card-content {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.75rem 0.875rem;
}
.present-card-fields {
  display: grid;
  grid-template-columns: 5.5rem minmax(0, 1fr);
  column-gap: 0.75rem;
  row-gap: 0.375rem;
  margin: 0;
  font-size: 0.75rem;
}
/* 行包装盒不参与布局，让 dt / dd 直接对齐到两列网格。 */
.present-card-field {
  display: contents;
}
.present-card-field dt {
  color: var(--color-desk-muted);
  line-height: 1.6;
}
.present-card-field dd {
  margin: 0;
  color: var(--color-desk-ink);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.present-card-capability {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  padding: 0.625rem;
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-panel);
}
/* 技能、MCP 与工具三段之间只留一条分隔线，不叠外边距。 */
.present-card-capability > * + * {
  padding-top: 0.625rem;
  border-top: 1px solid var(--color-desk-line);
}
/* 文件段与能力段同一面板基调；组间一条分隔线，行内路径截断展示、全文进 title。 */
.present-card-files {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  padding: 0.625rem;
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-panel);
}
.present-card-file-group + .present-card-file-group {
  padding-top: 0.625rem;
  border-top: 1px solid var(--color-desk-line);
}
.present-card-file-group-title {
  margin: 0 0 0.25rem;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.4;
  color: var(--color-desk-ink);
}
.present-card-file-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.present-card-file-row + .present-card-file-row {
  margin-top: 0.25rem;
}
.present-card-file-line {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}
.present-card-file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  line-height: 1.6;
  color: var(--color-desk-ink);
}
.present-card-file-reveal {
  flex: none;
  min-height: 1.5rem;
  padding: 0.125rem 0.5rem;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-sm);
  background: transparent;
  color: var(--color-desk-ink);
  font: inherit;
  font-size: 0.6875rem;
  line-height: 1.4;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.present-card-file-reveal:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.present-card-file-reveal:focus-visible {
  outline: 2px solid var(--color-desk-accent);
  outline-offset: 2px;
}
.present-card-file-error {
  margin: 0.125rem 0 0;
  font-size: 0.6875rem;
  line-height: 1.5;
  color: var(--color-desk-danger);
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
  padding: 0.5rem 0.625rem;
  max-height: 20rem;
  overflow: auto;
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-panel);
  color: var(--color-desk-ink);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.present-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0.625rem 0.875rem;
  border-top: 1px solid var(--color-desk-line);
}
.present-card-button {
  min-height: 1.75rem;
  padding: 0.25rem 0.75rem;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-sm);
  background: transparent;
  color: var(--color-desk-ink);
  font: inherit;
  font-size: 0.75rem;
  line-height: 1.4;
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
  padding: 0 0.875rem 0.625rem;
  font-size: 0.75rem;
  color: var(--color-desk-muted);
}
.present-card-error {
  margin: 0;
  padding: 0 0.875rem 0.625rem;
  font-size: 0.75rem;
  color: var(--color-desk-danger);
}
/* 窄容器下字段改为纵向堆叠，标签与值不抢固定列宽。 */
@media (max-width: 640px) {
  .present-card-fields {
    grid-template-columns: minmax(0, 1fr);
    row-gap: 0.125rem;
  }
  .present-card-field dd {
    margin-bottom: 0.375rem;
  }
}
@media (prefers-reduced-motion: reduce) {
  .present-card-button,
  .present-card-file-reveal {
    transition: none;
  }
}
</style>
