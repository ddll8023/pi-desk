<!--
  设置页「专家与专家团」分节：把专家与专家团放在同一页管理。

  专家是一段角色说明加一份能力范围，专家团是「团长 + 成员」的组合，成员本身就是专家；
  两者一起管理，才能在同一个列表里看清角色资产与它们之间的引用关系，不必在两页之间来回切换。
  顶部「默认能力」卡片只作用于专家：团队不声明能力范围，成员的能力取自各自的专家定义。
  列表按类型分段筛选（全部 / 专家 / 专家团），行内带类型徽标与来源；内置只读，自定义可编辑与删除。
  团队编辑在对话框里从专家清单勾选团长与成员，不接受手写标识；正文与简介的作用范围在对话框里标注。
  删除专家会连带影响引用它的团队，因此确认框列出这些团队并说明后果。
  加载诊断把两类定义的诊断并成一段，条目带来源标签；诊断只读展示，界面上不提供自动修复。
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

/** 类型筛选：一段控制专家与团队两份清单在同一页里的呈现。 */
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

/** 能力默认基线只作用于专家：筛选到专家团时收起，避免被当成团队的能力设置。 */
const showCapabilityDefaults = computed(() => filter.value !== 'team')

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

/** 空态与计数都按当前筛选算：切到「专家团」时不该显示「还没有专家」。 */
const visibleCount = computed(() => builtinExperts.value.length + userExperts.value.length
  + builtinTeams.value.length + userTeams.value.length)
const visibleLoaded = computed(() => loaded.value && teamLoaded.value)

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

/** 诊断行：两类定义的诊断并成一段，用来源标签区分，不各占一块。 */
interface AssetIssueRow {
  readonly key: string
  readonly source: '专家' | '专家团'
  readonly label: string
  readonly text: string
  readonly path: string
}

const issueRows = computed<readonly AssetIssueRow[]>(() => {
  const rows: AssetIssueRow[] = []
  if (showExperts.value) {
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
  }
  if (showTeams.value) {
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
  }
  return rows
})

/** 引用某个专家的团队：删除前的确认框要用它说明连带影响。 */
const teamsReferencingPending = computed<readonly TeamView[]>(() => {
  const target = pendingDelete.value
  if (target === null) return []
  return teams.value.filter(team => team.leadExpertId === target.id
    || team.memberExpertIds.includes(target.id))
})

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
  const names = team.memberExpertIds.map(expertNameOf)
  return names.length <= 3 ? names.join('、') : `${names.slice(0, 3).join('、')} 等 ${names.length} 个`
}

/** 继承模式相对基线的加减：没有改动时不写括号，避免每行都带一个空括注。 */
function delta(add: readonly string[], remove: readonly string[]): string {
  if (add.length === 0 && remove.length === 0) return ''
  const parts: string[] = []
  if (add.length > 0) parts.push(`+${add.length}`)
  if (remove.length > 0) parts.push(`−${remove.length}`)
  return `（${parts.join(' ')}）`
}

/** 能力摘要：只描述范围口径与数量，不把整个名单塞进列表。 */
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
  // 工具维度只在偏离默认时提一句：大多数专家不动工具，列表行不应被它撑长。
  const tools = expert.toolsMode === 'only'
    ? `工具 ${expert.toolIds.length} 个（仅用选中）`
    : expert.toolAddIds.length === 0 && expert.toolRemoveIds.length === 0
      ? null
      : `工具继承默认${delta(expert.toolAddIds, expert.toolRemoveIds)}`
  return [skills, mcp, tools].filter((part): part is string => part !== null).join(' · ')
}

/** 写入范围摘要：不限制、只读与白名单三种形态各一句话，名单同样只取前三个。 */
function writeScopeSummary(expert: SessionExpertView): string {
  const scope = expert.writeScope
  if (scope === null) return '不限制'
  if (scope.length === 0) return '只读（write 与 edit 会被拒绝）'
  return nameList(scope)
}

function isBusy(expert: SessionExpertView): boolean {
  return busyId.value === expert.id
}

