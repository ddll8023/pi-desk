/** 任务光线适配：只向已归属且可见的轨道节点投递真实语义更新，历史与换绑静默；渲染完全使用 Lancer Light UI。 */
import { nextTick } from 'vue'
import { createLightLayer } from '../ui/lancer-light-ui'
import type { LightLayer } from '../ui/lancer-light-ui'
import type { SessionTaskGroup, SessionTaskTrack } from './task-flow-view'

export interface TaskMotionContext {
  readonly key: string
  readonly sourceOwner: string
  readonly targetOwner: string
  readonly enabled: boolean
  readonly track: SessionTaskTrack
}
interface TaskSignature { readonly semantic: string; readonly delivery: string }
function signature(task: SessionTaskGroup): TaskSignature {
  const report = task.latest?.report
  return {
    semantic: JSON.stringify([report?.stageId, report?.stages, report?.status, report?.intent, report?.summary, report?.artifacts, report?.step]),
    delivery: JSON.stringify([task.summary, task.artifacts.map(item => [item.kind, item.path, item.title, item.description])])
  }
}
/** 两端中心点必须位于当前视口和祖先滚动裁剪区内且未被遮挡；不把隐藏或超出视野的锚点当作发射点。 */
function visible(element: HTMLElement): boolean {
  if (!element.isConnected || document.hidden) return false
  const bounds = element.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0) return false
  const x = bounds.left + bounds.width / 2
  const y = bounds.top + bounds.height / 2
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false
  for (let parent: HTMLElement | null = element; parent !== null; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0 || parent.inert) return false
    const rect = parent.getBoundingClientRect()
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && (x < rect.left || x > rect.right)) return false
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (y < rect.top || y > rect.bottom)) return false
  }
  const top = document.elementFromPoint(x, y)
  return top !== null && (element === top || element.contains(top))
}
function anchor(selector: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>(selector)].find(visible) ?? null
}

export function createTaskFlowMotion(): { update(context: TaskMotionContext): void; destroy(): void } {
  let current: TaskMotionContext | null = null
  let key: string | null = null
  let enabled = false
  let disposed = false
  let generation = 0
  let layer: LightLayer | null = null
  let cancelFlight: (() => void) | null = null
  const revisions = new Map<string, number>()
  const signatures = new Map<string, TaskSignature>()
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  function clearLayer(): void {
    generation++
    cancelFlight?.()
    cancelFlight = null
    layer?.destroy()
    layer = null
  }
  function seed(context: TaskMotionContext): void {
    for (const turn of context.track.turns) {
      if (turn.report !== null) revisions.set(turn.report.turnEntryId, turn.report.revision)
    }
    for (const task of context.track.tasks) signatures.set(task.id, signature(task))
  }
  function visibilityChanged(): void {
    clearLayer()
    enabled = current?.enabled === true && !document.hidden && !reduced.matches
    if (current !== null) seed(current)
  }
  document.addEventListener('visibilitychange', visibilityChanged)
  reduced.addEventListener('change', visibilityChanged)
  return {
    update(context) {
      if (disposed) return
      current = context
      const available = context.enabled && !document.hidden && !reduced.matches
      if (key !== context.key || !available || !enabled) {
        clearLayer()
        if (key !== context.key) { revisions.clear(); signatures.clear() }
        key = context.key
        enabled = available
        seed(context)
        return
      }
      const oldRevisions = new Map(revisions)
      const oldSignatures = new Map(signatures)
      seed(context)
      const loaded = new Set(context.track.turns.flatMap(turn => turn.report === null ? [] : [turn.report.turnEntryId]))
      for (const id of revisions.keys()) if (!loaded.has(id)) revisions.delete(id)
      const knownTasks = new Set(context.track.tasks.map(task => task.id))
      for (const id of signatures.keys()) if (!knownTasks.has(id)) signatures.delete(id)
      if (context.track.unreported.some(turn => turn.current)) { clearLayer(); return }
      for (const task of context.track.tasks) {
        const report = task.latest?.report
        if (!task.current || report == null) continue
        if (report.status === 'waiting' || report.status === 'blocked' || report.status === 'cancelled') { clearLayer(); continue }
        if (report.revision <= (oldRevisions.get(report.turnEntryId) ?? 0)) continue
        const previous = oldSignatures.get(task.id)
        const next = signature(task)
        if (previous?.semantic === next.semantic) continue
        const deliveryChanged = previous?.delivery !== next.delivery && (task.summary !== null || task.artifacts.length > 0)
        const candidateIds = [
          ...(deliveryChanged ? ['delivery'] : []),
          ...(report.stageId === null ? [] : [`stage:${report.stageId}`]),
          ...(report.step === undefined ? [] : [`step:${report.step.stepId}`]),
          `turn:${report.turnEntryId}`
        ]
        const targetId = candidateIds.find(id => task.nodes.some(node => node.id === id))
        if (targetId === undefined) continue
        const token = generation
        const sourceSelector = `[data-task-source-owner="${CSS.escape(context.sourceOwner)}"][data-task-source-task="${CSS.escape(task.id)}"][data-task-source-turn="${CSS.escape(report.turnEntryId)}"]`
        const targetSelector = `[data-task-node-owner="${CSS.escape(context.targetOwner)}"][data-task-id="${CSS.escape(task.id)}"][data-task-node="${CSS.escape(targetId)}"]`
        void nextTick(async () => {
          // 先让轨道完成自己的阅读锚点调整，再检查真实可见的落点；不借动效滚动聊天。
          await nextTick()
          if (disposed || token !== generation || current?.key !== context.key || !enabled || document.hidden || reduced.matches) return
          // 事件已经消费，缺锚点便静默跳过；不滚动、不补播，也不向最近坐标猜测投递。
          const source = anchor(sourceSelector)
          const target = anchor(targetSelector)
          if (source === null || target === null) return
          cancelFlight?.()
          layer ??= createLightLayer()
          const color = getComputedStyle(target).getPropertyValue('--color-desk-accent').trim() || getComputedStyle(target).color
          const flight = layer.emit({ id: `${context.key}:${report.turnEntryId}:${report.revision}:${targetId}`,
            source: () => anchor(sourceSelector), target: () => anchor(targetSelector), color })
          cancelFlight = flight.cancel
        })
      }
    },
    destroy() {
      if (disposed) return
      disposed = true
      clearLayer()
      document.removeEventListener('visibilitychange', visibilityChanged)
      reduced.removeEventListener('change', visibilityChanged)
      revisions.clear()
      signatures.clear()
      current = null
    }
  }
}
