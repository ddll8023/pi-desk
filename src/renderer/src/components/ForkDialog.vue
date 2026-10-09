<!-- 分叉会话弹层：展示当前会话可分叉的用户消息，选择一条后重启式切换到新会话；加载、空列表与失败都如实展示。 -->
<script setup lang="ts">
import { useSessionStore } from '../stores/session'
import { useRuntimeStore } from '../stores/runtime'

const sessionStore = useSessionStore()
const runtimeStore = useRuntimeStore()

/** 分叉只在 Runtime 就绪时可用；运行中分叉会先中断当前操作，与切换会话同语义。 */
function onPick(entryId: string): void {
  if (sessionStore.forkBusy) return
  void sessionStore.fork(entryId, true).then((done) => {
    // 成功时主进程已切换会话；弹层由父级根据 store 状态收起。
    if (done) sessionStore.closeFork()
  })
}

function close(): void {
  sessionStore.closeFork()
}

function truncate(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
</script>

<template>
  <div
    class="dialog-overlay"
    @click.self="close"
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-label="从历史消息分叉"
      class="dialog-panel max-w-lg"
    >
      <div class="dialog-header">
        <div class="min-w-0">
          <h2 class="dialog-title">从历史消息分叉</h2>
          <p class="mt-1 text-2xs text-desk-muted">
            选择一条历史输入，Pi 会从那条消息创建新会话；当前会话保持不变。运行中的操作会被停止。
          </p>
        </div>
      </div>

      <div class="dialog-body">
        <p v-if="sessionStore.forkLoading" role="status" class="py-6 text-center text-xs text-desk-muted">
          正在读取可分叉的消息…
        </p>
        <p v-else-if="sessionStore.forkError" role="alert" class="status-notice status-notice-error">
          {{ sessionStore.forkError.message }}
        </p>
        <p v-else-if="sessionStore.forkMessages.length === 0" class="py-6 text-center text-xs text-desk-muted">
          当前会话还没有可分叉的历史输入。
        </p>

        <ul v-else class="space-y-1">
          <li v-for="message in sessionStore.forkMessages" :key="message.entryId">
            <button
              type="button"
              class="list-item border-desk-line"
              :disabled="sessionStore.forkBusy || runtimeStore.view.phase !== 'ready'"
              @click="onPick(message.entryId)"
            >
              <span class="block break-words text-xs leading-5">{{ truncate(message.text) }}</span>
            </button>
          </li>
        </ul>

        <p v-if="sessionStore.forkBusy" role="status" class="text-2xs text-desk-muted">
          正在分叉并切换到新会话…
        </p>
      </div>

      <div class="dialog-footer">
        <button type="button" class="control-button" :disabled="sessionStore.forkBusy" @click="close">
          关闭
        </button>
      </div>
    </div>
  </div>
</template>
