<!--
  专家编辑对话框：新建或修改一份自定义专家（身份、能力范围、正文）。

  表单由本对话框持有，保存交给专家 store：成功后由 store 关闭并重读清单，失败时保留已填内容并就地展示原因。
  能力范围分技能与 MCP 两个维度，各有「继承默认」与「仅用选中」两种口径；继承时只记录相对默认基线的增减，
  不用每次从零勾选，也随默认基线统一调整。技能候选来自随包与共享目录，MCP 只列全局配置；
  定义里引用但当前不可用的项仍列出来，避免一次编辑把它们静默丢掉。
  新建时标识由主进程分配，界面不提供标识输入——标识即目录名且创建后不可改，让用户填只会填错。
-->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue'
import { MAX_EXPERT_DISPLAY_NAME_LENGTH, MAX_EXPERT_MCP_REFS, MAX_EXPERT_SKILL_REFS, MAX_EXPERT_SUMMARY_LENGTH } from '../../../../shared/experts-api'
import type { ExpertEditableDefinition, ExpertSaveRequest } from '../../../../shared/experts-api'
import { useExpertStore } from '../stores/expert'
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

/** 能力候选行：来源用于标注，`unavailable` 表示定义引用了但当前环境里没有，`state` 是行尾的差异标记。 */
interface CapabilityRow {
  readonly id: string
  readonly label: string
  readonly unavailable: boolean
  readonly state: string
}


const store = useExpertStore()
const panel = ref<HTMLElement | null>(null)
const titleId = useId()
/** 打开前的焦点元素；关闭后把焦点还给它。 */
let opener: HTMLElement | null = null

const displayName = ref('')
const summary = ref('')
const body = ref('')
/** 技能与 MCP 的范围口径；默认继承基线，只记录相对基线的增减。 */
const skillsMode = ref<'inherit' | 'only'>('inherit')
const mcpMode = ref<'inherit' | 'only'>('inherit')
const selectedSkills = ref<readonly string[]>([])
const selectedMcp = ref<readonly string[]>([])
/** 继承模式下保留的旧提示列表（`skills:` 字段），保存时原样回传，不因一次编辑被洗掉。 */
const hintSkillIds = ref<readonly string[]>([])
/** 定义里出现过的技能与服务器：用于把当前不可用的引用也列出来。 */
const referencedSkillIds = ref<readonly string[]>([])
const referencedMcpNames = ref<readonly string[]>([])
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
/** 默认基线的两个维度；`null` 表示不限制，等于全部候选。 */
const baselineSkills = computed(() => store.capabilities?.defaults.skills ?? null)
const baselineMcp = computed(() => store.capabilities?.defaults.mcpServers ?? null)

const skillRows = computed<CapabilityRow[]>(() => {
  const rows: Omit<CapabilityRow, 'state'>[] = (store.capabilities?.skills ?? []).map(item => ({
    id: item.id, label: item.source === 'builtin' ? '随包' : '共享目录', unavailable: false
  }))
  const known = new Set(rows.map(row => row.id))
  for (const id of referencedSkillIds.value) {
    if (known.has(id)) continue
    known.add(id)
    rows.push({ id, label: '当前不可用', unavailable: true })
  }
  return rows.map(row => ({
    ...row,
    state: capabilityState({ row, dimension: 'skills', mode: skillsMode.value, selected: selectedSkills.value })
  }))
})

const mcpRows = computed<CapabilityRow[]>(() => {
  const rows: Omit<CapabilityRow, 'state'>[] = (store.capabilities?.mcpServers ?? []).map(item => ({
    id: item.name, label: item.enabled ? '全局配置' : '配置里已停用', unavailable: false
  }))
  const known = new Set(rows.map(row => row.id))
  for (const name of referencedMcpNames.value) {
    if (known.has(name)) continue
    known.add(name)
    rows.push({ id: name, label: '当前不可用', unavailable: true })
  }
  return rows.map(row => ({
    ...row,
    state: capabilityState({ row, dimension: 'mcp', mode: mcpMode.value, selected: selectedMcp.value })
  }))
})

