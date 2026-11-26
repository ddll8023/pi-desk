<!--
  定时任务面板：为一个工作流配置按 cron 触发的运行。

  定时任务自带项目与参数值——到点时没人可问，值必须提前定下来。
  触发只在应用运行期间发生，这一点写在面板标题下，不让用户以为关掉应用也会跑。
  常用节奏给预设按钮，用户不必记 cron 语法；写错时本地先用同一份解析函数拦住。
  弹层外壳交给 AppDialog：焦点、Escape 与遮罩关闭由它统一处理。
-->
<script setup lang="ts">
import { ref, watch } from 'vue'
import { isWorkflowCron, missingWorkflowParameters } from '../../../../shared/workflow-api'
import type { WorkflowParameter, WorkflowSchedule } from '../../../../shared/workflow-api'
import { useWorkflowScheduleStore } from '../stores/workflow-schedule'
import AppButton from '../../ui/AppButton.vue'
import AppDialog from '../../ui/AppDialog.vue'

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

/** 表单取值：只接受真正带值的元素，避免把事件目标当成已知类型断言。 */
function inputValue(event: Event): string {
  const target = event.target
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return target.value
  return ''
}

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
  <AppDialog
    :open="props.open"
    title="定时任务"
    subtitle="按 cron 触发运行；只在应用运行期间生效，应用退出后不再触发。"
    panel-class="max-w-2xl"
    @close="emit('close')"
  >
    <ul v-if="store.schedules.length > 0" class="space-y-2">
      <li
        v-for="item in store.schedules"
        :key="item.id"
        class="flex flex-wrap items-center justify-between gap-2 rounded-desk-sm border border-desk-line px-3 py-2"
      >
        <span class="text-xs break-all text-desk-muted">{{ describe(item) }}</span>
        <div class="flex gap-1">
          <AppButton variant="compact" :disabled="store.running" @click="store.runNow(item.id)">立即运行</AppButton>
          <AppButton variant="compact" @click="edit(item)">编辑</AppButton>
          <AppButton variant="quiet-danger" :disabled="store.removing" @click="store.remove(item.id)">删除</AppButton>
        </div>
      </li>
    </ul>
    <p v-else class="text-xs text-desk-muted">还没有定时任务。</p>

    <hr class="border-t border-desk-line">

    <h3 class="text-xs font-semibold">{{ editingId === '' ? '新增定时任务' : '编辑定时任务' }}</h3>

    <div class="space-y-4">
      <label class="block space-y-1">
        <span class="field-label">cron</span>
        <input v-model="cron" class="text-control" placeholder="0 9 * * 1-5">
      </label>
      <div class="flex flex-wrap gap-1">
        <AppButton v-for="preset in CRON_PRESETS" :key="preset.cron" variant="compact" @click="cron = preset.cron">
          {{ preset.label }}
        </AppButton>
      </div>

      <label v-for="parameter in parameters" :key="parameter.name" class="block space-y-1">
        <span class="field-label">
          {{ parameter.label }}
          <code class="ml-1.5 font-mono text-2xs text-desk-muted">&#123;&#123;{{ parameter.name }}&#125;&#125;</code>
        </span>
        <select v-if="parameter.type === 'select'" v-model="values[parameter.name]" class="text-control">
          <option value="">（用默认值）</option>
          <option v-for="option in parameter.options" :key="option" :value="option">{{ option }}</option>
        </select>
        <input v-else v-model="values[parameter.name]" class="text-control" maxlength="400">
      </label>

      <label class="flex items-center gap-1.5 text-xs">
        <input v-model="enabled" type="checkbox">
        <span>启用</span>
      </label>
    </div>

    <p v-if="localError !== null" class="text-xs text-desk-danger">{{ localError }}</p>
    <p v-if="store.error !== null" class="text-xs text-desk-danger">{{ store.error }}</p>
    <p v-if="store.notice !== null" class="text-xs text-desk-muted">{{ store.notice }}</p>

    <template #footer>
      <AppButton v-if="editingId !== ''" variant="compact" @click="resetDraft">取消编辑</AppButton>
      <AppButton @click="emit('close')">关闭</AppButton>
      <AppButton variant="primary" :disabled="store.saving" @click="submit">
        {{ editingId === '' ? '新增' : '保存' }}
      </AppButton>
    </template>
  </AppDialog>
</template>
