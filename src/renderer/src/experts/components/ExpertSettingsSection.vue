<!--
  设置页「专家与专家团」分节：把专家与专家团放在同一页管理。

  专家是一段角色说明加一份能力范围，专家团是「团长 + 成员」的组合，成员本身就是专家；
  两者一起管理，才能在同一个列表里看清角色资产与它们之间的引用关系，不必在两页之间来回切换。
  列表按类型分段筛选（全部 / 专家 / 专家团），筛选只裁剪列表，不改变页面骨架：
  分段、创建动作、默认能力与加载诊断始终在位，切换时不会像换了一个页面。
  行模板只有一份：专家与专家团的差异全部收敛到行内徽标与动作集合，来源（内置 / 自定义）不再靠分组标题表达。
  顶部「角色资产」卡片承载列表与创建入口，创建动作跟随当前筛选，只出现该类型的主创建动作。
  默认能力与加载诊断是页面级配置，收在页尾的折叠分组里：前者只作用于专家，后者只在有条目时出现。
  团队编辑在对话框里从专家清单勾选团长与成员，不接受手写标识；正文与简介的作用范围在对话框里标注。
  删除专家会连带影响引用它的团队，因此确认框列出这些团队并说明后果。
  新建与编辑各走自己的对话框（ExpertEditorDialog / TeamEditorDialog）。
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import type { SessionExpertIssue, SessionExpertView } from '../../../../shared/session-api'
import type { TeamIssueView, TeamView } from '../../../../shared/teams-api'
import { useExpertStore } from '../stores/expert'
import { useTeamStore } from '../stores/team'
import AppButton from '../../ui/AppButton.vue'
import ConfirmDialog from '../../ui/ConfirmDialog.vue'
import ExpertCapabilityDefaultsCard from './ExpertCapabilityDefaultsCard.vue'
import ExpertEditorDialog from './ExpertEditorDialog.vue'
import TeamEditorDialog from './TeamEditorDialog.vue'

const store = useExpertStore()
const teamStore = useTeamStore()
const {
  experts, issues: expertIssues, busyId, loadError, actionError, notice, loaded, editorOpen, editingId,
  capabilities, capabilitiesError, defaultsSaving
} = storeToRefs(store)
const {
  teams, issues: teamIssues, busyId: teamBusyId, loadError: teamLoadError,
  actionError: teamActionError, notice: teamNotice, loaded: teamLoaded,
  editorOpen: teamEditorOpen, editingId: teamEditingId
} = storeToRefs(teamStore)

/** 类型筛选：只裁剪列表，不参与页面骨架与创建动作之外的任何显隐判断。 */
type AssetFilter = 'all' | 'expert' | 'team'
const filter = ref<AssetFilter>('all')
const filterOptions: readonly { readonly value: AssetFilter; readonly label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'expert', label: '专家' },
  { value: 'team', label: '专家团' }
]

const pendingDelete = ref<SessionExpertView | null>(null)
const pendingDeleteTeam = ref<TeamView | null>(null)

const deleteOpen = computed(() => pendingDelete.value !== null)
const deleteTeamOpen = computed(() => pendingDeleteTeam.value !== null)

const showExperts = computed(() => filter.value !== 'team')
const showTeams = computed(() => filter.value !== 'expert')

/** 创建入口跟随筛选：只在「全部」时并列两个同级按钮，其余只留当前类型的主创建动作。 */
const createTarget = computed<'expert' | 'team' | 'both'>(() => {
  if (filter.value === 'team') return 'team'
  if (filter.value === 'expert') return 'expert'
  return 'both'
})

/** 行内状态徽标：warning 只换文字色，形状与中性芯片一致。 */
interface AssetChip {
  readonly text: string
  readonly tone: 'plain' | 'warning'
}

/** 列表行：专家与专家团共用一份形状，差异都收敛到徽标与动作集合里。 */
interface AssetRow {
  readonly key: string
  readonly kind: 'expert' | 'team'
  readonly id: string
  readonly name: string
  readonly summary: string
  readonly source: 'builtin' | 'user'
  readonly derivedFrom: string | null
  readonly chips: readonly AssetChip[]
  /** 需要警示的第二行：不可用技能引用与正文截断。 */
  readonly warning: string | null
}

