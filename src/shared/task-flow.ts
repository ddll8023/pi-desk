/** 任务流程的有界领域契约：计划不授予执行权限，运行状态只接受宿主控制器产生的事实。 */
import type { RuntimeError, RuntimeTarget } from './runtime/status'
import { isTaskId } from './task-intent'

export const TASK_FLOW_START_CHANNEL = 'desktop:task-flow-start'
export const TASK_FLOW_READ_CHANNEL = 'desktop:task-flow-read'
export const TASK_FLOW_ENTRY_TYPE = 'pi-desk.task-flow.v1'
export const TASK_FLOW_MAX_FLOWS = 16
export const TASK_FLOW_MAX_STEPS = 12
export const TASK_FLOW_MAX_TEXT = 4096
export type TaskFlowPhase = 'pending' | 'running' | 'stopping' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export interface TaskFlowPlan {
  readonly title: string
  readonly steps: readonly { readonly title: string; readonly instruction: string }[]
}
export interface TaskFlowStep {
  readonly id: string
  readonly title: string
  readonly instruction: string
  readonly phase: TaskFlowPhase
  readonly startedAt: number | null
  readonly endedAt: number | null
  readonly promptEntryId: string | null
  readonly resultEntryId: string | null
  readonly result: string | null
  readonly error: string | null
  /** 步骤中有成功工具回执的变更路径；展示层按所属工作区转为相对路径，裁剪至有界范围。 */
  readonly changedFiles?: readonly string[]
  /** 当前步骤等待用户决定或缺少业务交付声明时的说明，不是执行错误。 */
  readonly waitingReason?: string | null
}
export interface TaskFlow {
  readonly id: string
  readonly revision: number
  readonly title: string
  readonly originEntryId: string | null
  readonly taskId?: string | null
  readonly phase: TaskFlowPhase
  readonly createdAt: number
  readonly updatedAt: number
  readonly steps: readonly TaskFlowStep[]
}
export interface TaskFlowState {
  readonly revision: number
  readonly flows: readonly TaskFlow[]
  readonly error: string | null
}
export interface TaskFlowStartRequest {
  readonly target: RuntimeTarget
  readonly flowId: string
  readonly revision: number
}
export interface TaskFlowReadRequest {
  readonly target: RuntimeTarget
  readonly revision: number | null
}
export interface TaskFlowProbe {
  readonly runtimeId: number
  readonly revision: number
  /** 水位未变化时不反复传输计划与结果，更不读取完整聊天记录。 */
  readonly state: TaskFlowState | null
}
export type TaskFlowReadResult =
  | { readonly ok: true; readonly data: TaskFlowProbe & { readonly runId?: number } }
  | { readonly ok: false; readonly error: RuntimeError }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function text(value: unknown, max = TASK_FLOW_MAX_TEXT): value is string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0')
}
function id(value: unknown): value is string { return text(value, 128) && value !== '' }
function nullableId(value: unknown): boolean { return value === null || id(value) }
function nullableText(value: unknown): boolean { return value === null || text(value) }
function optionalStringArray(value: unknown, maxItems = 64, maxLength = 512): boolean {
  if (value === undefined) return true
  return Array.isArray(value) && value.length <= maxItems
    && value.every(item => typeof item === 'string' && item.length <= maxLength && !item.includes('\0'))
}
function time(value: unknown): boolean { return value === null || count(value) }
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}
function target(value: unknown): boolean {
  return record(value) && count(value.runId) && value.runId > 0
    && count(value.runtimeId) && value.runtimeId > 0 && keys(value, ['runId', 'runtimeId'])
}
export function isTaskFlowPhase(value: unknown): value is TaskFlowPhase {
  return typeof value === 'string' && ['pending', 'running', 'stopping', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted'].includes(value)
}
export function isTaskFlowActive(phase: TaskFlowPhase): boolean {
  return phase === 'running' || phase === 'stopping'
}
export function parseTaskFlowPlan(value: unknown): TaskFlowPlan | null {
  if (!record(value) || !text(value.title, 200) || value.title.trim() === ''
    || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > TASK_FLOW_MAX_STEPS
    || !keys(value, ['title', 'steps'])) return null
  const steps: { title: string; instruction: string }[] = []
  for (const step of value.steps) {
    if (!record(step) || !text(step.title, 200) || step.title.trim() === ''
      || !text(step.instruction) || step.instruction.trim() === '' || !keys(step, ['title', 'instruction'])) return null
    steps.push({ title: step.title.trim(), instruction: step.instruction.trim() })
  }
  return { title: value.title.trim(), steps }
}
function isStep(value: unknown): value is TaskFlowStep {
  return record(value) && id(value.id) && text(value.title, 200) && value.title.trim() !== ''
    && text(value.instruction) && value.instruction.trim() !== '' && isTaskFlowPhase(value.phase)
    && time(value.startedAt) && time(value.endedAt) && nullableId(value.promptEntryId)
    && nullableId(value.resultEntryId) && nullableText(value.result) && nullableText(value.error)
    && optionalStringArray(value.changedFiles)
    && (value.waitingReason === undefined || nullableText(value.waitingReason))
    && keys(value, ['id', 'title', 'instruction', 'phase', 'startedAt', 'endedAt', 'promptEntryId', 'resultEntryId', 'result', 'error', 'changedFiles', 'waitingReason'])
}
export function isTaskFlow(value: unknown): value is TaskFlow {
  return record(value) && id(value.id) && count(value.revision) && text(value.title, 200) && value.title.trim() !== ''
    && nullableId(value.originEntryId) && (value.taskId == null || isTaskId(value.taskId)) && isTaskFlowPhase(value.phase) && count(value.createdAt) && count(value.updatedAt)
    && Array.isArray(value.steps) && value.steps.length > 0 && value.steps.length <= TASK_FLOW_MAX_STEPS
    && value.steps.every(isStep) && new Set(value.steps.map(step => step.id)).size === value.steps.length
    && keys(value, ['id', 'revision', 'title', 'originEntryId', 'taskId', 'phase', 'createdAt', 'updatedAt', 'steps'])
}
export function isTaskFlowState(value: unknown): value is TaskFlowState {
  return record(value) && count(value.revision) && nullableText(value.error)
    && Array.isArray(value.flows) && value.flows.length <= TASK_FLOW_MAX_FLOWS && value.flows.every(isTaskFlow)
    && new Set(value.flows.map(flow => flow.id)).size === value.flows.length && keys(value, ['revision', 'flows', 'error'])
}
export function isTaskFlowProbe(value: unknown): value is TaskFlowProbe {
  return record(value) && count(value.runtimeId) && value.runtimeId > 0 && count(value.revision)
    && (value.state === null || (isTaskFlowState(value.state) && value.state.revision === value.revision))
    && (value.runId === undefined || (count(value.runId) && value.runId > 0))
    && keys(value, ['runtimeId', 'revision', 'state', 'runId'])
}
export function isTaskFlowStartRequest(value: unknown): value is TaskFlowStartRequest {
  return record(value) && target(value.target) && id(value.flowId) && count(value.revision)
    && keys(value, ['target', 'flowId', 'revision'])
}
export function isTaskFlowReadRequest(value: unknown): value is TaskFlowReadRequest {
  return record(value) && target(value.target) && (value.revision === null || count(value.revision))
    && keys(value, ['target', 'revision'])
}
/** 聊天快捷入口仍要求唯一计划；一般的“继续”和用户补充不被当作启动授权。 */
export function resolveTaskFlowStart(flows: readonly TaskFlow[], message: string, attachmentCount: number): TaskFlow | null {
  if (attachmentCount !== 0) return null
  const command = message.trim()
  const phase = ['开始', '开始执行'].includes(command) ? 'pending'
    : command === '继续当前步骤' ? 'waiting' : null
  if (phase === null) return null
  const candidates = flows.filter(flow => flow.phase === phase)
  return candidates.length === 1 ? candidates[0] ?? null : null
}
export function emptyTaskFlowState(): TaskFlowState { return { revision: 0, flows: [], error: null } }
/** 同一分支内仅用流程修订号合并，不用到达顺序或时间戳覆盖更新的事实。 */
export function mergeTaskFlows(previous: readonly TaskFlow[], incoming: readonly TaskFlow[]): TaskFlow[] {
  const flows = new Map(previous.map(flow => [flow.id, flow]))
  for (const flow of incoming) {
    if ((flows.get(flow.id)?.revision ?? -1) <= flow.revision) flows.set(flow.id, flow)
  }
  return [...flows.values()]
}
