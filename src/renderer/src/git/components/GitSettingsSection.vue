<!-- 设置页的 Git 分节：盘点某个项目的仓库体积、托管任务工作树与临时任务分支，并提供修剪、清理与垃圾回收。
     盘点的项目由本节顶部的项目选择器决定，默认跟随左侧当前项目；在这里切换查看目标只改变本分节的盘点对象，
     不改变应用当前项目，因此不必为了清另一个仓库先去侧边栏切换项目。
     清理对象只限应用自己建在 `<仓库根>/.pi/worktrees/` 下的工作树与 `pi/task-*` 分支；主进程会再校验一次，
     页面全选也只覆盖这些范围。含未提交改动的工作树必须显式强制才能清理，因此单独走确认弹窗。
     页面只提交「要清理哪些」，不构造 git 参数；每次清理完成后重新盘点，用主进程结果覆盖本地展示。 -->
<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import type { TaskBranchCleanItem, TaskWorktreeCleanItem } from '../../../../shared/git-cleanup-api'
import { useProjectStore } from '../../projects/stores/project'
import { usePreferencesStore } from '../../preferences/stores/preferences'
import AppButton from '../../ui/AppButton.vue'
import AppSelect from '../../ui/AppSelect.vue'
import ConfirmDialog from '../../ui/ConfirmDialog.vue'

const projectStore = useProjectStore()
const preferencesStore = usePreferencesStore()
const { ready, gitAutoCleanWorktreeOnMerge, gitAutoCleanWorktreeOnSessionDelete } = storeToRefs(preferencesStore)

/** 盘点视图：首次加载与刷新共用一份，避免刷新时整块内容消失。 */
type SummaryView =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready' }
  | { readonly phase: 'error'; readonly message: string }
  | { readonly phase: 'unsupported' }
  | { readonly phase: 'not-repository' }

const view = shallowRef<SummaryView>({ phase: 'loading' })
const summary = shallowRef<{ gitDirBytes: number; totalWorktrees: number; prunableWorktrees: number; orphanWorktrees: number; totalTaskBranches: number; mergedTaskBranches: number; currentBranch: string | null; repositoryRoot: string } | null>(null)
const worktrees = shallowRef<readonly TaskWorktreeCleanItem[]>([])
const taskBranches = shallowRef<readonly TaskBranchCleanItem[]>([])
const selectedWorktrees = ref<readonly string[]>([])
const selectedBranches = ref<readonly string[]>([])
const busy = ref(false)
const busyLabel = ref('')
const actionError = ref('')
const actionNotice = ref('')

/** 强制清理含未提交改动的确认目标；null 表示弹窗关闭。 */
const forceTargets = shallowRef<readonly TaskWorktreeCleanItem[] | null>(null)

/** 本节盘点的项目路径；由顶部选择器决定，默认跟随应用当前项目。 */
const selectedPath = ref(projectStore.currentProject?.path ?? '')
/** 用户是否在本节手动选过项目：手动选过之后不再跟着左侧当前项目跳动。 */
const pickedByUser = ref(false)

/** 选择器的候选项来自同一份项目列表；已选项目被移除时补一条，避免选中值退化成空标签。 */
const projectGroups = computed(() => {
  const options = projectStore.projects.map((project) => ({
    value: project.path,
    label: project.name,
    description: project.path
  }))
  if (selectedPath.value !== '' && !options.some((option) => option.value === selectedPath.value)) {
    options.push({ value: selectedPath.value, label: selectedPath.value, description: '该项目已不在侧栏列表中' })
  }
  return [{ options }]
})

const projectPath = computed(() => selectedPath.value)
const inFlight = computed(() => busy.value)

/** 已合入或孤立的干净工作树：可以被「一键清理」直接覆盖的安全子集。 */
const safeCleanableWorktrees = computed(() => worktrees.value.filter((item) => (
  item.status !== null && item.status.isClean && (item.isOrphan || item.phase === 'merged' || item.phase === 'removed')
)))