const canSave = computed(() => !saving.value
  && displayName.value.trim() !== ''
  && summary.value.trim() !== ''
  && body.value.trim() !== ''
  // 技能白名单为空等于禁用全部技能，主进程也会拒；在按钮上先拦住并给理由。
  && !(skillsMode.value === 'only' && selectedSkills.value.length === 0))

/** 基线展开后的集合：用于判断某一行是「基线默认」还是被手动改动过。 */
function baselineOf(dimension: 'skills' | 'mcp'): readonly string[] {
  return dimension === 'skills'
    ? baseIds(baselineSkills.value, allSkillIds.value)
    : baseIds(baselineMcp.value, allMcpNames.value)
}

/**
 * 行尾的状态标记：仅用选中时勾选本身已经说明了状态，不再重复一遍；
 * 继承模式下要能看出哪些是基线默认、哪些是手动加减。
 */
function capabilityState(input: {
  readonly row: { readonly id: string; readonly unavailable: boolean }
  readonly dimension: 'skills' | 'mcp'
  readonly mode: 'inherit' | 'only'
  readonly selected: readonly string[]
}): string {
  if (input.row.unavailable) return '当前不可用'
  if (input.mode === 'only') return ''
  const checked = input.selected.includes(input.row.id)
  const inBaseline = baselineOf(input.dimension).includes(input.row.id)
  if (inBaseline) return checked ? '基线默认' : '已排除'
  return checked ? '额外启用' : '未启用'
}

/** 基线展开：`null` 时用全部候选，与主进程的计算口径一致。 */
function baseIds(baseline: readonly string[] | null, all: readonly string[]): readonly string[] {
  return baseline ?? all
}

/** 清空表单：能力勾选回到默认基线，不残留上一次编辑的痕迹。 */
function resetForm(): void {
  displayName.value = ''
  summary.value = ''
  body.value = ''
  skillsMode.value = 'inherit'
  mcpMode.value = 'inherit'
  hintSkillIds.value = []
  referencedSkillIds.value = []
  referencedMcpNames.value = []
  selectedSkills.value = [...baseIds(baselineSkills.value, allSkillIds.value)]
  selectedMcp.value = [...baseIds(baselineMcp.value, allMcpNames.value)]
  loadError.value = null
  saveError.value = null
}

