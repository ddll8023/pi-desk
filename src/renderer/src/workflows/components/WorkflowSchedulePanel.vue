<!--
  定时任务面板：为一个工作流配置按 cron 触发的运行。

  定时任务自带项目与参数值——到点时没人可问，值必须提前定下来。
  触发只在应用运行期间发生，这一点写在面板顶部，不让用户以为关掉应用也会跑。
  常用节奏给预设按钮，用户不必记 cron 语法；写错时本地先用同一份解析函数拦住。
-->
<script setup lang="ts">
import { ref, watch } from 'vue'
import { isWorkflowCron, missingWorkflowParameters } from '../../../../shared/workflow-api'
import type { WorkflowParameter, WorkflowSchedule } from '../../../../shared/workflow-api'
import { useWorkflowScheduleStore } from '../stores/workflow-schedule'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  readonly open: boolean
  readonly workflowId: string | null
  readonly parameters: readonly WorkflowParameter[]
  readonly projectPath: string | null
}>()

const emit = defineEmits<{ close: [] }>()

const store = useWorkflowScheduleStore()

const editingId = ref<string>('')
const cron = ref('0 9 * * 1-5')
const values = ref<Record<string, string>>({})
const enabled = ref(true)
const localError = ref<string | null>(null)

const CRON_PRESETS: readonly { label: string; cron: string }[] = [
  { label: '每天 09:00', cron: '0 9 * * *' },
  { label: '工作日 09:00', cron: '0 9 * * 1-5' },
  { label: '每周一 09:00', cron: '0 9 * * 1' },
  { label: '每小时', cron: '0 * * * *' }
]

watch(() => props.open, open => {
  if (!open || props.workflowId === null) return
  store.clearMessages()
  void store.load(props.workflowId)
  resetDraft()
}, { immediate: true })

function resetDraft(): void {
  editingId.value = ''
  cron.value = '0 9 * * 1-5'
  enabled.value = true
  localError.value = null
  const next: Record<string, string> = {}
  for (const parameter of props.parameters) next[parameter.name] = parameter.defaultValue
  values.value = next
}

function edit(schedule: WorkflowSchedule): void {
  editingId.value = schedule.id
  cron.value = schedule.cron
  enabled.value = schedule.enabled
  const next: Record<string, string> = {}
  for (const parameter of props.parameters) {
    next[parameter.name] = schedule.parameters[parameter.name] ?? parameter.defaultValue
  }
  values.value = next
  localError.value = null
}

async function submit(): Promise<void> {
  const workflowId = props.workflowId
  if (workflowId === null) return
  if (!isWorkflowCron(cron.value)) {
    localError.value = 'cron 写法不合法：需要五段「分 时 日 月 周」，支持 *、数字、区间、列表与 */n。'
    return
  }
  const projectPath = props.projectPath
  if (projectPath === null) {
    localError.value = '先打开一个项目：定时任务要在项目目录里运行。'
    return
  }
  // 必填参数必须先有值：到点时无人可问，缺值只会变成一条失败记录。
  const missing = missingWorkflowParameters(props.parameters, values.value)
  if (missing.length > 0) {
    localError.value = `这些参数是必填的：${missing.join('、')}。`
    return
  }
  localError.value = null
  const saved = await store.save({
    scheduleId: editingId.value,
    workflowId,
    cron: cron.value.trim(),
    projectPath,
    parameters: { ...values.value },
    enabled: enabled.value
  })
  if (saved) resetDraft()
}

function describe(schedule: WorkflowSchedule): string {
  return `${schedule.cron} · ${schedule.projectPath}${schedule.enabled ? '' : '（已停用）'}`
}
</script>

