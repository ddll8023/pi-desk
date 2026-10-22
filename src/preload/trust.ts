/** Project Trust：preload 的 trust 域，只经固定 channel 与主进程通信，载荷与响应在此重建与校验。 */

import { ipcRenderer } from 'electron'
import { TRUST_DECIDE_CHANNEL, TRUST_STATUS_CHANNEL, isTrustDecisionResult, isTrustStatusResult } from '../shared/trust-api'
import type { TrustDecisionInput, TrustStatusResult } from '../shared/trust-api'
import type { TrustApi } from '../shared/trust-api'

const INVALID_TRUST_RESPONSE = '桌面接口返回了无法识别的信任状态。'

function invalidTrustResponse(): TrustStatusResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_TRUST_RESPONSE } }
}

export const trustApi = {
  async getTrustStatus(runId?: number) {
    // 不传身份时保持零参数调用，让主进程按当前项目解析。
    const response: unknown = runId === undefined
      ? await ipcRenderer.invoke(TRUST_STATUS_CHANNEL)
      : await ipcRenderer.invoke(TRUST_STATUS_CHANNEL, { runId })
    return isTrustStatusResult(response) ? response : invalidTrustResponse()
  },

  async decideTrust(projectPath: string, decision: TrustDecisionInput, runId?: number) {
    // 只搬运已声明的字段，不把页面传入的整个对象转交给主进程。
    const request = runId === undefined
      ? { projectPath, decision }
      : { projectPath, decision, runId }
    const response: unknown = await ipcRenderer.invoke(TRUST_DECIDE_CHANNEL, request)
    return isTrustDecisionResult(response) ? response : invalidTrustResponse()
  }
} satisfies TrustApi
