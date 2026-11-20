<!--
  专家编辑对话框：新建或修改一份自定义专家（身份、能力范围、正文）。

  表单由本对话框持有，保存交给专家 store：成功后由 store 关闭并重读清单，失败时保留已填内容并就地展示原因。
  能力范围分技能、MCP 与工具三个维度，各有「继承默认」与「仅用选中」两种口径；继承时只记录相对默认基线的增减，
  不用每次从零勾选，也随默认基线统一调整。三个维度都按 3 列勾选格呈现，格内右槽标出状态（基线默认／已排除／必需等），
  title 里同时带标识与来源；引用数量不设上限。
  工具维度里技能门禁、待办清单与记忆工具属受保护项：勾选格锁定，保存时也不会被排除。
  写入范围是路径边界而不是能力：它不决定有没有写工具，只决定 write 与 edit 能写到哪里；三态分别对应不限制、只读与指定目录，
  留空不能同时表示两种含义。bash 的重定向不经过工具参数，界面如实说明这一点。
  技能候选来自随包、产品目录与共享目录，MCP 只列全局配置；
  项目自带技能属于工作区，不受专家范围限制，因此在候选列表外单独说明。
  定义里引用但当前不可用的项仍列出来，避免一次编辑把它们静默丢掉。
  新建时标识由主进程分配，界面不提供标识输入——标识即目录名且创建后不可改，让用户填只会填错。
-->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue'
import {
  MAX_EXPERT_DISPLAY_NAME_LENGTH, MAX_EXPERT_SUMMARY_LENGTH,
  MAX_EXPERT_WRITE_SCOPE_ITEMS, normalizeExpertWriteScopeEntry
} from '../../../../shared/experts-api'
import type { ExpertEditableDefinition, ExpertSaveRequest } from '../../../../shared/experts-api'
import { useExpertStore } from '../stores/expert'
import { baseIds, restoreSelection, selectionState, toSelectionFields } from '../capability-selection'
import { skillSourceLabel } from '../skill-source-label'
import AppButton from '../../ui/AppButton.vue'
import ExpertCapabilityPicker from './ExpertCapabilityPicker.vue'

const props = defineProps<{
  /** 弹层由父级常驻挂载，`open` 控制进入/退出与焦点、快捷键生命周期。 */
  readonly open: boolean
  /** 编辑目标；`null` 表示新建。 */
  readonly expertId: string | null
}>()

const emit = defineEmits<{
  cancel: []
}>()

/** 能力候选行：来源用于标注，`unavailable` 表示定义引用了但当前环境里没有，`state` 是行尾的差异标记，`locked` 是不可取消。 */
interface CapabilityRow {
  readonly id: string
  readonly label: string
  readonly unavailable: boolean
  readonly state: string
  readonly locked?: boolean
}


const store = useExpertStore()
const panel = ref<HTMLElement | null>(null)
const titleId = useId()
/** 写入范围三态的单选组名，同一组只能选一项。 */
const writeScopeGroupId = useId()
/** 打开前的焦点元素；关闭后把焦点还给它。 */
let opener: HTMLElement | null = null

const displayName = ref('')
const summary = ref('')
const body = ref('')
/** 写入范围三态：不限制、只读、指定路径。三者靠单选区分，不靠“留空”推断。 */
const writeScopeMode = ref<'unrestricted' | 'readonly' | 'paths'>('unrestricted')
/** 指定路径时的文本输入；逗号或换行分隔，保存时按路径规则归一化。 */
const writeScopePaths = ref('')
/** 技能、MCP 与工具的范围口径；默认继承基线，只记录相对基线的增减。 */
const skillsMode = ref<'inherit' | 'only'>('inherit')
const mcpMode = ref<'inherit' | 'only'>('inherit')
const toolsMode = ref<'inherit' | 'only'>('inherit')
const selectedSkills = ref<readonly string[]>([])
const selectedMcp = ref<readonly string[]>([])
const selectedTools = ref<readonly string[]>([])
/** 继承模式下保留的旧提示列表（`skills:` 字段），保存时原样回传，不因一次编辑被洗掉。 */
const hintSkillIds = ref<readonly string[]>([])
/** 定义里出现过的技能、服务器与工具：用于把当前不可用的引用也列出来。 */
const referencedSkillIds = ref<readonly string[]>([])
const referencedMcpNames = ref<readonly string[]>([])
const referencedToolNames = ref<readonly string[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)
const saveError = ref<string | null>(null)