<template>
  <div v-if="props.open" class="workflow-overlay" role="dialog" aria-label="定时任务">
    <section class="workflow-dialog">
      <header class="workflow-dialog-head">
        <h2 class="text-sm font-semibold">定时任务</h2>
        <AppButton variant="compact" @click="emit('close')">关闭</AppButton>
      </header>
      <p class="workflow-hint">按 cron 触发运行；只在应用运行期间生效，应用退出后不再触发。</p>

      <ul v-if="store.schedules.length > 0" class="workflow-schedule-list">
        <li v-for="item in store.schedules" :key="item.id" class="workflow-schedule-item">
          <span class="workflow-schedule-text">{{ describe(item) }}</span>
          <div class="flex gap-1">
            <AppButton variant="compact" :disabled="store.busy" @click="store.runNow(item.id)">立即运行</AppButton>
            <AppButton variant="compact" @click="edit(item)">编辑</AppButton>
            <AppButton variant="quiet-danger" :disabled="store.busy" @click="store.remove(item.id)">删除</AppButton>
          </div>
        </li>
      </ul>
      <p v-else class="workflow-hint">还没有定时任务。</p>

      <hr class="workflow-divider">

      <h3 class="text-xs font-semibold">{{ editingId === '' ? '新增定时任务' : '编辑定时任务' }}</h3>

      <label class="workflow-field">
        <span>cron</span>
        <input v-model="cron" class="workflow-input" placeholder="0 9 * * 1-5">
      </label>
      <div class="flex flex-wrap gap-1">
        <AppButton v-for="preset in CRON_PRESETS" :key="preset.cron" variant="compact" @click="cron = preset.cron">
          {{ preset.label }}
        </AppButton>
      </div>

      <label v-for="parameter in parameters" :key="parameter.name" class="workflow-field">
        <span>{{ parameter.label }} <code class="workflow-parameter-name">&#123;&#123;{{ parameter.name }}&#125;&#125;</code></span>
        <select v-if="parameter.type === 'select'" v-model="values[parameter.name]" class="workflow-input">
          <option value="">（用默认值）</option>
          <option v-for="option in parameter.options" :key="option" :value="option">{{ option }}</option>
        </select>
        <input v-else v-model="values[parameter.name]" class="workflow-input" maxlength="400">
      </label>

      <label class="workflow-inline">
        <input v-model="enabled" type="checkbox">
        <span>启用</span>
      </label>

      <p v-if="localError !== null" class="workflow-error">{{ localError }}</p>
      <p v-if="store.error !== null" class="workflow-error">{{ store.error }}</p>
      <p v-if="store.notice !== null" class="workflow-hint">{{ store.notice }}</p>

      <div class="workflow-dialog-actions">
        <AppButton v-if="editingId !== ''" variant="compact" @click="resetDraft">取消编辑</AppButton>
        <AppButton variant="primary" :disabled="store.busy" @click="submit">
          {{ editingId === '' ? '新增' : '保存' }}
        </AppButton>
      </div>
    </section>
  </div>
</template>

<style scoped>
.workflow-overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-desk-overlay);
}

.workflow-dialog {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(560px, calc(100vw - 48px));
  max-height: calc(100vh - 96px);
  padding: 16px;
  overflow-y: auto;
  border-radius: 10px;
  background: var(--color-desk-surface);
  border: 1px solid var(--color-desk-border);
}

.workflow-dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.workflow-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.workflow-hint {
  margin: 0;
  font-size: 11px;
  color: var(--color-desk-muted);
}

.workflow-divider {
  width: 100%;
  border: none;
  border-top: 1px solid var(--color-desk-border);
}

.workflow-schedule-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.workflow-schedule-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--color-desk-border);
  border-radius: 6px;
}

.workflow-schedule-text {
  font-size: 11px;
  color: var(--color-desk-muted);
  word-break: break-all;
}

.workflow-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}

.workflow-parameter-name {
  margin-left: 6px;
  font-size: 11px;
  color: var(--color-desk-muted);
}

.workflow-input {
  padding: 5px 8px;
  border: 1px solid var(--color-desk-border);
  border-radius: 6px;
  background: transparent;
  font-size: 12px;
}

.workflow-inline {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.workflow-error {
  font-size: 12px;
  color: var(--color-desk-danger);
}
</style>
