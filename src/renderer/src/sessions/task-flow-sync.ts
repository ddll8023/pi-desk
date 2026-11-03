/** 在途流程的轻量对账：事件优先，快照水位兜底；不保存第二份任务状态，不自动重发执行请求。 */
import type { TaskFlowProbe } from '../../../shared/task-flow'
import type { RuntimeTarget } from '../../../shared/runtime-api'
import { getRuntimeTaskFlow } from './services/runtime'

interface ReconcileTarget {
  readonly target: RuntimeTarget
  readonly revision: number | null
}
interface ReconcileOptions {
  targets(): readonly ReconcileTarget[]
  apply(target: RuntimeTarget, snapshot: TaskFlowProbe): void
  failed(target: RuntimeTarget, message: string, unavailable: boolean): void
}
const RECONCILE_INTERVAL_MS = 2000
const RECONCILE_DEADLINE_MS = 8000

export function createTaskFlowReconciler(options: ReconcileOptions): {
  start(): void; stop(): void; refresh(): void
} {
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let generation = 0
  const inFlight = new Map<string, symbol>()
  const nextRead = new Map<string, number>()
  const deadlines = new Set<ReturnType<typeof setTimeout>>()
  const keyOf = (target: RuntimeTarget): string => `${target.runId}:${target.runtimeId}`
  function schedule(): void {
    if (!running || timer !== null || options.targets().length === 0) return
    timer = setTimeout(() => { timer = null; tick() }, RECONCILE_INTERVAL_MS)
  }
  function tick(): void {
    if (!running) return
    const currentGeneration = generation
    for (const { target, revision } of options.targets()) {
      const key = keyOf(target)
      if (inFlight.has(key) || (nextRead.get(key) ?? 0) > Date.now()) continue
      nextRead.set(key, Date.now() + RECONCILE_INTERVAL_MS)
      const token = Symbol(key)
      inFlight.set(key, token)
      let expired = false
      const deadline = setTimeout(() => {
        expired = true
        if (running && generation === currentGeneration) options.failed(target, '状态读取没有及时回应；保留最后记录，不会重新执行。', false)
        // 未返回的 IPC 仍在途，不开启重叠读取；旧响应返回后才允许下一次读取。
      }, RECONCILE_DEADLINE_MS)
      deadlines.add(deadline)
      void getRuntimeTaskFlow({ target, revision }).then(result => {
        if (!running || generation !== currentGeneration || expired) return
        if (result.ok) options.apply(target, result.data)
        else options.failed(target, result.error.message,
          ['RUNTIME_EXITED', 'RUNTIME_NOT_READY', 'BRIDGE_UNAVAILABLE', 'SESSION_NOT_FOUND'].includes(result.error.code))
      }).catch(() => {
        if (running && generation === currentGeneration && !expired) options.failed(target, '任务状态读取失败；不会重新执行。', false)
      }).finally(() => {
        clearTimeout(deadline)
        deadlines.delete(deadline)
        if (inFlight.get(key) === token) inFlight.delete(key)
      })
    }
    schedule()
  }
  return {
    start() { if (!running) { running = true; generation++; tick() } },
    stop() {
      running = false
      generation++
      if (timer !== null) clearTimeout(timer)
      timer = null
      for (const deadline of deadlines) clearTimeout(deadline)
      deadlines.clear()
      inFlight.clear()
      nextRead.clear()
    },
    refresh() { if (running) tick() }
  }
}
