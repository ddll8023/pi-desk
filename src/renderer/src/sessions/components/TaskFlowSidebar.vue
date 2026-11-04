<!-- 用户任务侧栏宿主：固定会话与工作区身份，接入任务概览、计划动作和既有问题入口。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { createTaskFlowMotion } from '../task-flow-motion'
import type { TaskMotionContext } from '../task-flow-motion'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionViewStore } from '../stores/session-view'
import { useExtensionUiStore } from '../stores/extension-ui'
import { isTaskArtifactPath } from '../../../../shared/task-intent'
import { useChatNavigationStore } from '../stores/chat-navigation'
import { useWorkspaceTabsStore } from '../../workspace/stores/workspace-tabs'
import { useProjectStore } from '../../projects/stores/project'
import { usePreferencesStore } from '../../preferences/stores/preferences'
import { createChatViewCache } from '../chat-view'
import { parseDialogTitle } from '../extension-dialog-presentation'
import { buildSessionTaskTrack } from '../task-flow-view'
import type { TaskTurnHistory } from '../task-flow-view'
import TaskFlowPanel from './TaskFlowPanel.vue'

const runtime = useRuntimeStore()
const extension = useExtensionUiStore()
const sessionView = useSessionViewStore()
const navigation = useChatNavigationStore()
const workspace = useWorkspaceTabsStore()
const projects = useProjectStore()
const preferences = usePreferencesStore()
const eligible = computed(() => !workspace.isChatNewDraft && (workspace.isChatReady || workspace.isChatLogPreview))
const contextKey = computed(() => eligible.value
  ? `${projects.currentProject?.path ?? ''}:${workspace.activeWorkspace?.id ?? ''}:${workspace.activeSessionId ?? sessionView.key}` : null)
const projectRoot = computed(() => workspace.activeWorkspace?.rootPath ?? projects.currentProject?.path ?? null)
const viewCache = createChatViewCache()
const turns = computed(() => viewCache.toTurns(runtime.displayMessages, runtime.displayTools))
const runtimeInfo = computed(() => runtime.view.phase === 'ready' ? runtime.view.snapshot.info : null)
const live = computed(() => runtime.taskFlowLive && runtime.projectionSync === 'synced')
const notice = computed(() => runtime.taskFlowNotice ?? (runtime.projectionSync === 'stale'
  ? '会话状态尚未同步，保留最后记录，不推断执行结束。'
  : runtime.projectionSync === 'syncing' ? '正在同步会话，保留已载入记录。' : null))
const turnHistory = computed(() => {
  const result = new Map<string, TaskTurnHistory>()
  const latest = turns.value.at(-1)?.key
  for (const turn of turns.value) {
    const detail = turn.historyId === null ? undefined : runtime.history.turns[turn.historyId]
    const active = turn.key === latest && runtime.taskFlowLive && (runtimeInfo.value?.isStreaming === true
      || runtimeInfo.value?.isCompacting === true || (turn.turn !== null && turn.turn.endedAt === null))
    const recoverable = turn.user?.recoverable === true || turn.responses.some(message => message.recoverable)
    result.set(turn.key, {
      available: turn.historyId !== null && !active && (recoverable || detail !== undefined),
      loaded: detail?.loaded ?? !recoverable,
      loading: detail?.loading ?? false,
      hasMore: detail?.next != null,
      error: detail?.error ?? null
    })
  }
  return result
})
const taskTrack = computed(() => buildSessionTaskTrack(turns.value, runtime.displayTaskFlows, {
  live: live.value, streaming: runtimeInfo.value?.isStreaming === true,
  compacting: runtimeInfo.value?.isCompacting === true,
  projectRoot: projectRoot.value, history: turnHistory.value
}))
const earlier = computed(() => ({
  available: runtime.history.before !== null, loading: runtime.history.loading, error: runtime.history.error
}))