const editing = computed(() => props.expertId !== null)
const title = computed(() => (editing.value ? '编辑专家' : '新建专家'))
const saving = computed(() => store.saving)
const capabilityError = computed(() => store.capabilitiesError)
const capabilityReady = computed(() => store.capabilities !== null)
const allSkillIds = computed(() => (store.capabilities?.skills ?? []).map(item => item.id))
const allMcpNames = computed(() => (store.capabilities?.mcpServers ?? []).map(item => item.name))
const allToolNames = computed(() => (store.capabilities?.tools ?? []).map(item => item.name))
/** 受保护工具：候选里标「必需」，勾选保持且不能取消，与主进程保存校验同一套标准。 */
const requiredToolNames = computed(() => (store.capabilities?.tools ?? [])
  .filter(item => item.required).map(item => item.name))
/** 默认基线的三个维度；`null` 表示不限制，等于全部候选。 */
const baselineSkills = computed(() => store.capabilities?.defaults.skills ?? null)
const baselineMcp = computed(() => store.capabilities?.defaults.mcpServers ?? null)
const baselineTools = computed(() => store.capabilities?.defaults.tools ?? null)

const skillRows = computed<CapabilityRow[]>(() => {
  const rows: Omit<CapabilityRow, 'state'>[] = (store.capabilities?.skills ?? []).map(item => ({
    id: item.id,
    label: item.source === 'shared' ? '' : skillSourceLabel(item.source),
    unavailable: false
  }))
  const known = new Set(rows.map(row => row.id))
  for (const id of referencedSkillIds.value) {
    if (known.has(id)) continue
    known.add(id)
    rows.push({ id, label: '当前不可用', unavailable: true })
  }
  return rows.map(row => ({
    ...row,
    state: selectionState({
      unavailable: row.unavailable,
      mode: skillsMode.value,
      checked: selectedSkills.value.includes(row.id),
      inBaseline: baselineOf('skills').includes(row.id)
    })
  }))
})

const mcpRows = computed<CapabilityRow[]>(() => {
  const rows: Omit<CapabilityRow, 'state'>[] = (store.capabilities?.mcpServers ?? []).map(item => ({
    id: item.name, label: item.enabled ? '' : '配置里已停用', unavailable: false
  }))
  const known = new Set(rows.map(row => row.id))
  for (const name of referencedMcpNames.value) {
    if (known.has(name)) continue
    known.add(name)
    rows.push({ id: name, label: '当前不可用', unavailable: true })
  }
  return rows.map(row => ({
    ...row,
    state: selectionState({
      unavailable: row.unavailable,
      mode: mcpMode.value,
      checked: selectedMcp.value.includes(row.id),
      inBaseline: baselineOf('mcp').includes(row.id)
    })
  }))
})

/** 工具行：受保护候选带 `locked`，其余与另两个维度同一套状态文案。 */
const toolRows = computed<CapabilityRow[]>(() => {
  const rows: Omit<CapabilityRow, 'state'>[] = (store.capabilities?.tools ?? []).map(item => ({
    id: item.name, label: item.summary, unavailable: false, locked: item.required
  }))
  const known = new Set(rows.map(row => row.id))
  for (const name of referencedToolNames.value) {
    if (known.has(name)) continue
    known.add(name)
    rows.push({ id: name, label: '当前不可用', unavailable: true })
  }
  return rows.map(row => ({
    ...row,
    state: selectionState({
      unavailable: row.unavailable,
      mode: toolsMode.value,
      checked: selectedTools.value.includes(row.id),
      inBaseline: baselineOf('tools').includes(row.id),
      required: row.locked === true
    })
  }))
})

const canSave = computed(() => !saving.value
  && displayName.value.trim() !== ''
  && summary.value.trim() !== ''
  && body.value.trim() !== ''
  // 指定路径却一项都不合法时不保存：写入范围会变成只读或空，与界面显示不一致。
  && (writeScopeMode.value !== 'paths' || parsedWriteScope.value.valid.length > 0)
  // 有超限项时也不保存：超出上限的项没有落点，带上去只会在主进程被整批拒掉。
  && parsedWriteScope.value.overflow.length === 0
  // 技能白名单为空等于禁用全部技能，主进程也会拒；在按钮上先拦住并给理由。
  && !(skillsMode.value === 'only' && selectedSkills.value.length === 0))

/**
 * 写入范围输入拆成合法项与非法项：非法项就地报出，保存时不带走；
 * 超出条数上限的合法项计入 overflow 单独提示并阻止保存，不静默截断成半份范围。
 */
