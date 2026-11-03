<!-- 右侧任务与执行看板宿主：就绪时全量挂载任务面板承接当前焦点与执行轨道；视图切换不持有或暂停执行与对账。 -->
<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionViewStore } from '../stores/session-view'
import { useChatNavigationStore } from '../stores/chat-navigation'
import { useWorkspaceTabsStore } from '../../workspace/stores/workspace-tabs'
import { useProjectStore } from '../../projects/stores/project'
import { usePreferencesStore } from '../../preferences/stores/preferences'
import TaskFlowPanel from './TaskFlowPanel.vue'

const runtime = useRuntimeStore()
const sessionView = useSessionViewStore()
const navigation = useChatNavigationStore()
const workspace = useWorkspaceTabsStore()
const projects = useProjectStore()
const preferences = usePreferencesStore()
const eligible = computed(() => !workspace.isChatNewDraft && (workspace.isChatReady || workspace.isChatLogPreview))
const contextKey = computed(() => eligible.value
  ? `${projects.currentProject?.path ?? ''}:${workspace.activeSessionId ?? sessionView.key}` : null)

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

/** 定位意图固定渲染时的会话身份，切换期间不能跳进另一会话。 */
function locate(entryId: string, ownerKey: string): void {
  if (eligible.value && contextKey.value === ownerKey && entryId !== '') navigation.requestEntryJump(sessionView.key, entryId)
}
async function refresh(): Promise<void> {
  if (eligible.value) await runtime.refreshTaskFlow()
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
      class="min-h-0 flex-1 overflow-y-auto"
      :flows="runtime.displayTaskFlows"
      :owner-key="contextKey ?? 'no-session'"
      :live="runtime.taskFlowLive"
      :notice="runtime.taskFlowNotice"
      @locate="locate"
    />
  </section>
</template>
