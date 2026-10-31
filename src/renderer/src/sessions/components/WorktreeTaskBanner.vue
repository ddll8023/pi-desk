<!-- 隔离工作树任务状态条：展示当前会话绑定的工作树分支名，并提供审阅合入、自动清理与放弃工作树的保护闭环。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useWorkspaceTabsStore } from '../../workspace/stores/workspace-tabs'
import AppButton from '../../ui/AppButton.vue'
import ConfirmDialog from '../../ui/ConfirmDialog.vue'

const workspaceTabsStore = useWorkspaceTabsStore()
const activeWorktree = computed(() => workspaceTabsStore.activeWorktree)

// 合并弹窗状态
const mergeDialogOpen = ref(false)
const mergeLoading = ref(false)
const mergeError = ref<string | null>(null)
const squashMerge = ref(false)
const deleteAfterMerge = ref(true)
const worktreeStatus = ref<{ changedCount: number; untrackedCount: number } | null>(null)

// 放弃弹窗状态
const discardDialogOpen = ref(false)
const discardLoading = ref(false)

async function openMergeDialog(): Promise<void> {
  const wt = activeWorktree.value
  if (!wt || !window.desktop) return
  mergeError.value = null
  mergeDialogOpen.value = true
  const res = await window.desktop.getWorktreeStatus({ worktreePath: wt.path })
  if (res.ok) {
    worktreeStatus.value = {
      changedCount: res.status.changedFileCount,
      untrackedCount: res.status.untrackedFileCount
    }
  } else {
    worktreeStatus.value = null
  }
}

async function handleConfirmMerge(): Promise<void> {
  const wt = activeWorktree.value
  if (!wt || !window.desktop || mergeLoading.value) return
  mergeLoading.value = true
  mergeError.value = null
  try {
    const res = await window.desktop.mergeWorktree({
      worktreePath: wt.path,
      squash: squashMerge.value,
      deleteAfterMerge: deleteAfterMerge.value
    })
    if (!res.ok) {
      mergeError.value = res.error.message
      return
    }
    // 合并并清理成功
    if (deleteAfterMerge.value && workspaceTabsStore.activeTab) {
      workspaceTabsStore.clearWorktreeOfTab(workspaceTabsStore.activeTab)
    }
    mergeDialogOpen.value = false
  } catch (err) {
    mergeError.value = err instanceof Error ? err.message : String(err)
  } finally {
    mergeLoading.value = false
  }
}

async function handleConfirmDiscard(): Promise<void> {
  const wt = activeWorktree.value
  if (!wt || !window.desktop || discardLoading.value) return
  discardLoading.value = true
  try {
    const res = await window.desktop.removeWorktree({
      worktreePath: wt.path,
      deleteBranch: true,
      force: true
    })
    if (res.ok && workspaceTabsStore.activeTab) {
      workspaceTabsStore.clearWorktreeOfTab(workspaceTabsStore.activeTab)
      discardDialogOpen.value = false
    }
  } catch (err) {
    console.error('放弃工作树失败：', err)
  } finally {
    discardLoading.value = false
  }
}
</script>

<template>
  <div v-if="activeWorktree" class="worktree-task-banner px-4 py-2 bg-neutral-900/80 border-t border-neutral-800 flex items-center justify-between text-xs text-neutral-300">
    <div class="flex items-center gap-2 overflow-hidden">
      <span class="inline-flex items-center justify-center w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
      <span class="font-medium text-neutral-200">隔离工作树：</span>
      <code class="px-1.5 py-0.5 rounded bg-neutral-800 text-emerald-400 font-mono text-[11px] truncate max-w-[240px]">
        {{ activeWorktree.branch }}
      </code>
      <span class="text-neutral-500 hidden sm:inline">（改动仅作用于此临时分支）</span>
    </div>

    <div class="flex items-center gap-2 shrink-0">
      <AppButton variant="secondary" size="compact" @click="openMergeDialog">
        审阅并合并
      </AppButton>
      <AppButton variant="ghost" size="compact" class="text-rose-400 hover:text-rose-300" @click="discardDialogOpen = true">
        放弃
      </AppButton>
    </div>

    <!-- 审阅并合并弹窗 -->
    <ConfirmDialog
      :open="mergeDialogOpen"
      title="将隔离任务合入主分支？"
      :description="`当前任务位于独立分支 [${activeWorktree.branch}]。确认后将把改动合并回主分支。`"
      :confirm-label="mergeLoading ? '正在合并…' : '确认合并'"
      :confirm-disabled="mergeLoading"
      @confirm="handleConfirmMerge"
      @cancel="mergeDialogOpen = false"
    >
      <template #body>
        <div class="mt-3 space-y-2 text-xs text-neutral-400">
          <div v-if="worktreeStatus" class="p-2.5 rounded bg-neutral-900 border border-neutral-800 space-y-1">
            <div class="flex justify-between">
              <span>待合入改动文件：</span>
              <span class="font-mono text-neutral-200 font-semibold">{{ worktreeStatus.changedCount }} 个</span>
            </div>
            <div v-if="worktreeStatus.untrackedCount > 0" class="flex justify-between text-amber-400/90">
              <span>未跟踪新增文件：</span>
              <span class="font-mono font-semibold">{{ worktreeStatus.untrackedCount }} 个</span>
            </div>
          </div>

          <div class="pt-2 space-y-2">
            <label class="flex items-center gap-2 cursor-pointer select-none">
              <input v-model="deleteAfterMerge" type="checkbox" class="rounded border-neutral-700 bg-neutral-800 text-emerald-600 focus:ring-0">
              <span class="text-neutral-300">合并成功后自动清理该工作树与临时分支（推荐）</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer select-none">
              <input v-model="squashMerge" type="checkbox" class="rounded border-neutral-700 bg-neutral-800 text-emerald-600 focus:ring-0">
              <span>以 Squash 模式合并（压缩为单个提交）</span>
            </label>
          </div>

          <p v-if="mergeError" class="p-2 text-rose-400 bg-rose-950/40 rounded border border-rose-900/50">
            {{ mergeError }}
          </p>
        </div>
      </template>
    </ConfirmDialog>

    <!-- 放弃工作树二次确认弹窗 -->
    <ConfirmDialog
      :open="discardDialogOpen"
      title="确认放弃并清理此工作树？"
      description="放弃后将直接删除此隔离工作树目录及关联临时分支，未合入的改动将无法找回。"
      confirm-label="确认放弃并删除"
      variant="danger"
      :confirm-disabled="discardLoading"
      @confirm="handleConfirmDiscard"
      @cancel="discardDialogOpen = false"
    />
  </div>
</template>
