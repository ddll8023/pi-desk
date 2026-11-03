/** 单会话任务执行所有者：先记录再执行，程序串行推进步骤，页面与模型均不能自行改写运行终态。 */
import { randomUUID } from 'node:crypto'
import { emptyTaskFlowState, isTaskFlowActive, TASK_FLOW_MAX_FLOWS, TASK_FLOW_MAX_TEXT } from '../../shared/task-flow'
import type { TaskFlow, TaskFlowPhase, TaskFlowPlan, TaskFlowState, TaskFlowStep } from '../../shared/task-flow'
import { interruptHistoricalFlow } from './history'

export interface TaskStepOutcome {
  readonly phase: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  readonly result: string | null
  readonly error: string | null
  readonly promptEntryId: string | null
  readonly resultEntryId: string | null
  readonly changedFiles?: readonly string[]
}
interface ExecutionHost {
  persist(flow: TaskFlow): void
  changed(state: TaskFlowState): void
  execute(flow: TaskFlow, step: TaskFlowStep, index: number): Promise<TaskStepOutcome>
}
function boundedText(value: string | null): string | null {
  if (value === null) return null
  const text = value.replaceAll('\0', '�')
  if (text.length <= TASK_FLOW_MAX_TEXT) return text
  return text.slice(0, TASK_FLOW_MAX_TEXT - 24) + '\n（内容已省略，完整输出见会话）'
}

export class TaskFlowController {
  private state: TaskFlowState = emptyTaskFlowState()
  private host: ExecutionHost | null = null
  private generation = 0
  private activeId: string | null = null
  private stopRequested = false
  private execution: Promise<void> | null = null

