<!-- Pi 运行目录设置分节：显示产品自有 agent 目录、只读共享来源与首启导入状态。
     只读状态与触发导入，不读取任何配置文件正文；导入不会覆盖产品目录里已有的项。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppButton from '../../ui/AppButton.vue'
import { importSharedAgent, loadAgentHomeState } from '../services/agent-home'
import type { AgentHomeImportItem, AgentHomeSnapshot } from '../../../../shared/agent-home-api'

const snapshot = ref<AgentHomeSnapshot | null>(null)
const loading = ref(true)
const busy = ref(false)
const error = ref<string | null>(null)
const feedback = ref<string | null>(null)

const stateLabels: Record<AgentHomeSnapshot['imported']['state'], string> = {
  idle: '尚未导入', running: '正在导入', done: '已导入', partial: '部分未导入', skipped: '未导入'
}
const itemLabels: Record<AgentHomeImportItem['id'], string> = {
  settings: 'Pi 设置', models: '供应商定义', mcp: 'MCP 服务器', npm: '扩展包', sessions: '会话历史'
}
const itemStateLabels: Record<AgentHomeImportItem['state'], string> = {
  copied: '已复制', existing: '已存在，跳过', missing: '共享目录没有', failed: '复制失败'
}

/** 需要重试的项：只有复制失败需要处置，缺失项通常只是源目录没有对应文件。 */
const failedItems = computed(() => (snapshot.value?.imported.items ?? [])
  .filter(item => item.state === 'failed'))

async function refresh(): Promise<void> {
  loading.value = true
  const result = await loadAgentHomeState()
  loading.value = false
  if (!result.ok) { error.value = result.error.message; return }
  error.value = null
  snapshot.value = result.data
}

async function importNow(): Promise<void> {
  if (busy.value) return
  busy.value = true
  feedback.value = null
  const result = await importSharedAgent()
  busy.value = false
  if (!result.ok) { error.value = result.error.message; return }
  error.value = null
  snapshot.value = result.data
  feedback.value = result.data.imported.state === 'partial'
    ? '导入完成，但部分项目没有复制成功；可再次导入重试。'
    : '导入完成；已有的项保持不变，源目录没有被修改。'
}

onMounted(() => { void refresh() })
</script>

<template>
  <section class="settings-section space-y-4" aria-labelledby="agent-home-title">
    <div class="settings-section-heading">
      <div>
        <h2 id="agent-home-title" class="panel-section-title">Pi 运行目录</h2>
        <p class="mt-1 max-w-prose text-xs leading-5 text-desk-muted">
          桌面用自己的一份 agent 目录保存凭据、设置、模型、MCP、会话与已装包，与终端 CLI 互不覆盖；
          CLI 目录只用于只读加载 <code>AGENTS.md</code> 与 <code>skills/</code>，因此同一份规则与技能在两个宿主里都生效。
        </p>
      </div>
    </div>

    <p v-if="loading" role="status" class="text-xs text-desk-muted">读取目录状态…</p>
    <p v-else-if="error !== null" role="alert" class="status-notice status-notice-error">{{ error }}</p>

    <template v-if="snapshot !== null">
      <div class="settings-row">
        <span class="text-sm font-medium">产品运行目录</span>
        <p class="break-all text-2xs text-desk-muted">{{ snapshot.productDir }}</p>
      </div>
      <div class="settings-row">
        <span class="text-sm font-medium">只读共享目录</span>
        <p class="break-all text-2xs text-desk-muted">
          {{ snapshot.sharedDir }}
          <template v-if="!snapshot.sharedDirExists">（当前不存在）</template>
        </p>
      </div>
      <p
        v-if="snapshot.explicitDirectory"
        role="status"
        class="status-notice status-notice-warn"
      >
        已由 <code>PI_CODING_AGENT_DIR</code> 指定目录：产品与 CLI 暂时共用同一份配置，导入与隔离都不生效。
      </p>

      <h3 class="panel-section-title">从 Pi 全局目录导入</h3>
      <p class="max-w-prose text-xs leading-5 text-desk-muted">
        只复制可复用的部分：设置、供应商定义、MCP 配置、扩展包与会话历史。
        登录凭据不复制，需要在桌面重新登录一次；源目录不会被修改或删除。
      </p>

      <div class="settings-row">
        <span class="text-sm font-medium">导入状态</span>
        <p class="text-2xs text-desk-muted">{{ stateLabels[snapshot.imported.state] }}</p>
      </div>

      <ul v-if="snapshot.imported.items.length > 0" class="space-y-1">
        <li
          v-for="item in snapshot.imported.items"
          :key="item.id"
          class="flex flex-wrap items-baseline gap-x-2 text-2xs text-desk-muted"
        >
          <span class="text-sm text-desk-ink">{{ itemLabels[item.id] }}</span>
          <span>{{ itemStateLabels[item.state] }}</span>
          <span v-if="item.detail !== null" class="break-all">（{{ item.detail }}）</span>
        </li>
      </ul>

      <p
        v-if="snapshot.imported.message !== null"
        role="status"
        class="status-notice status-notice-warn"
      >
        {{ snapshot.imported.message }}
      </p>
      <p v-if="failedItems.length > 0" role="status" class="text-2xs text-desk-muted">
        有 {{ failedItems.length }} 项没有复制成功，可再次导入重试；已存在的项不会被覆盖。
      </p>
      <p v-if="feedback !== null" role="status" class="text-2xs text-desk-muted">{{ feedback }}</p>

      <div class="flex items-center gap-2">
        <AppButton
          variant="primary"
          :disabled="busy || snapshot.explicitDirectory"
          @click="importNow"
        >
          {{ busy ? '导入中…' : '重新导入' }}
        </AppButton>
        <p v-if="snapshot.explicitDirectory" class="text-2xs text-desk-muted">
          目录被显式指定时不需要导入。
        </p>
      </div>
    </template>
  </section>
</template>