function isTeamBusy(team: TeamView): boolean {
  return teamBusyId.value === team.id
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
        专家给会话注入一段角色说明并收窄能力范围；专家团把若干专家组成「团长 + 成员」，由团长拆解与验收。
      </p>
    </header>

    <ExpertCapabilityDefaultsCard
      v-if="showCapabilityDefaults"
      :capabilities="capabilities"
      :error="capabilitiesError"
      :saving="defaultsSaving"
      @save="store.saveDefaults"
    />

    <section class="settings-section" aria-labelledby="settings-experts-list-title" :aria-busy="!visibleLoaded">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-experts-list-title" class="settings-section-title">角色资产</h2>
          <p class="mt-1 text-xs text-desk-muted">
            内置只读，可派生专家副本；自定义可编辑与删除，标识创建后不可修改。
          </p>
        </div>
        <div class="flex items-center gap-2">
          <AppButton variant="ghost" :disabled="!loaded || !teamLoaded" @click="refresh">重新读取</AppButton>
          <AppButton variant="ghost" :disabled="!loaded" @click="store.openCreate()">新建专家</AppButton>
          <AppButton variant="primary" :disabled="!teamLoaded" @click="teamStore.openCreate()">新建专家团</AppButton>
        </div>
      </div>

      <div class="segment mt-3 w-full sm:w-72" role="group" aria-label="按类型筛选">
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

      <p v-if="loadError !== null" role="alert" class="status-notice status-notice-error mt-3">
        读取专家清单失败：{{ loadError }}
      </p>
      <p v-if="teamLoadError !== null" role="alert" class="status-notice status-notice-error mt-3">
        读取团队清单失败：{{ teamLoadError }}
      </p>

      <p v-if="notice !== null" role="status" class="status-notice mt-3">{{ notice }}</p>
      <p v-if="actionError !== null" role="alert" class="status-notice status-notice-error mt-3">
        {{ actionError }}
      </p>
      <p v-if="teamNotice !== null" role="status" class="status-notice mt-3">{{ teamNotice }}</p>
      <p v-if="teamActionError !== null" role="alert" class="status-notice status-notice-error mt-3">
        {{ teamActionError }}
      </p>

      <p v-if="visibleLoaded && visibleCount === 0" role="status" class="mt-3 text-xs text-desk-muted">
        {{ filter === 'team'
          ? '还没有专家团；用右上角「新建专家团」创建，团长与成员都从专家清单里选。'
          : filter === 'expert'
            ? '还没有专家；可用右上角「新建专家」创建。'
            : '还没有专家或专家团；先新建一位专家，再把它组成团队。' }}
      </p>

      <template v-if="builtinExperts.length > 0 || userExperts.length > 0">
        <p v-if="builtinExperts.length > 0" class="mt-4 text-2xs font-medium tracking-wide text-desk-muted">内置专家</p>
        <ul v-if="builtinExperts.length > 0" class="mt-2 space-y-2">
          <li
            v-for="expert in builtinExperts"
            :key="expert.id"
            class="rounded-lg border border-desk-line px-3 py-2.5"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="text-sm font-medium">{{ expert.displayName }}</span>
                  <span class="rounded-full border border-desk-line px-1.5 py-px text-2xs text-desk-muted">专家</span>
                  <span class="rounded-full border border-desk-line px-1.5 py-px text-2xs text-desk-muted">内置</span>
                  <span class="font-mono text-2xs text-desk-muted">{{ expert.id }}</span>
                </div>
                <p class="mt-1 text-xs text-desk-muted">{{ expert.summary }}</p>
                <p class="mt-1 text-2xs text-desk-muted">能力范围：{{ capabilitySummary(expert) }}</p>
                <p class="mt-1 text-2xs text-desk-muted">写入范围：{{ writeScopeSummary(expert) }}</p>
                <p v-if="expert.unavailableSkillIds.length > 0" class="mt-1 text-2xs text-desk-warning">
                  不可用：{{ expert.unavailableSkillIds.join('、') }}
                </p>
                <p v-if="expert.truncated" class="mt-1 text-2xs text-desk-warning">
                  正文过长，召唤时会被截断
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <AppButton
                  variant="ghost"
                  :disabled="busyId !== null"
                  @click="store.derive(expert.id)"
                >
                  {{ isBusy(expert) ? '派生中…' : '派生副本' }}
                </AppButton>
              </div>
            </div>
          </li>
        </ul>

        <p v-if="userExperts.length > 0" class="mt-4 text-2xs font-medium tracking-wide text-desk-muted">自定义专家</p>
        <ul v-if="userExperts.length > 0" class="mt-2 space-y-2">
          <li
            v-for="expert in userExperts"
            :key="expert.id"
            class="rounded-lg border border-desk-line px-3 py-2.5"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="text-sm font-medium">{{ expert.displayName }}</span>
                  <span class="rounded-full border border-desk-line px-1.5 py-px text-2xs text-desk-muted">专家</span>
                  <span class="rounded-full border border-desk-line px-1.5 py-px text-2xs text-desk-muted">自定义</span>
                  <span
                    v-if="expert.derivedFrom !== null"
                    class="rounded-full border border-desk-line px-1.5 py-px text-2xs text-desk-muted"
                  >
                    派生自 {{ expert.derivedFrom }}
                  </span>
                  <span class="font-mono text-2xs text-desk-muted">{{ expert.id }}</span>
                </div>
                <p class="mt-1 text-xs text-desk-muted">{{ expert.summary }}</p>
                <p class="mt-1 text-2xs text-desk-muted">能力范围：{{ capabilitySummary(expert) }}</p>
                <p class="mt-1 text-2xs text-desk-muted">写入范围：{{ writeScopeSummary(expert) }}</p>
                <p v-if="expert.unavailableSkillIds.length > 0" class="mt-1 text-2xs text-desk-warning">
                  不可用：{{ expert.unavailableSkillIds.join('、') }}
                </p>
                <p v-if="expert.truncated" class="mt-1 text-2xs text-desk-warning">
                  正文过长，召唤时会被截断
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <AppButton
                  variant="ghost"
                  :disabled="busyId !== null"
                  @click="store.openEdit(expert.id)"
                >
                  编辑
                </AppButton>
                <AppButton
                  variant="ghost"
                  :disabled="busyId !== null"
                  @click="pendingDelete = expert"
                >
                  删除
                </AppButton>
              </div>
            </div>
          </li>
        </ul>
      </template>

      <template v-if="builtinTeams.length > 0 || userTeams.length > 0">
        <p v-if="builtinTeams.length > 0" class="mt-4 text-2xs font-medium tracking-wide text-desk-muted">内置专家团</p>
        <ul v-if="builtinTeams.length > 0" class="mt-2 space-y-2">
          <li
            v-for="team in builtinTeams"
            :key="team.id"
            class="rounded-lg border border-desk-line px-3 py-2.5"
          >
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="text-sm font-medium">{{ team.displayName }}</span>
              <span class="rounded-full border border-desk-line px-1.5 py-px text-2xs text-desk-muted">专家团</span>
              <span class="rounded-full border border-desk-line px-1.5 py-px text-2xs text-desk-muted">内置</span>
              <span class="font-mono text-2xs text-desk-muted">{{ team.id }}</span>
              <span class="text-2xs" :class="team.ready ? 'text-desk-muted' : 'text-desk-warning'">
                {{ team.ready ? '可开团' : '不可开团' }}
              </span>
            </div>
            <p class="mt-1 text-xs text-desk-muted">{{ team.summary }}</p>
            <p class="mt-1 text-2xs text-desk-muted">团长：{{ expertNameOf(team.leadExpertId) }}</p>
            <p class="mt-1 text-2xs text-desk-muted">成员：{{ memberSummary(team) }}</p>
          </li>
        </ul>

        <p v-if="userTeams.length > 0" class="mt-4 text-2xs font-medium tracking-wide text-desk-muted">自定义专家团</p>
        <ul v-if="userTeams.length > 0" class="mt-2 space-y-2">
          <li
            v-for="team in userTeams"
            :key="team.id"
            class="rounded-lg border border-desk-line px-3 py-2.5"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="text-sm font-medium">{{ team.displayName }}</span>
                  <span class="rounded-full border border-desk-line px-1.5 py-px text-2xs text-desk-muted">专家团</span>
                  <span class="rounded-full border border-desk-line px-1.5 py-px text-2xs text-desk-muted">自定义</span>
                  <span class="font-mono text-2xs text-desk-muted">{{ team.id }}</span>
                  <span class="text-2xs" :class="team.ready ? 'text-desk-muted' : 'text-desk-warning'">
                    {{ team.ready ? '可开团' : '不可开团' }}
                  </span>
                </div>
                <p class="mt-1 text-xs text-desk-muted">{{ team.summary }}</p>
                <p class="mt-1 text-2xs text-desk-muted">团长：{{ expertNameOf(team.leadExpertId) }}</p>
                <p class="mt-1 text-2xs text-desk-muted">成员：{{ memberSummary(team) }}</p>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <AppButton
                  variant="ghost"
                  :disabled="teamBusyId !== null"
                  @click="teamStore.openEdit(team.id)"
                >
                  编辑
                </AppButton>
                <AppButton
                  variant="ghost"
                  :disabled="teamBusyId !== null"
                  @click="pendingDeleteTeam = team"
                >
                  {{ isTeamBusy(team) ? '删除中…' : '删除' }}
                </AppButton>
              </div>
            </div>
          </li>
        </ul>
      </template>
    </section>

    <section v-if="issueRows.length > 0" class="settings-section" aria-labelledby="settings-experts-issues-title">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-experts-issues-title" class="settings-section-title">加载诊断</h2>
        </div>
      </div>
      <ul class="mt-3 space-y-1.5">
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
    </section>

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
