<!--
  设置页「工作流」分节：存储位置、运行记录的保留口径与清理入口。

  这些是能力级的固定事实（目录由主进程给出），页面上只做说明与清理，不做可调参数：
  并发上限与节点超时是运行语义的一部分，放开成设置项会让同一个图在不同机器上行为不一致。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { MAX_WORKFLOW_CONCURRENCY } from '../../../../shared/workflow-api'
import { clearWorkflowRuns } from '../services/desktop'
import AppButton from '../../ui/AppButton.vue'

const clearing = ref(false)
const notice = ref<string | null>(null)
const error = ref<string | null>(null)

const keepHint = computed(() => `同层最多 ${MAX_WORKFLOW_CONCURRENCY} 个节点并行；运行记录保留最近 50 份，超出的在启动时清理。`)

async function clearRuns(): Promise<void> {
  if (clearing.value) return
  clearing.value = true
  notice.value = null
  error.value = null
  const result = await clearWorkflowRuns()
  clearing.value = false
  if (!result.ok) {
    error.value = result.error.message
    return
  }
  notice.value = result.data.removed === 0 ? '没有可清理的运行记录。' : `已清理 ${result.data.removed} 份运行记录。`
}
</script>

<template>
  <div class="settings-section-stack">
    <header>
      <h1 class="text-xl font-semibold tracking-tight">工作流</h1>
      <p class="mt-1 text-sm text-desk-muted">
        节点图编排：一个节点是一次独立的 Agent 会话，边决定推进方向。
      </p>
    </header>

    <section class="settings-section">
      <div class="settings-section-heading">
        <h2 class="settings-section-title">存储与运行</h2>
      </div>
      <dl class="mt-3 grid gap-2 text-xs">
        <div class="flex gap-2">
          <dt class="w-24 shrink-0 text-desk-muted">定义</dt>
          <dd>产品 agent 目录下的 <code>workflows/&lt;标识&gt;/workflow.json</code>；删除走系统废纸篓。</dd>
        </div>
        <div class="flex gap-2">
          <dt class="w-24 shrink-0 text-desk-muted">运行记录</dt>
          <dd>产品 agent 目录下的 <code>workflow-runs/&lt;运行标识&gt;/</code>，含每个节点的会话文件。</dd>
        </div>
        <div class="flex gap-2">
          <dt class="w-24 shrink-0 text-desk-muted">口径</dt>
          <dd>{{ keepHint }}</dd>
        </div>
      </dl>

      <div class="mt-4 flex items-center gap-3">
        <AppButton variant="quiet-danger" :disabled="clearing" @click="clearRuns">
          {{ clearing ? '清理中…' : '清空已结束的运行记录' }}
        </AppButton>
        <span v-if="notice !== null" class="text-xs text-desk-muted">{{ notice }}</span>
        <span v-if="error !== null" class="text-xs text-desk-danger">{{ error }}</span>
      </div>
    </section>
  </div>
</template>
