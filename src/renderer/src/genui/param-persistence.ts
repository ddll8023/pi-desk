/**
 * 界面参数的本机持久化编排：启动时预加载磁盘记录，运行期把内存变化节流回写。
 *
 * 内存（`param-state.ts`）始终是运行时真源，磁盘只做两件事：冷启动补数据、写入后异步留档。
 * 因此这里不参与界面挂载与取值判定，只把 `param-state` 的写入钩子接到主进程的旁路文件上。
 *
 * 节流按 `documentId` 合并：滑杆拖动能一秒产生十几次写入，每步落盘会变成明显的写放大；
 * 同一界面在窗口期内只保留最后一次变化，提交、卸载与页面关闭时立即落盘。
 *
 * 失败只置一次可见标记，不重试、不回滚：参数是可再生产的缓存，丢一次不该阻断任何操作，
 * 但用户需要知道这次调节没存下来。
 */
import { reactive } from 'vue'
import type { GenuiParamRecord } from '../../../shared/genui-params-api'
import { clearGenuiParams as clearGenuiParamsOnDisk, getGenuiParams, saveGenuiParam } from '../services/genui-params'
import {
  clearGenuiParams as clearGenuiParamsInMemory,
  hydrateGenuiParams,
  setGenuiParamWriteHook
} from './param-state'

/** 同一界面的回写合并窗口；与主进程窗口状态保存的防抖量级一致。 */
const SAVE_THROTTLE_MS = 400

/** 持久化状态：界面据此提示「本次调节没能保存」，设置页据此显示清除结果。 */
export const genuiParamPersistence = reactive({
  /** 至少有一次回写失败且尚未被后续成功覆盖。 */
  failed: false,
  /** 首次预加载是否已结束；读取失败也算结束，不把启动变成阻塞。 */
  ready: false,
  /**
   * 本机已保存参数值的界面份数；供设置页在清除前后告知实际影响。
   * 按已确认写入磁盘的界面标识计，不包含只改了默认值的界面。
   */
  recordCount: 0
})

/** 待落盘的变化；`null` 表示删除该界面的记录。后写覆盖前写。 */
const pending = new Map<string, GenuiParamRecord | null>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
/** 正在执行的保存数；用于 `flushGenuiParamPersistence` 等齐在途请求。 */
const inflight = new Set<Promise<unknown>>()

/**
 * 磁盘上确实存有取值的界面标识。`recordCount` 从它派生，不另外维护计数：
 * 同一界面的重复回写与删除不会让份数漂移，也不需要为了报数再读一次磁盘。
 */
const storedIds = new Set<string>()

/** 发起一次保存并跟踪状态；失败只置标记，不抛出、不重试。 */
function persist(documentId: string, record: GenuiParamRecord | null): void {
  const run = saveGenuiParam(documentId, record).then((result) => {
    genuiParamPersistence.failed = !result.ok
    // 只在写入成功后改动份数：失败时磁盘没变，提前记上会让设置页报出虚数。
    if (result.ok) {
      if (record === null) storedIds.delete(documentId)
      else storedIds.add(documentId)
      genuiParamPersistence.recordCount = storedIds.size
    }
  }).catch(() => {
    genuiParamPersistence.failed = true
  })
  inflight.add(run)
  void run.finally(() => inflight.delete(run))
}

/** 记下一次变化并按界面节流落盘；窗口期内同一界面只保留最后一次。 */
function schedule(documentId: string, record: GenuiParamRecord | null): void {
  pending.set(documentId, record)
  const existing = timers.get(documentId)
  if (existing !== undefined) clearTimeout(existing)
  timers.set(documentId, setTimeout(() => {
    timers.delete(documentId)
    const latest = pending.get(documentId)
    if (latest === undefined) return
    pending.delete(documentId)
    persist(documentId, latest)
  }, SAVE_THROTTLE_MS))
}

/**
 * 立即把待落盘的变化写出去；提交参数、界面卸载与页面关闭时调用。
 * 返回的 Promise 在全部在途请求结束后 resolve，调用方一般不必等待。
 */
export async function flushGenuiParamPersistence(): Promise<void> {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  const entries = [...pending.entries()]
  pending.clear()
  for (const [documentId, record] of entries) persist(documentId, record)
  await Promise.allSettled([...inflight])
}

/**
 * 启动时调用一次：先挂上写入钩子，再异步拉取磁盘记录。
 *
 * 顺序是刻意的——钩子先挂，用户在这次加载完成前调整的参数也能被记下来；
 * 加载晚到时只补内存里还没有的界面（见 `hydrateGenuiParams`），不会覆盖刚调过的取值。
 * 读取失败按「本机没有记录」处理，界面照常用默认值。
 */
export async function initializeGenuiParamPersistence(): Promise<void> {
  setGenuiParamWriteHook((documentId, record) => schedule(documentId, record))
  try {
    const result = await getGenuiParams()
    if (result.ok) {
      // 没有取值项的记录 `hydrateGenuiParams` 会直接丢弃，这里同样不计入份数，两边口径一致。
      for (const [documentId, record] of Object.entries(result.data)) {
        if (Object.keys(record.values).length > 0) storedIds.add(documentId)
      }
      genuiParamPersistence.recordCount = storedIds.size
      hydrateGenuiParams(result.data)
    }
  } catch {
    // 预加载失败只影响能否恢复上次的取值，不影响界面本身，因此不置 `failed`。
  } finally {
    genuiParamPersistence.ready = true
  }
}

/**
 * 清除全部已保存的参数：先清磁盘，成功后再清内存。
 *
 * 顺序不能反：磁盘清除失败时内存取值还在，界面与磁盘至少保持一致；
 * 反过来先清内存会让磁盘上的记录在下次重启时又冒出来。
 */
export async function clearGenuiParamsEverywhere(): Promise<
  { readonly ok: true; readonly removed: number } | { readonly ok: false; readonly message: string }
> {
  // 待落盘的变化先作废：清除之后不该再有旧值写回去。
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  pending.clear()
  const result = await clearGenuiParamsOnDisk()
  if (!result.ok) return { ok: false, message: result.error.message }
  clearGenuiParamsInMemory()
  storedIds.clear()
  genuiParamPersistence.recordCount = 0
  genuiParamPersistence.failed = false
  return { ok: true, removed: result.data.removed }
}
