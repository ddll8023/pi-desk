<!-- 团队面板：根会话输入坞上方的只读视图，显示任务账本、成员状态、写区重叠与成本。
     数据来自宿主投影（账本与成员轮次）与成员会话只读通道，面板本身不派活、不停止、不改账本。
     非团队会话整块不渲染；账本还没提交时只显示成员与成本，不留空壳标题。
     折叠方式与 TodoPanel 一致：标题行即折叠开关，折叠状态不持久化。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppButton from '../../ui/AppButton.vue'
import { useTeamPanelStore } from '../stores/team-panel'
import { TEAM_BOARD_STATUS_LABELS } from '../../../../shared/team-board-api'
import type { TeamBoard, TeamBoardItem } from '../../../../shared/team-board-api'
import { TEAM_MEMBER_RUN_STATUS_LABELS } from '../../../../shared/team-run-api'
import type { TeamMemberRun } from '../../../../shared/team-run-api'
import type { TeamSessionView } from '../../../../shared/team-session-api'

/** 成员的展示信息：显示名与写入范围都来自专家清单，面板不自己解析专家定义。 */
interface TeamPanelMemberInfo {
  readonly name: string
  readonly scope: readonly string[] | null
}

const props = defineProps<{
  /** 团队绑定的团队标识；null 表示当前会话不是团队会话，整块不渲染。 */
  readonly teamId: string | null
  readonly projectPath: string | null
  readonly rootSessionId: string | null
  readonly board: TeamBoard | null
  readonly runs: readonly TeamMemberRun[]
  readonly memberInfo: Readonly<Record<string, TeamPanelMemberInfo>>
}>()

const store = useTeamPanelStore()
const expanded = ref(true)

/** 成员状态按会话文件判定：还没派活与文件不见对用户意味不同，分别给文案。 */
const MEMBER_STATE_LABELS: Readonly<Record<TeamSessionView['state'], string>> = {
  idle: '尚未派活',
  active: '有会话记录',
  missing: '会话文件不见'
}

const items = computed<readonly TeamBoardItem[]>(() => props.board?.items ?? [])

const doneCount = computed(() => items.value.filter(item => item.status === 'done').length)

const title = computed(() => (items.value.length === 0
  ? '团队 · 尚未提交账本'
  : `团队 · 账本 ${doneCount.value}/${items.value.length}`))

/** 成员行：登记标识、显示名、会话状态与最近一轮状态；登记缺失时按团队定义补一行。 */
interface MemberRow {
  readonly id: string
  readonly name: string
  readonly state: TeamSessionView['state']
  readonly run: TeamMemberRun | null
  readonly blocked: boolean
}

const rows = computed<readonly MemberRow[]>(() => {
  const registered = new Map(store.members.map(member => [member.memberExpertId, member]))
  // 成员行只以团队定义的成员为准：换过定义后登记里残留的旧成员不再占行、也不计入成员数。
  return Object.keys(props.memberInfo).map(id => ({
    id,
    name: props.memberInfo[id]?.name ?? id,
    state: registered.get(id)?.state ?? 'idle',
    run: latestRunOf(id),
    blocked: isBlocked(id)
  }))
})

/** 该成员最近的一轮：记录按时间先后排列，从尾部倒查即可，不依赖条目当前指派给谁。 */
function latestRunOf(memberExpertId: string): TeamMemberRun | null {
  for (let index = props.runs.length - 1; index >= 0; index -= 1) {
    const run = props.runs[index]
    if (run !== undefined && run.memberExpertId === memberExpertId) return run
  }
  return null
}

/** 成员是否有条目卡在「依赖未完成」：组长据此决定先催谁。 */
function isBlocked(memberExpertId: string): boolean {
  const doneIds = new Set(items.value.filter(item => item.status === 'done').map(item => item.id))
  return items.value.some(item => item.assignee === memberExpertId
    && item.blockedBy.some(id => !doneIds.has(id)))
}

/**
 * 写区重叠：两位成员的写入声明相交时提示，`null` 视为不限制，与任何声明都算重叠。
 * 只做提示，执行期仍由成员自己的写入守卫硬拒越界，这里不形成第二套判定。
 */
function overlaps(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (left === null || right === null) return true
  return left.some(item => right.some(other => sharesPath(item, other)))
}

/** 目录项按前缀比较，文件项要求完全相等；相对路径统一成 `/` 分隔后再比。 */
function sharesPath(left: string, right: string): boolean {
  const normalize = (value: string): string => value.split('\\').join('/')
  const a = normalize(left)
  const b = normalize(right)
  const directory = (value: string): boolean => value.endsWith('/')
  if (directory(a) && directory(b)) return a.startsWith(b) || b.startsWith(a)
  if (directory(a)) return b.startsWith(a)
  if (directory(b)) return a.startsWith(b)
  return a === b
}