/** 列表分组：只在两类都有内容时才显示分组标题，单一筛选下不重复类型名。 */
interface AssetGroup {
  readonly key: 'expert' | 'team'
  readonly label: string
  readonly rows: readonly AssetRow[]
}

const builtinExperts = computed(() => showExperts.value
  ? experts.value.filter(item => item.source === 'builtin')
  : [])
const userExperts = computed(() => showExperts.value
  ? experts.value.filter(item => item.source === 'user')
  : [])
const builtinTeams = computed(() => showTeams.value
  ? teams.value.filter(item => item.source === 'builtin')
  : [])
const userTeams = computed(() => showTeams.value
  ? teams.value.filter(item => item.source === 'user')
  : [])

const ISSUE_LABELS = {
  'definition-invalid': '定义无效',
  'id-conflict': '标识冲突',
  'skill-reference-missing': '引用的技能不存在',
  'skill-reference-sub-agent': '引用了子代理专用技能',
  'mcp-reference-missing': '引用的 MCP 服务器不存在',
  'write-scope-invalid': '写入范围里有写法不合法的项'
} as const satisfies Record<SessionExpertIssue['kind'], string>

const TEAM_ISSUE_LABELS = {
  'definition-invalid': '定义无效',
  'id-conflict': '标识冲突',
  'lead-reference-missing': '引用的团长不存在',
  'member-reference-missing': '引用的成员不存在',
  'no-usable-member': '没有可用成员',
  'lead-in-members': '团长同时写进了成员，已按团长处理'
} as const satisfies Record<TeamIssueView['kind'], string>

function expertNameOf(expertId: string): string {
  return experts.value.find(item => item.id === expertId)?.displayName ?? expertId
}

/** 名单只取前三个，再多用「等 N 个」收住：列表行不是清单页。 */
function nameList(ids: readonly string[]): string {
  return ids.length <= 3 ? ids.join('、') : `${ids.slice(0, 3).join('、')} 等 ${ids.length} 个`
}

/** 成员显示名：以当前专家清单为准，引用失效时退回标识。 */
function memberSummary(team: TeamView): string {
  if (team.memberExpertIds.length === 0) return '未配置成员'
  return nameList(team.memberExpertIds.map(expertNameOf))
}

/** 继承模式相对基线的加减：没有改动时不写括号，避免每行都带一个空括注。 */
function delta(add: readonly string[], remove: readonly string[]): string {
  if (add.length === 0 && remove.length === 0) return ''
  const parts: string[] = []
  if (add.length > 0) parts.push(`+${add.length}`)
  if (remove.length > 0) parts.push(`−${remove.length}`)
  return `（${parts.join(' ')}）`
}

/** 能力摘要：只描述范围口径与数量，不把整个名单塞进行内徽标。 */
function capabilitySummary(expert: SessionExpertView): string {
  const skills = expert.skillsMode === 'only'
    ? (expert.skillIds.length === 0
      ? '技能 0 个（仅用选中）'
      : `技能 ${expert.skillIds.length} 个（仅用选中：${nameList(expert.skillIds)}）`)
    // 继承模式下的 `skills` 只作提示，不参与装配，所以标出来避免被当成实际范围。
    : `技能继承默认${delta(expert.skillAddIds, expert.skillRemoveIds)}${
      expert.skillIds.length > 0 ? `；声明 ${nameList(expert.skillIds)} 仅提示` : ''}`
  const mcp = expert.mcpMode === 'only'
    ? `MCP ${expert.mcpServerIds.length} 个（仅用选中）`
    : `MCP 继承默认${delta(expert.mcpAddIds, expert.mcpRemoveIds)}`
  // 工具维度只在偏离默认时提一句：大多数专家不动工具，行内徽标不应被它撑长。
  const tools = expert.toolsMode === 'only'
    ? `工具 ${expert.toolIds.length} 个（仅用选中）`
    : expert.toolAddIds.length === 0 && expert.toolRemoveIds.length === 0
      ? null
      : `工具继承默认${delta(expert.toolAddIds, expert.toolRemoveIds)}`
  return [skills, mcp, tools].filter((part): part is string => part !== null).join(' · ')
}

