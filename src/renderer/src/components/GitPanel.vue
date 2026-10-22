<!--
  源代码管理面板：分支与远端状态、提交框、按区域分组的改动列表、单条目差异。

  数据全部来自主进程（`stores/git-status`）：本组件只负责展示与派发意图，不拼命令、不读磁盘。
  改动分四组：冲突、更改（工作区）、已暂存的更改、未跟踪文件；空组不出现，组内按路径排序。
  行上的操作按区域给：工作区可暂存/丢弃，已暂存可取消暂存，未跟踪可暂存/删除，冲突可「标记为已解决」。
  丢弃是不可恢复的，必须过一次确认对话框；确认后仍由主进程再校验路径与文件类型。

  差异不另开标签页，而是就地替换列表：面板本身很窄，跳来跳去会丢掉「刚才在看哪个文件」的上下文。
  需要编辑时用差异视图右上角的「打开文件」把用户带到工作区的文件标签。

  视图分「未提交」与「历史」两个：前者是本工作区还没提交的改动，后者是已经提交的记录（含未推送标记）。
  行上的「查看此文件的历史」把历史视图切到该路径的过滤模式，用户不必再自己找文件名。

  分支行只读：分支名、分离 HEAD 与与上游的领先/落后；拉取与推送放在提交区的动作组里（`GitCommitActions`），
  与 Orca 同一分工：分支行不因按钮而挤掉分支名的可用宽度，动作集中在一处也不用来回找。
  拉取/推送与提交互斥，运行中按钮就地显示进度，失败原因落在下方的提示行。

  两条排版约定（对应 `main.css` 的 `.git-*`）：所有区块的左缩进统一到 14px（页签文字是最靠上的
  视觉锚点）；改动行是「名称 | 目录」两列定宽网格，目录列起点逐行一致，行操作浮在右侧不挤文字。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { GIT_STATUS_LIMIT } from '../../../shared/git-api'
import type { GitChangeEntry, GitChangeStatus, GitConflictKind, GitConflictOperation } from '../../../shared/git-api'
import { useGitHistoryStore } from '../stores/git-history'
import { useGitStatusStore } from '../stores/git-status'
import { useProjectStore } from '../stores/project'
import { useWorkspaceTabsStore } from '../stores/workspace-tabs'
import AppButton from '../ui/AppButton.vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import GitCommitActions from './GitCommitActions.vue'
import GitDiffView from './GitDiffView.vue'
import GitHistoryView from './GitHistoryView.vue'

/** 改动类型到单字符标记：与各编辑器的源代码管理视图保持同一套习惯。 */
const STATUS_LETTERS: Readonly<Record<GitChangeStatus, string>> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U'
}

/** 冲突类型的可读说明；悬停与读屏都用它，列表里只显示「冲突」角标。 */
const CONFLICT_LABELS: Readonly<Record<GitConflictKind, string>> = {
  both_modified: '双方都修改',
  both_added: '双方都添加',
  both_deleted: '双方都删除',
  added_by_us: '我们添加',
  added_by_them: '对方添加',
  deleted_by_us: '我们删除',
  deleted_by_them: '对方删除'
}

const OPERATION_LABELS: Readonly<Record<GitConflictOperation, string>> = {
  merge: '合并',
  rebase: '变基',
  'cherry-pick': '拣选'
}

/** 差异视图头部右侧的区域标签：与改动分组一一对应。 */
const AREA_LABELS: Readonly<Record<'staged' | 'unstaged' | 'untracked', string>> = {
  staged: '已暂存',
  unstaged: '工作区',
  untracked: '未跟踪'
}

const gitStore = useGitStatusStore()
const historyStore = useGitHistoryStore()
const projectStore = useProjectStore()
const workspaceTabsStore = useWorkspaceTabsStore()

const { status, phase, error, busyPath, actionError, actionNotice, commitMessage, committing, remoteBusy, selection, diff, diffPhase, diffError, groups, entries, stagedCount, hasChanges, isRepository } = storeToRefs(gitStore)
const upstream = computed(() => status.value?.upstream ?? null)
const remotes = computed<readonly string[]>(() => status.value?.remotes ?? [])
const { currentProject } = storeToRefs(projectStore)

