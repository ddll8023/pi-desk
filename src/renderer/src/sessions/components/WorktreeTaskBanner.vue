<!-- 任务生命周期入口：固定目标、阻止未保存编辑被清理，并单独确认受影响的运行终端；合入弹窗的默认清理勾选跟随偏好。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import type { WorkspaceContext } from '../../../../shared/workspace-api'
import { useWorkspaceTabsStore } from '../../workspace/stores/workspace-tabs'
import { useTaskWorkspacesStore } from '../../workspace/stores/task-workspaces'
import { useTerminalStore } from '../../workspace/stores/terminal'
import { useProjectEditorStore } from '../../editor/stores/project-editor'
import { usePreferencesStore } from '../../preferences/stores/preferences'
import { useSessionStore } from '../stores/session'
import AppButton from '../../ui/AppButton.vue'
import ConfirmDialog from '../../ui/ConfirmDialog.vue'

const tabs = useWorkspaceTabsStore(), workspaces = useTaskWorkspacesStore(), terminals = useTerminalStore(), editors = useProjectEditorStore()
const preferences = usePreferencesStore()
const activeWorktree = computed(() => tabs.activeWorktree)
const mergeTarget = ref<WorkspaceContext | null>(null), discardTarget = ref<WorkspaceContext | null>(null)
const mergeDialogOpen = ref(false), discardDialogOpen = ref(false), busy = ref(false)
const mergeError = ref<string | null>(null), discardError = ref<string | null>(null)
const squashMerge = ref(false), deleteAfterMerge = ref(true), closeMergeTerminals = ref(false), closeDiscardTerminals = ref(false)
const worktreeStatus = ref<{ changedCount: number; untrackedCount: number; runningTerminals: number; destinationRunningTerminals: number } | null>(null)
const scope = (workspace: WorkspaceContext) => ({ projectPath: workspace.projectPath, workspaceId: workspace.id })
const mergeTerminalCount = computed(() => (worktreeStatus.value?.runningTerminals ?? 0) + (worktreeStatus.value?.destinationRunningTerminals ?? 0))
function affectedIds(target: WorkspaceContext, destination: boolean): string[] {
  const root = target.repositoryPath?.replace(/\\/g, '/').replace(/\/$/, '')
  return [...new Set([target.id, ...Object.values(workspaces.workspaces).filter(item => {
    const path = item.rootPath.replace(/\\/g, '/')
    return destination && root && item.kind === 'project' && (path === root || path.startsWith(`${root}/`))
  }).map(item => item.id)])]
}
function lock(ids: readonly string[]): string | null {
  if (Object.values(editors.records).some(record => ids.includes(record.workspaceId) && (record.dirty || record.saving || record.richDraft !== null))) return '受影响工作区有未保存或正在保存的文件，请先保存或关闭这些编辑，再处理任务。'
  return workspaces.beginOperation(ids) ? null : '工作区正在处理另一项操作。'
}
async function loadStatus(target: WorkspaceContext, kind: 'merge' | 'discard'): Promise<void> {
  const bridge = window.desktop
  const report = (message: string): void => { if (kind === 'merge') mergeError.value = message; else discardError.value = message }
  if (!bridge) { report('桌面桥接不可用。'); return }
  try {
    const result = await bridge.getWorktreeStatus(scope(target))
    if (kind === 'merge' ? !mergeDialogOpen.value || mergeTarget.value?.id !== target.id : !discardDialogOpen.value || discardTarget.value?.id !== target.id) return
    if (!result.ok) { report(result.error.message); return }
    workspaces.accept(result.workspace)
    worktreeStatus.value = { changedCount: result.status.changedFileCount, untrackedCount: result.status.untrackedFileCount,
      runningTerminals: result.runningTerminals, destinationRunningTerminals: result.destinationRunningTerminals }
  } catch (error) { report(error instanceof Error ? error.message : '读取工作区状态失败。') }
}
async function openMergeDialog(): Promise<void> {
  const target = activeWorktree.value
  if (!target || target.phase !== 'ready' || busy.value) return
  mergeTarget.value = target; mergeError.value = null; worktreeStatus.value = null; closeMergeTerminals.value = false
  // 默认勾选值跟随设置页的偏好；用户仍可在本次弹窗里改回，改动不回写偏好。
  deleteAfterMerge.value = preferences.gitAutoCleanWorktreeOnMerge
  discardDialogOpen.value = false; mergeDialogOpen.value = true
  await loadStatus(target, 'merge')
}
async function requestDiscard(): Promise<void> {
  const target = activeWorktree.value
  if (!target || !['ready', 'merged'].includes(target.phase) || busy.value) return
  discardTarget.value = target; discardError.value = null; worktreeStatus.value = null; closeDiscardTerminals.value = false
  mergeDialogOpen.value = false; discardDialogOpen.value = true
  await loadStatus(target, 'discard')
}
async function handleConfirmMerge(): Promise<void> {
  const target = mergeTarget.value, bridge = window.desktop
  if (!target || !bridge || busy.value || !worktreeStatus.value || mergeTerminalCount.value > 0 && !closeMergeTerminals.value) return
  if (workspaces.of(target.id)?.phase !== 'ready') { mergeError.value = '任务状态已变化，未重复合入。'; return }
  const ids = affectedIds(target, true), blocked = lock(ids)
  if (blocked) { mergeError.value = blocked; return }
  busy.value = true; mergeError.value = null
  try {
    const result = await bridge.mergeWorktree({ ...scope(target), squash: squashMerge.value, deleteAfterMerge: deleteAfterMerge.value, closeTerminals: closeMergeTerminals.value })
    if (!result.ok) { mergeError.value = result.error.message; workspaces.fail(result.error.message); return }
    workspaces.accept(result.workspace)
    if (result.cleanupError) workspaces.fail(`任务已合入；清理未完整完成：${result.cleanupError}`)
    mergeDialogOpen.value = false
  } catch (error) {
    const message = error instanceof Error ? error.message : '合入结果未知，未自动重试。'
    mergeError.value = message; workspaces.fail(message)
  } finally { workspaces.endOperation(ids); busy.value = false; void terminals.ensureLoaded() }
}
async function newProjectConversation(): Promise<void> {
  const target = activeWorktree.value
  if (!target || busy.value) return
  const intent = await tabs.openNewChatTab(target.projectPath, null)
  if (intent) await useSessionStore().openIntent(intent)
}
async function handleConfirmDiscard(): Promise<void> {
  const target = discardTarget.value, bridge = window.desktop
  if (!target || !bridge || busy.value || !worktreeStatus.value || worktreeStatus.value.runningTerminals > 0 && !closeDiscardTerminals.value) return
  const ids = affectedIds(target, false), blocked = lock(ids)
  if (blocked) { discardError.value = blocked; return }
  busy.value = true; discardError.value = null
  try {
    const result = await bridge.removeWorktree({ ...scope(target), deleteBranch: true, force: target.phase !== 'merged', closeTerminals: closeDiscardTerminals.value })
    if (!result.ok) { discardError.value = result.error.message; workspaces.fail(result.error.message); return }
    workspaces.accept(result.workspace)
    if (result.workspace.problem) workspaces.fail(result.workspace.problem)
    discardDialogOpen.value = false
  } catch (error) {
    const message = error instanceof Error ? error.message : '清理结果未知，未自动重试。'
    discardError.value = message; workspaces.fail(message)
  } finally { workspaces.endOperation(ids); busy.value = false; void terminals.ensureLoaded() }
}
</script>

