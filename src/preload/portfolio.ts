/** 作品库域桥接：只经固定 channel 转发清单、详情、删除、改名、封面截图与素材打开，不开放路径与文件读写。 */
import { ipcRenderer } from 'electron'
import {
  PORTFOLIO_CAPTURE_COVER_CHANNEL,
  PORTFOLIO_DELETE_CHANNEL,
  PORTFOLIO_LIST_CHANNEL,
  PORTFOLIO_OPEN_ASSET_CHANNEL,
  PORTFOLIO_READ_CHANNEL,
  PORTFOLIO_RENAME_CHANNEL,
  isPortfolioDetailResult,
  isPortfolioListResult,
  isPortfolioMutationResult,
  isPortfolioOpenAssetResult
} from '../shared/portfolio-api'
import type {
  PortfolioApi,
  PortfolioDetailResult,
  PortfolioIdRequest,
  PortfolioListResult,
  PortfolioMutationResult,
  PortfolioOpenAssetRequest,
  PortfolioOpenAssetResult,
  PortfolioRenameRequest
} from '../shared/portfolio-api'

/** 通道异常只回固定文案：invoke 的原始 message 带有内部通道名与主进程异常文本。 */
function callFailure(): { readonly ok: false; readonly error: string } {
  return { ok: false, error: '作品库接口调用失败。' }
}

function invalidResponse(): { readonly ok: false; readonly error: string } {
  return { ok: false, error: '作品库接口返回了不符合契约的结果。' }
}

export const portfolioApi: PortfolioApi = {
  async listPortfolio(): Promise<PortfolioListResult> {
    try {
      const response: unknown = await ipcRenderer.invoke(PORTFOLIO_LIST_CHANNEL)
      return isPortfolioListResult(response) ? response : invalidResponse()
    } catch {
      return callFailure()
    }
  },
  async readPortfolio(request: PortfolioIdRequest): Promise<PortfolioDetailResult> {
    try {
      const response: unknown = await ipcRenderer.invoke(PORTFOLIO_READ_CHANNEL, { id: request?.id })
      return isPortfolioDetailResult(response) ? response : invalidResponse()
    } catch {
      return callFailure()
    }
  },
  async deletePortfolio(request: PortfolioIdRequest): Promise<PortfolioMutationResult> {
    try {
      const response: unknown = await ipcRenderer.invoke(PORTFOLIO_DELETE_CHANNEL, { id: request?.id })
      return isPortfolioMutationResult(response) ? response : invalidResponse()
    } catch {
      return callFailure()
    }
  },
  async renamePortfolio(request: PortfolioRenameRequest): Promise<PortfolioMutationResult> {
    try {
      const response: unknown = await ipcRenderer.invoke(PORTFOLIO_RENAME_CHANNEL, {
        id: request?.id,
        name: request?.name
      })
      return isPortfolioMutationResult(response) ? response : invalidResponse()
    } catch {
      return callFailure()
    }
  },
  async capturePortfolioCover(request: PortfolioIdRequest): Promise<PortfolioMutationResult> {
    try {
      const response: unknown = await ipcRenderer.invoke(PORTFOLIO_CAPTURE_COVER_CHANNEL, { id: request?.id })
      return isPortfolioMutationResult(response) ? response : invalidResponse()
    } catch {
      return callFailure()
    }
  },
  async openPortfolioAsset(request: PortfolioOpenAssetRequest): Promise<PortfolioOpenAssetResult> {
    try {
      const response: unknown = await ipcRenderer.invoke(PORTFOLIO_OPEN_ASSET_CHANNEL, {
        id: request?.id,
        path: request?.path
      })
      return isPortfolioOpenAssetResult(response) ? response : invalidResponse()
    } catch {
      return callFailure()
    }
  }
}
