<!-- 会话内卡片：present_card 工具交付的载荷，按随包枚举渲染固定外壳（标题、字段、正文、能力勾选、文件清单、记忆候选、主次按钮）。
     卡片只是数据展示与动作转发：按钮按动作 ID 调既有业务通道（保存专家走 desktop:expert-save，复制走剪贴板，
     记忆候选保存走 desktop:memory-save-candidates），不在渲染层拼装写入规则、不写文件；
     动作是否成立仍由主进程判定，失败原因就地显示。
     所在位置由 ChatMessageItem 定为独立展示行，宽度占满消息列：不做限宽居中，也不套进执行记录面板。
     能力段的候选与默认基线来自能力候选通道，勾选换算与设置页编辑对话框共用 capability-selection 里的同一套规则。
     能力段含技能、MCP 与工具三个维度；工具里的受保护项（技能门禁、待办清单与记忆组）始终保持勾选。
     交付汇总的文件段带行级「定位」：这是类型段的宿主固定行为、不进动作白名单，复用既有 desktop:project-entry-reveal
     通道；工作区目标由当前项目与运行实例推导，日志视图等没有绑定工作区时禁用并说明原因。
     记忆候选段同样是类型段的宿主固定行为：候选默认全选、可编辑（类型、标题、正文、规则键、状态）后再保存；
     保存前的编辑是确认面的一部分，已入库记录的编辑不在这里。
     卡片带更新目标（targetExpertId／targetTeamId）时进入更新模式：先按既有读通道回填当前定义，
     模型缺省的字段由回填补齐，写入范围一律按定义三态回填（卡片缺省的「留空＝只读」会把不限制的专家悄悄收窄）；
     定义读不到时锁定保存，不对着已删除的目标提交。
     团队草案段（team.draft）：团长单选、成员多选，候选与设置页同一份专家清单，模型给的未知标识按
     「当前不可用」列出，换团长时自动把它移出成员（与团队编辑对话框同一口径）；保存走 desktop:team-save。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref } from 'vue'
import { MAX_EXPERT_DISPLAY_NAME_LENGTH, MAX_EXPERT_SUMMARY_LENGTH, MAX_EXPERT_WRITE_SCOPE_ITEMS,
  normalizeExpertWriteScopeEntry } from '../../../../shared/experts-api'
import type { ExpertEditableDefinition, ExpertSaveRequest } from '../../../../shared/experts-api'
import { MEMORY_CONTENT_MAX, MEMORY_RECORD_TYPES, MEMORY_RULE_KEY_MAX, MEMORY_TOPIC_MAX } from '../../../../shared/memory-api'
import type { MemoryRecordType, MemorySaveCandidate } from '../../../../shared/memory-api'
import type { PresentCardView } from '../../../../shared/present-card-view'
import { MAX_TEAM_DISPLAY_NAME_LENGTH, MAX_TEAM_SUMMARY_LENGTH } from '../../../../shared/teams-api'
import type { WorkspaceTarget } from '../../../../shared/workspace-api'
import { copyText } from '../../ui/clipboard'
import { revealProjectEntry } from '../../editor/services/project-file'
import { readExpertDefinition, saveExpert } from '../../experts/services/expert'
import { readTeamDefinition, saveTeam } from '../../experts/services/team'
import { useExpertStore } from '../../experts/stores/expert'
import { useTeamStore } from '../../experts/stores/team'
import { baseIds, restoreSelection, selectionState, toSelectionFields } from '../../experts/capability-selection'
import type { CapabilitySelectionMode } from '../../experts/capability-selection'
import { skillSourceLabel } from '../../experts/skill-source-label'
import ExpertCapabilityPicker from '../../experts/components/ExpertCapabilityPicker.vue'
import { saveMemoryCandidates } from '../../memory/services/memory'
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
const teamStore = useTeamStore()
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

/** 写入范围的编辑值：一行一个（或用逗号分隔）的项目内相对路径；留空即只读。 */
const scopeInput = ref((props.card.capability?.writeScope ?? []).join('\n'))
const scopeError = ref('')

/**
 * 更新模式：卡片带目标标识时按既有定义回填再让用户改，保存带标识走更新而不是新建。
 * 名称、简介与正文的编辑值创建模式只按卡片原值透传，更新模式渲染成输入框。
 */
const expertUpdating = computed(() => props.card.targetExpertId !== null)
const teamUpdating = computed(() => props.card.targetTeamId !== null)
const titleInput = ref(props.card.title)
const subtitleInput = ref(props.card.subtitle ?? '')
const bodyInput = ref(props.card.body ?? '')
/** 回填是否就绪：定义读不到时锁定保存，不对着已删除的目标提交。 */
const expertDefinitionReady = ref(!expertUpdating.value)
const expertBackfillError = ref('')
const teamDefinitionReady = ref(!teamUpdating.value)
const teamBackfillError = ref('')

