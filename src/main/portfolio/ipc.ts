/**
 * 作品库域 IPC：设置页只经这六条固定通道读写作品，参数一律在主进程复核。
 *
 * 页面只能传作品 ID、名称与库内相对路径；封面截图由主进程从受管内置浏览器页面捕获，
 * 不接受渲染层传入的图片数据，也不接受任意绝对路径。
 */

import { shell, webContents } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import {
  PORTFOLIO_CAPTURE_COVER_CHANNEL,
  PORTFOLIO_DELETE_CHANNEL,
  PORTFOLIO_LIST_CHANNEL,
  PORTFOLIO_NAME_MAX_CHARS,
  PORTFOLIO_OPEN_ASSET_CHANNEL,
  PORTFOLIO_READ_CHANNEL,
  PORTFOLIO_RENAME_CHANNEL,
  isPortfolioId,
  isPortfolioRelativePath,
  isPortfolioText
} from '../../shared/portfolio-api'
import type {
  PortfolioDetailResult,
  PortfolioListResult,
  PortfolioMutationResult,
  PortfolioOpenAssetResult
} from '../../shared/portfolio-api'
import { handle, isTrustedCaller } from '../ipc/dispatch'
import { browserSessionService, portfolioStore } from '../services'
import { PortfolioStoreError } from './portfolio-store'

/** 失败统一成页面可展示的一句话；只有作品库业务错误透出原文，未预期异常只记主进程日志。 */
function failure(error: unknown): { readonly ok: false; readonly error: string } {
  if (error instanceof PortfolioStoreError) return { ok: false, error: error.message }
  console.error('[portfolio] 作品库操作失败：', error)
  return { ok: false, error: '作品库操作失败。' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只接受恰好一个请求对象；多余参数不参与解释。 */
function payloadOf(args: readonly unknown[]): Record<string, unknown> | null {
  return args.length === 1 && isRecord(args[0]) ? args[0] : null
}

export function registerPortfolioHandlers(pageUrl: string): void {
  handle(PORTFOLIO_LIST_CHANNEL, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PortfolioListResult> => {
    if (!isTrustedCaller(event, pageUrl) || args.length !== 0) return failure(new PortfolioStoreError('作品列表请求不合法。'))
    try {
      return { ok: true, data: { entries: await portfolioStore.list() } }
    } catch (error) {
      return failure(error)
    }
  })

  handle(PORTFOLIO_READ_CHANNEL, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PortfolioDetailResult> => {
    const payload = payloadOf(args)
    if (!isTrustedCaller(event, pageUrl) || payload === null || !isPortfolioId(payload.id)) {
      return failure(new PortfolioStoreError('作品标识不合法。'))
    }
    try {
      return { ok: true, data: { entry: await portfolioStore.read(payload.id) } }
    } catch (error) {
      return failure(error)
    }
  })

  handle(PORTFOLIO_DELETE_CHANNEL, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PortfolioMutationResult> => {
    const payload = payloadOf(args)
    if (!isTrustedCaller(event, pageUrl) || payload === null || !isPortfolioId(payload.id)) {
      return failure(new PortfolioStoreError('作品标识不合法。'))
    }
    try {
      await portfolioStore.remove(payload.id)
      return { ok: true, data: { entry: null } }
    } catch (error) {
      return failure(error)
    }
  })

  handle(PORTFOLIO_RENAME_CHANNEL, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PortfolioMutationResult> => {
    const payload = payloadOf(args)
    if (!isTrustedCaller(event, pageUrl) || payload === null || !isPortfolioId(payload.id)
      || !isPortfolioText(payload.name, PORTFOLIO_NAME_MAX_CHARS)) {
      return failure(new PortfolioStoreError('作品改名请求不合法。'))
    }
    try {
      return { ok: true, data: { entry: await portfolioStore.rename(payload.id, payload.name) } }
    } catch (error) {
      return failure(error)
    }
  })

  handle(PORTFOLIO_CAPTURE_COVER_CHANNEL, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PortfolioMutationResult> => {
    const payload = payloadOf(args)
    if (!isTrustedCaller(event, pageUrl) || payload === null || !isPortfolioId(payload.id)) {
      return failure(new PortfolioStoreError('作品标识不合法。'))
    }
    try {
      // 取最近更新的未销毁实例：设置页不持有某个页面，也不替用户挑选具体标签。
      const instance = browserSessionService.latestLiveInstance()
      if (instance === null) {
        return failure(new PortfolioStoreError('没有可用的内置浏览器页面：请先在工作区打开要收录的页面。'))
      }
      const target = webContents.fromId(instance.webContentsId)
      if (!target || target.isDestroyed()) return failure(new PortfolioStoreError('内置浏览器页面已被关闭。'))
      const image = await target.capturePage()
      if (image.isEmpty()) return failure(new PortfolioStoreError('网页截图为空，已放弃写入封面。'))
      return { ok: true, data: { entry: await portfolioStore.captureCover(payload.id, image.toPNG()) } }
    } catch (error) {
      return failure(error)
    }
  })

  handle(PORTFOLIO_OPEN_ASSET_CHANNEL, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PortfolioOpenAssetResult> => {
    const payload = payloadOf(args)
    if (!isTrustedCaller(event, pageUrl) || payload === null || !isPortfolioId(payload.id)
      || !isPortfolioRelativePath(payload.path)) {
      return failure(new PortfolioStoreError('素材打开请求不合法。'))
    }
    try {
      const absolute = await portfolioStore.resolveAsset(payload.id, payload.path)
      const message = await shell.openPath(absolute)
      if (message !== '') return failure(new PortfolioStoreError(`打开素材失败：${message}`))
      return { ok: true, data: null }
    } catch (error) {
      return failure(error)
    }
  })
}
