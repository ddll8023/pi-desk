/**
 * 单个会话 JSONL 文件的流式用量扫描器：
 * 逐行提取 session 头部、首条用户消息标题、model_change 事件以及每条 assistant 消息的 token 用量。
 * 内存占用恒定，不把整个 JSONL 载入内存。
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type {
  UsageDailyStat,
  UsageModelStat,
  UsageTokenBreakdown
} from '../../shared/usage-stats-api'
import { parseSkillBlock, stripImageMarkerLines } from '../../shared/user-message-text'
import type { CachedSessionUsage } from './usage-stats-index'

const MAX_TITLE_CHARS = 80

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeTitleText(text: string): string | null {
  const stripped = stripImageMarkerLines(text).replace(/\s+/g, ' ').trim()
  return stripped === '' ? null : stripped.slice(0, MAX_TITLE_CHARS)
}

function extractFirstUserMessageText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  for (const entry of content) {
    if (isRecord(entry) && entry.type === 'text' && typeof entry.text === 'string') {
      return entry.text
    }
  }
  return null
}

function formatDateKey(timestamp: number): string {
  const d = new Date(timestamp)
  if (Number.isNaN(d.getTime())) return 'unknown'
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null
}

/**
 * 提取委派工具结果里的子代理用量：子代理是另起的模型调用，其用量只出现在
 * `details.subAgents[].usage` 里，计入一次；历史记录的单任务写法也兼容。
 * 没有可用快照或供应商未上报时返回 null，不把它当成零消耗。
 */
function readSubAgentUsage(details: unknown): { input: number; output: number; total: number } | null {
  if (!isRecord(details)) return null
  const source = Array.isArray(details.subAgents) ? details.subAgents : [details.subAgent]
  let input = 0
  let output = 0
  let total = 0
  let seen = false
  for (const item of source) {
    if (!isRecord(item) || !isRecord(item.usage)) continue
    const usage = item.usage
    const inputTokens = readCount(usage.inputTokens)
    const outputTokens = readCount(usage.outputTokens)
    const totalTokens = readCount(usage.totalTokens)
    if (inputTokens === null && outputTokens === null && totalTokens === null) continue
    seen = true
    input += inputTokens ?? 0
    output += outputTokens ?? 0
    total += totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0)
  }
  return seen ? { input, output, total } : null
}