/** 等待确认的丢弃条目；null 表示对话框关闭。 */
const pendingDiscard = ref<GitChangeEntry | null>(null)
/** 当前视图：未提交的更改，或已提交的历史。 */
const view = ref<'changes' | 'history'>('changes')

const selectionLabel = computed(() => (
  selection.value === null ? '' : AREA_LABELS[selection.value.area]
))

const messageReady = computed(() => commitMessage.value.trim() !== '')

const truncatedNotice = computed(() => (
  status.value?.truncated === true
    ? `改动过多，仅显示前 ${GIT_STATUS_LIMIT} 项；把生成目录加入 .gitignore 可以缩短这个列表。`
    : null
))

const conflictNotice = computed(() => {
  const operation = status.value?.conflictOperation ?? null
  return operation === null ? null : `仓库正在${OPERATION_LABELS[operation]}中，先解决冲突再提交。`
})

/** 条目拆成「名称 + 所在目录」，名称优先占宽。 */
function splitPath(path: string): { readonly name: string; readonly directory: string } {
  const slash = path.lastIndexOf('/')
  return slash < 0
    ? { name: path, directory: '' }
    : { name: path.slice(slash + 1), directory: path.slice(0, slash) }
}

function letterOf(entry: GitChangeEntry): string {
  return STATUS_LETTERS[entry.status]
}

function conflictLabel(entry: GitChangeEntry): string | null {
  return entry.conflictKind === undefined ? null : CONFLICT_LABELS[entry.conflictKind]
}

function isBusy(entry: GitChangeEntry): boolean {
  return busyPath.value === entry.path
}

/** 该条目是否可在当前区域执行「暂存」；冲突条目的暂存等于标记为已解决。 */
function canStage(entry: GitChangeEntry): boolean {
  return entry.area !== 'staged'
}

function canUnstage(entry: GitChangeEntry): boolean {
  return entry.area === 'staged'
}

function openFile(entry: GitChangeEntry): void {
  workspaceTabsStore.openFileTab(entry.path)
}

/** 差异视图里的「打开文件」：路径来自当前选中项，不构造假条目。 */
function openSelected(): void {
  const current = selection.value
  if (current === null) return
  workspaceTabsStore.openFileTab(current.path)
}

function requestDiscard(entry: GitChangeEntry): void {
  pendingDiscard.value = entry
}

function confirmDiscard(): void {
  const entry = pendingDiscard.value
  pendingDiscard.value = null
  if (entry === null) return
  void gitStore.discard(entry)
}

const discardTitle = computed(() => {
  const entry = pendingDiscard.value
  if (entry === null) return '丢弃改动？'
  return entry.area === 'untracked' ? '删除未跟踪的文件？' : '丢弃这个文件的改动？'
})

const discardDescription = computed(() => {
  const entry = pendingDiscard.value
  if (entry === null) return ''
  return entry.area === 'untracked'
    ? '文件会被直接删除，无法恢复。'
    : '工作区内容会恢复到已暂存（或已提交）的版本，未保存的修改会丢失，无法恢复。'
})

/** 切换视图：离开历史时回到列表；历史自己的首次读取由该视图在挂载时完成。 */
function selectView(next: 'changes' | 'history'): void {
  view.value = next
  if (next === 'history') {
    gitStore.clearSelection()
    return
  }
  historyStore.backToList()
}

/** 只看某个文件的历史：直接切到历史视图并带上过滤路径。 */
function openFileHistory(entry: GitChangeEntry): void {
  view.value = 'history'
  gitStore.clearSelection()
  void historyStore.open(entry.path)
}

/** 提交成功后刷新历史，让新提交立刻出现在最上面。 */
async function onCommit(): Promise<void> {
  const committed = await gitStore.commit()
  if (committed) await refreshHistory()
}

function onCommitKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter') return
  if (!event.metaKey && !event.ctrlKey) return
  event.preventDefault()
  void onCommit()
}

/** 远端操作成功后历史里的「未推送」标记与领先数会变，已打开的历史视图跟着重读一次。 */
async function triggerRemote(kind: 'pull' | 'push'): Promise<void> {
  const done = kind === 'pull' ? await gitStore.pull() : await gitStore.push()
  if (done) await refreshHistory()
}