const dirtyWorktrees = computed(() => worktrees.value.filter((item) => (
  item.status !== null && !item.status.isClean
)))

const removableBranches = computed(() => taskBranches.value.filter((item) => (
  item.isMerged && !item.isUsedByWorktree
)))

const allWorktreesSelected = computed(() => (
  safeCleanableWorktrees.value.length > 0
  && safeCleanableWorktrees.value.every((item) => selectedWorktrees.value.includes(item.path))
))

const allBranchesSelected = computed(() => (
  removableBranches.value.length > 0
  && removableBranches.value.every((item) => selectedBranches.value.includes(item.name))
))

const selectedWorktreeItems = computed(() => (
  worktrees.value.filter((item) => selectedWorktrees.value.includes(item.path))
))

/** 选中项里含未提交改动的部分：清理它们必须走强制确认，不能因为一次普通点击就丢掉改动。 */
const dirtySelected = computed(() => selectedWorktreeItems.value.filter((item) => item.status !== null && !item.status.isClean))

/** 把字节换算成可读体积；只用于展示规模，不做精确计量。 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const date = new Date(seconds * 1000)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** 工作树状态文案：把「干净 / 有改动 / 登记已失效」区分开，颜色不是唯一信息载体。 */
function worktreeStateLabel(item: TaskWorktreeCleanItem): string {
  if (item.isPrunable) return '登记已失效'
  if (item.status === null) return '状态未知'
  if (item.status.isClean) return '无改动'
  return `${item.status.changedFileCount} 改动 / ${item.status.untrackedFileCount} 未跟踪`
}

/** 归属文案：孤立与已合入要能一眼分开，因为它们对应的处置动作不同。 */
function worktreeOwnerLabel(item: TaskWorktreeCleanItem): string {
  if (item.isOrphan) return '孤立'
  if (item.phase === 'merged') return '已合入待清理'
  if (item.phase === 'removed') return '目录已移除'
  if (item.phase === 'ready') return '可继续使用'
  return item.phase ?? '未知'
}

/** 标签与控件的 DOM id 只用于本页关联，不能直接用含斜杠的路径；同位保存一份安全的键。 */
function worktreeDomId(item: TaskWorktreeCleanItem): string {
  return `git-worktree-${item.path.replace(/[^A-Za-z0-9_-]/gu, '_')}`
}

function toggleWorktree(path: string, checked: boolean): void {
  selectedWorktrees.value = checked
    ? [...selectedWorktrees.value, path]
    : selectedWorktrees.value.filter((item) => item !== path)
}

/** 分支名里的斜杠同样要换成安全字符，保证 label 与 checkbox 的关联可靠。 */
function branchDomId(name: string): string {
  return `git-branch-${name.replace(/[^A-Za-z0-9_-]/gu, '_')}`
}

function toggleBranch(name: string, checked: boolean): void {
  selectedBranches.value = checked
    ? [...selectedBranches.value, name]
    : selectedBranches.value.filter((item) => item !== name)
}

function selectAllWorktrees(): void {
  selectedWorktrees.value = allWorktreesSelected.value ? [] : safeCleanableWorktrees.value.map((item) => item.path)
}

function selectAllBranches(): void {
  selectedBranches.value = allBranchesSelected.value ? [] : removableBranches.value.map((item) => item.name)
}

/** 丢弃已不存在的选择，避免盘点后仍对着已消失的条目发请求。 */
function reconcileSelection(): void {
  const worktreePaths = new Set(worktrees.value.map((item) => item.path))
  const branchNames = new Set(taskBranches.value.map((item) => item.name))
  selectedWorktrees.value = selectedWorktrees.value.filter((path) => worktreePaths.has(path))
  selectedBranches.value = selectedBranches.value.filter((name) => branchNames.has(name))
}

