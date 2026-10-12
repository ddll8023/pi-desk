/**
 * 用户消息的展示身份：只保存时间戳与规范化摘要，不为回退额外保留完整消息或图片。
 *
 * 同时供旧 RPC 回退定位与迁移期投影使用；SDK 会话链路以官方条目 ID 定位，不依赖本摘要。
 */
import { createHash } from 'node:crypto'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface UserMessageIdentity {
  readonly timestamp: number | null
  readonly digest: string
}

/** 截断展示前建立身份；文本与图片按固定字段规范化，未知内容拒绝猜测。 */
export function toUserMessageIdentity(value: unknown): UserMessageIdentity | null {
  if (!isRecord(value) || value.role !== 'user') return null
  const source = typeof value.content === 'string'
    ? [{ type: 'text', text: value.content }]
    : value.content
  if (!Array.isArray(source)) return null
  const blocks: Record<string, string>[] = []
  let hasText = false
  for (const block of source) {
    if (!isRecord(block)) return null
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text })
      hasText ||= block.text.trim() !== ''
    } else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      blocks.push({ type: 'image', data: block.data, mimeType: block.mimeType })
    } else {
      return null
    }
  }
  if (!hasText) return null
  return {
    timestamp: typeof value.timestamp === 'number' ? value.timestamp : null,
    digest: createHash('sha256').update(JSON.stringify(blocks)).digest('hex')
  }
}