/** 写入范围摘要：不限制、只读与白名单三种形态各一句短语，名单同样只取前三个。 */
function writeScopeSummary(expert: SessionExpertView): string {
  const scope = expert.writeScope
  if (scope === null) return '写入 不限制'
  if (scope.length === 0) return '写入 只读'
  return `写入 ${nameList(scope)}`
}

/** 专家的警示行：技能引用失效与正文截断都只影响召唤后的效果，所以并成一行。 */
function expertWarning(expert: SessionExpertView): string | null {
  const parts: string[] = []
  if (expert.unavailableSkillIds.length > 0) parts.push(`不可用：${expert.unavailableSkillIds.join('、')}`)
  if (expert.truncated) parts.push('正文过长，召唤时会被截断')
  return parts.length === 0 ? null : parts.join(' · ')
}

function expertRow(expert: SessionExpertView): AssetRow {
  return {
    key: `expert-${expert.id}`,
    kind: 'expert',
    id: expert.id,
    name: expert.displayName,
    summary: expert.summary,
    source: expert.source,
    derivedFrom: expert.derivedFrom,
    chips: [
      { text: capabilitySummary(expert), tone: 'plain' },
      { text: writeScopeSummary(expert), tone: 'plain' }
    ],
    warning: expertWarning(expert)
  }
}

function teamRow(team: TeamView): AssetRow {
  return {
    key: `team-${team.id}`,
    kind: 'team',
    id: team.id,
    name: team.displayName,
    summary: team.summary,
    source: team.source,
    derivedFrom: null,
    chips: [
      { text: team.ready ? '可开团' : '不可开团', tone: team.ready ? 'plain' : 'warning' },
      { text: `团长 ${expertNameOf(team.leadExpertId)}`, tone: 'plain' },
      { text: `成员 ${memberSummary(team)}`, tone: 'plain' }
    ],
    warning: null
  }
}

/** 一份分组清单：专家在前、专家团在后，组内内置在前、自定义在后。 */
const assetGroups = computed<readonly AssetGroup[]>(() => {
  const groups: AssetGroup[] = []
  const expertList = [...builtinExperts.value, ...userExperts.value]
  if (expertList.length > 0) {
    groups.push({ key: 'expert', label: '专家', rows: expertList.map(expertRow) })
  }
  const teamList = [...builtinTeams.value, ...userTeams.value]
  if (teamList.length > 0) {
    groups.push({ key: 'team', label: '专家团', rows: teamList.map(teamRow) })
  }
  return groups
})

const visibleCount = computed(() => assetGroups.value.reduce((total, group) => total + group.rows.length, 0))
const visibleLoaded = computed(() => loaded.value && teamLoaded.value)

/** 空态：给出当前筛选下能立刻执行的下一步，而不是只留一句灰字。 */
const emptyState = computed<{
  readonly title: string
  readonly hint: string
  readonly actionLabel: string
  readonly target: 'expert' | 'team'
}>(() => {
  if (filter.value === 'team') {
    return {
      title: '还没有专家团',
      hint: '团队由团长与成员组成，成员从专家清单里选；可用专家不足两位时先新建专家。',
      actionLabel: '新建专家团',
      target: 'team'
    }
  }
  if (filter.value === 'expert') {
    return {
      title: '还没有专家',
      hint: '专家保存为一份 expert.md，新建会话时可选它注入角色与能力范围。',
      actionLabel: '新建专家',
      target: 'expert'
    }
  }
  return {
    title: '还没有专家或专家团',
    hint: '先新建一位专家，再把它组成团队。',
    actionLabel: '新建专家',
    target: 'expert'
  }
})

/** 提示区按来源合并：同一来源的错误优先于提示，最多两条，不并列堆叠六个通知。 */
interface StatusLine {
  readonly key: string
  readonly source: string
  readonly text: string
  readonly tone: 'error' | 'status'
}