/** 重新盘点；失败时保留上次成功展示的清单，只在顶部说明原因。 */
async function refresh(): Promise<void> {
  const target = projectPath.value
  if (target === '') {
    view.value = { phase: 'not-repository' }
    summary.value = null
    worktrees.value = []
    taskBranches.value = []
    return
  }
  const bridge = window.desktop
  if (!bridge || typeof bridge.getGitCleanupSummary !== 'function') {
    view.value = { phase: 'unsupported' }
    return
  }
  if (view.value.phase !== 'ready') view.value = { phase: 'loading' }
  actionError.value = ''
  try {
    const result = await bridge.getGitCleanupSummary({ projectPath: target })
    // 盘点期间切了项目：丢弃这份迟到结果，不用别的项目的数据覆盖当前展示。
    if (target !== projectPath.value) return
    if (!result.ok) {
      view.value = { phase: 'error', message: result.error.message }
      return
    }
    summary.value = result.summary
    worktrees.value = result.worktrees
    taskBranches.value = result.taskBranches
    view.value = result.isRepository ? { phase: 'ready' } : { phase: 'not-repository' }
    reconcileSelection()
  } catch (error) {
    view.value = { phase: 'error', message: error instanceof Error ? error.message : '读取 Git 清理概览失败。' }
  }
}

/** 统一包裹一次清理动作：置忙、清空提示、执行、重新盘点。 */
async function runAction(label: string, action: () => Promise<void>): Promise<void> {
  if (busy.value) return
  busy.value = true
  busyLabel.value = label
  actionError.value = ''
  actionNotice.value = ''
  try {
    await action()
  } finally {
    busy.value = false
    busyLabel.value = ''
  }
}

async function pruneWorktrees(): Promise<void> {
  const target = projectPath.value
  const bridge = window.desktop
  if (target === '' || !bridge) return
  await runAction('正在修剪失效登记', async () => {
    const result = await bridge.pruneWorktrees({ projectPath: target })
    if (!result.ok) actionError.value = result.error.message
    else actionNotice.value = result.prunedCount > 0 ? `已修剪 ${result.prunedCount} 条失效工作树登记。` : '没有需要修剪的失效登记。'
    await refresh()
  })
}

async function removeWorktrees(targets: readonly TaskWorktreeCleanItem[], force: boolean): Promise<void> {
  const target = projectPath.value
  const bridge = window.desktop
  if (target === '' || !bridge || targets.length === 0) return
  await runAction(force ? '正在强制清理工作树' : '正在清理工作树', async () => {
    const result = await bridge.removeWorktrees({
      projectPath: target,
      worktreePaths: targets.map((item) => item.path),
      force,
      deleteBranch: true
    })
    if (!result.ok) {
      actionError.value = result.error.message
    } else {
      const failed = result.errors.length > 0 ? `，${result.failedCount} 项未清理：${result.errors.join('；')}` : ''
      actionNotice.value = `已清理 ${result.removedCount} 个工作树${failed}`
    }
    await refresh()
  })
}

/** 选中项含未提交改动时先弹确认，其余直接执行。 */
async function cleanSelectedWorktrees(): Promise<void> {
  const targets = selectedWorktreeItems.value
  if (targets.length === 0) return
  if (dirtySelected.value.length > 0) {
    forceTargets.value = targets
    return
  }
  await removeWorktrees(targets, false)
}

async function confirmForceRemove(): Promise<void> {
  const targets = forceTargets.value
  forceTargets.value = null
  if (targets === null) return
  await removeWorktrees(targets, true)
}

