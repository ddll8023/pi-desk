<!--
  内置浏览器控制权与人工接管状态横幅：呈现 AI 操控中、人工接管、挂起与已绑定状态，并提供一键接管、恢复与会话绑定控制。
  仅展示控制状态副本并向父组件抛出意图，不直接调用底层原生能力。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import type { BrowserControlState } from '../../../../shared/browser-session-api'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  readonly tabKey: string
  readonly controlState: BrowserControlState | null
  readonly targets: readonly { readonly id: string; readonly title: string }[]
}>()

const emit = defineEmits<{
  bind: [sessionId: string]
  release: []
  takeover: []
  resume: []
}>()

const selectedTargetId = ref('')

const phase = computed(() => props.controlState?.phase ?? 'unbound')

const currentTargetTitle = computed(() => {
  const sessionId = props.controlState?.sessionId
  if (!sessionId) return '未知对话'
  const match = props.targets.find(t => t.id === sessionId)
  return match ? match.title : sessionId.slice(0, 8)
})

function onBindSelect(event: Event): void {
  const target = event.target as HTMLSelectElement
  const sessionId = target.value
  if (sessionId) {
    emit('bind', sessionId)
    selectedTargetId.value = ''
  }
}
</script>

<template>
  <div class="browser-control-banner text-xs select-none">
    <!-- 1. AI 正在操控页面 -->
    <div
      v-if="phase === 'running'"
      class="bg-sky-500/10 border-b border-sky-500/30 text-sky-600 dark:text-sky-400 px-3 py-1.5 flex items-center justify-between"
      role="alert"
    >
      <div class="flex items-center gap-2 min-w-0">
        <span class="relative flex h-2 w-2 shrink-0">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75" />
          <span class="relative inline-flex rounded-full h-2 w-2 bg-sky-500" />
        </span>
        <span class="font-medium truncate">AI 正在操控此网页… (绑定对话: {{ currentTargetTitle }})</span>
      </div>
      <AppButton
        variant="default"
        class="text-xs shrink-0 ml-2 py-0.5 px-2.5 bg-red-500/20 text-red-600 hover:bg-red-500/30 border-red-500/30"
        @click="emit('takeover')"
      >
        人工接管
      </AppButton>
    </div>

    <!-- 2. 人工已接管（自动化已暂停） -->
    <div
      v-else-if="phase === 'takeover'"
      class="bg-amber-500/10 border-b border-amber-500/30 text-amber-600 dark:text-amber-400 px-3 py-1.5 flex items-center justify-between"
      role="status"
    >
      <div class="flex items-center gap-2 min-w-0">
        <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span class="truncate">已由人工接管控制，AI 自动化已暂停。</span>
      </div>
      <div class="flex items-center gap-1.5 shrink-0 ml-2">
        <AppButton variant="default" class="text-xs py-0.5 px-2" @click="emit('resume')">
          恢复 AI 控制
        </AppButton>
        <AppButton variant="ghost" class="text-xs py-0.5 px-1.5 text-[var(--color-desk-ink-muted)]" @click="emit('release')">
          解绑
        </AppButton>
      </div>
    </div>

    <!-- 3. 自动挂起（跨源跳转、DevTools 打开等） -->
    <div
      v-else-if="phase === 'paused'"
      class="bg-amber-500/15 border-b border-amber-500/30 text-amber-700 dark:text-amber-300 px-3 py-1.5 flex items-center justify-between"
      role="alert"
    >
      <div class="flex items-center gap-2 min-w-0">
        <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span class="truncate">AI 控制已挂起：{{ props.controlState?.pausedReason ?? '状态异常' }}</span>
      </div>
      <div class="flex items-center gap-1.5 shrink-0 ml-2">
        <AppButton variant="default" class="text-xs py-0.5 px-2" @click="emit('resume')">
          恢复控制
        </AppButton>
        <AppButton variant="ghost" class="text-xs py-0.5 px-1.5 text-[var(--color-desk-ink-muted)]" @click="emit('release')">
          解绑
        </AppButton>
      </div>
    </div>

    <!-- 4. 已绑定待命中 -->
    <div
      v-else-if="phase === 'attached'"
      class="bg-[var(--color-desk-panel)] border-b border-[var(--color-desk-border)] text-[var(--color-desk-ink-muted)] px-3 py-1 flex items-center justify-between"
    >
      <div class="flex items-center gap-2 min-w-0">
        <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
        <span class="truncate text-xs">已连接对话：<strong class="text-[var(--color-desk-ink)] font-normal">{{ currentTargetTitle }}</strong> (待命中)</span>
      </div>
      <div class="flex items-center gap-1.5 shrink-0 ml-2">
        <AppButton variant="ghost" class="text-xs py-0.5 px-2 hover:text-[var(--color-desk-ink)]" @click="emit('takeover')">
          接管
        </AppButton>
        <AppButton variant="ghost" class="text-xs py-0.5 px-1.5 text-[var(--color-desk-ink-muted)]" @click="emit('release')">
          解绑
        </AppButton>
      </div>
    </div>

    <!-- 5. 未绑定且当前项目有可用对话 -->
    <div
      v-else-if="props.targets.length > 0"
      class="bg-[var(--color-desk-panel)]/50 border-b border-[var(--color-desk-border)]/60 text-[var(--color-desk-ink-muted)] px-3 py-1 flex items-center justify-between"
    >
      <span class="truncate text-xs">AI 自动操控未绑定</span>
      <div class="flex items-center gap-1.5 shrink-0 ml-2">
        <select
          class="bg-[var(--color-desk-surface)] border border-[var(--color-desk-border)] rounded text-xs px-2 py-0.5 text-[var(--color-desk-ink)] outline-none"
          :value="selectedTargetId"
          @change="onBindSelect"
        >
          <option value="" disabled selected>绑定到对话…</option>
          <option v-for="t in props.targets" :key="t.id" :value="t.id">
            {{ t.title }}
          </option>
        </select>
      </div>
    </div>
  </div>
</template>