/** 写入范围三态（仅更新模式）：不限制、只读、指定路径，与专家编辑对话框同一口径，靠单选区分不靠留空推断。 */
const writeScopeMode = ref<'unrestricted' | 'readonly' | 'paths'>('readonly')
const writeScopePaths = ref('')
const writeScopeError = ref('')

/** 名称与简介的输入上限：按卡片类型取对应保存契约的常量，不在界面另写数字。 */
const titleMaxLength = computed(() => (props.card.cardType === 'team.draft'
  ? MAX_TEAM_DISPLAY_NAME_LENGTH
  : MAX_EXPERT_DISPLAY_NAME_LENGTH))
const summaryMaxLength = computed(() => (props.card.cardType === 'team.draft'
  ? MAX_TEAM_SUMMARY_LENGTH
  : MAX_EXPERT_SUMMARY_LENGTH))

/**
 * 解析写入范围文本：与专家定义同一份归一规则（项目内相对路径，目录以 `/` 结尾），
 * 超出条数上限时整批报错；上限与保存契约同源，就地报错而不是等保存通道给一句不相关的原因。
 */
function parseScopeText(text: string): { scope: string[]; error: string | null } {
  const scope: string[] = []
  for (const raw of text.split(/[\n,]/)) {
    const value = raw.trim().replace(/^\.\//, '')
    if (value === '') continue
    const normalized = normalizeExpertWriteScopeEntry(value)
    if (normalized === null) {
      return { scope: [], error: `「${value}」不是合法的写入范围项：必须是项目内相对路径，目录以 / 结尾，不含 .. 或盘符` }
    }
    if (!scope.includes(normalized)) scope.push(normalized)
  }
  if (scope.length > MAX_EXPERT_WRITE_SCOPE_ITEMS) {
    return { scope: [], error: `写入范围最多 ${MAX_EXPERT_WRITE_SCOPE_ITEMS} 项：请精简后再保存` }
  }
  return { scope, error: null }
}
/** 候选保存成功条数；有值时说明这张卡片已经写库，勾选与编辑一并锁定。 */
const savedMemoryCount = ref<number | null>(null)

/**
 * 记忆候选的可编辑副本：模型建议是初始值，用户改完勾选保存。
 * 勾选默认全选；替代链引用（supersede／source ID）不开放编辑，保存时按原候选透传给引擎校验。
 */
interface CandidateEdit {
  readonly index: number
  checked: boolean
  type: MemoryRecordType
  topic: string
  content: string
  ruleKey: string
  status: 'active' | 'resolved' | 'archived'
}

const candidateEdits = ref<readonly CandidateEdit[]>(
  (props.card.candidates ?? []).map((candidate, index) => toCandidateEdit(candidate, index))
)

function toCandidateEdit(candidate: MemorySaveCandidate, index: number): CandidateEdit {
  return {
    index,
    checked: true,
    type: candidate.type,
    topic: candidate.topic,
    content: candidate.content,
    ruleKey: candidate.rule_key ?? '',
    status: candidate.status ?? 'active'
  }
}

/** 规则类（decision／constraint）恒为 active 且需要规则键；其余类型在界面上显式选状态。 */
function isRuleType(type: MemoryRecordType): boolean {
  return type === 'decision' || type === 'constraint'
}

/** 单条是否可保存：只做形式校验（标题、正文、规则键非空），业务组合由引擎判定。 */
function candidateComplete(edit: CandidateEdit): boolean {
  if (edit.topic.trim() === '' || edit.content.trim() === '') return false
  return !(isRuleType(edit.type) && edit.ruleKey.trim() === '')
}

/** 勾选且形式完整的候选才会进保存请求；一条都不满足时保存按钮禁用（不选即不写）。 */
const savableCandidates = computed<readonly MemorySaveCandidate[]>(() => candidateEdits.value
  .filter(edit => edit.checked && candidateComplete(edit))
  .map(edit => {
    const source = props.card.candidates?.[edit.index]
    return {
      type: edit.type,
      topic: edit.topic.trim(),
      content: edit.content.trim(),
      ...(isRuleType(edit.type) ? { rule_key: edit.ruleKey.trim() } : {}),
      ...(!isRuleType(edit.type) ? { status: edit.status } : {}),
      ...(source?.source_record_ids === undefined ? {} : { source_record_ids: source.source_record_ids }),
      ...(source?.supersede_record_ids === undefined ? {} : { supersede_record_ids: source.supersede_record_ids }),
      ...(source?.supersession_reason === undefined ? {} : { supersession_reason: source.supersession_reason })
    }
  }))

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
const saveDisabled = computed(() => busy.value || savedExpertId.value !== null || skillsEmpty.value
  || !expertDefinitionReady.value || titleInput.value.trim() === '' || subtitleInput.value.trim() === '')
/** 记忆候选保存：写库后锁定全部编辑控件；可保存集合为空（全不勾或全不完整）时禁用。 */
const memorySaveDisabled = computed(() => busy.value || savedMemoryCount.value !== null || savableCandidates.value.length === 0)

/** 团队草案的团长与成员编辑值：候选与设置页团队编辑对话框同一份专家清单。 */
const leadExpertId = ref(props.card.team?.leadExpertId ?? '')
const memberIds = ref<readonly string[]>(props.card.team?.memberExpertIds ?? [])
const savedTeamId = ref<string | null>(null)

/** 团长与成员的候选行：清单里没有的模型引用按「当前不可用」列出，让用户显式替换或取消，不静默丢弃。 */
interface ExpertRow {
  readonly id: string
  readonly label: string
  readonly tag: string
  readonly unavailable: boolean
}

const expertRows = computed<readonly ExpertRow[]>(() => {
  const rows: { id: string; label: string; tag: string; unavailable: boolean }[] = expertStore.experts
    .map(item => ({
      id: item.id,
      label: item.displayName,
      tag: item.source === 'builtin' ? '内置' : '自定义',
      unavailable: false
    }))
  const known = new Set(rows.map(row => row.id))
  const referenced = [props.card.team?.leadExpertId, ...(props.card.team?.memberExpertIds ?? [])]
  for (const id of referenced) {
    if (id === undefined || known.has(id)) continue
    known.add(id)
    rows.push({ id, label: id, tag: '', unavailable: true })
  }
  return rows
})

function rowOf(id: string): ExpertRow | undefined {
  return expertRows.value.find(row => row.id === id)
}

/** 引用失效就地报错：团长或成员里有清单外的标识时阻止保存，不把开不了团的团队写进清单。 */
const leadUnavailable = computed(() => leadExpertId.value !== '' && rowOf(leadExpertId.value)?.unavailable === true)
const unavailableMembers = computed(() => memberIds.value.filter(id => rowOf(id)?.unavailable === true))

const teamSaveDisabled = computed(() => busy.value || savedTeamId.value !== null || !teamDefinitionReady.value
  || titleInput.value.trim() === '' || subtitleInput.value.trim() === ''
  || leadExpertId.value === '' || leadUnavailable.value
  || memberIds.value.length === 0 || unavailableMembers.value.length > 0)

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
  if (props.card.cardType === 'expert.draft') {
    // 候选与基线只在卡片需要时读一次；读失败时保持未就绪，保存仍以主进程校验为准。
    if (expertStore.capabilities === null) await expertStore.loadCapabilities()
    if (expertUpdating.value) {
      await backfillExpertDefinition()
      // 更新模式下模型给了能力建议时按建议还原勾选；没给时回填函数已按定义还原，不重置为基线。
      if (props.card.capability !== null) applyInitialSelection()
    } else {
      applyInitialSelection()
    }
  }
  if (props.card.cardType === 'team.draft') {
    // 团长与成员的候选是专家清单：与设置页同源，读失败时行清单为空，保存按钮按未选禁用。
    if (!expertStore.loaded) await expertStore.load()
    if (teamUpdating.value) await backfillTeamDefinition()
  }
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
 * 保存用写入范围：创建模式按文本框解析（留空即只读）；更新模式按三态换算，
 * `null` 不限制——更新不能借「留空」的缺省语义把不限制的专家悄悄收窄成只读。
 */
function saveWriteScope(): readonly string[] | null {
  if (!expertUpdating.value) return parseScopeText(scopeInput.value).scope
  if (writeScopeMode.value === 'unrestricted') return null
  if (writeScopeMode.value === 'readonly') return []
  return parseScopeText(writeScopePaths.value).scope
}

/**
 * 由草案组装保存请求：名称、简介与正文取编辑值（创建模式未渲染输入框时即卡片原值）；
 * 能力范围按当前勾选换算，未给能力段的旧卡片按「继承默认基线」写入；更新模式带目标标识。
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
    expertId: props.card.targetExpertId,
    displayName: titleInput.value.trim(),
    summary: subtitleInput.value.trim(),
    body: bodyInput.value,
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
    toolRemoveIds: [...tools.removeIds],
    writeScope: saveWriteScope()
  }
}

async function saveExpertDefinition(): Promise<void> {
  if (saveDisabled.value) return
  // 写入范围不合法时停在卡片上：不能带一份错的范围去保存。更新模式的指定路径态要求至少一项。
  if (expertUpdating.value && writeScopeMode.value === 'paths') {
    const parsedPaths = parseScopeText(writeScopePaths.value)
    if (parsedPaths.scope.length === 0 || parsedPaths.error !== null) {
      writeScopeError.value = parsedPaths.error ?? '指定路径时至少要给一项合法的写入范围。'
      return
    }
  } else if (!expertUpdating.value) {
    const parsedScope = parseScopeText(scopeInput.value)
    if (parsedScope.error !== null) {
      scopeError.value = parsedScope.error
      return
    }
  }
  writeScopeError.value = ''
  scopeError.value = ''
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
  const savedNote = unavailable.length > 0
    ? `已保存 ${result.data.expertId}；当前不可用的引用：${unavailable.join('；')}。`
    : props.card.targetExpertId !== null
      ? `已更新 ${result.data.expertId}；改专家定义新建会话才生效。`
      : `已保存 ${result.data.expertId}，新建会话即可召唤。`
  notice.value = savedNote
  // 输入坞的专家菜单读的是会话域的清单，保存后立刻重读，避免菜单里看不到新专家。
  await sessionStore.loadExperts()
}

/** 复制内容：带文件段的卡片给文本化清单（组名 + 路径，附正文），带候选段的给候选清单，其余卡片维持只复制正文。 */
function copyContent(): string {
  const files = props.card.files
  if (files !== null) {
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
  const candidates = props.card.candidates
  if (candidates !== null) {
    const blocks = candidates.map(candidate => `【${candidate.type}】${candidate.topic}\n${candidate.content}`)
    if (props.card.body !== null && props.card.body !== '') blocks.push(props.card.body)
    return blocks.join('\n\n')
  }
  return props.card.body ?? ''
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
  notice.value = props.card.files !== null
    ? '清单已复制到剪贴板。'
    : props.card.candidates !== null ? '候选清单已复制到剪贴板。' : '正文已复制到剪贴板。'
}

/**
 * 保存勾选的记忆候选：只转发项目路径与编辑后的候选，归属与计划由主进程处理。
 * 未关联项目的会话传空路径，主进程按全局记忆落库并在回执里说明。
 */
async function saveCardCandidates(): Promise<void> {
  if (memorySaveDisabled.value) return
  phase.value = 'busy'
  errorText.value = ''
  notice.value = ''
  const projectPath = projectStore.currentProject?.path ?? ''
  const result = await saveMemoryCandidates({ projectPath, candidates: savableCandidates.value })
  if (!result.ok) {
    phase.value = 'failed'
    errorText.value = result.error.message
    return
  }
  savedMemoryCount.value = result.data.savedCount
  phase.value = 'saved'
  const globalNote = projectPath === '' ? '；未关联项目，已按全局记忆保存' : ''
  notice.value = `已保存 ${result.data.savedCount} 条记忆${globalNote}。`
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
  if (id === 'team.save') {
    void saveTeamDefinition()
    return
  }
  if (id === 'memory.save') {
    void saveCardCandidates()
    return
  }
  void copyBody()
}

function actionDisabled(id: PresentCardView['primaryAction']['id']): boolean {
  if (id === 'expert.save') return saveDisabled.value
  if (id === 'team.save') return teamSaveDisabled.value
  if (id === 'memory.save') return memorySaveDisabled.value
  return busy.value
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

/** 更新模式回填：模型缺省的简介与正文按当前定义补齐；写入范围一律按定义三态回填。 */
async function backfillExpertDefinition(): Promise<void> {
  const result = await readExpertDefinition(props.card.targetExpertId ?? '')
  if (!result.ok) {
    expertBackfillError.value = `没能读到专家当前定义：${result.error.message}；更新已禁用，可改用设置页编辑。`
    return
  }
  const definition = result.data
  expertDefinitionReady.value = true
  if (subtitleInput.value === '') subtitleInput.value = definition.summary
  if (bodyInput.value === '') bodyInput.value = definition.body
  writeScopeMode.value = definition.writeScope === null
    ? 'unrestricted'
    : definition.writeScope.length === 0 ? 'readonly' : 'paths'
  writeScopePaths.value = definition.writeScope === null || definition.writeScope.length === 0
    ? '' : definition.writeScope.join('\n')
  // 模型没给能力建议时按定义已保存的范围还原勾选，不重置成默认基线。
  if (props.card.capability === null) restoreDefinitionSelection(definition)
}

/** 按定义还原三个维度的勾选：与保存字段同一套加减语义；受保护工具照常补回。 */
function restoreDefinitionSelection(definition: ExpertEditableDefinition): void {
  skillsMode.value = definition.skillsMode
  selectedSkills.value = restoreSelection({
    mode: definition.skillsMode,
    onlyIds: definition.skillIds,
    addIds: definition.skillAddIds,
    removeIds: definition.skillRemoveIds,
    baseline: baselineSkills.value,
    all: allSkillIds.value
  })
  mcpMode.value = definition.mcpMode
  selectedMcp.value = restoreSelection({
    mode: definition.mcpMode,
    onlyIds: definition.mcpServerIds,
    addIds: definition.mcpAddIds,
    removeIds: definition.mcpRemoveIds,
    baseline: baselineMcp.value,
    all: allMcpNames.value
  })
  toolsMode.value = definition.toolsMode
  selectedTools.value = [...new Set([
    ...restoreSelection({
      mode: definition.toolsMode,
      onlyIds: definition.toolIds,
      addIds: definition.toolAddIds,
      removeIds: definition.toolRemoveIds,
      baseline: baselineTools.value,
      all: allToolNames.value
    }),
    ...requiredToolNames.value
  ])]
}

/** 团队更新回填：团长与成员以定义为准，模型缺省的简介与正文按定义补齐。 */
async function backfillTeamDefinition(): Promise<void> {
  const result = await readTeamDefinition(props.card.targetTeamId ?? '')
  if (!result.ok) {
    teamBackfillError.value = `没能读到团队当前定义：${result.error.message}；更新已禁用，可改用设置页编辑。`
    return
  }
  const definition = result.data
  teamDefinitionReady.value = true
  if (subtitleInput.value === '') subtitleInput.value = definition.summary
  if (bodyInput.value === '') bodyInput.value = definition.body
  leadExpertId.value = definition.leadExpertId
  memberIds.value = [...definition.memberExpertIds]
}

/** 团长选择后把同名标识移出成员：团长进成员名单会让派活绕过「团长不生产」。 */
function onLeadChange(event: Event): void {
  leadExpertId.value = event.target instanceof HTMLSelectElement ? event.target.value : ''
  memberIds.value = memberIds.value.filter(id => id !== leadExpertId.value)
}

function toggleMember(id: string, checked: boolean): void {
  if (id === leadExpertId.value) return
  memberIds.value = checked
    ? [...memberIds.value.filter(item => item !== id), id]
    : memberIds.value.filter(item => item !== id)
}

/** 勾选事件转成员增减：instanceof 收窄放脚本里做，模板表达式拿不到 DOM 类型。 */
function onMemberToggle(id: string, event: Event): void {
  toggleMember(id, event.target instanceof HTMLInputElement && event.target.checked)
}

/** 保存团队草案：成员名单里团长已由选择动作排除，这里再按当前团长过滤一次。 */
async function saveTeamDefinition(): Promise<void> {
  if (teamSaveDisabled.value) return
  phase.value = 'busy'
  errorText.value = ''
  notice.value = ''
  const result = await saveTeam({
    teamId: props.card.targetTeamId,
    displayName: titleInput.value.trim(),
    summary: subtitleInput.value.trim(),
    leadExpertId: leadExpertId.value,
    memberExpertIds: memberIds.value.filter(id => id !== leadExpertId.value),
    body: bodyInput.value
  })
  if (!result.ok) {
    phase.value = 'failed'
    errorText.value = result.error.message
    return
  }
  savedTeamId.value = result.data.teamId
  phase.value = 'saved'
  notice.value = props.card.targetTeamId !== null
    ? `已更新 ${result.data.teamId}；改团队定义新建会话才生效。`
    : `已保存 ${result.data.teamId}，新建会话即可开团。`
  // 输入坞的团队面板与设置页读同一份清单，保存后立刻重读，避免面板里看不到新团队。
  void teamStore.load()
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

      <!-- 更新模式的编辑面：字段按当前定义回填，模型给的内容是建议值，保存前可直接修改。 -->
      <div v-if="expertUpdating || teamUpdating" class="present-card-editable">
        <p v-if="expertBackfillError !== ''" class="present-card-file-error" role="alert">{{ expertBackfillError }}</p>
        <p class="present-card-edit-hint">
          {{ card.cardType === 'team.draft'
            ? '更新模式：以下内容已按当前定义回填；协作约定正文只供查看与编辑，不进入系统提示。'
            : '更新模式：以下内容已按当前定义回填，可直接修改后保存；改定义新建会话才生效。' }}
        </p>
        <p class="present-card-edit-row">
          <label class="present-card-scope-label" for="present-card-edit-title">名称</label>
          <input
            id="present-card-edit-title"
            v-model="titleInput"
            type="text"
            class="present-card-edit-input"
            :maxlength="titleMaxLength"
            :disabled="busy || savedExpertId !== null || savedTeamId !== null"
            :aria-label="card.cardType === 'team.draft' ? '团队显示名称' : '专家显示名称'"
          />
        </p>
        <p class="present-card-edit-row">
          <label class="present-card-scope-label" for="present-card-edit-summary">简介</label>
          <input
            id="present-card-edit-summary"
            v-model="subtitleInput"
            type="text"
            class="present-card-edit-input"
            :maxlength="summaryMaxLength"
            :disabled="busy || savedExpertId !== null || savedTeamId !== null"
            :aria-label="card.cardType === 'team.draft' ? '团队简介' : '专家简介'"
          />
        </p>
        <p class="present-card-edit-row">
          <label class="present-card-scope-label" for="present-card-edit-body">正文</label>
          <textarea
            id="present-card-edit-body"
            v-model="bodyInput"
            class="present-card-edit-body"
            rows="6"
            spellcheck="false"
            :disabled="busy || savedExpertId !== null || savedTeamId !== null"
            :aria-label="card.cardType === 'team.draft' ? '协作约定正文' : '专家定义正文'"
          ></textarea>
        </p>
      </div>

      <!-- 团队草案段：团长单选、成员多选，候选与设置页同一份专家清单；清单外的引用按不可用列出。 -->
      <div v-if="card.cardType === 'team.draft'" class="present-card-team">
        <p v-if="teamBackfillError !== ''" class="present-card-file-error" role="alert">{{ teamBackfillError }}</p>
        <p class="present-card-team-hint">团长与成员从当前专家清单里选；团长不生产，开团后只验收与派活，不能同时当成员。</p>
        <p class="present-card-team-lead">
          <label class="present-card-scope-label" for="present-card-team-lead">团长</label>
          <select
            id="present-card-team-lead"
            class="present-card-team-select"
            :value="leadExpertId"
            :disabled="busy || savedTeamId !== null"
            @change="onLeadChange"
          >
            <option value="">未选择</option>
            <option v-for="row in expertRows" :key="row.id" :value="row.id" :disabled="row.unavailable">
              {{ row.label }}{{ row.tag === '' ? '' : `（${row.tag}）` }}{{ row.unavailable ? '——当前不可用' : '' }}
            </option>
          </select>
        </p>
        <div class="present-card-team-members">
          <span class="present-card-scope-label">成员</span>
          <ul class="present-card-team-list">
            <li v-for="row in expertRows" :key="row.id" class="present-card-team-row">
              <label class="present-card-team-check">
                <input
                  type="checkbox"
                  class="present-card-candidate-check"
                  :checked="memberIds.includes(row.id)"
                  :disabled="row.id === leadExpertId || busy || savedTeamId !== null"
                  :aria-label="`选择 ${row.label} 为成员`"
                  @change="onMemberToggle(row.id, $event)"
                />
                <span class="present-card-team-name">{{ row.label }}</span>
                <span v-if="row.tag !== ''" class="present-card-team-tag">{{ row.tag }}</span>
                <span v-if="row.unavailable" class="present-card-team-unavailable">当前不可用</span>
              </label>
            </li>
          </ul>
        </div>
        <p v-if="memberIds.length === 0" class="present-card-file-error" role="alert">至少要选一名成员才能保存。</p>
        <p v-if="leadUnavailable" class="present-card-file-error" role="alert">团长是清单外的标识，先换一位当前可用的团长。</p>
        <p v-if="unavailableMembers.length > 0" class="present-card-file-error" role="alert">
          成员里有当前不可用的专家（{{ unavailableMembers.join('、') }}），先取消或换人再保存。
        </p>
      </div>

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
                  :title="revealTarget === null ? '当前视图没有绑定工作区，无法定位。' : undefined"
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
        <!-- 写入范围：创建模式留空即只读；更新模式按定义三态回填，靠单选区分，不靠留空推断。 -->
        <p v-if="!expertUpdating" class="present-card-scope">
          <label class="present-card-scope-label" for="present-card-scope-input">写入范围</label>
          <textarea
            id="present-card-scope-input"
            v-model="scopeInput"
            class="present-card-scope-input"
            rows="2"
            spellcheck="false"
            :disabled="busy || savedExpertId !== null"
            placeholder="留空 = 只读；例：docs/（目录以 / 结尾）、README.md"
          ></textarea>
        </p>
        <div v-else class="present-card-scope-edit">
          <span class="present-card-scope-label">写入范围</span>
          <div class="present-card-scope-modes" role="radiogroup" aria-label="写入范围口径">
            <label class="present-card-scope-mode">
              <input v-model="writeScopeMode" type="radio" value="unrestricted" :disabled="busy || savedExpertId !== null" />
              不限制
            </label>
            <label class="present-card-scope-mode">
              <input v-model="writeScopeMode" type="radio" value="readonly" :disabled="busy || savedExpertId !== null" />
              只读
            </label>
            <label class="present-card-scope-mode">
              <input v-model="writeScopeMode" type="radio" value="paths" :disabled="busy || savedExpertId !== null" />
              指定路径
            </label>
          </div>
          <textarea
            v-if="writeScopeMode === 'paths'"
            v-model="writeScopePaths"
            class="present-card-scope-input"
            rows="2"
            spellcheck="false"
            :disabled="busy || savedExpertId !== null"
            aria-label="写入范围路径"
            placeholder="例：docs/（目录以 / 结尾）、README.md"
          ></textarea>
        </div>
        <p v-if="scopeError !== ''" class="present-card-error" role="alert">{{ scopeError }}</p>
        <p v-if="writeScopeError !== ''" class="present-card-error" role="alert">{{ writeScopeError }}</p>
      </div>
      <p v-if="skillsEmpty" class="present-card-error" role="alert">「仅用选中」时至少要保留一个技能。</p>

      <!-- 记忆候选段：类型段的宿主固定行为——候选默认全选、可编辑后再保存；替代链引用不在此展示。
           保存前的编辑属于确认面，写库后（savedMemoryCount 有值）勾选与编辑一并锁定。 -->
      <div v-if="candidateEdits.length > 0" class="present-card-candidates">
        <p class="present-card-candidates-title">记忆候选（{{ savableCandidates.length }} / {{ candidateEdits.length }} 条可保存）</p>
        <div
          v-for="edit in candidateEdits"
          :key="edit.index"
          class="present-card-candidate"
          :class="{ 'is-incomplete': !candidateComplete(edit) }"
        >
          <div class="present-card-candidate-head">
            <input
              v-model="edit.checked"
              type="checkbox"
              class="present-card-candidate-check"
              :disabled="busy || savedMemoryCount !== null"
              :aria-label="`保存候选 ${edit.index + 1}`"
            />
            <select
              v-model="edit.type"
              class="present-card-candidate-type"
              :disabled="busy || savedMemoryCount !== null"
              :aria-label="`候选 ${edit.index + 1} 的记忆类型`"
            >
              <option v-for="type in MEMORY_RECORD_TYPES" :key="type" :value="type">{{ type }}</option>
            </select>
            <input
              v-if="isRuleType(edit.type)"
              v-model="edit.ruleKey"
              type="text"
              class="present-card-candidate-rulekey"
              placeholder="规则键（如 chat.present-card-mechanism）"
              :maxlength="MEMORY_RULE_KEY_MAX"
              :disabled="busy || savedMemoryCount !== null"
              :aria-label="`候选 ${edit.index + 1} 的规则键`"
            />
          </div>
          <input
            v-model="edit.topic"
            type="text"
            class="present-card-candidate-topic"
            :maxlength="MEMORY_TOPIC_MAX"
            :disabled="busy || savedMemoryCount !== null"
            :aria-label="`候选 ${edit.index + 1} 的标题`"
          />
          <textarea
            v-model="edit.content"
            class="present-card-candidate-content"
            :maxlength="MEMORY_CONTENT_MAX"
            rows="3"
            :disabled="busy || savedMemoryCount !== null"
            :aria-label="`候选 ${edit.index + 1} 的正文`"
          ></textarea>
          <div v-if="!isRuleType(edit.type)" class="present-card-candidate-status">
            <label class="present-card-candidate-status-label">
              状态
              <select
                v-model="edit.status"
                class="present-card-candidate-status-select"
                :disabled="busy || savedMemoryCount !== null"
                :aria-label="`候选 ${edit.index + 1} 的状态`"
              >
                <option value="active">active（生效中／未决）</option>
                <option value="resolved">resolved（已解决）</option>
                <option value="archived">archived（已归档）</option>
              </select>
            </label>
            <span v-if="edit.type === 'progress' && edit.status === 'active'" class="present-card-candidate-hint">
              active 的 progress 不能含提交号或改动行数，否则保存会被拒绝。
            </span>
          </div>
          <p v-if="!candidateComplete(edit)" class="present-card-file-error" role="alert">
            这条缺少{{ isRuleType(edit.type) && edit.ruleKey.trim() === '' ? '标题、正文或规则键' : '标题或正文' }}，不会包含在保存里。
          </p>
        </div>
      </div>

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
/* 写入范围一行：标签与多行输入并排，输入框吃满剩余宽度。 */
.present-card-scope {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0;
}
.present-card-scope-label {
  flex: none;
  padding-top: 0.25rem;
  font-size: var(--text-2xs);
  color: var(--color-desk-muted);
}
.present-card-scope-input {
  min-width: 0;
  flex: 1 1 auto;
  resize: vertical;
  padding: 0.25rem 0.375rem;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-surface);
  color: var(--color-desk-ink);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  line-height: 1.5;
}
.present-card-scope-input:disabled {
  color: var(--color-desk-muted);
  background: var(--color-desk-surface-subtle);
}
/* 更新模式的编辑面：与写入范围同一行式布局，正文用多行输入吃满剩余宽度。 */
.present-card-editable {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0.625rem;
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-panel);
}
.present-card-edit-hint,
.present-card-team-hint {
  margin: 0;
  font-size: 0.6875rem;
  line-height: 1.5;
  color: var(--color-desk-muted);
}
.present-card-edit-row {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0;
}
.present-card-edit-input {
  min-width: 0;
  flex: 1 1 auto;
  padding: 0.25rem 0.375rem;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-surface);
  color: var(--color-desk-ink);
  font: inherit;
  font-size: 0.75rem;
  line-height: 1.5;
}
.present-card-edit-body {
  min-width: 0;
  flex: 1 1 auto;
  resize: vertical;
  padding: 0.25rem 0.375rem;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-surface);
  color: var(--color-desk-ink);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  line-height: 1.6;
}
/* 写入范围三态：单选一行铺开，指定路径时下方出现路径输入。 */
.present-card-scope-edit {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.present-card-scope-modes {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}
.present-card-scope-mode {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.6875rem;
  color: var(--color-desk-ink);
}
/* 团队草案段：与文件段同一面板基调；团长单选占满一行，成员按清单逐行勾选。 */
.present-card-team {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.625rem;
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-panel);
}
.present-card-team-lead {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
}
.present-card-team-select {
  min-width: 0;
  flex: 1 1 auto;
  min-height: 1.75rem;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-surface);
  color: var(--color-desk-ink);
  font: inherit;
  font-size: 0.75rem;
  line-height: 1.4;
}
.present-card-team-members {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}
.present-card-team-list {
  min-width: 0;
  flex: 1 1 auto;
  margin: 0;
  padding: 0;
  list-style: none;
}
.present-card-team-row + .present-card-team-row {
  margin-top: 0.125rem;
}
.present-card-team-check {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  min-height: 1.375rem;
  font-size: 0.75rem;
  color: var(--color-desk-ink);
}
.present-card-team-name {
  overflow-wrap: anywhere;
}
.present-card-team-tag,
.present-card-team-unavailable {
  flex: none;
  font-size: 0.6875rem;
  color: var(--color-desk-muted);
}
.present-card-team-unavailable {
  color: var(--color-desk-danger);
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
/* 记忆候选段：与文件段同一面板基调；条目内是可编辑表单，勾选与编辑在写库后锁定。 */
.present-card-candidates {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.625rem;
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-panel);
}
.present-card-candidates-title {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.4;
  color: var(--color-desk-ink);
}
.present-card-candidate + .present-card-candidate {
  padding-top: 0.5rem;
  border-top: 1px solid var(--color-desk-line);
}
.present-card-candidate {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.present-card-candidate.is-incomplete {
  border-left: 2px solid var(--color-desk-danger);
  padding-left: 0.5rem;
}
.present-card-candidate-head {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}
.present-card-candidate-check {
  flex: none;
  margin: 0;
  accent-color: var(--color-desk-accent);
}
.present-card-candidate-type,
.present-card-candidate-status-select {
  flex: none;
  min-height: 1.5rem;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-surface);
  color: var(--color-desk-ink);
  font: inherit;
  font-size: 0.6875rem;
  line-height: 1.4;
}
.present-card-candidate-rulekey {
  flex: 1;
  min-width: 0;
  min-height: 1.5rem;
  padding: 0.125rem 0.375rem;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-surface);
  color: var(--color-desk-ink);
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  line-height: 1.4;
}
.present-card-candidate-topic {
  width: 100%;
  box-sizing: border-box;
  min-height: 1.5rem;
  padding: 0.125rem 0.375rem;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-surface);
  color: var(--color-desk-ink);
  font: inherit;
  font-size: 0.75rem;
  line-height: 1.5;
}
.present-card-candidate-content {
  width: 100%;
  box-sizing: border-box;
  padding: 0.25rem 0.375rem;
  border: 1px solid var(--color-desk-line);
  border-radius: var(--radius-desk-sm);
  background: var(--color-desk-surface);
  color: var(--color-desk-ink);
  font: inherit;
  font-size: 0.75rem;
  line-height: 1.6;
  resize: vertical;
  min-height: 3.5rem;
}
.present-card-candidate-topic:focus-visible,
.present-card-candidate-content:focus-visible,
.present-card-candidate-rulekey:focus-visible,
.present-card-candidate-type:focus-visible,
.present-card-candidate-status-select:focus-visible,
.present-card-candidate-check:focus-visible {
  outline: 2px solid var(--color-desk-accent);
  outline-offset: 1px;
}
.present-card-candidate-topic:disabled,
.present-card-candidate-content:disabled,
.present-card-candidate-rulekey:disabled,
.present-card-candidate-type:disabled,
.present-card-candidate-status-select:disabled,
.present-card-candidate-check:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.present-card-candidate-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.6875rem;
  color: var(--color-desk-muted);
}
.present-card-candidate-status-label {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}
.present-card-candidate-hint {
  font-size: 0.6875rem;
  color: var(--color-desk-muted);
  overflow-wrap: anywhere;
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