const parsedWriteScope = computed(() => {
  const items = writeScopePaths.value.split(/[,\n]/).map(item => item.trim()).filter(item => item !== '')
  const valid: string[] = []
  const invalid: string[] = []
  const overflow: string[] = []
  for (const item of items) {
    const normalized = normalizeExpertWriteScopeEntry(item)
    if (normalized === null) { invalid.push(item); continue }
    if (valid.includes(normalized)) continue
    if (valid.length >= MAX_EXPERT_WRITE_SCOPE_ITEMS) { overflow.push(normalized); continue }
    valid.push(normalized)
  }
  return { valid, invalid, overflow }
})

/** 基线展开后的集合：用于判断某一行是「基线默认」还是被手动改动过。 */
function baselineOf(dimension: 'skills' | 'mcp' | 'tools'): readonly string[] {
  if (dimension === 'tools') return baseIds(baselineTools.value, allToolNames.value)
  return dimension === 'skills'
    ? baseIds(baselineSkills.value, allSkillIds.value)
    : baseIds(baselineMcp.value, allMcpNames.value)
}

/** 勾满时只说结论，部分选中才给数量；三个维度同一口径。 */
function selectionCount(rows: readonly CapabilityRow[], selected: readonly string[]): string {
  const total = rows.length
  if (total === 0) return ''
  return selected.length === total ? `${total} 个全部可用` : `已选 ${selected.length} / ${total}`
}

/** 全选只管当前维度：把候选（含已引用但当前不可用的项）全部勾上。 */
function selectAllSkills(): void {
  selectedSkills.value = skillRows.value.map(row => row.id)
}

function selectAllMcp(): void {
  selectedMcp.value = mcpRows.value.map(row => row.id)
}

function selectAllTools(): void {
  selectedTools.value = toolRows.value.map(row => row.id)
}

/** 清空表单：能力勾选回到默认基线，不残留上一次编辑的痕迹。 */
function resetForm(): void {
  displayName.value = ''
  summary.value = ''
  body.value = ''
  skillsMode.value = 'inherit'
  mcpMode.value = 'inherit'
  toolsMode.value = 'inherit'
  writeScopeMode.value = 'unrestricted'
  writeScopePaths.value = ''
  hintSkillIds.value = []
  referencedSkillIds.value = []
  referencedMcpNames.value = []
  referencedToolNames.value = []
  selectedSkills.value = [...baseIds(baselineSkills.value, allSkillIds.value)]
  selectedMcp.value = [...baseIds(baselineMcp.value, allMcpNames.value)]
  selectedTools.value = [...new Set([
    ...baseIds(baselineTools.value, allToolNames.value), ...requiredToolNames.value
  ])]
  loadError.value = null
  saveError.value = null
}

/** 按定义与基线还原勾选：`only` 直接取列表，继承则基线上加加减减。 */
function applyDefinition(definition: ExpertEditableDefinition | null): void {
  skillsMode.value = definition?.skillsMode ?? 'inherit'
  mcpMode.value = definition?.mcpMode ?? 'inherit'
  toolsMode.value = definition?.toolsMode ?? 'inherit'
  // 三态回填：null 不限制、空数组只读、其余按路径展示。
  const scope = definition?.writeScope ?? null
  writeScopeMode.value = scope === null ? 'unrestricted' : scope.length === 0 ? 'readonly' : 'paths'
  writeScopePaths.value = scope === null ? '' : scope.join('、')
  hintSkillIds.value = definition?.skillIds ?? []
  referencedSkillIds.value = definition === null
    ? []
    : [...definition.skillIds, ...definition.skillAddIds, ...definition.skillRemoveIds]
  referencedMcpNames.value = definition === null
    ? []
    : [...definition.mcpServerIds, ...definition.mcpAddIds, ...definition.mcpRemoveIds]
  referencedToolNames.value = definition === null
    ? []
    : [...definition.toolIds, ...definition.toolAddIds, ...definition.toolRemoveIds]
  selectedSkills.value = restoreSelection({
    mode: skillsMode.value,
    onlyIds: definition?.skillIds ?? [],
    addIds: definition?.skillAddIds ?? [],
    removeIds: definition?.skillRemoveIds ?? [],
    baseline: baselineSkills.value,
    all: allSkillIds.value
  })
  selectedMcp.value = restoreSelection({
    mode: mcpMode.value,
    onlyIds: definition?.mcpServerIds ?? [],
    addIds: definition?.mcpAddIds ?? [],
    removeIds: definition?.mcpRemoveIds ?? [],
    baseline: baselineMcp.value,
    all: allMcpNames.value
  })
  // 受保护工具即使定义里没写也要勾上：保存时它们不被排除，界面不补回就会出现「没勾却生效」。
  selectedTools.value = [...new Set([
    ...restoreSelection({
      mode: toolsMode.value,
      onlyIds: definition?.toolIds ?? [],
      addIds: definition?.toolAddIds ?? [],
      removeIds: definition?.toolRemoveIds ?? [],
      baseline: baselineTools.value,
      all: allToolNames.value
    }),
    ...requiredToolNames.value
  ])]
}

