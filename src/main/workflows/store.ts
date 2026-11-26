/**
 * 工作流定义的落盘：`<agentDir>/workflows/<id>/workflow.json`。
 *
 * 目录名即标识，创建后不可改；写入走一份临时文件再改名（同目录 rename），避免半份 JSON 落盘。
 * 删除通过 Electron 的 `shell.trashItem` 移入系统废纸篓，不做硬删除。
 * 定义文件只由本模块读写，运行记录另在 `run-store`。
 */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { shell } from 'electron'
import {
  MAX_WORKFLOW_ENTRIES,
  MAX_WORKFLOW_SCHEDULES,
  parseWorkflowDefinition,
  parseWorkflowSchedule,
  validateWorkflowGraph
} from '../../shared/workflow-api'
import type {
  WorkflowDefinition,
  WorkflowIssueView,
  WorkflowParameter,
  WorkflowParameterValues,
  WorkflowSchedule,
  WorkflowView
} from '../../shared/workflow-api'

/** 定义文件名；目录里只有这一个文件才算一份合法定义。 */
const DEFINITION_FILE = 'workflow.json'
/** 定时任务文件名：与定义同目录，删除定义时一并移除。 */
const SCHEDULES_FILE = 'schedules.json'

/** 临时文件序号：同一进程内并发写不能共用一个临时名，否则互相截断。 */
let tmpSequence = 0
function temporaryPath(target: string): string {
  tmpSequence += 1
  return `${target}.${process.pid}.${tmpSequence}.tmp`
}

function workflowsRoot(agentDir: string): string {
  return join(agentDir, 'workflows')
}

function workflowDirectory(agentDir: string, workflowId: string): string {
  return join(workflowsRoot(agentDir), workflowId)
}

/** 新建标识：时间戳转 36 进制，足以在本机内唯一，也不依赖随机数。 */
function allocateWorkflowId(existing: ReadonlySet<string>): string {
  const stamp = Date.now().toString(36).replace(/[^a-z0-9]/g, '')
  let candidate = `wf-${stamp}`
  let suffix = 1
  while (existing.has(candidate)) {
    candidate = `wf-${stamp}-${suffix}`
    suffix += 1
    if (suffix > 99) return `wf-${stamp}-${Math.random().toString(36).slice(2, 6)}`
  }
  return candidate
}

