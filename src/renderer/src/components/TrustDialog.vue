<!-- Project Trust 决定对话框：展示探测到的受保护资源与安全影响，决定后由调用方重试被打断的操作；取消不保存任何状态。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { onMounted, onUnmounted, useId } from 'vue'
import { useTrustStore } from '../stores/trust'
import type { TrustResourceKind } from '../../../shared/trust-api'

const trustStore = useTrustStore()
const { view, actionError, deciding } = storeToRefs(trustStore)

const emit = defineEmits<{
  /** 决定已保存（信任或不信任）；由调用方重试被拦截的操作。 */
  decided: []
  /** 用户取消，未做任何决定。 */
  cancelled: []
}>()

const titleId = useId()

/** 资源类型的界面标签；与官方受保护资源清单一一对应。 */
const KIND_LABELS: Readonly<Record<TrustResourceKind, string>> = {
  settings: '项目设置',
  mcp: 'MCP 服务器配置',
  extensions: 'Extension 脚本',
  skills: 'Skill 资源',
  prompts: 'Prompt 模板',
  themes: '主题资源',
  systemMd: '系统提示词',
  appendSystemMd: '附加系统提示词',
  agentSkills: '项目 Skill（.agents/skills）'
}

function kindLabel(kind: TrustResourceKind): string {
  return KIND_LABELS[kind]
}

function confirmTrusted(): void {
  void trustStore.decide('trusted').then(() => {
    if (trustStore.view.phase === 'idle') emit('decided')
  })
}

function cancelTrust(): void {
  trustStore.cancel()
  emit('cancelled')
}

function confirmUntrusted(): void {
  void trustStore.decide('untrusted').then(() => {
    if (trustStore.view.phase === 'idle') emit('decided')
  })
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') cancelTrust()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div
    v-if="view.phase === 'prompting'"
    class="dialog-overlay"
    @click.self="cancelTrust"
  >
    <div
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      class="dialog-panel max-w-lg"
    >
      <div class="dialog-header">
        <h2 :id="titleId" class="dialog-title">信任此项目？</h2>
      </div>

      <div class="dialog-body">
        <p class="text-sm">
          此项目包含 Pi 的受保护资源。信任后，这些资源将在启动 Runtime 时随项目加载。
        </p>

        <ul class="scroll-area max-h-40 space-y-1 overflow-y-auto rounded-desk-sm border border-desk-line bg-desk-canvas p-2">
          <li
            v-for="resource in view.status.resources"
            :key="`${resource.kind}:${resource.path}`"
            class="flex flex-wrap items-baseline gap-2 text-xs"
          >
            <span class="chip">{{ kindLabel(resource.kind) }}</span>
            <span class="break-all font-mono text-desk-muted">{{ resource.path }}</span>
          </li>
        </ul>

        <div class="status-notice space-y-1">
          <p>Extension 与 Skill 在 Pi 进程内以当前用户权限运行；信任项目不是沙箱，也不限制工具的文件与命令访问。</p>
          <p>AGENTS.md、CLAUDE.md 等上下文文件不受信任决定影响，始终会加载。</p>
          <p>此决定只保存在 Desktop 本地，且会覆盖 Pi 已保存的项目信任记录；可随时在 Runtime 详情中重置。</p>
        </div>

        <p v-if="actionError" role="alert" class="status-notice status-notice-error">{{ actionError }}</p>
      </div>

      <div class="dialog-footer">
        <button
          type="button"
          class="control-button"
          :disabled="deciding"
          @click="confirmUntrusted"
        >
          不信任
        </button>
        <button
          type="button"
          class="control-button-primary"
          :disabled="deciding"
          @click="confirmTrusted"
        >
          信任并加载
        </button>
      </div>
    </div>
  </div>
</template>