/** 按定义与基线还原勾选：`only` 直接取列表，继承则基线上加加减减。 */
function applyDefinition(definition: ExpertEditableDefinition | null): void {
  skillsMode.value = definition?.skillsMode ?? 'inherit'
  mcpMode.value = definition?.mcpMode ?? 'inherit'
  hintSkillIds.value = definition?.skillIds ?? []
  referencedSkillIds.value = definition === null
    ? []
    : [...definition.skillIds, ...definition.skillAddIds, ...definition.skillRemoveIds]
  referencedMcpNames.value = definition === null
    ? []
    : [...definition.mcpServerIds, ...definition.mcpAddIds, ...definition.mcpRemoveIds]
  const skillBase = baseIds(baselineSkills.value, allSkillIds.value)
  const mcpBase = baseIds(baselineMcp.value, allMcpNames.value)
  selectedSkills.value = skillsMode.value === 'only'
    ? [...(definition?.skillIds ?? [])]
    : [...new Set([...skillBase, ...(definition?.skillAddIds ?? [])])]
      .filter(id => !(definition?.skillRemoveIds ?? []).includes(id))
  selectedMcp.value = mcpMode.value === 'only'
    ? [...(definition?.mcpServerIds ?? [])]
    : [...new Set([...mcpBase, ...(definition?.mcpAddIds ?? [])])]
      .filter(name => !(definition?.mcpRemoveIds ?? []).includes(name))
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
  const skillBase = baseIds(baselineSkills.value, allSkillIds.value)
  const mcpBase = baseIds(baselineMcp.value, allMcpNames.value)
  return {
    expertId: props.expertId,
    displayName: displayName.value.trim(),
    summary: summary.value.trim(),
    body: body.value,
    skillIds: skillsMode.value === 'only' ? [...selectedSkills.value] : [...hintSkillIds.value],
    skillsMode: skillsMode.value,
    skillAddIds: skillsMode.value === 'inherit'
      ? selectedSkills.value.filter(id => !skillBase.includes(id))
      : [],
    skillRemoveIds: skillsMode.value === 'inherit'
      ? skillBase.filter(id => !selectedSkills.value.includes(id))
      : [],
    mcpMode: mcpMode.value,
    mcpServerIds: mcpMode.value === 'only' ? [...selectedMcp.value] : [],
    mcpAddIds: mcpMode.value === 'inherit'
      ? selectedMcp.value.filter(name => !mcpBase.includes(name))
      : [],
    mcpRemoveIds: mcpMode.value === 'inherit'
      ? mcpBase.filter(name => !selectedMcp.value.includes(name))
      : []
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
                  专家正文在新建会话召唤后作为独立系统提示段注入；能力范围只收窄本会话的技能与 MCP 服务器，
                  不改工具与权限。标识创建后不可改，显示名称、能力范围与正文可以随时改。
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
                    :max-refs="MAX_EXPERT_SKILL_REFS"
                    inherit-label="继承默认"
                    only-label="仅用选中"
                    inherit-hint="勾选记录相对默认基线的增减，基线调整时跟着变。"
                    only-hint="只装配勾选的技能，不随默认基线变化；至少保留一个。"
                    search-placeholder="按名称筛选技能"
                    empty-text="没有匹配的技能。"
                    no-rows-text="随包与共享目录里都没有技能。"
                    :ready="capabilityReady"
                    :disabled="saving || loading"
                    list-in-inherit
                    @update:mode="skillsMode = $event"
                    @update:selected="selectedSkills = $event"
                  />
                  <ExpertCapabilityPicker
                    title="MCP 服务器范围"
                    group-label="MCP 服务器范围"
                    :mode="mcpMode"
                    :selected="selectedMcp"
                    :rows="mcpRows"
                    :max-refs="MAX_EXPERT_MCP_REFS"
                    inherit-label="继承默认"
                    only-label="仅用选中"
                    inherit-hint="勾选记录相对默认基线的增减，基线调整时跟着变。"
                    only-hint="只连接勾选的服务器，不随默认基线变化。"
                    search-placeholder="按名称筛选服务器"
                    empty-text="没有匹配的服务器。"
                    no-rows-text="全局 mcp.json 里还没有服务器；先到资源页添加，再回来勾选。"
                    :ready="capabilityReady"
                    :disabled="saving || loading"
                    list-in-inherit
                    @update:mode="mcpMode = $event"
                    @update:selected="selectedMcp = $event"
                  />
                </div>

                <label class="block space-y-1">
                  <span class="field-label">正文</span>
                  <textarea
                    v-model="body"
                    class="text-control font-mono"
                    rows="12"
                    placeholder="身份、方法论、工作流程与输出规范；这部分会整段进入系统提示"
                    :disabled="saving || loading"
                  ></textarea>
                  <span class="hint-text">正文超过注入上限时只在召唤时截断，定义文件保留全文。</span>
                </label>
              </div>
            </div>

            <div class="dialog-footer">
              <p v-if="saveError !== null" role="alert" class="mr-auto text-xs text-desk-danger">
                {{ saveError }}
              </p>
              <p v-else-if="!canSave && !loading" class="mr-auto hint-text">
                显示名称、简介与正文都不能为空；技能选「仅用选中」时至少保留一个。
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