/** 现有标识清单：只取目录名，读不到目录时按空处理（首次新建）。 */
async function existingIds(agentDir: string): Promise<string[]> {
  try {
    const entries = await readdir(workflowsRoot(agentDir), { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }
}

/** 读取一份定义；文件缺失或内容不合契约时返回 null，由调用方给出 NOT_FOUND。 */
export async function readWorkflowFile(
  agentDir: string,
  workflowId: string
): Promise<WorkflowDefinition | null> {
  try {
    const text = await readFile(join(workflowDirectory(agentDir, workflowId), DEFINITION_FILE), 'utf-8')
    return parseWorkflowDefinition(JSON.parse(text))
  } catch {
    return null
  }
}

/** 清单：按更新时间倒序；单份定义损坏只跳过它，不让整份清单失败。 */
export async function listWorkflowFiles(agentDir: string): Promise<WorkflowView[]> {
  const ids = (await existingIds(agentDir)).slice(0, MAX_WORKFLOW_ENTRIES)
  const views: WorkflowView[] = []
  for (const id of ids) {
    const definition = await readWorkflowFile(agentDir, id)
    if (definition === null) continue
    views.push({
      id: definition.id,
      name: definition.name,
      summary: definition.summary,
      nodeCount: definition.nodes.length,
      updatedAt: definition.updatedAt
    })
  }
  return views.sort((left, right) => right.updatedAt - left.updatedAt)
}

export interface SaveWorkflowInput {
  /** 空串表示新建。 */
  readonly workflowId: string
  readonly name: string
  readonly summary: string
  readonly parameters: readonly WorkflowParameter[]
  readonly nodes: WorkflowDefinition['nodes']
  readonly edges: WorkflowDefinition['edges']
}

export type SaveWorkflowOutcome =
  | { readonly ok: true; readonly workflowId: string; readonly definition: WorkflowDefinition }
  | { readonly ok: false; readonly reason: 'invalid'; readonly issues: readonly WorkflowIssueView[] }
  | { readonly ok: false; readonly reason: 'not-found' }

/**
 * 保存定义：先校验图形，再落盘。
 * 标识不是由页面决定的——新建时分配；已存在时沿用；传了不存在的标识时直接报错，
 * 不静默新建一份（否则另一处删掉后保存会凭空多出一份同名工作流）。
 */
export async function saveWorkflowFile(
  agentDir: string,
  input: SaveWorkflowInput
): Promise<SaveWorkflowOutcome> {
  const issues = validateWorkflowGraph(input)
  if (issues.length > 0) return { ok: false, reason: 'invalid', issues }

  const ids = new Set(await existingIds(agentDir))
  if (input.workflowId !== '' && !ids.has(input.workflowId)) return { ok: false, reason: 'not-found' }
  const workflowId = input.workflowId === '' ? allocateWorkflowId(ids) : input.workflowId

  const definition: WorkflowDefinition = {
    id: workflowId,
    name: input.name.trim(),
    summary: input.summary.trim(),
    parameters: input.parameters,
    nodes: input.nodes,
    edges: input.edges,
    updatedAt: Date.now()
  }

  const directory = workflowDirectory(agentDir, workflowId)
  await mkdir(directory, { recursive: true })
  const target = join(directory, DEFINITION_FILE)
  const temporary = temporaryPath(target)
  await writeFile(temporary, `${JSON.stringify(definition, null, 2)}\n`, 'utf-8')
  await rename(temporary, target)
  return { ok: true, workflowId, definition }
}

/** 删除定义目录：整份进系统废纸篓；目录不存在视为已完成。 */
export async function deleteWorkflowFile(agentDir: string, workflowId: string): Promise<boolean> {
  const directory = workflowDirectory(agentDir, workflowId)
  try {
    await shell.trashItem(directory)
    return true
  } catch {
    try {
      await readdir(directory)
      return false
    } catch {
      return true
    }
  }
}

/* ------------------------------------------------------------------ 定时任务 */

/** 读取某个工作流的定时任务；文件缺失、内容不合契约或属于别的工作流时按空处理。 */
async function readScheduleFile(agentDir: string, workflowId: string): Promise<WorkflowSchedule[]> {
  try {
    const text = await readFile(join(workflowDirectory(agentDir, workflowId), SCHEDULES_FILE), 'utf-8')
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return []
    const list = (parsed as { schedules?: unknown }).schedules
    if (!Array.isArray(list)) return []
    const schedules: WorkflowSchedule[] = []
    for (const item of list.slice(0, MAX_WORKFLOW_SCHEDULES)) {
      const schedule = parseWorkflowSchedule(item)
      if (schedule !== null && schedule.workflowId === workflowId) schedules.push(schedule)
    }
    return schedules
  } catch {
    return []
  }
}

async function writeScheduleFile(
  agentDir: string,
  workflowId: string,
  schedules: readonly WorkflowSchedule[]
): Promise<void> {
  const directory = workflowDirectory(agentDir, workflowId)
  await mkdir(directory, { recursive: true })
  const target = join(directory, SCHEDULES_FILE)
  const temporary = temporaryPath(target)
  await writeFile(temporary, `${JSON.stringify({ schedules }, null, 2)}\n`, 'utf-8')
  await rename(temporary, target)
}

/** 列出一个工作流的定时任务。 */
export async function listSchedules(agentDir: string, workflowId: string): Promise<WorkflowSchedule[]> {
  return readScheduleFile(agentDir, workflowId)
}

export interface SaveScheduleInput {
  /** 空串表示新建。 */
  readonly scheduleId: string
  readonly workflowId: string
  readonly cron: string
  readonly projectPath: string
  readonly parameters: WorkflowParameterValues
  readonly enabled: boolean
}

export type SaveScheduleOutcome =
  | { readonly ok: true; readonly schedule: WorkflowSchedule }
  | { readonly ok: false; readonly reason: 'full' | 'not-found' }

/** 保存一个定时任务：标识由主进程分配，同一工作流下最多 `MAX_WORKFLOW_SCHEDULES` 条。 */
export async function saveSchedule(agentDir: string, input: SaveScheduleInput): Promise<SaveScheduleOutcome> {
  const schedules = await readScheduleFile(agentDir, input.workflowId)
  const existing = input.scheduleId === '' ? null : schedules.find(item => item.id === input.scheduleId)
  if (input.scheduleId !== '' && existing === null) return { ok: false, reason: 'not-found' }
  if (existing === null && schedules.length >= MAX_WORKFLOW_SCHEDULES) return { ok: false, reason: 'full' }
  const schedule: WorkflowSchedule = {
    id: existing?.id ?? `sch-${Date.now().toString(36)}`,
    workflowId: input.workflowId,
    cron: input.cron.trim(),
    projectPath: input.projectPath,
    parameters: input.parameters,
    enabled: input.enabled
  }
  const next = existing === null
    ? [...schedules, schedule]
    : schedules.map(item => item.id === schedule.id ? schedule : item)
  await writeScheduleFile(agentDir, input.workflowId, next)
  return { ok: true, schedule }
}

/** 删除一个定时任务；找不到时不当作错误（可能已经被删过）。 */
export async function deleteSchedule(agentDir: string, scheduleId: string): Promise<void> {
  for (const workflowId of await existingIds(agentDir)) {
    const schedules = await readScheduleFile(agentDir, workflowId)
    if (!schedules.some(item => item.id === scheduleId)) continue
    await writeScheduleFile(agentDir, workflowId, schedules.filter(item => item.id !== scheduleId))
    return
  }
}

/** 调度器读的一整份快照：调度 + 它所属的定义，一次读全避免 tick 里反复读文件。 */
export interface ScheduledWorkflow {
  readonly schedule: WorkflowSchedule
  readonly definition: WorkflowDefinition
}

/** 读出所有工作流下启用的定时任务及其定义；单条跳过不影响其余。 */
export async function listEnabledSchedules(agentDir: string): Promise<ScheduledWorkflow[]> {
  const result: ScheduledWorkflow[] = []
  for (const workflowId of await existingIds(agentDir)) {
    const schedules = await readScheduleFile(agentDir, workflowId)
    if (schedules.length === 0) continue
    const definition = await readWorkflowFile(agentDir, workflowId)
    if (definition === null) continue
    for (const schedule of schedules) {
      if (schedule.enabled) result.push({ schedule, definition })
    }
  }
  return result
}

/** 按标识找一个定时任务及其定义；立即运行与调度触发共用。 */
export async function findSchedule(agentDir: string, scheduleId: string): Promise<ScheduledWorkflow | null> {
  for (const workflowId of await existingIds(agentDir)) {
    const schedules = await readScheduleFile(agentDir, workflowId)
    const schedule = schedules.find(item => item.id === scheduleId)
    if (schedule === undefined) continue
    const definition = await readWorkflowFile(agentDir, workflowId)
    return definition === null ? null : { schedule, definition }
  }
  return null
}

