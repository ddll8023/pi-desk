<!--
  弹层宿主：把应用级对话框统一经 Teleport 渲染到 body，全部落在根堆叠上下文；组件常驻挂载，
  进出由各自内部的 Transition 驱动。

  这里只持有弹层的展示派生值与「决定后做什么」：待确认目标本身由各能力 Store 持有
  （项目移除在项目 Store、会话删除与会话切换在会话 Store、文件／浏览器丢弃关闭在标签 Store、
  快捷命令的编辑与删除在快捷命令 Store），宿主不另存一份，避免两处状态不同步。
  信任决定的结果按候选项目、会话打开或 Git 写操作三种来源分派，取消则各回到原状。
-->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import ExtensionDialog from '../../sessions/components/ExtensionDialog.vue'
import QuickCommandDialog from '../../preferences/components/QuickCommandDialog.vue'
import TrustDialog from '../../projects/components/TrustDialog.vue'
import UpdateNoticeDialog from '../../updates/components/UpdateNoticeDialog.vue'
import { useGitStatusStore } from '../../git/stores/git-status'
import { useProjectStore } from '../../projects/stores/project'
import { useQuickCommandsStore } from '../../preferences/stores/quick-commands'
import { useRuntimeStore } from '../../sessions/stores/runtime'
import { useSessionStore } from '../../sessions/stores/session'
import { useSettingsStore } from '../stores/settings'
import { useUpdatesStore } from '../../updates/stores/updates'
import { useWorkspaceTabsStore } from '../../workspace/stores/workspace-tabs'
import ConfirmDialog from '../../ui/ConfirmDialog.vue'

const gitStore = useGitStatusStore()
const projectStore = useProjectStore()
const quickCommandsStore = useQuickCommandsStore()
const runtimeStore = useRuntimeStore()
const sessionStore = useSessionStore()
const settingsStore = useSettingsStore()
const updatesStore = useUpdatesStore()
const workspaceTabsStore = useWorkspaceTabsStore()
const { awaitingInterrupt, pendingReload, pendingSessionId } = storeToRefs(sessionStore)
const { pendingAddition, pendingAdditionDecision } = storeToRefs(projectStore)

/** 候选项目的信任决定：已有决定或正在等待中断确认时不再展示信任弹层。 */
const additionTrustStatus = computed(() => {
  const candidate = pendingAddition.value
  if (candidate === null || candidate.trustStatus.resources.length === 0
    || candidate.trustStatus.decision !== null || pendingAdditionDecision.value !== null) return null
  return candidate.trustStatus
})

/** 中断确认的文案按来源分档：重新加载资源与切换会话的理由不同，不能共用一句。 */
const sessionConfirmDetail = computed(() => {
  if (pendingReload.value) return '重新加载 Pi 资源（重建会话服务，保留当前会话）'
  return pendingSessionId.value === null ? '新建会话' : `会话 ${pendingSessionId.value.slice(0, 8)}`
})
const sessionConfirmTitle = computed(() => (
  pendingReload.value ? '停止运行中的操作并重新加载资源？' : '停止运行中的操作并切换会话？'
))
const sessionConfirmDescription = computed(() => (
  pendingReload.value
    ? 'Pi 在会话建立或重载时读取 Skills、Prompt Templates、MCP 配置与 Extension，因此重新加载需要重建会话服务；已提交的内容不会重放。'
    : '切换会话会先停止当前 Agent 操作，已提交的内容不会重放。'
))
const sessionConfirmLabel = computed(() => (pendingReload.value ? '停止并重新加载' : '停止并切换'))

/** 待确认关闭的文件或浏览器标签标题；标签消失时退化为空串。 */
const pendingFileCloseTitle = computed(() => (
  workspaceTabsStore.tabs.find(tab => tab.id === workspaceTabsStore.pendingCloseKey)?.title ?? ''
))

/** 删除确认弹层的会话名：与侧栏同一口径，优先首条用户消息预览。 */
const sessionToRemoveTitle = computed(() => {
  const preview = sessionStore.pendingRemoval?.session.preview?.trim()
  return preview !== undefined && preview !== '' ? preview : '未命名会话'
})
const isRemovingCurrentSession = computed(() => (
  sessionStore.pendingRemoval !== null
  && sessionStore.pendingRemoval.session.sessionId === runtimeStore.foregroundSessionId
))

function confirmSessionSwitch(): void {
  sessionStore.confirmPending()
}

function cancelSessionSwitch(): void {
  sessionStore.cancelPending()
}

/** 候选项目的信任决定随添加动作提交；现有 Runtime 流程则重试被拦截的会话打开，Git 写操作同理重试。 */
function onTrustResolved(decision?: 'trusted' | 'untrusted'): void {
  if (pendingAddition.value !== null) {
    if (decision === undefined) {
      projectStore.cancelAddition()
      return
    }
    void projectStore.commitAddition(false, decision)
    return
  }
  if (sessionStore.awaitingTrust) void sessionStore.retryPendingAfterTrust()
  if (gitStore.awaitingTrust) void gitStore.retryPendingAfterTrust()
}