const statusLines = computed<readonly StatusLine[]>(() => {
  const lines: StatusLine[] = []
  const expertErrors = [loadError.value, actionError.value].filter((text): text is string => text !== null)
  if (expertErrors.length > 0) {
    lines.push({ key: 'expert-error', source: '专家', text: expertErrors.join('；'), tone: 'error' })
  } else if (notice.value !== null) {
    lines.push({ key: 'expert-notice', source: '专家', text: notice.value, tone: 'status' })
  }
  const teamErrors = [teamLoadError.value, teamActionError.value].filter((text): text is string => text !== null)
  if (teamErrors.length > 0) {
    lines.push({ key: 'team-error', source: '团队', text: teamErrors.join('；'), tone: 'error' })
  } else if (teamNotice.value !== null) {
    lines.push({ key: 'team-notice', source: '团队', text: teamNotice.value, tone: 'status' })
  }
  return lines
})

/** 诊断行：两类定义的诊断并成一段，用来源标签区分，不各占一块。 */
interface AssetIssueRow {
  readonly key: string
  readonly source: '专家' | '专家团'
  readonly label: string
  readonly text: string
  readonly path: string
}

/** 诊断不随筛选裁剪：用户要知道的是「一共有几条问题」，不是当前筛选下剩几条。 */
const issueRows = computed<readonly AssetIssueRow[]>(() => {
  const rows: AssetIssueRow[] = []
  expertIssues.value.forEach((issue, index) => {
    const target = issue.skillId ?? issue.serverName
    rows.push({
      key: `expert-${issue.kind}-${index}`,
      source: '专家',
      label: ISSUE_LABELS[issue.kind] ?? issue.kind,
      text: target === null ? (issue.expertId ?? '（无标识）') : `${issue.expertId ?? '（无标识）'}：${target}`,
      path: issue.path
    })
  })
  teamIssues.value.forEach((issue, index) => {
    rows.push({
      key: `team-${issue.kind}-${index}`,
      source: '专家团',
      label: TEAM_ISSUE_LABELS[issue.kind] ?? issue.kind,
      text: issue.expertId === null
        ? (issue.teamId ?? '（无标识）')
        : `${issue.teamId ?? '（无标识）'}：${issue.expertId}`,
      path: issue.path
    })
  })
  return rows
})

/** 引用某个专家的团队：删除前的确认框要用它说明连带影响。 */
const teamsReferencingPending = computed<readonly TeamView[]>(() => {
  const target = pendingDelete.value
  if (target === null) return []
  return teams.value.filter(team => team.leadExpertId === target.id
    || team.memberExpertIds.includes(target.id))
})

/** 行只带标识，删除前回查完整对象：确认框要显示名称与引用它的团队。 */
function openDeleteExpert(expertId: string): void {
  pendingDelete.value = experts.value.find(item => item.id === expertId) ?? null
}

function openDeleteTeam(teamId: string): void {
  pendingDeleteTeam.value = teams.value.find(item => item.id === teamId) ?? null
}

/** 重新读取两份清单：专家与团队互相引用，只刷一份会让引用关系显示成旧的。 */
async function refresh(): Promise<void> {
  store.clearNotice()
  teamStore.clearNotice()
  await Promise.all([store.load(), teamStore.load()])
}

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value
  pendingDelete.value = null
  if (target === null) return
  await store.remove(target.id)
  // 团队的可开团判定依赖专家清单，删完专家要重读团队，诊断与状态才算如实。
  await teamStore.load()
}

async function confirmDeleteTeam(): Promise<void> {
  const target = pendingDeleteTeam.value
  pendingDeleteTeam.value = null
  if (target === null) return
  await teamStore.remove(target.id)
}

onMounted(() => {
  void store.load()
  void teamStore.load()
})
</script>

