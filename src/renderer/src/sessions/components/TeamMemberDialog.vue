<!-- 成员只读弹窗：查看一个成员会话的最近一轮结果与近期对话，不提供输入框、发送按钮或停止入口。
     成员会话对用户只读是团队设计的一部分：用户不成为第三个驱动方，拍板仍经团长。
     数据来自成员会话只读通道与宿主记录的成员轮次；Esc、遮罩与关闭按钮都能关闭，关闭后焦点回到触发元素。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import AppButton from '../../ui/AppButton.vue'
import { useTeamPanelStore } from '../stores/team-panel'
import { TEAM_MEMBER_RUN_STATUS_LABELS } from '../../../../shared/team-run-api'
import type { TeamMemberRun } from '../../../../shared/team-run-api'

const props = defineProps<{
  readonly open: boolean
  readonly memberName: string
  /** 该成员最近一轮的宿主记录；没有轮次时为 null，只显示会话记录。 */
  readonly run: TeamMemberRun | null
}>()

const emit = defineEmits<{ close: []; retry: [] }>()

const store = useTeamPanelStore()
const panel = ref<HTMLElement | null>(null)
let restoreFocus: HTMLElement | null = null

const titleId = 'team-member-dialog-title'

const runLabel = computed(() => (props.run === null
  ? null
  : `${TEAM_MEMBER_RUN_STATUS_LABELS[props.run.status]} · 第 ${props.run.attempt} 轮`))

/** 用量只在宿主记录里有值时显示：成员会话的累计与团长自己的请求分开算。 */
const usageLabel = computed(() => {
  const usage = props.run?.usage
  if (usage === undefined || usage === null) return null
  return `输入 ${usage.inputTokens} · 输出 ${usage.outputTokens} · 合计 ${usage.totalTokens}`
})

const messages = computed(() => store.history?.messages ?? [])

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

function detach(): void {
  window.removeEventListener('keydown', onKeydown)
  restoreFocus?.focus()
  restoreFocus = null
}

watch(() => props.open, open => {
  if (!open) {
    detach()
    return
  }
  restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  window.addEventListener('keydown', onKeydown)
  void nextTick(() => panel.value?.focus())
})

onBeforeUnmount(detach)
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div v-if="open" class="dialog-overlay" @click.self="emit('close')">
        <Transition name="dialog-panel-motion" appear>
          <div
            ref="panel"
            role="dialog"
            aria-modal="true"
            :aria-labelledby="titleId"
            tabindex="-1"
            class="dialog-panel team-member-panel max-w-2xl"
          >
            <div class="dialog-header">
              <h2 :id="titleId" class="dialog-title">{{ memberName }}</h2>
              <span v-if="runLabel !== null" class="team-member-run-label">{{ runLabel }}</span>
              <button type="button" class="dialog-close-button" aria-label="关闭" @click="emit('close')"></button>
            </div>

            <div class="dialog-body scroll-area">
              <p v-if="store.detailPhase === 'loading'" class="team-member-status" role="status">正在读取成员会话…</p>
              <p v-else-if="store.detailPhase === 'failed'" class="team-member-error" role="alert">
                {{ store.detailError }}
                <AppButton variant="unstyled" class="team-member-retry" @click="emit('retry')">重试</AppButton>
              </p>

              <template v-else>
                <section v-if="run !== null" class="team-member-section" aria-labelledby="team-member-run-title">
                  <h3 id="team-member-run-title" class="team-member-heading">最近一轮</h3>
                  <p v-if="run.summary !== null" class="team-member-summary">{{ run.summary }}</p>
                  <p v-if="usageLabel !== null" class="team-member-usage">{{ usageLabel }}</p>
                  <template v-if="run.files.length > 0">
                    <p class="team-member-label">写入文件</p>
                    <ul class="team-member-files" role="list">
                      <li v-for="file in run.files" :key="file" class="team-member-file">{{ file }}</li>
                    </ul>
                  </template>
                  <template v-if="run.questions.length > 0">
                    <p class="team-member-label">待决项</p>
                    <ul class="team-member-questions" role="list">
                      <li v-for="question in run.questions" :key="question">{{ question }}</li>
                    </ul>
                  </template>
                </section>

                <section class="team-member-section" aria-labelledby="team-member-history-title">
                  <h3 id="team-member-history-title" class="team-member-heading">
                    近期对话<span class="team-member-count">{{ messages.length }}</span>
                  </h3>
                  <p v-if="messages.length === 0" class="team-member-status">这个成员还没有对话记录。</p>
                  <ol v-else class="team-member-messages" role="list">
                    <li
                      v-for="(message, index) in messages"
                      :key="`${index}-${message.role}`"
                      class="team-member-message"
                      :class="`is-${message.role}`"
                    >
                      <span class="team-member-role">{{ message.role === 'user' ? '团长' : memberName }}</span>
                      <span class="team-member-text">{{ message.text }}</span>
                    </li>
                  </ol>
                  <p v-if="store.history?.truncated === true" class="team-member-status">
                    更早的消息没有读出：这里只显示最近的若干条。
                  </p>
                </section>
              </template>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.team-member-panel {
  display: flex;
  flex-direction: column;
  max-height: min(72vh, 640px);
}

.team-member-run-label {
  margin-inline-start: auto;
  font-size: 12px;
  color: var(--color-desk-muted);
}

.team-member-section {
  display: grid;
  gap: 6px;
  padding-block: 4px 10px;
}

.team-member-section + .team-member-section {
  border-top: 1px solid var(--color-desk-line);
  padding-block-start: 10px;
}

.team-member-heading {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-desk-muted);
}

.team-member-count {
  margin-inline-start: 6px;
  font-size: 11px;
  font-weight: 400;
  color: var(--color-desk-muted);
  font-variant-numeric: tabular-nums;
}

.team-member-summary,
.team-member-usage,
.team-member-status,
.team-member-label {
  margin: 0;
  font-size: 12px;
  color: var(--color-desk-muted);
  overflow-wrap: anywhere;
}

.team-member-usage,
.team-member-status {
  font-size: 11px;
  color: var(--color-desk-muted);
}

.team-member-label {
  color: var(--color-desk-muted);
}

.team-member-error {
  margin: 0;
  font-size: 12px;
  color: var(--color-desk-danger);
  display: flex;
  align-items: center;
  gap: 6px;
}

.team-member-retry {
  font-size: 12px;
  color: var(--color-desk-accent);
  text-decoration: underline;
}

.team-member-files,
.team-member-questions,
.team-member-messages {
  display: grid;
  gap: 3px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.team-member-file,
.team-member-questions li {
  font-size: 12px;
  color: var(--color-desk-muted);
  overflow-wrap: anywhere;
}

.team-member-file {
  font-family: var(--font-mono);
  font-size: 11px;
}

.team-member-message {
  display: grid;
  gap: 2px;
  padding: 4px 6px;
  border-radius: 6px;
  background: var(--color-desk-surface-subtle);
}

.team-member-role {
  font-size: 11px;
  color: var(--color-desk-muted);
}

.team-member-text {
  font-size: 12px;
  color: var(--color-desk-ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