function onTrustCancelled(): void {
  if (pendingAddition.value !== null) {
    projectStore.cancelAddition()
    return
  }
  sessionStore.cancelPending()
  gitStore.cancelPendingTrust()
}

/** 确认丢弃修改或批注并关标签：关闭后落到的相邻对话标签需要补打开时在这里提交意图。 */
async function onConfirmFileClose(): Promise<void> {
  const intent = await workspaceTabsStore.confirmPendingClose()
  if (intent !== null) void sessionStore.openIntent(intent)
}

/** 版本更新提示的「查看详情」：关掉提示并直接落到设置页的「版本与更新」分节，由它展示完整版本清单。 */
function onUpdateDetails(): void {
  updatesStore.dismissNotice()
  settingsStore.openSettings('version')
}
</script>

<template>
  <Teleport to="body">
    <ConfirmDialog
      :open="awaitingInterrupt"
      :title="sessionConfirmTitle"
      :description="sessionConfirmDescription"
      :detail="sessionConfirmDetail"
      :confirm-label="sessionConfirmLabel"
      @confirm="confirmSessionSwitch"
      @cancel="cancelSessionSwitch"
    />

    <TrustDialog
      :addition-status="additionTrustStatus"
      @decided="onTrustResolved"
      @cancelled="onTrustCancelled"
    />

    <ConfirmDialog
      :open="projectStore.pendingRemoval !== null"
      title="从项目列表移除？"
      description="只移除 Pi Desktop 中的项目记录，不删除项目目录、代码或会话文件；该项目的信任决定也会清除。若它是当前项目，确认后会关闭对应 Runtime。"
      :detail="projectStore.pendingRemoval?.path ?? ''"
      confirm-label="移除项目"
      @confirm="projectStore.confirmRemoval()"
      @cancel="projectStore.cancelRemoval()"
    />

    <!-- 会话删除是破坏性操作：确认后中断该会话的在途操作、释放运行实例并删除会话文件，不可恢复。 -->
    <ConfirmDialog
      :open="sessionStore.pendingRemoval !== null"
      :title="`删除会话「${sessionToRemoveTitle}」？`"
      description="将永久删除该会话的历史记录文件，不可恢复。若该会话正在运行，确认后会先停止它的操作；若删除的是当前会话，聊天区会回到未发送消息的状态。"
      :detail="sessionStore.pendingRemoval?.session.sessionId ?? ''"
      :confirm-label="isRemovingCurrentSession ? '停止并删除' : '删除会话'"
      @confirm="sessionStore.confirmRemoval()"
      @cancel="sessionStore.cancelRemoval()"
    />

    <!-- 文件或浏览器关闭前确认：丢弃未保存修改或未交付批注后关闭，不可恢复。 -->
    <ConfirmDialog
      :open="workspaceTabsStore.pendingCloseKey !== null"
      :title="workspaceTabsStore.isBrowserKey(workspaceTabsStore.pendingCloseKey ?? '') ? '关闭浏览器会丢弃未交付的批注' : '关闭文件会丢弃未保存的修改'"
      :description="workspaceTabsStore.isBrowserKey(workspaceTabsStore.pendingCloseKey ?? '') ? '关闭标签后截图和批注不可恢复。' : '该文件有未保存的修改，关闭标签后不可恢复。需要保留时先取消并保存。'"
      :detail="pendingFileCloseTitle"
      confirm-label="丢弃并关闭"
      @confirm="onConfirmFileClose"
      @cancel="workspaceTabsStore.cancelPendingClose()"
    />

    <!-- 快捷命令的新增与编辑；保存成功才关闭，失败保留已填内容并就地提示。 -->
    <QuickCommandDialog
      :open="quickCommandsStore.editor !== null"
      :command="quickCommandsStore.editor?.target ?? null"
      :default-scope="quickCommandsStore.editor?.scope ?? 'global'"
      :default-project-path="quickCommandsStore.editor?.projectPath ?? null"
      @saved="quickCommandsStore.closeEditor()"
      @cancel="quickCommandsStore.closeEditor()"
    />

    <!-- 快捷命令删除是破坏性操作：确认后从清单里移除，不可恢复。 -->
    <ConfirmDialog
      :open="quickCommandsStore.pendingRemoval !== null"
      :title="`删除快捷命令「${quickCommandsStore.pendingRemoval?.label ?? ''}」？`"
      description="该快捷命令会从保存的清单里移除，菜单与终端右键里不再出现。"
      :detail="quickCommandsStore.pendingRemoval?.command ?? ''"
      confirm-label="删除"
      @confirm="quickCommandsStore.confirmRemoval()"
      @cancel="quickCommandsStore.cancelRemoval()"
    />

    <!-- Extension 对话一次只展示队首；队列由 store 持有，回应后自动滑到下一条。 -->
    <ExtensionDialog />

    <!-- 启动检查到更新时的只读提示；每次运行最多弹一次，手动重查不再弹。 -->
    <UpdateNoticeDialog
      :open="updatesStore.noticeOpen"
      @details="onUpdateDetails"
      @dismiss="updatesStore.dismissNotice()"
    />
  </Teleport>
</template>