/**
 * 打开时重置表单并按编辑目标回填；`expertId` 为 null 时只把能力勾选初始化到默认基线。
 * 能力候选没读到就先读一次：勾选状态依赖基线，拿半份默认值会让保存写出与显示不一致的范围。
 */
async function loadForm(expertId: string | null): Promise<void> {
  loading.value = true
  loadError.value = null
  if (store.capabilities === null) await store.loadCapabilities()
  resetForm()
  if (expertId === null) {
    loading.value = false
    return
  }
  const definition = await store.readDefinition(expertId)
  if (definition === null) {
    loading.value = false
    loadError.value = '没能读到这份定义，可以关闭后重试，或直接改定义文件。'
    return
  }
  displayName.value = definition.displayName
  summary.value = definition.summary
  body.value = definition.body
  applyDefinition(definition)
  loading.value = false
}

/** 打开时决定是否要回填；关闭时解绑快捷键并把焦点还回去。 */
watch(
  () => props.open,
  (open) => {
    if (open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      window.addEventListener('keydown', onKeydown)
      void nextTick(() => panel.value?.focus())
      void loadForm(props.expertId)
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

/** 组装保存请求：`only` 写入白名单，继承写入相对基线的加与减；提示列表原样带回。 */
function buildRequest(): ExpertSaveRequest {
  const skills = toSelectionFields({
    mode: skillsMode.value,
    selected: selectedSkills.value,
    baseline: baselineSkills.value,
    all: allSkillIds.value,
    inheritOnlyIds: hintSkillIds.value
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
    expertId: props.expertId,
    displayName: displayName.value.trim(),
    summary: summary.value.trim(),
    body: body.value,
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
    writeScope: writeScopeMode.value === 'unrestricted'
      ? null
      : writeScopeMode.value === 'readonly'
        ? []
        : parsedWriteScope.value.valid
  }
}

async function submit(): Promise<void> {
  if (!canSave.value) return
  saveError.value = null
  const result = await store.save(buildRequest())
  if (!result.ok) saveError.value = result.error.message
}

/** 面板内可聚焦元素；Tab 只在弹窗内循环。 */
function focusableElements(): HTMLElement[] {
  const root = panel.value
  if (root === null) return []
  const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  return [...root.querySelectorAll<HTMLElement>(selector)]
    .filter((element) => element.offsetParent !== null)
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
</script>

<template>
  <Teleport to="body">
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
              <div>
                <h2 :id="titleId" class="dialog-title">{{ title }}</h2>
                <p class="dialog-subtitle">
                  名称、能力范围与正文可以改；标识创建后不可修改。
                </p>
              </div>
            </div>

            <div class="dialog-body">
              <p v-if="loading" role="status" class="text-xs text-desk-muted">正在读取定义…</p>
              <p v-else-if="loadError !== null" role="alert" class="status-notice status-notice-error">
                {{ loadError }}
              </p>

              <div class="space-y-4">
                <label class="block space-y-1">
                  <span class="field-label">显示名称</span>
                  <input
                    v-model="displayName"
                    class="text-control"
                    type="text"
                    :maxlength="MAX_EXPERT_DISPLAY_NAME_LENGTH"
                    placeholder="例如：文档评审官"
                    :disabled="saving || loading"
                  >
                </label>

                <label class="block space-y-1">
                  <span class="field-label">一句话简介</span>
                  <input
                    v-model="summary"
                    class="text-control"
                    type="text"
                    :maxlength="MAX_EXPERT_SUMMARY_LENGTH"
                    placeholder="说明这个专家负责什么、不负责什么"
                    :disabled="saving || loading"
                  >
                </label>

                <div class="space-y-4 border-t border-desk-line pt-4">
                  <p v-if="capabilityError !== null" role="alert" class="text-xs text-desk-danger">
                    能力候选读取失败：{{ capabilityError }}
                  </p>
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
                    :disabled="saving || loading"
                    select-all-label="全选"
                    @update:mode="skillsMode = $event"
                    @update:selected="selectedSkills = $event"
                    @select-all="selectAllSkills"
                  />
                  <p class="hint-text">项目自带技能始终可用，不受此处限制。</p>
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
                    no-rows-text="全局 mcp.json 里还没有服务器；先到资源页添加，再回来勾选。"
                    :ready="capabilityReady"
                    :disabled="saving || loading"
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
                    no-rows-text="随包清单里还没有工具声明；先重建资源再回来勾选。"
                    :ready="capabilityReady"
                    :disabled="saving || loading"
                    select-all-label="全选"
                    @update:mode="toolsMode = $event"
                    @update:selected="selectedTools = $event"
                    @select-all="selectAllTools"
                  />
                  <p class="hint-text">
                    工具范围只影响本专家会话里可调用的工具；技能门禁、待办清单与记忆工具属必需项，不会被排除。
                  </p>
                </div>

                <fieldset class="space-y-2 border-t border-desk-line pt-4">
                  <legend class="field-label">写入范围</legend>
                  <p class="hint-text">
                    决定这个专家的会话里 write 与 edit 能写到哪里；bash 的重定向不经过这道检查。
                  </p>
                  <label class="flex items-start gap-2 text-xs">
                    <input
                      v-model="writeScopeMode"
                      type="radio"
                      :name="writeScopeGroupId"
                      value="unrestricted"
                      :disabled="saving || loading"
                    >
                    <span>
                      不限制
                      <span class="block text-2xs text-desk-muted">沿用工具范围的结果，可写项目内任意文件。</span>
                    </span>
                  </label>
                  <label class="flex items-start gap-2 text-xs">
                    <input
                      v-model="writeScopeMode"
                      type="radio"
                      :name="writeScopeGroupId"
                      value="readonly"
                      :disabled="saving || loading"
                    >
                    <span>
                      只读
                      <span class="block text-2xs text-desk-muted">write 与 edit 一律被拒，适合审查与调研专家。</span>
                    </span>
                  </label>
                  <label class="flex items-start gap-2 text-xs">
                    <input
                      v-model="writeScopeMode"
                      type="radio"
                      :name="writeScopeGroupId"
                      value="paths"
                      :disabled="saving || loading"
                    >
                    <span>
                      指定路径
                      <span class="block text-2xs text-desk-muted">只能写列出的目录或文件，越界写入被拒。</span>
                    </span>
                  </label>
                  <label v-if="writeScopeMode === 'paths'" class="block space-y-1">
                    <span class="field-label">允许写入的目录或文件</span>
                    <input
                      v-model="writeScopePaths"
                      class="text-control font-mono"
                      type="text"
                      placeholder="docs/、README.md"
                      :disabled="saving || loading"
                    >
                    <span class="hint-text">相对项目根；目录以 / 结尾，多个用逗号分隔，最多 {{ MAX_EXPERT_WRITE_SCOPE_ITEMS }} 项。</span>
                    <span v-if="parsedWriteScope.invalid.length > 0" role="alert" class="text-xs text-desk-danger">
                      这些路径写法不合法：{{ parsedWriteScope.invalid.join('、') }}
                    </span>
                    <span v-if="parsedWriteScope.overflow.length > 0" role="alert" class="text-xs text-desk-danger">
                      写入范围最多 {{ MAX_EXPERT_WRITE_SCOPE_ITEMS }} 项，超出未计入：{{ parsedWriteScope.overflow.join('、') }}
                    </span>
                  </label>
                </fieldset>

                <label class="block space-y-1">
                  <span class="field-label">正文</span>
                  <textarea
                    v-model="body"
                    class="text-control font-mono"
                    rows="12"
                    placeholder="身份、方法论、工作流程与输出规范；这部分会整段进入系统提示"
                    :disabled="saving || loading"
                  ></textarea>
                </label>
              </div>
            </div>

            <div class="dialog-footer">
              <p v-if="saveError !== null" role="alert" class="mr-auto text-xs text-desk-danger">
                {{ saveError }}
              </p>
              <p v-else-if="!canSave && !loading" class="mr-auto hint-text">
                名称、简介与正文不能为空；仅用选中时技能至少一个。
              </p>
              <AppButton :disabled="saving" @click="emit('cancel')">取消</AppButton>
              <AppButton variant="primary" :disabled="!canSave" @click="submit">
                {{ saving ? '保存中…' : '保存' }}
              </AppButton>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