async function removeSelectedBranches(): Promise<void> {
  const target = projectPath.value
  const bridge = window.desktop
  if (target === '' || !bridge || selectedBranches.value.length === 0) return
  await runAction('正在删除临时分支', async () => {
    const result = await bridge.removeTaskBranches({ projectPath: target, branchNames: selectedBranches.value, force: false })
    if (!result.ok) {
      actionError.value = result.error.message
    } else {
      const failed = result.errors.length > 0 ? `，${result.failedCount} 项未删除：${result.errors.join('；')}` : ''
      actionNotice.value = `已删除 ${result.removedCount} 个任务分支${failed}`
    }
    await refresh()
  })
}

async function runGc(): Promise<void> {
  const target = projectPath.value
  const bridge = window.desktop
  if (target === '' || !bridge) return
  await runAction('正在回收仓库空间', async () => {
    const result = await bridge.runGitGc({ projectPath: target })
    if (!result.ok) {
      actionError.value = result.error.message
    } else {
      actionNotice.value = `垃圾回收完成，释放约 ${formatBytes(result.data.freedBytes)}（${formatBytes(result.data.beforeBytes)} → ${formatBytes(result.data.afterBytes)}）。`
    }
    await refresh()
  })
}

// 本项目选择器手动选过之后不再跟随左侧当前项目；否则保持「默认看当前项目」。
watch(selectedPath, (value) => {
  if (value !== (projectStore.currentProject?.path ?? '')) pickedByUser.value = true
})

// 左侧切换当前项目：用户没在本节手动选过时跟着看新项目，选过就保持他自己的选择。
watch(() => projectStore.currentProject?.path ?? '', (path) => {
  if (pickedByUser.value || path === '') return
  selectedPath.value = path
})

// 换项目就重新盘点：清单永远对应所选项目，不沿用上一个仓库的数字。
watch(projectPath, () => {
  selectedWorktrees.value = []
  selectedBranches.value = []
  actionNotice.value = ''
  actionError.value = ''
  void refresh()
})

onMounted(() => {
  void refresh()
})
</script>

