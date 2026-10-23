/**
 * 封装生成式界面参数取值的本机旁路存储读写：读取全量记录、保存或删除单条、清除全部。
 *
 * 服务层只做桥接与错误归一：参数取值来自渲染端内存，不能把响应式代理直接传过 contextBridge，
 * 因此保存前显式重建普通对象；桥接失败保留原始异常文本，避免真实原因被固定文案盖掉。
 * 参数可再生产，因此失败一律回传错误由调用方决定提示，不在这里重试。
 */
import type {
  GenuiParamRecord,
  GenuiParamsClearResult,
  GenuiParamsGetResult,
  GenuiParamSaveRequest,
  GenuiParamsSaveResult
} from '../../../../shared/genui-params-api'

/** 桥接缺失：页面不在 Electron 里打开，所有参数存储能力都不可用。 */
function unavailable(): { ok: false; error: { code: 'BRIDGE_UNAVAILABLE'; message: string } } {
  return {
    ok: false,
    error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开此页面。' }
  }
}

/** 桥接调用异常：保留原始错误文本，避免真实原因被固定文案盖掉。 */
function callFailed(error: unknown): { ok: false; error: { code: 'BRIDGE_CALL_FAILED'; message: string } } {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    error: { code: 'BRIDGE_CALL_FAILED', message: `桌面桥接调用失败，可以重试：${detail}` }
  }
}

/** 读取全部已保存的界面参数；失败时调用方按无记录处理，界面继续用默认值。 */
export async function getGenuiParams(): Promise<GenuiParamsGetResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getGenuiParams !== 'function') return unavailable()
  try {
    return await bridge.getGenuiParams()
  } catch (error) {
    return callFailed(error)
  }
}

/** 保存或删除一份界面的取值；`record` 为 null 即删除该界面的记录。 */
export async function saveGenuiParam(
  documentId: string,
  record: GenuiParamRecord | null
): Promise<GenuiParamsSaveResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.saveGenuiParam !== 'function') return unavailable()
  try {
    // 只搬运已声明的字段，并重建普通对象与取值表，避免响应式代理跨 contextBridge。
    const request: GenuiParamSaveRequest = record === null
      ? { documentId, record: null }
      : { documentId, record: { revision: record.revision, updatedAt: record.updatedAt, values: { ...record.values } } }
    return await bridge.saveGenuiParam(request)
  } catch (error) {
    return callFailed(error)
  }
}

/** 清除全部已保存的界面参数；返回删除条数，失败时保留原因交给设置页展示。 */
export async function clearGenuiParams(): Promise<GenuiParamsClearResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.clearGenuiParams !== 'function') return unavailable()
  try {
    return await bridge.clearGenuiParams()
  } catch (error) {
    return callFailed(error)
  }
}
