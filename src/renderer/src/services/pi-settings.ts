/** 封装 Pi 默认模型的读写桥接，重建普通载荷并保留桥接失败原因。 */
import type { PiDefaultModelError, PiDefaultModelResult } from '../../../shared/pi-settings-api'
import type { ModelIdentity } from '../../../shared/runtime-api'

function unavailable(): { ok: false; error: PiDefaultModelError } {
  return {
    ok: false,
    error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开此页面。' }
  }
}

/** 桥接调用异常：保留原始错误文本，避免真实原因被固定文案盖掉。 */
function callFailed(error: unknown): { ok: false; error: PiDefaultModelError } {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    error: { code: 'BRIDGE_CALL_FAILED', message: `桌面桥接调用失败，可以重试：${detail}` }
  }
}

/** 读取 Pi 的默认模型；null 表示 settings.json 未设置。 */
export async function getPiDefaultModel(): Promise<PiDefaultModelResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getPiDefaultModel !== 'function') return unavailable()
  try {
    return await bridge.getPiDefaultModel()
  } catch (error) {
    return callFailed(error)
  }
}

/** 服务层逐字段重建，响应式模型对象不能直接跨 contextBridge。 */
export async function setPiDefaultModel(model: ModelIdentity): Promise<PiDefaultModelResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.setPiDefaultModel !== 'function') return unavailable()
  try {
    return await bridge.setPiDefaultModel({
      provider: model.provider,
      modelId: model.modelId
    })
  } catch (error) {
    return callFailed(error)
  }
}