<template>
  <div v-if="activeWorktree" class="worktree-task-banner px-4 py-2 bg-neutral-900/80 border-t border-neutral-800 flex items-center justify-between text-xs text-neutral-300" :aria-busy="busy">
    <div class="flex items-center gap-2 overflow-hidden">
      <span class="font-medium text-neutral-200">任务工作区：</span>
      <code class="px-1.5 py-0.5 rounded bg-neutral-800 text-emerald-400 font-mono text-[11px] truncate max-w-[240px]">{{ activeWorktree.branch }}</code>
      <span v-if="activeWorktree.phase === 'removed'" class="text-neutral-400">已结束；保留对话历史，不切回主目录</span>
      <span v-else-if="activeWorktree.phase === 'merged'" class="text-neutral-400">已合入，待清理</span>
      <span v-else-if="activeWorktree.phase !== 'ready'" class="text-neutral-400">当前不可执行：{{ activeWorktree.phase }}</span>
    </div>
    <div class="flex items-center gap-2 shrink-0">
      <AppButton v-if="['merged', 'removed', 'failed'].includes(activeWorktree.phase)" variant="compact" :disabled="busy" @click="newProjectConversation">在项目工作区新建对话</AppButton>
      <AppButton v-if="activeWorktree.phase === 'ready'" variant="compact" :disabled="busy" @click="openMergeDialog">审阅并合并</AppButton>
      <AppButton v-if="activeWorktree.phase === 'ready' || activeWorktree.phase === 'merged'" variant="ghost" class="text-rose-400 hover:text-rose-300" :disabled="busy" @click="requestDiscard">{{ activeWorktree.phase === 'merged' ? '重试清理' : '放弃' }}</AppButton>
    </div>
  </div>
  <ConfirmDialog
    :open="mergeDialogOpen" title="将任务改动合入原工作区？"
    :description="`目标任务分支：${mergeTarget?.branch ?? ''}。合入目标固定为创建任务时的项目分支，不随当前标签变化。`"
    :detail="mergeTarget?.rootPath ?? ''"
    :confirm-label="busy ? '正在合入…' : '确认合入'" :confirm-disabled="busy || worktreeStatus === null || (mergeTerminalCount > 0 && !closeMergeTerminals)"
    @confirm="handleConfirmMerge" @cancel="mergeDialogOpen = false"
  >
    <template #body>
      <div class="mt-3 space-y-2 text-xs text-neutral-400">
        <p v-if="worktreeStatus">当前未提交文件：{{ worktreeStatus.changedCount }}；未跟踪文件：{{ worktreeStatus.untrackedCount }}。这不是任务累计差异。</p>
        <label class="flex items-center gap-2"><input v-model="deleteAfterMerge" type="checkbox" :disabled="busy"><span>合入成功后清理任务工作树与临时分支</span></label>
        <label class="flex items-center gap-2"><input v-model="squashMerge" type="checkbox" :disabled="busy"><span>压缩为单个提交（Squash）</span></label>
        <label class="flex items-center gap-2"><input v-model="closeMergeTerminals" type="checkbox" :disabled="busy"><span>允许关闭任务与合入目标工作区的运行终端（当前 {{ mergeTerminalCount }} 个）</span></label>
        <p>有未保存编辑或执行中会话时拒绝合入；空闲会话先停止运行并保留历史。</p>
        <p v-if="mergeError" class="text-rose-400" role="alert">{{ mergeError }}</p>
      </div>
    </template>
  </ConfirmDialog>
  <ConfirmDialog
    :open="discardDialogOpen" :title="discardTarget?.phase === 'merged' ? '清理已合入任务？' : '放弃任务工作区？'"
    :description="discardTarget?.phase === 'merged' ? '仅清理发起操作时固定的工作区；若出现新的未提交修改则拒绝删除。' : '确认后删除此任务工作树及临时分支，未合入改动将丢弃；对话历史仍保留。'"
    :detail="discardTarget?.rootPath ?? ''"
    :confirm-label="busy ? '正在清理…' : '确认清理'" confirm-variant="danger"
    :confirm-disabled="busy || worktreeStatus === null || ((worktreeStatus?.runningTerminals ?? 0) > 0 && !closeDiscardTerminals)"
    @confirm="handleConfirmDiscard" @cancel="discardDialogOpen = false"
  >
    <template #body>
      <label class="flex items-center gap-2 text-xs"><input v-model="closeDiscardTerminals" type="checkbox" :disabled="busy"><span>允许关闭本任务的运行终端（当前 {{ worktreeStatus?.runningTerminals ?? 0 }} 个）</span></label>
      <p v-if="discardError" class="text-rose-400" role="alert">{{ discardError }}</p>
    </template>
  </ConfirmDialog>
</template>
