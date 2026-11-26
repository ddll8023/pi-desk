/**
 * 定时任务的状态：清单、保存与删除、立即运行。
 *
 * 调度由主进程按分钟推进，页面只负责编辑与手动触发；清单按工作流读取，缓存没有意义
 * （刚改过的调度要立刻看到）。「应用退出后不再触发」是这条能力的事实，由界面负责说明。
 * 保存、删除、立即运行各有自己的进行中标记：点删除时不该把「立即运行」一起禁掉。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  WorkflowParameterValues,
  WorkflowSchedule,
  WorkflowScheduleSaveRequest
} from '../../../../shared/workflow-api'
import * as service from '../services/desktop'
import { useWorkflowRunStore } from './workflow-run'

export const useWorkflowScheduleStore = defineStore('workflow-schedules', () => {
  const runStore = useWorkflowRunStore()
  const schedules = ref<readonly WorkflowSchedule[]>([])
  const workflowId = ref<string | null>(null)
  const saving = ref(false)
  const removing = ref(false)
  const running = ref(false)
  const error = ref<string | null>(null)
  const notice = ref<string | null>(null)
  /** 清单读取序号：切了工作流之后，上一份清单的回包不再写进来。 */
  let listSeq = 0

  const loaded = computed(() => workflowId.value !== null)

  async function load(id: string): Promise<void> {
    const seq = ++listSeq
    workflowId.value = id
    // 先清空：否则加载完成前列表里还是上一个工作流的任务，而且能被直接操作。
    schedules.value = []
    error.value = null
    const result = await service.listWorkflowSchedules(id)
    if (seq !== listSeq) return
    if (!result.ok) {
      schedules.value = []
      error.value = result.error.message
      return
    }
    schedules.value = result.data.schedules
  }

  /** 保存一条调度：成功后就地重读清单，避免页面各存一份定义漂移。 */
  async function save(request: WorkflowScheduleSaveRequest): Promise<boolean> {
    error.value = null
    notice.value = null
    saving.value = true
    const result = await service.saveWorkflowSchedule(request)
    saving.value = false
    if (!result.ok) {
      error.value = result.error.message
      return false
    }
    notice.value = request.scheduleId === '' ? '已新增定时任务。' : '已更新定时任务。'
    await load(request.workflowId)
    return true
  }

  /** 只允许操作属于当前工作流的调度：清单可能刚切换过，按 id 删会误删别的图的。 */
  function ownedBy(scheduleId: string, id: string): boolean {
    const target = schedules.value.find(item => item.id === scheduleId)
    if (target !== undefined && target.workflowId === id) return true
    error.value = '这条定时任务不属于当前工作流。'
    return false
  }

  async function remove(scheduleId: string): Promise<void> {
    const id = workflowId.value
    if (id === null) return
    if (!ownedBy(scheduleId, id)) return
    error.value = null
    notice.value = null
    removing.value = true
    const result = await service.deleteWorkflowSchedule(scheduleId)
    removing.value = false
    if (!result.ok) {
      error.value = result.error.message
      return
    }
    notice.value = '已删除定时任务。'
    await load(id)
  }

  /** 立即跑一次：不等下一个时刻，参数取调度里存的那份值。 */
  async function runNow(scheduleId: string): Promise<void> {
    const id = workflowId.value
    if (id === null) return
    if (!ownedBy(scheduleId, id)) return
    error.value = null
    notice.value = null
    running.value = true
    const result = await service.runWorkflowSchedule(scheduleId)
    running.value = false
    if (!result.ok) {
      error.value = result.error.message
      return
    }
    runStore.adopt(result.data)
    notice.value = '已按定时任务的配置启动一次运行。'
  }

  /** 参数值补齐：调度编辑时用定义里的默认值预填，避免每次手写。 */
  function valuesOf(schedule: WorkflowSchedule): WorkflowParameterValues {
    return schedule.parameters
  }

  function clearMessages(): void {
    error.value = null
    notice.value = null
  }

  return {
    schedules,
    workflowId,
    saving,
    removing,
    running,
    error,
    notice,
    loaded,
    load,
    save,
    remove,
    runNow,
    valuesOf,
    clearMessages
  }
})