/** 提交并推送：提交由 store 内部完成，这里只在整体成功后补一次历史重读。 */
async function onCommitAndPush(): Promise<void> {
  const done = await gitStore.commitAndPush()
  if (done) await refreshHistory()
}

/** 历史视图未打开时不读：它自己挂载时会读一次。 */
async function refreshHistory(): Promise<void> {
  if (historyStore.isOpen) await historyStore.open(historyStore.filterPath)
}

</script>

<template>
  <div class="git-panel">
    <!-- 分支行：分支名、分离 HEAD、与上游的领先/落后。 -->
    <div v-if="isRepository" class="git-branch">
      <span class="git-branch-name" :title="status?.branch ?? '分离的 HEAD'">
        <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.2" /><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="9" r="2.2" /><path d="M6 8.2v7.6" /><path d="M18 11.2c0 3-3.4 3.2-6 3.2" /></svg>
        <span class="git-branch-label">{{ status?.branch ?? '分离的 HEAD' }}</span>
      </span>
      <span v-if="upstream !== null" class="git-branch-sync" :title="`上游 ${upstream.name}`">
        <span v-if="upstream.ahead > 0" class="git-branch-ahead">↑{{ upstream.ahead }}</span>
        <span v-if="upstream.behind > 0" class="git-branch-behind">↓{{ upstream.behind }}</span>
        <span v-if="upstream.ahead === 0 && upstream.behind === 0" class="git-branch-even">与上游一致</span>
      </span>
    </div>

    <!-- 视图切换：更改（未提交）与历史（已提交）。 -->
    <div v-if="isRepository" class="git-view-switch" role="tablist" aria-label="源代码管理视图">
      <button
        type="button"
        role="tab"
        class="git-view-tab"
        :class="{ 'is-active': view === 'changes' }"
        :aria-selected="view === 'changes'"
        @click="selectView('changes')"
      >未提交<span v-if="entries.length > 0" class="git-view-count">{{ entries.length }}</span></button>
      <button
        type="button"
        role="tab"
        class="git-view-tab"
        :class="{ 'is-active': view === 'history' }"
        :aria-selected="view === 'history'"
        @click="selectView('history')"
      >历史</button>
    </div>

    <GitDiffView
      v-if="view === 'changes' && selection !== null"
      :path="selection.path"
      :label="selectionLabel"
      :phase="diffPhase"
      :diff="diff"
      :error="diffError"
      @back="gitStore.clearSelection()"
      @open="openSelected"
    />

    <GitHistoryView v-else-if="view === 'history'" />

    <div v-else class="git-scroll scroll-area">
      <p v-if="conflictNotice !== null" class="git-notice is-warning">{{ conflictNotice }}</p>
      <p v-if="truncatedNotice !== null" class="git-notice">{{ truncatedNotice }}</p>
      <p v-if="actionError !== null" class="git-notice is-error">{{ actionError.message }}</p>
      <p v-else-if="actionNotice !== null" class="git-notice" role="status">{{ actionNotice }}</p>

      <p v-if="currentProject === null" class="git-notice">尚未选择项目，先在左侧添加或切换项目。</p>
      <p v-else-if="status === null && (phase === 'idle' || phase === 'loading')" class="git-notice">正在读取 Git 状态…</p>
      <template v-else-if="phase === 'error'">
        <p class="git-notice is-error">{{ error?.message ?? '读取 Git 状态失败。' }}</p>
        <AppButton variant="compact" class="git-retry" @click="gitStore.refresh()">重试</AppButton>
      </template>
      <p v-else-if="status !== null && !isRepository" class="git-notice">此项目不是 Git 仓库，没有可管理的改动。</p>

      <template v-else-if="isRepository">
        <form class="git-commit" @submit.prevent>
          <textarea
            class="git-commit-input"
            :value="commitMessage"
            rows="2"
            placeholder="提交信息"
            aria-label="提交信息"
            title="⌘/Ctrl + Enter 提交"
            spellcheck="false"
            :disabled="committing"
            @input="gitStore.setCommitMessage(($event.target as HTMLTextAreaElement).value)"
            @keydown="onCommitKeydown"
          ></textarea>
          <GitCommitActions
            :staged-count="stagedCount"
            :message-ready="messageReady"
            :committing="committing"
            :remote-busy="remoteBusy"
            :upstream="upstream"
            :remotes="remotes"
            @commit="onCommit"
            @commit-and-push="onCommitAndPush"
            @pull="triggerRemote('pull')"
            @push="triggerRemote('push')"
          />
        </form>

        <p v-if="!hasChanges" class="git-notice">没有未提交的改动。</p>

        <section v-for="group in groups" :key="group.key" class="git-group">
          <header class="git-group-header">
            <span class="git-group-title">{{ group.title }}</span>
            <span class="git-group-count">{{ group.entries.length }}</span>
          </header>

          <ul class="git-list">
            <li v-for="entry in group.entries" :key="`${entry.area}:${entry.path}`">
              <div class="git-row" :class="{ 'is-busy': isBusy(entry) }">
                <button
                  type="button"
                  class="git-row-open"
                  :title="entry.path"
                  @click="gitStore.select(entry)"
                >
                  <span class="git-row-badge" :class="`is-${entry.status}`">{{ letterOf(entry) }}</span>
                  <span class="git-row-text">
                    <span class="git-row-name">{{ splitPath(entry.path).name }}</span>
                    <span v-if="splitPath(entry.path).directory !== ''" class="git-row-dir">{{ splitPath(entry.path).directory }}</span>
                  </span>
                  <span v-if="conflictLabel(entry) !== null" class="git-row-tag" :title="conflictLabel(entry) ?? ''">冲突</span>
                  <span v-else-if="entry.oldPath !== undefined" class="git-row-tag" :title="`原路径 ${entry.oldPath}`">重命名</span>
                </button>

                <div class="git-row-actions">
                  <AppButton
                    v-if="canStage(entry)"
                    variant="unstyled"
                    class="git-row-action"
                    :disabled="isBusy(entry)"
                    :title="entry.conflictKind === undefined ? '暂存' : '标记为已解决（暂存）'"
                    :aria-label="entry.conflictKind === undefined ? '暂存' : '标记为已解决'"
                    @click="gitStore.stage(entry)"
                  >
                    <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                  </AppButton>
                  <AppButton
                    v-if="canUnstage(entry)"
                    variant="unstyled"
                    class="git-row-action"
                    :disabled="isBusy(entry)"
                    title="取消暂存"
                    aria-label="取消暂存"
                    @click="gitStore.unstage(entry)"
                  >
                    <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14" /></svg>
                  </AppButton>
                  <AppButton
                    v-if="entry.conflictKind === undefined && entry.area !== 'staged'"
                    variant="unstyled"
                    class="git-row-action is-danger"
                    :disabled="isBusy(entry)"
                    :title="entry.area === 'untracked' ? '删除未跟踪的文件' : '丢弃改动'"
                    :aria-label="entry.area === 'untracked' ? '删除未跟踪的文件' : '丢弃改动'"
                    @click="requestDiscard(entry)"
                  >
                    <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /><path d="M6 7l1 13h10l1-13" /></svg>
                  </AppButton>
                  <AppButton
                    variant="unstyled"
                    class="git-row-action"
                    :disabled="isBusy(entry)"
                    title="查看此文件的历史"
                    aria-label="查看此文件的历史"
                    @click="openFileHistory(entry)"
                  >
                    <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" /><path d="M3 4v5h5" /><path d="M12 8v4.5l3 1.8" /></svg>
                  </AppButton>
                  <AppButton
                    variant="unstyled"
                    class="git-row-action"
                    title="在编辑器中打开"
                    aria-label="在编辑器中打开"
                    @click="openFile(entry)"
                  >
                    <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></svg>
                  </AppButton>
                </div>
              </div>
            </li>
          </ul>
        </section>
      </template>
    </div>

    <!-- 确认框挂到 body：面板自身是 overflow 容器，留在面板里会被裁切或压在面板层级之下。 -->
    <Teleport to="body">
      <ConfirmDialog
        :open="pendingDiscard !== null"
        :title="discardTitle"
        :description="discardDescription"
        :detail="pendingDiscard?.path ?? ''"
        confirm-label="确认丢弃"
        confirm-variant="danger"
        @confirm="confirmDiscard"
        @cancel="pendingDiscard = null"
      />
    </Teleport>
  </div>
</template>