const waitingDialog = computed(() => {
  if (!eligible.value || runtime.view.phase !== 'ready' || extension.runId !== runtime.view.snapshot.runId
    || extension.runtimeId !== runtime.view.snapshot.runtimeId) return null
  const dialog = extension.dialogs[0]
  return dialog === undefined ? null : { id: dialog.id, title: parseDialogTitle(dialog.title).question }
})
const canExecute = computed(() => eligible.value && workspace.isChatInteractive && live.value
  && runtime.view.phase === 'ready' && runtime.view.snapshot.runtimeId !== null
  && runtimeInfo.value?.sessionId === workspace.activeSessionId
  && runtimeInfo.value?.isStreaming !== true && runtimeInfo.value?.isCompacting !== true
  && !runtime.preparingPrompt && runtime.promptView.phase !== 'sending'
  && !runtime.taskFlowStarting && waitingDialog.value === null && sessionView.pendingPrompt === null)
const canOpenFiles = computed(() => eligible.value && workspace.activeWorkspace?.phase === 'ready'
  && workspace.activeTab !== null && projects.currentProject !== null
  && workspace.workspaceIdForTab(projects.currentProject.path, workspace.activeTab) === workspace.activeWorkspace.id)

const panelActive = computed(() => eligible.value && preferences.rightPanelOpen && preferences.rightPanelTab === 'task-flow')
const motionContext = computed<TaskMotionContext>(() => ({
  key: `${contextKey.value ?? ''}:${runtime.conversationKey}`,
  sourceOwner: runtime.conversationKey, targetOwner: contextKey.value ?? '',
  enabled: panelActive.value && workspace.isChatReady && live.value && notice.value === null
    && waitingDialog.value === null && !earlier.value.loading && runtimeInfo.value?.sessionId === workspace.activeSessionId,
  track: taskTrack.value
}))
// 工具流式文本不产生新动效事件；只监听语义修订、轮次归属和计划版本。
const motionSignal = computed(() => taskTrack.value.turns.map(turn => `${turn.id}:${turn.current}:${turn.report?.revision ?? '-'}`).join('|')
  + runtime.displayTaskFlows.map(flow => `${flow.id}:${flow.revision}`).join('|'))
let motion: ReturnType<typeof createTaskFlowMotion> | null = null
watch(() => [motionContext.value.key, motionContext.value.enabled, motionSignal.value] as const,
  () => motion?.update(motionContext.value), { flush: 'post' })
onMounted(() => { motion = createTaskFlowMotion(); motion.update(motionContext.value) })
onBeforeUnmount(() => { motion?.destroy(); motion = null })

/** 仅为界面提示去重，不是任务状态；重挂载时不把已有历史计划当成新计划抢切页签。 */
const mountedAt = Date.now()
const announced = new Map<string, Set<string>>()
watch(() => ({ key: contextKey.value, flows: runtime.displayTaskFlows, live: runtime.taskFlowLive }), async ({ key, flows, live }) => {
  if (key === null) return
  let seen = announced.get(key)
  const firstVisit = seen === undefined
  if (seen === undefined) {
    seen = new Set<string>()
    announced.set(key, seen)
    if (announced.size > 50) {
      const oldest = announced.keys().next().value
      if (oldest !== undefined && oldest !== key) announced.delete(oldest)
    }
  }
  const known = seen
  const fresh = flows.filter(flow => !known.has(flow.id) && flow.phase === 'pending'
    && (!firstVisit || flow.createdAt >= mountedAt))
  for (const flow of flows) {
    if (live || !fresh.some(candidate => candidate.id === flow.id)) known.add(flow.id)
  }
  if (fresh.length === 0 || !live) return
  const wasOpen = preferences.rightPanelOpen
  await preferences.setRightPanelTab('task-flow')
  // 偏好保存期间若用户已切走或主动收起，不再用旧计划抢回界面。
  if (contextKey.value !== key || preferences.rightPanelTab !== 'task-flow'
    || (wasOpen && !preferences.rightPanelOpen)) return
  await preferences.setRightPanelOpen(true)
}, { immediate: true })