<template>
  <div class="settings-section-stack">
    <header>
      <h1 class="text-xl font-semibold tracking-tight">Git</h1>
      <p class="mt-1 text-sm text-desk-muted">
        管理任务工作树与临时分支的残留，并回收仓库空间。这里只处理应用自己建立的资源，不触碰你的普通分支与工作树。
      </p>
    </header>

    <!-- 0. 盘点目标项目 -->
    <section class="settings-section" aria-labelledby="settings-git-target-title">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-git-target-title" class="settings-section-title">当前查看的项目</h2>
          <p class="mt-1 text-xs text-desk-muted">
            选择要盘点的项目；这里切换只改变本页的清理对象，不改变应用当前项目。
          </p>
        </div>
      </div>

      <p v-if="projectStore.projects.length === 0" class="mt-4 text-xs text-desk-muted" role="status">
        还没有任何项目，请先在左侧添加项目。
      </p>
      <div v-else class="mt-4 space-y-1">
        <span class="field-label">项目</span>
        <AppSelect
          id="git-cleanup-project"
          v-model="selectedPath"
          label="项目"
          searchable
          search-placeholder="搜索项目…"
          empty-label="选择项目"
          empty-results-label="没有匹配的项目"
          :groups="projectGroups"
          :disabled="inFlight"
        />
      </div>
    </section>

    <!-- 1. 仓库概览 -->
    <section class="settings-section" aria-labelledby="settings-git-overview-title" :aria-busy="inFlight">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-git-overview-title" class="settings-section-title">仓库概览</h2>
          <p class="mt-1 text-xs text-desk-muted">
            盘点项目：<code class="font-mono">{{ projectPath === '' ? '未选择项目' : projectPath }}</code>
          </p>
        </div>
        <AppButton variant="compact" :disabled="inFlight || projectPath === ''" @click="refresh">刷新</AppButton>
      </div>

      <p v-if="view.phase === 'loading'" class="mt-4 text-xs text-desk-muted" role="status">正在读取仓库信息…</p>
      <p v-else-if="view.phase === 'unsupported'" class="mt-4 text-xs text-desk-muted" role="status">
        当前版本未提供 Git 清理接口，请确认应用已完整加载。
      </p>
      <p v-else-if="view.phase === 'error'" class="mt-4 text-xs text-desk-danger" role="alert">{{ view.message }}</p>
      <p v-else-if="view.phase === 'not-repository'" class="mt-4 text-xs text-desk-muted" role="status">
        {{ projectPath === '' ? '请先在顶部选择要盘点的项目。' : '所选项目不是 Git 仓库，没有可清理的资源。' }}
      </p>
      <template v-else-if="summary !== null">
        <dl class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div class="rounded-desk-sm border border-desk-line bg-desk-canvas-sunken px-3 py-2">
            <dt class="text-2xs text-desk-muted">.git 体积</dt>
            <dd class="mt-0.5 text-sm font-semibold">{{ formatBytes(summary.gitDirBytes) }}</dd>
          </div>
          <div class="rounded-desk-sm border border-desk-line bg-desk-canvas-sunken px-3 py-2">
            <dt class="text-2xs text-desk-muted">当前分支</dt>
            <dd class="mt-0.5 truncate text-sm font-semibold" :title="summary.currentBranch ?? '游离 HEAD'">{{ summary.currentBranch ?? '游离 HEAD' }}</dd>
          </div>
          <div class="rounded-desk-sm border border-desk-line bg-desk-canvas-sunken px-3 py-2">
            <dt class="text-2xs text-desk-muted">托管工作树</dt>
            <dd class="mt-0.5 text-sm font-semibold">{{ worktrees.length }}</dd>
          </div>
          <div class="rounded-desk-sm border border-desk-line bg-desk-canvas-sunken px-3 py-2">
            <dt class="text-2xs text-desk-muted">临时任务分支</dt>
            <dd class="mt-0.5 text-sm font-semibold">{{ summary.totalTaskBranches }}</dd>
          </div>
        </dl>
        <p class="mt-3 text-2xs text-desk-muted">
          仓库根：<code class="font-mono">{{ summary.repositoryRoot }}</code>。体积为目录累加估算值，仅用于判断规模。
        </p>
      </template>
    </section>

    <!-- 2. 任务工作树 -->
    <section v-if="view.phase === 'ready'" class="settings-section" aria-labelledby="settings-git-worktrees-title" :aria-busy="inFlight">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-git-worktrees-title" class="settings-section-title">任务工作树</h2>
          <p class="mt-1 text-xs text-desk-muted">
            应用为隔离任务建在 <code class="font-mono">.pi/worktrees/</code> 下的工作树。孤立表示没有任何会话登记它，通常可以安全清理。
          </p>
        </div>
        <span class="text-2xs text-desk-muted">{{ summary?.orphanWorktrees ?? 0 }} 个孤立 · {{ summary?.prunableWorktrees ?? 0 }} 个失效登记</span>
      </div>

      <p v-if="worktrees.length === 0" class="mt-3 text-xs text-desk-muted" role="status">没有托管任务工作树。</p>
      <template v-else>
        <ul class="mt-3 max-h-80 space-y-1.5 overflow-y-auto scroll-area">
          <li
            v-for="item in worktrees"
            :key="item.path"
            class="flex items-start gap-3 rounded-desk-sm border border-desk-line bg-desk-surface px-3 py-2 text-xs"
          >
            <input
              :id="worktreeDomId(item)"
              type="checkbox"
              class="mt-0.5"
              :checked="selectedWorktrees.includes(item.path)"
              :disabled="inFlight || item.isPrunable"
              @change="toggleWorktree(item.path, ($event.target as HTMLInputElement).checked)"
            />
            <label :for="worktreeDomId(item)" class="min-w-0 flex-1 cursor-pointer">
              <span class="flex flex-wrap items-center gap-1.5">
                <code class="truncate font-mono text-[11px]">{{ item.branch ?? '游离 HEAD' }}</code>
                <span class="rounded-full border border-desk-line px-1.5 py-px text-2xs text-desk-muted">{{ worktreeOwnerLabel(item) }}</span>
                <span
                  class="rounded-full border px-1.5 py-px text-2xs"
                  :class="item.status !== null && !item.status.isClean
                    ? 'border-desk-danger/40 text-desk-danger'
                    : 'border-desk-line text-desk-muted'"
                >{{ worktreeStateLabel(item) }}</span>
              </span>
              <span class="mt-0.5 block truncate font-mono text-2xs text-desk-muted" :title="item.path">{{ item.path }}</span>
            </label>
          </li>
        </ul>

        <div class="settings-row">
          <div class="flex flex-wrap items-center gap-2">
            <AppButton variant="compact" :disabled="inFlight || safeCleanableWorktrees.length === 0" @click="selectAllWorktrees">
              {{ allWorktreesSelected ? '取消全选' : '全选可清理项' }}
            </AppButton>
            <AppButton
              variant="quiet-danger"
              :disabled="inFlight || selectedWorktrees.length === 0"
              @click="cleanSelectedWorktrees"
            >
              清理所选（{{ selectedWorktrees.length }}）
            </AppButton>
          </div>
          <AppButton variant="compact" :disabled="inFlight" @click="pruneWorktrees">修剪失效登记</AppButton>
        </div>
        <p v-if="dirtyWorktrees.length > 0" class="mt-2 text-2xs text-desk-muted">
          其中 {{ dirtyWorktrees.length }} 个仍有未提交改动；清理它们会丢弃这些改动，需要再次确认。
        </p>
      </template>
    </section>

    <!-- 3. 临时任务分支 -->
    <section v-if="view.phase === 'ready'" class="settings-section" aria-labelledby="settings-git-branches-title" :aria-busy="inFlight">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-git-branches-title" class="settings-section-title">临时任务分支</h2>
          <p class="mt-1 text-xs text-desk-muted">
            <code class="font-mono">pi/task-*</code> 分支。已被工作树占用的分支无法删除，已合入的分支可以安全清理。
          </p>
        </div>
        <span class="text-2xs text-desk-muted">{{ summary?.mergedTaskBranches ?? 0 }} 个已合入</span>
      </div>

      <p v-if="taskBranches.length === 0" class="mt-3 text-xs text-desk-muted" role="status">没有临时任务分支。</p>
      <template v-else>
        <ul class="mt-3 max-h-80 space-y-1.5 overflow-y-auto scroll-area">
          <li
            v-for="item in taskBranches"
            :key="item.name"
            class="flex items-start gap-3 rounded-desk-sm border border-desk-line bg-desk-surface px-3 py-2 text-xs"
          >
            <input
              :id="branchDomId(item.name)"
              type="checkbox"
              class="mt-0.5"
              :checked="selectedBranches.includes(item.name)"
              :disabled="inFlight || item.isUsedByWorktree"
              @change="toggleBranch(item.name, ($event.target as HTMLInputElement).checked)"
            />
            <label :for="branchDomId(item.name)" class="min-w-0 flex-1 cursor-pointer">
              <span class="flex flex-wrap items-center gap-1.5">
                <code class="truncate font-mono text-[11px]">{{ item.name }}</code>
                <span class="rounded-full border border-desk-line px-1.5 py-px text-2xs text-desk-muted">
                  {{ item.isUsedByWorktree ? '工作树占用中' : item.isMerged ? '已合入' : '未合入' }}
                </span>
                <span class="text-2xs text-desk-muted">{{ formatTime(item.commitTime) }}</span>
              </span>
              <span class="mt-0.5 block truncate text-2xs text-desk-muted" :title="item.commitSubject">{{ item.commitSubject || '（无提交说明）' }}</span>
            </label>
          </li>
        </ul>

        <div class="settings-row">
          <AppButton variant="compact" :disabled="inFlight || removableBranches.length === 0" @click="selectAllBranches">
            {{ allBranchesSelected ? '取消全选' : '全选可删除项' }}
          </AppButton>
          <AppButton variant="quiet-danger" :disabled="inFlight || selectedBranches.length === 0" @click="removeSelectedBranches">
            删除所选（{{ selectedBranches.length }}）
          </AppButton>
        </div>
      </template>
    </section>

    <!-- 4. 仓库维护与自动清理策略 -->
    <section v-if="view.phase === 'ready'" class="settings-section" aria-labelledby="settings-git-maintenance-title" :aria-busy="inFlight">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-git-maintenance-title" class="settings-section-title">仓库维护</h2>
          <p class="mt-1 text-xs text-desk-muted">
            垃圾回收会重写打包文件并清理不可达对象；仓库很大时耗时较长，期间不要关闭应用。
          </p>
        </div>
        <AppButton variant="compact" :disabled="inFlight" @click="runGc">立即回收空间</AppButton>
      </div>

      <div class="settings-row">
        <div class="min-w-0">
          <p class="text-sm font-medium">合入后默认清理工作树</p>
          <p class="mt-1 text-xs text-desk-muted">开启后，合入任务时默认勾选一并清理；仍可在合入弹窗里改回。</p>
        </div>
        <div class="segment w-full sm:w-64" role="group" aria-label="合入后默认清理工作树">
          <AppButton
            v-for="option in [{ value: false, label: '关闭' }, { value: true, label: '开启' }]"
            :key="String(option.value)"
            variant="unstyled"
            class="segment-option"
            :class="gitAutoCleanWorktreeOnMerge === option.value ? 'is-selected' : ''"
            :aria-pressed="gitAutoCleanWorktreeOnMerge === option.value"
            :disabled="!ready"
            @click="preferencesStore.setGitAutoCleanWorktreeOnMerge(option.value)"
          >
            {{ option.label }}
          </AppButton>
        </div>
      </div>

      <div class="settings-row">
        <div class="min-w-0">
          <p class="text-sm font-medium">删除会话时清理关联工作树</p>
          <p class="mt-1 text-xs text-desk-muted">只清理没有未提交改动的关联工作树；有改动的一律保留。</p>
        </div>
        <div class="segment w-full sm:w-64" role="group" aria-label="删除会话时清理关联工作树">
          <AppButton
            v-for="option in [{ value: false, label: '关闭' }, { value: true, label: '开启' }]"
            :key="String(option.value)"
            variant="unstyled"
            class="segment-option"
            :class="gitAutoCleanWorktreeOnSessionDelete === option.value ? 'is-selected' : ''"
            :aria-pressed="gitAutoCleanWorktreeOnSessionDelete === option.value"
            :disabled="!ready"
            @click="preferencesStore.setGitAutoCleanWorktreeOnSessionDelete(option.value)"
          >
            {{ option.label }}
          </AppButton>
        </div>
      </div>
    </section>

    <p v-if="actionError !== ''" class="text-xs text-desk-danger" role="alert">{{ actionError }}</p>
    <p v-else-if="actionNotice !== ''" class="text-xs text-desk-muted" role="status">{{ actionNotice }}</p>
    <p v-if="inFlight" class="text-2xs text-desk-muted" role="status">{{ busyLabel }}…</p>

    <ConfirmDialog
      :open="forceTargets !== null"
      title="这些工作树还有未提交的改动"
      description="清理会连同未提交的改动一起丢弃，无法从工作树恢复。确认只保留已提交的内容。"
      :detail="forceTargets === null ? '' : forceTargets.map((item) => item.path).join('\n')"
      confirm-label="仍然清理"
      confirm-variant="danger"
      :confirm-disabled="inFlight"
      @confirm="confirmForceRemove"
      @cancel="forceTargets = null"
    />
  </div>
</template>
