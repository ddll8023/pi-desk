<!-- 会话侧栏：当前项目的 Pi 会话列表、新建与刷新入口、跳过与截断提示，以及界面偏好保存失败的提示；会话文件解析与切换编排都在主进程。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import type { SessionSummary } from '../../../shared/session-api'
import { usePreferencesStore } from '../stores/preferences'
import { useProjectStore } from '../stores/project'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionStore } from '../stores/session'

const preferencesStore = usePreferencesStore()
const projectStore = useProjectStore()
const runtimeStore = useRuntimeStore()
const sessionStore = useSessionStore()
const { currentProject } = storeToRefs(projectStore)
const { view: sessionView, sessions, skipped, truncated, actionError, opening } = storeToRefs(sessionStore)
const { view: runtimeView } = storeToRefs(runtimeStore)
const { actionError: preferencesError } = storeToRefs(preferencesStore)

/** 当前会话以 Runtime 快照为准；未就绪时没有可高亮的会话。 */
const activeSessionId = computed(() => (
  runtimeView.value.phase === 'ready' ? runtimeView.value.snapshot.info?.sessionId ?? null : null
))
const busy = computed(() => opening.value || sessionView.value.phase === 'loading')

/** 只按最后修改时间分成两段，不推断会话内容或跨项目归属。 */
const groups = computed(() => {
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const boundary = startOfToday.getTime()
  const today: SessionSummary[] = []
  const earlier: SessionSummary[] = []
  for (const session of sessions.value) {
    if (session.updatedAt >= boundary) today.push(session)
    else earlier.push(session)
  }
  return [
    { key: 'today', label: '今天', items: today },
    { key: 'earlier', label: '更早', items: earlier }
  ].filter((group) => group.items.length > 0)
})

function formatUpdatedAt(session: SessionSummary): string {
  const updated = new Date(session.updatedAt)
  if (Number.isNaN(updated.getTime())) return session.createdAt
  return updated.toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function startNewSession(): void {
  void sessionStore.open(null, false)
}

function openSavedSession(sessionId: string): void {
  void sessionStore.open(sessionId, false)
}
</script>

<template>
  <aside
    class="flex w-64 shrink-0 flex-col border-r border-desk-line bg-desk-surface"
    aria-label="会话"
  >
    <div class="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-desk-line px-3">
      <h2 class="text-sm font-semibold">会话</h2>
      <div class="flex gap-1">
        <button
          type="button"
          class="icon-button"
          :disabled="busy || currentProject === null"
          @click="startNewSession"
        >
          新建
        </button>
        <button type="button" class="icon-button" :disabled="busy" @click="sessionStore.refresh()">
          刷新
        </button>
      </div>
    </div>

    <div class="scroll-area min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <p v-if="currentProject === null" class="px-1 text-xs leading-6 text-desk-muted">
        先选择项目，再查看该项目的 Pi 会话。
      </p>
      <template v-else>
        <p v-if="actionError" role="alert" class="status-notice status-notice-error mb-2">
          {{ actionError.message }}
        </p>

        <p v-if="sessionView.phase === 'loading'" class="px-1 text-xs text-desk-muted">正在读取会话列表。</p>
        <div v-else-if="sessionView.phase === 'error'" class="flex flex-wrap items-center gap-2">
          <p role="alert" class="text-xs text-desk-danger">{{ sessionView.error.message }}</p>
          <button type="button" class="icon-button" @click="sessionStore.refresh()">重试</button>
        </div>
        <p v-else-if="sessions.length === 0" class="px-1 text-xs leading-6 text-desk-muted">
          该项目还没有 Pi 会话；新建会话后会在本机会话目录里出现。
        </p>
        <template v-else>
          <section v-for="group in groups" :key="group.key" class="mb-4 last:mb-0">
            <h3 class="section-label mb-1.5 px-1">{{ group.label }}</h3>
            <ul class="space-y-0.5">
              <li v-for="session in group.items" :key="session.sessionId">
                <button
                  type="button"
                  class="list-item"
                  :class="session.sessionId === activeSessionId ? 'list-item-active' : ''"
                  :aria-current="session.sessionId === activeSessionId ? 'true' : 'false'"
                  :disabled="busy"
                  @click="openSavedSession(session.sessionId)"
                >
                  <span class="block truncate text-xs leading-5">
                    {{ session.preview ?? '未读取到用户消息' }}
                  </span>
                  <span class="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-2xs text-desk-muted">
                    <span>{{ formatUpdatedAt(session) }}</span>
                    <span class="font-mono">{{ session.sessionId.slice(0, 8) }}</span>
                    <span>{{ formatSize(session.sizeBytes) }}</span>
                  </span>
                </button>
              </li>
            </ul>
          </section>
        </template>
      </template>
    </div>

    <div
      v-if="currentProject !== null && (skipped > 0 || truncated > 0 || preferencesError)"
      class="space-y-1.5 border-t border-desk-line px-3 py-2 text-xs text-desk-muted"
    >
      <p v-if="skipped > 0 || truncated > 0" class="status-notice">
        已跳过 {{ skipped }} 个不属于此项目的会话文件<span v-if="truncated > 0">，另有 {{ truncated }} 条较早会话未列出</span>。
      </p>
      <p v-if="preferencesError" role="alert" class="status-notice status-notice-error">
        {{ preferencesError.message }}
      </p>
    </div>
  </aside>
</template>