export async function scanSessionJsonl(
  filePath: string,
  fileStamp: string,
  updatedAt: number
): Promise<CachedSessionUsage | null> {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  let sessionId: string | null = null
  let cwd: string | null = null
  let title: string | null = null
  let currentProvider = 'unknown'
  let currentModelId = 'unknown'

  let totalInput = 0
  let totalOutput = 0
  let totalCacheRead = 0
  let totalCacheWrite = 0
  let totalTokens = 0
  let totalCost = 0
  let assistantMessageCount = 0

  const modelMap = new Map<string, {
    provider: string
    modelId: string
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    totalTokens: number
    messageCount: number
  }>()

  const dailyMap = new Map<string, {
    date: string
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    totalTokens: number
    messageCount: number
  }>()

  try {
    for await (const line of rl) {
      if (!line || line.trim() === '') continue

      let entry: unknown
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (!isRecord(entry)) continue

      const type = entry.type

      if (type === 'session') {
        if (typeof entry.id === 'string') sessionId = entry.id
        if (typeof entry.cwd === 'string') cwd = entry.cwd
        continue
      }

      if (type === 'model_change') {
        if (typeof entry.provider === 'string' && entry.provider.trim() !== '') {
          currentProvider = entry.provider.trim()
        }
        if (typeof entry.modelId === 'string' && entry.modelId.trim() !== '') {
          currentModelId = entry.modelId.trim()
        }
        continue
      }

      if (type === 'message' && isRecord(entry.message)) {
        const msg = entry.message
        const role = msg.role

        // 子代理开销单独计入：不进模型分组（子任务未记录模型归属），也不增加消息条数。
        if (role === 'toolResult') {
          const subAgent = readSubAgentUsage(msg.details)
          if (subAgent !== null) {
            totalInput += subAgent.input
            totalOutput += subAgent.output
            totalTokens += subAgent.total
            const stamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp)
              : typeof entry.timestamp === 'number' ? entry.timestamp : updatedAt
            const dateKey = formatDateKey(Number.isNaN(stamp) ? updatedAt : stamp)
            let subDaily = dailyMap.get(dateKey)
            if (!subDaily) {
              subDaily = { date: dateKey, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, messageCount: 0 }
              dailyMap.set(dateKey, subDaily)
            }
            subDaily.input += subAgent.input
            subDaily.output += subAgent.output
            subDaily.totalTokens += subAgent.total
          }
        }

        // 提取首条用户消息作为标题
        if (role === 'user' && title === null) {
          const rawText = extractFirstUserMessageText(msg.content)
          if (rawText !== null) {
            const skill = parseSkillBlock(rawText)
            title = normalizeTitleText(skill ? (skill.userMessage ?? `技能：${skill.name}`) : rawText)
          }
        }

        // 提取助手消息用量
        if (role === 'assistant' && isRecord(msg.usage)) {
          const u = msg.usage
          const input = typeof u.input === 'number' && Number.isFinite(u.input) ? Math.max(0, u.input) : 0
          const output = typeof u.output === 'number' && Number.isFinite(u.output) ? Math.max(0, u.output) : 0
          const cacheRead = typeof u.cacheRead === 'number' && Number.isFinite(u.cacheRead) ? Math.max(0, u.cacheRead) : 0
          const cacheWrite = typeof u.cacheWrite === 'number' && Number.isFinite(u.cacheWrite) ? Math.max(0, u.cacheWrite) : 0
          const tokens = typeof u.totalTokens === 'number' && Number.isFinite(u.totalTokens)
            ? Math.max(0, u.totalTokens)
            : (input + output + cacheRead + cacheWrite)

          let costVal = 0
          if (typeof u.cost === 'number' && Number.isFinite(u.cost)) {
            costVal = Math.max(0, u.cost)
          } else if (isRecord(u.cost) && typeof u.cost.total === 'number' && Number.isFinite(u.cost.total)) {
            costVal = Math.max(0, u.cost.total)
          }

          // 如果助手消息自带 provider 或 model，优先采纳
          const p = (typeof msg.provider === 'string' && msg.provider.trim() !== '') ? msg.provider.trim() : currentProvider
          const m = (typeof msg.model === 'string' && msg.model.trim() !== '')
            ? msg.model.trim()
            : ((typeof msg.modelId === 'string' && msg.modelId.trim() !== '') ? msg.modelId.trim() : currentModelId)

          // 时间戳
          let ts: number = updatedAt
          if (typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp)) {
            ts = msg.timestamp
          } else if (typeof entry.timestamp === 'string') {
            const parsedTs = Date.parse(entry.timestamp)
            if (!Number.isNaN(parsedTs)) ts = parsedTs
          } else if (typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)) {
            ts = entry.timestamp
          }
          const dateKey = formatDateKey(ts)

          totalInput += input
          totalOutput += output
          totalCacheRead += cacheRead
          totalCacheWrite += cacheWrite
          totalTokens += tokens
          totalCost += costVal
          assistantMessageCount += 1

          // 累加模型
          const modelKey = `${p}:${m}`
          let modelBucket = modelMap.get(modelKey)
          if (!modelBucket) {
            modelBucket = {
              provider: p,
              modelId: m,
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              messageCount: 0
            }
            modelMap.set(modelKey, modelBucket)
          }
          modelBucket.input += input
          modelBucket.output += output
          modelBucket.cacheRead += cacheRead
          modelBucket.cacheWrite += cacheWrite
          modelBucket.totalTokens += tokens
          modelBucket.messageCount += 1

          // 累加日期
          let dailyBucket = dailyMap.get(dateKey)
          if (!dailyBucket) {
            dailyBucket = {
              date: dateKey,
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              messageCount: 0
            }
            dailyMap.set(dateKey, dailyBucket)
          }
          dailyBucket.input += input
          dailyBucket.output += output
          dailyBucket.cacheRead += cacheRead
          dailyBucket.cacheWrite += cacheWrite
          dailyBucket.totalTokens += tokens
          dailyBucket.messageCount += 1
        }
      }
    }
  } catch (error) {
    console.warn(`[usage-stats-scan] 扫描会话文件出错 (${filePath}):`, error)
  }

  if (sessionId === null || cwd === null) {
    return null
  }

  const totals: UsageTokenBreakdown = {
    input: totalInput,
    output: totalOutput,
    cacheRead: totalCacheRead,
    cacheWrite: totalCacheWrite,
    totalTokens
  }

  const models: UsageModelStat[] = Array.from(modelMap.values()).map(m => ({ ...m }))
  const daily: UsageDailyStat[] = Array.from(dailyMap.values()).map(d => ({ ...d }))

  return {
    filePath,
    fileStamp,
    sessionId,
    cwd,
    title: title ?? '未命名会话',
    updatedAt,
    messageCount: assistantMessageCount,
    totals,
    cost: totalCost,
    models,
    daily
  }
}
