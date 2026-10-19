/**
 * 从会话分支重建生成式界面的身份与版本：`revision` 不落任何外部文件，唯一来源就是当前分支上
 * 已经写进工具结果的 `details.ui`。
 *
 * 只认产生界面载荷的工具（`ui_render` / `ui_patch`）的 `toolResult` 条目。读身份时只看 `documentId` / `revision` / 标题
 * 这几个头部字段，不做整份校验——分支越长，这个开销越要压住；需要完整文档时再走 `parseGenuiPayload`。
 *
 * 分支语义由调用方决定：传入 `sessionManager.getBranch()` 就是当前叶路径，因此 rewind 到修改
 * 之前时，那个版本会重新成为最新版，这是正确的语义，这里不做额外处理。
 */
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { GENUI_RENDER_TOOL_NAMES, parseGenuiPayload, readGenuiPayloadHeader } from '../../shared/genui-api'
import type { GenuiPayload } from '../../shared/genui-api'

/** 该工具是否会产生界面载荷。名单的唯一事实源在 `genui-api.ts`，活动投影也用它。 */
function isRenderTool(toolName: string): boolean {
  return GENUI_RENDER_TOOL_NAMES.has(toolName)
}

/** 分支上一份界面的头部信息；不含节点树，用于列表、版本推导与「是否存在」判断。 */
export interface DocumentHeader {
  readonly documentId: string
  readonly revision: number
  readonly title: string
}

/**
 * 从一份工具结果的 `details` 里读界面头部；头部解析本身在 `genui-api.ts`，
 * 与活动投影共用同一份实现，避免两处口径漂移。
 */
export function readPayloadHeader(details: unknown): DocumentHeader | null {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return null
  return readGenuiPayloadHeader((details as Record<string, unknown>).ui)
}

/** 分支上所有界面载荷的头部，按出现顺序（即交付顺序）。 */
function headersOf(entries: readonly SessionEntry[]): DocumentHeader[] {
  const headers: DocumentHeader[] = []
  for (const entry of entries) {
    if (entry.type !== 'message') continue
    const message = entry.message
    if (message.role !== 'toolResult' || !isRenderTool(message.toolName)) continue
    const header = readPayloadHeader(message.details)
    if (header !== null) headers.push(header)
  }
  return headers
}

/** 分支上一份界面的概况：取该 `documentId` 的最大 revision，标题取最新那一版的。 */
export interface DocumentSummary {
  readonly documentId: string
  readonly revision: number
  readonly title: string
  readonly versions: number
}

/**
 * 列出分支上出现过的界面，同一 `documentId` 合并成一条，按首次交付顺序排列。
 * 标题缺失时留空字符串，由展示层决定怎么说明，不在这里编造占位文案。
 */
export function listDocuments(entries: readonly SessionEntry[]): DocumentSummary[] {
  const merged = new Map<string, DocumentSummary>()
  for (const header of headersOf(entries)) {
    const existing = merged.get(header.documentId)
    if (existing === undefined) {
      merged.set(header.documentId, {
        documentId: header.documentId,
        revision: header.revision,
        title: header.title,
        versions: 1
      })
      continue
    }
    merged.set(header.documentId, {
      documentId: header.documentId,
      revision: Math.max(existing.revision, header.revision),
      // 后出现的版本覆盖标题：修改可能同时改了标题。
      title: header.title === '' ? existing.title : header.title,
      versions: existing.versions + 1
    })
  }
  return [...merged.values()]
}

/**
 * 下一版版本号：该 `documentId` 在分支上还没有出现时返回 null，由调用方判定为「未知界面」。
 * 不与历史重叠的做法是取最大值加一，而不是取条数——中间版本可能因 rewind 而不在分支上。
 */
export function nextRevision(entries: readonly SessionEntry[], documentId: string): number | null {
  let max: number | null = null
  for (const header of headersOf(entries)) {
    if (header.documentId !== documentId) continue
    max = max === null ? header.revision : Math.max(max, header.revision)
  }
  return max === null ? null : max + 1
}

/**
 * 取某个界面的最新一版完整载荷；命中候选后才做整份校验。
 * 校验失败（历史文档被写坏或版本过旧）返回 null，由调用方给出明确提示而不是当成不存在。
 */
export function findLatestPayload(entries: readonly SessionEntry[], documentId: string): GenuiPayload | null {
  let latest: unknown = null
  let latestRevision = -1
  for (const entry of entries) {
    if (entry.type !== 'message') continue
    const message = entry.message
    if (message.role !== 'toolResult' || !isRenderTool(message.toolName)) continue
    // 先当 unknown 处理：下面只在 `readPayloadHeader` 确认形状后才取具体字段。
    const details: unknown = message.details
    const header = readPayloadHeader(details)
    if (header === null || header.documentId !== documentId) continue
    if (header.revision <= latestRevision) continue
    latestRevision = header.revision
    latest = (details as Record<string, unknown>).ui
  }
  return latest === null ? null : parseGenuiPayload(latest)
}
