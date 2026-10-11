/**
 * 自定义供应商（Pi 的 models.json）的渲染端调用入口：把桥接缺失与通信异常转换为安全的展示结果，
 * 并逐字段重建请求对象，避免响应式代理跨 contextBridge。
 */
import type {
  ModelsConfigDeleteRequest,
  ModelsConfigError,
  ModelsConfigResult,
  ModelsConfigSaveRequest
} from '../../../shared/models-config-api'

function unavailable(): { ok: false; error: ModelsConfigError } {
  return {
    ok: false,
    error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开此页面。' }
  }
}

/** 桥接调用异常：保留原始错误文本，避免真实原因被固定文案盖掉。 */
function callFailed(error: unknown): { ok: false; error: ModelsConfigError } {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    error: { code: 'BRIDGE_CALL_FAILED', message: `桌面桥接调用失败，可以重试：${detail}` }
  }
}

/** 读取供应商快照；主进程会同时把它作为后续保存的比对基线。 */
export async function getModelsConfig(): Promise<ModelsConfigResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getModelsConfig !== 'function') return unavailable()
  try {
    return await bridge.getModelsConfig()
  } catch (error) {
    return callFailed(error)
  }
}

/** 新增或整体替换一个供应商条目；`json` 是条目的 JSON 文本。 */
export async function saveModelsConfigProvider(
  providerId: string,
  json: string
): Promise<ModelsConfigResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.saveModelsConfigProvider !== 'function') return unavailable()
  const request: ModelsConfigSaveRequest = { providerId, json }
  try {
    return await bridge.saveModelsConfigProvider(request)
  } catch (error) {
    return callFailed(error)
  }
}

export async function deleteModelsConfigProvider(providerId: string): Promise<ModelsConfigResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.deleteModelsConfigProvider !== 'function') return unavailable()
  const request: ModelsConfigDeleteRequest = { providerId }
  try {
    return await bridge.deleteModelsConfigProvider(request)
  } catch (error) {
    return callFailed(error)
  }
}
