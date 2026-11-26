/**
 * 定时调度：每分钟检查一次到期任务，按调度里记录的项目与参数值启动运行。
 *
 * 桌面应用没有常驻服务：应用退出后不再触发，界面上要写明这一点，不能让用户以为关掉应用也会跑。
 * 防重入按「同一工作流已有运行在推进」判断——定时触发的语义是到点试一次，不排队补跑。
 * 触发失败的几种情形（项目被移除、定义不合法、必填参数缺值）都静默跳过：没有人能当场回答，
 * 记一条日志就够，不为此另建一套告警。
 */
import { getPiAgentDir } from '../shared/pi-paths'
import {
  matchesWorkflowCron,
  missingWorkflowParameters,
  resolveWorkflowParameters,
  validateWorkflowGraph
} from '../../shared/workflow-api'
import type { WorkflowDefinition, WorkflowRun, WorkflowSchedule } from '../../shared/workflow-api'
import { findSchedule, listEnabledSchedules } from './store'
import type { ScheduledWorkflow } from './store'
import { hasRunningWorkflow, startWorkflowRun } from './runner'

/** 检查间隔：小于一分钟，用来保证每分钟至少检查一次，同分钟内不重复判定。 */
const TICK_INTERVAL_MS = 15_000

let timer: NodeJS.Timeout | null = null
/** 上一次判定的分钟（毫秒时间戳按分钟取整）；同一分钟只判一次。 */
let lastMinuteKey = -1
let hasProject: ((projectPath: string) => Promise<boolean>) | null = null

/** 校验并启动一次运行；返回 null 表示这次触发被跳过。 */
async function trigger(
  definition: WorkflowDefinition,
  schedule: WorkflowSchedule,
  projectPath: string
): Promise<WorkflowRun | null> {
  if (hasProject === null) return null
  if (!await hasProject(projectPath)) return null
  // 防重入与启动必须处在同一个同步段内：await 之后再判一次，
  // 否则同一分钟内的定时触发与「立即运行」会双双通过检查各开一次。
  if (hasRunningWorkflow(schedule.workflowId)) return null
  if (validateWorkflowGraph(definition).length > 0) return null
  const values = resolveWorkflowParameters(definition.parameters, schedule.parameters)
  if (missingWorkflowParameters(definition.parameters, values).length > 0) return null
  return startWorkflowRun(definition, projectPath, values)
}

async function tick(): Promise<void> {
  const at = new Date()
  const minuteKey = Math.floor(at.getTime() / 60_000)
  if (minuteKey === lastMinuteKey) return
  let entries: ScheduledWorkflow[] = []
  try {
    entries = await listEnabledSchedules(getPiAgentDir())
  } catch {
    // 读不出来就不记这一分钟：下一个 15 秒还会重试，不会把整分钟窗口吞掉。
    return
  }
  lastMinuteKey = minuteKey
  for (const entry of entries) {
    if (!matchesWorkflowCron(entry.schedule.cron, at)) continue
    try {
      await trigger(entry.definition, entry.schedule, entry.schedule.projectPath)
    } catch {
      // 单条触发失败不影响同分钟里其他调度。
    }
  }
}

/** 装配期启动调度器；重复调用以最后一次的项目校验回调为准。 */
export function startWorkflowScheduler(check: (projectPath: string) => Promise<boolean>): void {
  hasProject = check
  if (timer !== null) return
  // 启动时立刻判一次：应用刚打开时若正好到点，不该等到下一个 15 秒。
  lastMinuteKey = -1
  void tick()
  timer = setInterval(() => { void tick() }, TICK_INTERVAL_MS)
}

/** 停用插件或退出应用时停掉定时器；不清项目校验回调，重启装配会重新设置。 */
export function stopWorkflowScheduler(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
}

/** 立即按某个定时任务的配置跑一次（不等下一个时刻）；找不到或跳过时返回 null。 */
export async function runScheduleOnce(scheduleId: string): Promise<WorkflowRun | null> {
  const found = await findSchedule(getPiAgentDir(), scheduleId)
  if (found === null) return null
  return trigger(found.definition, found.schedule, found.schedule.projectPath)
}