const overlapNotes = computed<readonly string[]>(() => {
  const ids = Object.keys(props.memberInfo)
  const notes: string[] = []
  for (let left = 0; left < ids.length; left += 1) {
    for (let right = left + 1; right < ids.length; right += 1) {
      const a = ids[left]
      const b = ids[right]
      if (a === undefined || b === undefined) continue
      const scopeA = props.memberInfo[a]?.scope ?? null
      const scopeB = props.memberInfo[b]?.scope ?? null
      if (!overlaps(scopeA, scopeB)) continue
      const nameA = props.memberInfo[a]?.name ?? a
      const nameB = props.memberInfo[b]?.name ?? b
      notes.push(`${nameA} 与 ${nameB}`)
    }
  }
  return notes
})

/** 累计用量：只算宿主记录的成员轮次，不含团长自己的请求。 */
const totalTokens = computed(() => props.runs.reduce((sum, run) => sum + (run.usage?.totalTokens ?? 0), 0))

const memberCount = computed(() => rows.value.length)

/** 金额化显示：上万后转 k，避免成本行被长数字挤断。 */
function formatTokens(value: number): string {
  return value >= 10_000 ? `${(value / 1_000).toFixed(1)}k` : String(value)
}

function itemStatus(item: TeamBoardItem): string {
  return TEAM_BOARD_STATUS_LABELS[item.status]
}

/** 依赖未完成的条目标出还差哪几条：派活前必须先完成它们。 */
function pendingDependencies(item: TeamBoardItem): readonly string[] {
  const doneIds = new Set(items.value.filter(row => row.status === 'done').map(row => row.id))
  return item.blockedBy.filter(id => !doneIds.has(id))
}

function checkProgress(item: TeamBoardItem): string | null {
  if (item.checks.length === 0) return null
  const done = item.checks.filter(check => check.done).length
  return `验收 ${done}/${item.checks.length}`
}

/** 成员行的最近一轮描述：没有轮次时留空，不写「无」。 */
function runLabel(row: MemberRow): string | null {
  if (row.run === null) return null
  return `${TEAM_MEMBER_RUN_STATUS_LABELS[row.run.status]} · 第 ${row.run.attempt} 轮`
}

async function refresh(): Promise<void> {
  await store.load(props.projectPath, props.rootSessionId, true)
}

async function select(memberExpertId: string): Promise<void> {
  if (props.projectPath === null || props.rootSessionId === null) return
  await store.open(props.projectPath, props.rootSessionId, memberExpertId)
}

/** 只在团队会话读取成员清单：普通会话不必为一块不渲染的面板发请求。 */
watch(
  () => [props.teamId, props.projectPath, props.rootSessionId] as const,
  () => {
    if (props.teamId === null) {
      store.clear()
      return
    }
    void store.load(props.projectPath, props.rootSessionId)
  },
  { immediate: true }
)
</script>

<template>
  <section v-if="teamId !== null" class="team-panel" aria-labelledby="team-panel-title">
    <AppButton
      variant="unstyled"
      class="team-panel-head"
      :aria-expanded="expanded"
      aria-controls="team-panel-body"
      :title="expanded ? '折叠团队面板' : '展开团队面板'"
      @click="expanded = !expanded"
    >
      <span id="team-panel-title" class="team-panel-title">{{ title }}</span>
      <span class="team-panel-meta">{{ memberCount }} 名成员 · {{ formatTokens(totalTokens) }} tokens</span>
      <span class="team-panel-chevron" aria-hidden="true">{{ expanded ? '⌃' : '⌄' }}</span>
    </AppButton>

    <div v-show="expanded" id="team-panel-body" class="team-panel-body">
      <p v-if="board !== null" class="team-panel-goal">{{ board.goal }}</p>
      <ul v-if="items.length > 0" class="team-panel-items scroll-area" role="list">
        <li
          v-for="item in items"
          :key="item.id"
          class="team-panel-item"
          :class="`is-${item.status}`"
        >
          <span class="team-panel-item-id" aria-hidden="true">{{ item.id }}</span>
          <span class="team-panel-item-title">{{ item.title }}</span>
          <span class="team-panel-item-status">{{ itemStatus(item) }}</span>
          <span v-if="item.assignee !== null" class="team-panel-item-assignee">
            {{ memberInfo[item.assignee]?.name ?? item.assignee }}
          </span>
          <span v-if="checkProgress(item) !== null" class="team-panel-item-checks">{{ checkProgress(item) }}</span>
          <span v-if="pendingDependencies(item).length > 0" class="team-panel-item-blocked">
            等 {{ pendingDependencies(item).join('、') }}
          </span>
        </li>
      </ul>
      <p v-else class="team-panel-empty">团长还没有提交任务账本。</p>

      <p v-if="overlapNotes.length > 0" class="team-panel-warn" role="status">
        写区重叠：{{ overlapNotes.join('；') }}——执行期仍由各自写入守卫拦截越界。
      </p>

      <div class="team-panel-members">
        <p v-if="store.phase === 'loading'" class="team-panel-status" role="status">正在读取成员会话…</p>
        <p v-else-if="store.phase === 'failed'" class="team-panel-error" role="alert">
          {{ store.error }}
          <AppButton variant="unstyled" class="team-panel-retry" @click="refresh">重试</AppButton>
        </p>
        <ul v-if="rows.length > 0" class="team-panel-member-list" role="list">
          <li v-for="row in rows" :key="row.id" class="team-panel-member">
            <span class="team-panel-member-name">{{ row.name }}</span>
            <span class="team-panel-member-state">{{ MEMBER_STATE_LABELS[row.state] }}</span>
            <span v-if="runLabel(row) !== null" class="team-panel-member-run">{{ runLabel(row) }}</span>
            <span v-if="row.blocked" class="team-panel-member-blocked">有条目等依赖</span>
            <AppButton
              variant="unstyled"
              class="team-panel-member-open"
              :disabled="row.state === 'idle'"
              :title="row.state === 'idle' ? '这个成员还没有会话记录' : `查看 ${row.name} 的会话`"
              @click="select(row.id)"
            >查看</AppButton>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.team-panel {
  border-top: 1px solid var(--color-desk-line);
  padding-block: 6px 2px;
}