<template>
  <div class="settings-section-stack">
    <header>
      <h1 class="text-xl font-semibold tracking-tight">专家与专家团</h1>
      <p class="mt-1 text-sm text-desk-muted">
        专家给会话注入一段角色说明与能力范围；专家团把若干专家组成「团长 + 成员」。
      </p>
    </header>

    <section class="settings-section" aria-labelledby="settings-experts-list-title" :aria-busy="!visibleLoaded">
      <div class="settings-section-heading">
        <h2 id="settings-experts-list-title" class="settings-section-title">角色资产</h2>
        <div class="flex items-center gap-2">
          <template v-if="createTarget === 'both'">
            <AppButton :disabled="!loaded" @click="store.openCreate()">新建专家</AppButton>
            <AppButton :disabled="!teamLoaded" @click="teamStore.openCreate()">新建专家团</AppButton>
          </template>
          <AppButton
            v-else-if="createTarget === 'expert'"
            variant="primary"
            :disabled="!loaded"
            @click="store.openCreate()"
          >
            新建专家
          </AppButton>
          <AppButton
            v-else
            variant="primary"
            :disabled="!teamLoaded"
            @click="teamStore.openCreate()"
          >
            新建专家团
          </AppButton>
        </div>
      </div>

      <div class="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div class="segment w-full sm:w-72" role="group" aria-label="按类型筛选">
          <AppButton
            v-for="option in filterOptions"
            :key="option.value"
            variant="unstyled"
            class="segment-option"
            :class="filter === option.value ? 'is-selected' : ''"
            :aria-pressed="filter === option.value"
            @click="filter = option.value"
          >
            {{ option.label }}（{{ option.value === 'all'
              ? experts.length + teams.length
              : option.value === 'expert' ? experts.length : teams.length }}）
          </AppButton>
        </div>
        <AppButton variant="ghost" :disabled="!loaded || !teamLoaded" @click="refresh">重新读取</AppButton>
      </div>

      <p
        v-for="line in statusLines"
        :key="line.key"
        :role="line.tone === 'error' ? 'alert' : 'status'"
        class="status-notice mt-3"
        :class="line.tone === 'error' ? 'status-notice-error' : ''"
      >
        {{ line.source }}：{{ line.text }}
      </p>

      <div
        v-if="visibleLoaded && visibleCount === 0"
        class="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-desk-line-strong bg-desk-surface-subtle px-4 py-3.5"
      >
        <div class="min-w-0">
          <p class="text-xs font-medium">{{ emptyState.title }}</p>
          <p class="mt-1 text-2xs text-desk-muted">{{ emptyState.hint }}</p>
        </div>
        <AppButton
          variant="primary"
          :disabled="emptyState.target === 'team' ? !teamLoaded : !loaded"
          @click="emptyState.target === 'team' ? teamStore.openCreate() : store.openCreate()"
        >
          {{ emptyState.actionLabel }}
        </AppButton>
      </div>

      <div v-for="group in assetGroups" :key="group.key">
        <p v-if="assetGroups.length > 1" class="mt-4 text-2xs font-medium tracking-wide text-desk-muted">
          {{ group.label }}
        </p>
        <ul class="mt-2 space-y-2">
          <li
            v-for="row in group.rows"
            :key="row.key"
            class="rounded-lg border border-desk-line px-3 py-2.5"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="text-sm font-medium">{{ row.name }}</span>
                  <span class="rounded-full border border-desk-line px-1.5 py-px text-2xs text-desk-muted">
                    {{ row.kind === 'expert' ? '专家' : '专家团' }}
                  </span>
                  <span class="rounded-full border border-desk-line px-1.5 py-px text-2xs text-desk-muted">
                    {{ row.source === 'builtin' ? '内置' : '自定义' }}
                  </span>
                  <span
                    v-if="row.derivedFrom !== null"
                    class="rounded-full border border-desk-line px-1.5 py-px text-2xs text-desk-muted"
                  >
                    派生自 {{ row.derivedFrom }}
                  </span>
                  <span class="font-mono text-2xs text-desk-muted">{{ row.id }}</span>
                </div>
                <p class="mt-1 text-xs text-desk-muted">{{ row.summary }}</p>
                <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <span
                    v-for="chip in row.chips"
                    :key="chip.text"
                    class="chip"
                    :class="chip.tone === 'warning' ? 'text-desk-warning' : ''"
                  >
                    {{ chip.text }}
                  </span>
                </div>
                <p v-if="row.warning !== null" class="mt-1 text-2xs text-desk-warning">{{ row.warning }}</p>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <template v-if="row.kind === 'expert'">
                  <AppButton
                    v-if="row.source === 'builtin'"
                    variant="ghost"
                    :disabled="busyId !== null"
                    @click="store.derive(row.id)"
                  >
                    {{ busyId === row.id ? '派生中…' : '派生副本' }}
                  </AppButton>
                  <template v-else>
                    <AppButton
                      variant="ghost"
                      :disabled="busyId !== null"
                      @click="store.openEdit(row.id)"
                    >
                      编辑
                    </AppButton>
                    <AppButton
                      variant="ghost"
                      :disabled="busyId !== null"
                      @click="openDeleteExpert(row.id)"
                    >
                      {{ busyId === row.id ? '删除中…' : '删除' }}
                    </AppButton>
                  </template>
                </template>
                <template v-else-if="row.source === 'user'">
                  <AppButton
                    variant="ghost"
                    :disabled="teamBusyId !== null"
                    @click="teamStore.openEdit(row.id)"
                  >
                    编辑
                  </AppButton>
                  <AppButton
                    variant="ghost"
                    :disabled="teamBusyId !== null"
                    @click="openDeleteTeam(row.id)"
                  >
                    {{ teamBusyId === row.id ? '删除中…' : '删除' }}
                  </AppButton>
                </template>
              </div>
            </div>
          </li>
        </ul>
      </div>
    </section>

    <details v-if="issueRows.length > 0" class="fold-group" open>
      <summary>
        <span class="disclosure" aria-hidden="true"></span>
        <span>加载诊断</span>
        <span class="chip">{{ issueRows.length }}</span>
      </summary>
      <div class="fold-group-body">
        <ul class="space-y-1.5">
          <li v-for="row in issueRows" :key="row.key" class="text-xs">
            <span class="rounded-full border border-desk-line px-1.5 py-px text-2xs text-desk-muted">
              {{ row.source }}
            </span>
            <span class="ml-2 rounded-full border border-desk-line px-1.5 py-px text-2xs text-desk-muted">
              {{ row.label }}
            </span>
            <span class="ml-2">{{ row.text }}</span>
            <span class="ml-2 block truncate font-mono text-2xs text-desk-muted" :title="row.path">
              {{ row.path }}
            </span>
          </li>
        </ul>
      </div>
    </details>

    <ExpertCapabilityDefaultsCard
      :capabilities="capabilities"
      :error="capabilitiesError"
      :saving="defaultsSaving"
      @save="store.saveDefaults"
    />

    <ExpertEditorDialog
      :open="editorOpen"
      :expert-id="editingId"
      @cancel="store.closeEditor()"
    />

    <TeamEditorDialog
      :open="teamEditorOpen"
      :team-id="teamEditingId"
      @cancel="teamStore.closeEditor()"
    />

    <ConfirmDialog
      :open="deleteOpen"
      title="删除自定义专家"
      :description="`将删除 ${pendingDelete?.displayName ?? ''} 的定义文件，已绑定该专家的会话下次打开时不再注入角色段。`"
      :detail="teamsReferencingPending.length === 0
        ? '只会删除该专家目录下的 expert.md；目录里还有别的文件时不会执行删除。'
        : `有 ${teamsReferencingPending.length} 个团队引用它（${teamsReferencingPending.map(team => team.displayName).join('、')}），删掉后这些团队会变成不可开团。只会删除 expert.md；目录里还有别的文件时不会执行删除。`"
      confirm-label="删除"
      :confirm-disabled="busyId !== null"
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />

    <ConfirmDialog
      :open="deleteTeamOpen"
      title="删除自定义专家团"
      :description="`将删除 ${pendingDeleteTeam?.displayName ?? ''} 的定义文件，已开团的会话保持原样，新建会话里不再能选它。`"
      detail="只会删除该团队目录下的 team.md；目录里还有别的文件时不会执行删除。成员会话与任务账本随根会话保留。"
      confirm-label="删除"
      :confirm-disabled="teamBusyId !== null"
      @confirm="confirmDeleteTeam"
      @cancel="pendingDeleteTeam = null"
    />
  </div>
</template>
