/** 桌面与手机共用的纯投影合并算法；长度或消息身份不符时返回 null，调用方必须重新取得权威快照。 */
import type { ProjectionBlock, ProjectionMessage, ProjectionUpdate, ToolExecution } from './projection'

function replaceBlock(blocks: readonly ProjectionBlock[], block: ProjectionBlock): ProjectionBlock[] {
  const index = blocks.findIndex(candidate => candidate.contentIndex === block.contentIndex)
  if (index < 0) return [...blocks, block].sort((left, right) => left.contentIndex - right.contentIndex)
  const next = [...blocks]
  next[index] = block
  return next
}
function appendBlock(blocks: readonly ProjectionBlock[], contentIndex: number, text: string, length: number): ProjectionBlock[] | null {
  const index = blocks.findIndex(candidate => candidate.contentIndex === contentIndex)
  const target = index < 0 ? undefined : blocks[index]
  if (target === undefined) return null
  const nextText = target.text + text
  if (nextText.length !== length) return null
  const next = [...blocks]
  next[index] = { ...target, text: nextText }
  return next
}
export function applyProjectionUpdates(
  messages: readonly ProjectionMessage[], tools: readonly ToolExecution[], updates: readonly ProjectionUpdate[]
): { messages: ProjectionMessage[]; tools: ToolExecution[] } | null {
  let nextMessages = [...messages]
  let nextTools = [...tools]
  for (const update of updates) {
    if (update.kind === 'activity') continue
    if (update.kind === 'tool') {
      const incoming = update.tool
      nextTools = nextTools.some(tool => tool.toolCallId === incoming.toolCallId)
        ? nextTools.map(tool => tool.toolCallId === incoming.toolCallId ? incoming : tool)
        : [...nextTools, incoming]
      continue
    }
    if (update.kind === 'message') {
      const incoming = update.message
      nextMessages = nextMessages.some(message => message.id === incoming.id)
        ? nextMessages.map(message => message.id === incoming.id ? incoming : message)
        : [...nextMessages, incoming]
      continue
    }
    const index = nextMessages.findIndex(message => message.id === update.messageId)
    const target = index < 0 ? undefined : nextMessages[index]
    if (target === undefined) return null
    const blocks = update.kind === 'block' ? replaceBlock(target.blocks, update.block)
      : appendBlock(target.blocks, update.contentIndex, update.text, update.length)
    if (blocks === null) return null
    nextMessages[index] = { ...target, blocks }
  }
  return { messages: nextMessages, tools: nextTools }
}