.team-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding-block: 2px;
  text-align: left;
}

.team-panel-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-desk-muted);
}

.team-panel-meta {
  margin-inline-start: auto;
  font-size: 11px;
  color: var(--color-desk-muted);
  font-variant-numeric: tabular-nums;
}

.team-panel-chevron {
  font-size: 11px;
  color: var(--color-desk-muted);
}

.team-panel-body {
  display: grid;
  gap: 6px;
  padding-block: 4px 2px;
}

.team-panel-goal {
  margin: 0;
  font-size: 12px;
  color: var(--color-desk-muted);
  overflow-wrap: anywhere;
}

.team-panel-items,
.team-panel-member-list {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 168px;
  overflow-y: auto;
}

.team-panel-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 2px 4px;
  border-radius: 5px;
  font-size: 12px;
  color: var(--color-desk-muted);
}

.team-panel-item:hover {
  background: color-mix(in srgb, var(--color-desk-ink) 5%, transparent);
}

.team-panel-item-id {
  font-size: 11px;
  color: var(--color-desk-muted);
  font-variant-numeric: tabular-nums;
  min-width: 18px;
}

.team-panel-item-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.team-panel-item-status {
  font-size: 11px;
  color: var(--color-desk-muted);
  white-space: nowrap;
}

.team-panel-item.is-done .team-panel-item-title {
  color: var(--color-desk-muted);
  text-decoration: line-through;
}

.team-panel-item.is-failed .team-panel-item-status {
  color: var(--color-desk-danger);
}

.team-panel-item.is-review .team-panel-item-status {
  color: var(--color-desk-accent);
}

.team-panel-item-assignee,
.team-panel-item-checks,
.team-panel-item-blocked {
  font-size: 11px;
  color: var(--color-desk-muted);
  white-space: nowrap;
}

.team-panel-item-blocked {
  color: var(--color-desk-warning);
}

.team-panel-empty,
.team-panel-status {
  margin: 0;
  font-size: 12px;
  color: var(--color-desk-muted);
}

.team-panel-error {
  margin: 0;
  font-size: 12px;
  color: var(--color-desk-danger);
  display: flex;
  align-items: center;
  gap: 6px;
}

.team-panel-retry {
  font-size: 12px;
  color: var(--color-desk-accent);
  text-decoration: underline;
}

.team-panel-warn {
  margin: 0;
  font-size: 11px;
  color: var(--color-desk-warning);
}

.team-panel-member {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 2px 4px;
  border-radius: 5px;
  font-size: 12px;
}

.team-panel-member:hover {
  background: color-mix(in srgb, var(--color-desk-ink) 5%, transparent);
}

.team-panel-member-name {
  color: var(--color-desk-muted);
  min-width: 72px;
}

.team-panel-member-state,
.team-panel-member-run,
.team-panel-member-blocked {
  font-size: 11px;
  color: var(--color-desk-muted);
  white-space: nowrap;
}

.team-panel-member-blocked {
  color: var(--color-desk-warning);
}

.team-panel-member-open {
  margin-inline-start: auto;
  font-size: 12px;
  color: var(--color-desk-accent);
}

.team-panel-member-open:disabled {
  color: var(--color-desk-line-strong);
  cursor: default;
}
</style>
