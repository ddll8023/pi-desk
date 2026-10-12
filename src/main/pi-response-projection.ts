/**
 * Pi 一次性进程响应的字段投影：把 `get_commands`、`get_available_models` 与 `get_state`
 * 的 data 归一化成页面预读所需的形状。
 *
 * 只做字段投影与形状校验：不持有子进程、不关联请求、不缓存消息，也不参与运行中会话。
 * 形状不符时返回 null 由调用方按协议错误处理，缺失字段一律为 null，不猜造。
 */
import type {
  ModelSummary,
  PiResourceEntry,
  PiResourceKind,
  RuntimeInfo
} from '../shared/runtime-api'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 当前模型的 provider 与 id：只在两者都是非空字符串时才算可识别。 */
function readModelIdentity(value: unknown): { provider: string | null; id: string | null } {
  if (!isRecord(value)) return { provider: null, id: null }
  return {
    provider: typeof value.provider === 'string' && value.provider !== '' ? value.provider : null,
    id: typeof value.id === 'string' && value.id !== '' ? value.id : null
  }
}

/** 把 get_state 的 data 投影为会话与图片输入所需字段；缺少约定字段时返回 null。 */
export function toRuntimeInfo(data: unknown): RuntimeInfo | null {
  if (!isRecord(data)) return null
  const { messageCount, isStreaming, sessionId } = data
  if (typeof messageCount !== 'number' || !Number.isInteger(messageCount)) return null
  if (typeof isStreaming !== 'boolean') return null
  const identity = readModelIdentity(data.model)
  return {
    modelProvider: identity.provider,
    modelId: identity.id,
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    messageCount,
    isStreaming,
    // 用量与速率不来自 get_state；预读不提供它们。
    usage: null,
    rate: { live: null, average: null }
  }
}

/**
 * 把 `get_available_models` 的 data 投影为精简列表；`models` 不是数组时返回 null，
 * 单条形状不符只丢弃该条，不因此让整个列表不可用。
 */
export function toModelSummaries(data: unknown): ModelSummary[] | null {
  if (!isRecord(data) || !Array.isArray(data.models)) return null

  const models: ModelSummary[] = []
  for (const entry of data.models) {
    if (!isRecord(entry)) continue
    const provider = typeof entry.provider === 'string' ? entry.provider : ''
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (provider === '' || id === '') continue
    models.push({
      provider,
      id,
      // 显示名与上下文窗口来自模型目录；缺失或形状不符时为 null，不猜造。
      name: readOptionalText(entry.name),
      contextWindow: readContextWindow(entry.contextWindow),
      // 模型目录的 input 字段描述支持的输入模态；缺失时不猜造。
      imageInput: readImageInput(entry.input)
    })
  }
  return models
}

/** 正有限数为有效上下文窗口，其余（含缺失）一律 null。 */
function readContextWindow(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** `input` 数组含 `image` 为 true，是数组但不含为 false，缺失或其他形状为 null。 */
function readImageInput(value: unknown): boolean | null {
  if (!Array.isArray(value)) return null
  return value.some((entry) => entry === 'image')
}

/** `get_commands` 的 `source` 到页面资源分类的映射；其他来源不进入页面。 */
const RESOURCE_KIND_BY_SOURCE: Readonly<Record<string, PiResourceKind>> = {
  skill: 'skill',
  prompt: 'prompt',
  extension: 'extension'
}

/** 非空字符串或 null；其他取值一律视为缺失，不猜造。 */
function readOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * 把 `get_commands` 的 data 投影为资源条目列表：只保留 skill/prompt/extension 三类，
 * 名称或来源不符的条目丢弃，`commands` 不是数组时返回 null（由调用方按格式错误处理）。
 * 归属信息只取官方 sourceInfo；缺失字段一律为 null。
 */
export function toResources(data: unknown): PiResourceEntry[] | null {
  if (!isRecord(data) || !Array.isArray(data.commands)) return null

  const entries: PiResourceEntry[] = []
  for (const entry of data.commands) {
    if (!isRecord(entry)) continue
    const kind = typeof entry.source === 'string' ? RESOURCE_KIND_BY_SOURCE[entry.source] : undefined
    const name = readOptionalText(entry.name)
    if (kind === undefined || name === null) continue
    const info = isRecord(entry.sourceInfo) ? entry.sourceInfo : {}
    entries.push({
      kind,
      name,
      description: readOptionalText(entry.description),
      path: readOptionalText(info.path),
      scope: readOptionalText(info.scope),
      origin: readOptionalText(info.origin),
      baseDir: readOptionalText(info.baseDir)
    })
  }
  return entries
}