  get active(): boolean { return this.activeId !== null }
  snapshot(): TaskFlowState { return this.state }
  bind(flows: readonly TaskFlow[], host: ExecutionHost): void {
    const revision = this.state.revision + 1
    this.reset()
    this.host = host
    this.state = { revision, flows: flows.slice(-TASK_FLOW_MAX_FLOWS).map(interruptHistoricalFlow), error: null }
    this.notify()
  }
  /** 换绑令旧异步执行失效；不会在新会话里补写旧终态。 */
  reset(): void {
    this.generation++
    this.host = null
    this.activeId = null
    this.stopRequested = true
    this.execution = null
    this.state = emptyTaskFlowState()
  }
  create(plan: TaskFlowPlan, originEntryId: string | null): TaskFlow {
    if (this.host === null || this.active) throw new Error('当前任务仍在执行，不能替换计划。')
    // 新计划只替代尚未执行的计划，不修改已结束的执行记录。
    for (const pending of this.state.flows.filter(flow => flow.phase === 'pending')) {
      this.commit({ ...pending, phase: 'cancelled', steps: pending.steps.map<TaskFlowStep>(step => ({ ...step, phase: 'cancelled' })) })
    }
    const now = Date.now()
    const flow: TaskFlow = { id: randomUUID(), revision: 0, title: plan.title, originEntryId,
      phase: 'pending', createdAt: now, updatedAt: now, steps: plan.steps.map<TaskFlowStep>(step => ({
        ...step, id: randomUUID(), phase: 'pending', startedAt: null, endedAt: null,
        promptEntryId: null, resultEntryId: null, result: null, error: null, changedFiles: []
      })) }
    this.commit(flow)
    return this.find(flow.id)
  }
  /** 启动回执不等待整段执行；启动记录持久化失败时绝不派发第一步。 */
  start(id: string, revision: number): void {
    const host = this.host
    const flow = this.find(id)
    if (host === null || this.active || flow.phase !== 'pending' || flow.revision !== revision) {
      throw new Error('计划已变化或已经启动，请同步后查看，不会重复执行。')
    }
    this.activeId = id
    this.stopRequested = false
    try { this.commit({ ...flow, phase: 'running' }) } catch (error) { this.activeId = null; throw error }
    const generation = this.generation
    const execution = Promise.resolve().then(() => this.run(id, generation, host))
      .catch(error => {
        if (this.generation !== generation || this.host !== host) return
        const current = this.find(id)
        const reason = error instanceof Error ? error.message : '步骤执行异常。'
        this.commitSafely({ ...current, phase: 'failed', steps: current.steps.map<TaskFlowStep>(step =>
          isTaskFlowActive(step.phase) ? { ...step, phase: 'failed', endedAt: Date.now(), error: boundedText(reason) } : step) })
      }).finally(() => {
        if (this.generation !== generation || this.host !== host) return
        this.activeId = null
        this.execution = null
        this.notify()
      })
    this.execution = execution
  }
  /** 先关闭下一步派发，再由宿主实际中止；记录故障也不能阻止真正的取消动作。 */
  requestStop(): void {
    if (this.activeId === null) return
    this.stopRequested = true
    const flow = this.find(this.activeId)
    this.commitSafely({ ...flow, phase: 'stopping', steps: flow.steps.map<TaskFlowStep>(step =>
      step.phase === 'running' ? { ...step, phase: 'stopping' } : step) })
  }
  async waitForStop(): Promise<void> { await this.execution }
  private find(id: string): TaskFlow {
    const flow = this.state.flows.find(candidate => candidate.id === id)
    if (flow === undefined) throw new Error('任务不属于当前会话分支。')
    return flow
  }
  private async run(id: string, generation: number, host: ExecutionHost): Promise<void> {
    const valid = (): boolean => this.generation === generation && this.host === host
    for (let index = 0; valid() && index < this.find(id).steps.length; index++) {
      if (this.stopRequested) break
      const flow = this.find(id)
      const step = flow.steps[index]
      if (step === undefined || step.phase !== 'pending') throw new Error('步骤状态不允许启动。')
      this.commit({ ...flow, steps: flow.steps.map<TaskFlowStep>(candidate => candidate.id === step.id
        ? { ...candidate, phase: 'running', startedAt: Date.now() } : candidate) })
      // changed 回调可能触发取消；派发之前再检查一次，不能越过停止门。
      if (!valid() || this.stopRequested) break
      const outcome = await host.execute(this.find(id), step, index)
      if (!valid()) return
      const current = this.find(id)
      const phase = this.stopRequested ? 'cancelled' : outcome.phase
      this.commit({ ...current, steps: current.steps.map<TaskFlowStep>(candidate => candidate.id === step.id
        ? { ...candidate, ...outcome, phase, result: boundedText(outcome.result), error: boundedText(outcome.error),
            changedFiles: outcome.changedFiles?.slice(0, 64) ?? candidate.changedFiles ?? [], endedAt: Date.now() }
        : candidate) })
      if (phase !== 'completed') {
        this.finish(id, phase)
        return
      }
      // 步骤边界交还事件循环，让已送达的停止与生命周期控制先于下一步处理。
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    if (valid()) this.finish(id, this.stopRequested ? 'cancelled' : 'completed')
  }
  private finish(id: string, phase: TaskFlowPhase): void {
    const flow = this.find(id)
    this.commit({ ...flow, phase, steps: flow.steps.map<TaskFlowStep>(step =>
      isTaskFlowActive(step.phase) ? { ...step, phase: phase === 'cancelled' ? 'cancelled' : 'interrupted', endedAt: Date.now() } : step) })
  }
  private commit(flow: TaskFlow): void {
    const host = this.host
    if (host === null) throw new Error('任务执行环境已经失效。')
    const next = { ...flow, revision: flow.revision + 1, updatedAt: Date.now() }
    host.persist(next)
    const flows = this.state.flows.filter(candidate => candidate.id !== flow.id)
    flows.push(next)
    this.state = { revision: this.state.revision + 1, flows: flows.slice(-TASK_FLOW_MAX_FLOWS), error: null }
    this.notify()
  }
  private commitSafely(flow: TaskFlow): void {
    try { this.commit(flow) } catch {
      const flows = this.state.flows.map(candidate => candidate.id === flow.id
        ? { ...flow, revision: flow.revision + 1, updatedAt: Date.now() } : candidate)
      this.state = { revision: this.state.revision + 1, flows, error: '任务状态记录失败；已停止继续派发，请保留当前结果。' }
      this.stopRequested = true
      this.notify()
    }
  }
  private notify(): void {
    // 通知消费者失效不能中断执行所有者；丢失通知由同源快照恢复。
    try { this.host?.changed(this.state) } catch { console.error('[task-flow] 状态通知失败，保留快照等待同步。') }
  }
}
