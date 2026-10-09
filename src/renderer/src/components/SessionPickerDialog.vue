<!-- 会话选择弹层：展示当前项目的 Pi 会话列表，选中后沿用主进程的重启式打开链切换；列表数据与编排都在主进程与 session store，不解析会话文件。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, watch } from 'vue'
import type { SessionSummary } from '../../../shared/session-api'
import { useSessionStore } from '../stores/session'
import AppButton from './ui/AppButton.vue'

const emit = defineEmits<{ close: [] }>()

/** 弹层由父级常驻挂载，`open` 控制进入/退出；每次打开都重新读列表。 */
const props = defineProps<{
  readonly open: boolean
}>()

const sessionStore = useSessionStore()
const { view, sessions, skipped, truncated, actionError, opening } = storeToRefs(sessionStore)

const busy = computed(() => opening.value || view.value.phase === 'loading')

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

function close(): void {
  emit('close')
}

function openSavedSession(sessionId: string): void {
  void sessionStore.open(sessionId, false).then(() => {
    // 失败时弹层保留并展示 actionError；成功或转入中断确认/信任流程时收起。
    if (sessionStore.actionError === null) close()
  })
}

watch(
  () => props.open,
  (open) => {
    if (open) void sessionStore.refresh()
  },
  { immediate: true }
)
</script>

<template>
  <Transition name="dialog-fade">
    <div v-if="props.open" class="dialog-overlay" @click.self="close">
      <Transition name="dialog-panel-motion" appear>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="选择会话"
          class="dialog-panel max-w-lg"
        >
      <div class="dialog-header">
        <div class="min-w-0">
          <h2 class="dialog-title">选择会话</h2>
          <p class="dialog-subtitle">
            选择一条历史会话继续；切换会重启 Runtime 并停止运行中的操作。
          </p>
        </div>
        <AppButton variant="unstyled" class="dialog-close-button" aria-label="关闭" @click="close" />
      </div>

      <div class="scroll-area dialog-body">
        <p v-if="view.phase === 'loading'" class="empty-state py-10">
          <span class="empty-state-title">正在读取会话列表…</span>
        </p>
        <div v-else-if="view.phase === 'error'" class="flex flex-wrap items-center gap-2">
          <p role="alert" class="text-xs text-desk-danger">{{ view.error.message }}</p>
          <AppButton variant="unstyled" class="icon-button" @click="sessionStore.refresh()">重试</AppButton>
        </div>
        <p v-else-if="sessions.length === 0" class="empty-state py-10">
          <span class="empty-state-title">当前项目还没有 Pi 会话</span>
          <span class="empty-state-text">在输入框输入 /new 新建会话后，这里会列出它。</span>
        </p>
        <template v-else>
          <p v-if="actionError" role="alert" class="status-notice status-notice-error">
            {{ actionError.message }}
          </p>
          <section v-for="group in groups" :key="group.key" class="panel-section">
            <h3 class="panel-section-title">{{ group.label }}</h3>
            <ul class="space-y-1.5">
              <li v-for="session in group.items" :key="session.sessionId">
                <AppButton
                  variant="unstyled"
                  class="list-card"
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
                </AppButton>
              </li>
            </ul>
          </section>
        </template>
      </div>

      <div
        v-if="skipped > 0 || truncated > 0"
        class="dialog-footer"
      >
        <p class="w-full text-left text-2xs text-desk-muted">
          已跳过 {{ skipped }} 个不属于此项目的会话文件<span v-if="truncated > 0">，另有 {{ truncated }} 条较早会话未列出</span>。
        </p>
      </div>
        </div>
      </Transition>
    </div>
  </Transition>
</template>