/** 所有侧栏意图固定渲染时的会话身份，切换期间不能跳进另一会话。 */
function owns(ownerKey: string): boolean {
  return eligible.value && contextKey.value === ownerKey
}
function locateTurn(messageId: string, ownerKey: string): void {
  if (owns(ownerKey) && turns.value.some(turn => turn.user?.id === messageId)) {
    navigation.requestJump(sessionView.key, messageId)
  }
}
function locate(entryId: string, ownerKey: string): void {
  if (!owns(ownerKey) || entryId === '') return
  // 摘要页可能只载入用户消息：用步骤的已知 Prompt 身份定位，不为寻找回复而扫描历史。
  const step = runtime.displayTaskFlows.flatMap(flow => flow.steps).find(candidate => candidate.resultEntryId === entryId)
  const turn = turns.value.find(candidate => candidate.user?.entryId === entryId
    || candidate.responses.some(message => message.entryId === entryId)
    || (step?.promptEntryId != null && candidate.user?.entryId === step.promptEntryId))
  if (turn?.user) navigation.requestJump(sessionView.key, turn.user.id)
  else navigation.requestEntryJump(sessionView.key, entryId)
}
/** 不经聊天草稿转发启动口令；直接固定当前会话、计划与修订号，迟到点击不能换目标。 */
async function startFlow(flowId: string, revision: number, ownerKey: string): Promise<void> {
  if (!owns(ownerKey) || !canExecute.value || runtime.view.phase !== 'ready') return
  const target = { runId: runtime.view.snapshot.runId, runtimeId: runtime.view.snapshot.runtimeId }
  if (target.runId === null || target.runtimeId === null) return
  await runtime.startTaskFlow(flowId, revision, { runId: target.runId, runtimeId: target.runtimeId })
}
function openFile(path: string, ownerKey: string): void {
  if (!owns(ownerKey) || !canOpenFiles.value || !isTaskArtifactPath(path)
    || !taskTrack.value.tasks.some(task => task.artifacts.some(artifact => artifact.path === path))) return
  const target = workspace.activeWorkspace
  if (target === null) return
  workspace.openFileTab(path, undefined, undefined, { projectPath: target.projectPath, workspaceId: target.id })
}
function showQuestion(dialogId: string, ownerKey: string): void {
  if (owns(ownerKey) && waitingDialog.value?.id === dialogId) extension.restoreDialog()
}
async function loadEarlier(ownerKey: string): Promise<void> {
  if (owns(ownerKey) && runtime.history.before !== null && !runtime.history.loading) await runtime.loadEarlierHistory()
}
async function loadTurn(turnId: string, more: boolean, ownerKey: string): Promise<void> {
  if (!owns(ownerKey)) return
  const turn = turns.value.find(candidate => candidate.historyId === turnId)
  const history = turn === undefined ? undefined : turnHistory.value.get(turn.key)
  if (history?.available && !history.loading) await runtime.loadHistoryTurn(turnId, more)
}
async function refresh(): Promise<void> {
  const owner = contextKey.value
  if (!eligible.value || owner === null) return
  // 语义随消息快照传输；只读同步当前绑定，不借刷新要求 Agent 补报或恢复会话。
  if (runtime.taskFlowLive && runtime.view.phase === 'ready' && runtime.view.snapshot.runtimeId !== null) {
    await runtime.syncProjection(runtime.view.snapshot.runtimeId)
    if (contextKey.value !== owner || !eligible.value) return
  }
  await runtime.refreshTaskFlow()
}
defineExpose({ refresh })
</script>

<template>
  <section id="right-panel-page-task-flow" class="flex min-h-0 flex-1 flex-col" role="tabpanel" aria-labelledby="right-panel-tab-task-flow">
    <div v-if="!eligible" class="p-4 text-xs text-desk-muted" role="status">
      请选择一个对话查看任务流程。文件、终端和新对话不会展示其他会话的任务。
    </div>
    <TaskFlowPanel
      v-else
      :key="contextKey ?? 'no-session'"
      class="min-h-0 flex-1"
      :track="taskTrack"
      :owner-key="contextKey ?? 'no-session'"
      :active="panelActive"
      :live="live"
      :notice="notice"
      :project-root="projectRoot"
      :earlier="earlier"
      :running="live && runtimeInfo?.isStreaming === true"
      :starting="runtime.taskFlowStarting"
      :can-execute="canExecute"
      :can-open-files="canOpenFiles"
      :waiting-dialog="waitingDialog"
      @locate="locate"
      @locate-turn="locateTurn"
      @load-earlier="loadEarlier"
      @load-turn="loadTurn"
      @start="startFlow"
      @open-file="openFile"
      @show-question="showQuestion"
    />
  </section>
</template>
