/** 作品库域的受限桥接：设置页读清单与详情、改名、截封面、删除与打开素材；不向页面开放目录与文件读写。 */
import {
  PORTFOLIO_NAME_MAX_CHARS,
  isPortfolioDetailResult,
  isPortfolioListResult,
  isPortfolioMutationResult,
  isPortfolioOpenAssetResult
} from '../../../../shared/portfolio-api'
import type {
  PortfolioDetailResult,
  PortfolioEntry,
  PortfolioListResult,
  PortfolioMutationResult,
  PortfolioOpenAssetResult,
  PortfolioResult
} from '../../../../shared/portfolio-api'

interface PortfolioBridge {
  readonly listPortfolio: () => Promise<unknown>
  readonly readPortfolio: (request: { readonly id: string }) => Promise<unknown>
  readonly deletePortfolio: (request: { readonly id: string }) => Promise<unknown>
  readonly renamePortfolio: (request: { readonly id: string; readonly name: string }) => Promise<unknown>
  readonly capturePortfolioCover: (request: { readonly id: string }) => Promise<unknown>
  readonly openPortfolioAsset: (request: { readonly id: string; readonly path: string }) => Promise<unknown>
}

function bridge(): PortfolioBridge | null {
  const value = window.desktop as Partial<PortfolioBridge> | null | undefined
  if (value === null || value === undefined || typeof value !== 'object') return null
  if (typeof value.listPortfolio !== 'function' || typeof value.readPortfolio !== 'function'
    || typeof value.deletePortfolio !== 'function' || typeof value.renamePortfolio !== 'function'
    || typeof value.capturePortfolioCover !== 'function' || typeof value.openPortfolioAsset !== 'function') return null
  return value as PortfolioBridge
}

const UNAVAILABLE = '当前环境没有桌面作品库接口。'
const CALL_FAILED = '作品库接口调用失败。'

/** 桥接缺失、通道异常与契约不符都归一成同一形状，页面只展示 `error`。 */
async function call<T>(
  work: (target: PortfolioBridge) => Promise<unknown>,
  parse: (value: unknown) => value is PortfolioResult<T>
): Promise<PortfolioResult<T>> {
  try {
    const target = bridge()
    if (target === null) return { ok: false, error: UNAVAILABLE }
    const response = await work(target)
    if (!parse(response)) return { ok: false, error: '作品库接口返回了不符合契约的结果。' }
    return response
  } catch {
    // 原始异常可能带有通道名与主进程文本，页面只拿固定文案。
    return { ok: false, error: CALL_FAILED }
  }
}

export function loadPortfolioEntries(): Promise<PortfolioListResult> {
  return call(target => target.listPortfolio(), isPortfolioListResult)
}

export function loadPortfolioDetail(id: string): Promise<PortfolioDetailResult> {
  return call(target => target.readPortfolio({ id }), isPortfolioDetailResult)
}

export function renamePortfolioEntry(id: string, name: string): Promise<PortfolioMutationResult> {
  const trimmed = name.trim()
  if (trimmed === '' || trimmed.length > PORTFOLIO_NAME_MAX_CHARS) {
    return Promise.resolve({ ok: false, error: `名称不能为空且不能超过 ${PORTFOLIO_NAME_MAX_CHARS} 字。` })
  }
  return call(target => target.renamePortfolio({ id, name: trimmed }), isPortfolioMutationResult)
}

export function deletePortfolioEntry(id: string): Promise<PortfolioMutationResult> {
  return call(target => target.deletePortfolio({ id }), isPortfolioMutationResult)
}

export function capturePortfolioCover(id: string): Promise<PortfolioMutationResult> {
  return call(target => target.capturePortfolioCover({ id }), isPortfolioMutationResult)
}

export function openPortfolioAsset(id: string, path: string): Promise<PortfolioOpenAssetResult> {
  return call(target => target.openPortfolioAsset({ id, path }), isPortfolioOpenAssetResult)
}

/** 列表项按更新时间倒序由主进程给出，这里只做就地替换，避免每次改动重读全库。 */
export function replaceEntry(entries: readonly PortfolioEntry[], entry: PortfolioEntry): PortfolioEntry[] {
  const next = entries.filter(item => item.id !== entry.id)
  return [entry, ...next].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}
