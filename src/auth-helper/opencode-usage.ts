/** OpenCode Go 订阅额度查询：凭据只在辅助进程内解析，固定请求官方地址，仅缓存脱敏后的展示数据。 */
import { createHash } from 'node:crypto'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { OpencodeUsageSnapshot, OpencodeUsageWindow } from '../shared/auth-api'

/** OpenCode 官方额度接口，不属于稳定公开 API；不接受自定义供应商的 baseUrl。 */
const OPENCODE_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'
const CACHE_TTL_MS = 60_000
const QUERY_TIMEOUT_MS = 10_000
/**
 * 该接口位于 Cloudflare 之后，非浏览器 User-Agent 会被直接拒绝（HTTP 403 / error 1010）；
 * 这里固定一个通用浏览器标识，不携带任何账户信息。
 */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/**
 * 本机没有可用于额度查询的 OpenCode Go API Key（未配置，或凭据不含 API Key）。
 * 属预期状态而不是故障，单独上报让页面不展示额度区；消息里不携带任何凭据内容。
 */
export class OpencodeNotConfiguredError extends Error {}

interface UsageAuth {
  readonly token: string
  readonly fingerprint: string
}

interface PendingUsage {
  readonly fingerprint: string
  readonly controller: AbortController
  readonly promise: Promise<OpencodeUsageSnapshot>
}

/** 三个窗口的固定顺序；上游缺失的窗口不补零，保持为空。 */
const WINDOW_IDS = ['rolling', 'weekly', 'monthly'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidResponse(): Error {
  return new Error('OpenCode Go 额度接口返回了无法识别的数据，请稍后刷新。')
}

/** 由 SDK 解析已配置的 API Key；不自行读取 auth.json 或环境变量。 */
async function resolveAuth(runtime: ModelRuntime, signal: AbortSignal): Promise<UsageAuth> {
  let resolved: Awaited<ReturnType<ModelRuntime['getAuth']>>
  try {
    resolved = await runtime.getAuth('opencode-go', { signal })
  } catch {
    // SDK 的原始异常可能包含凭据内容；不让它进入 JSONL、日志或页面。
    throw new Error(signal.aborted
      ? '读取 OpenCode Go 凭据超时，请重试。'
      : '无法读取 OpenCode Go 凭据，请在设置的模型页面确认配置。')
  }
  if (resolved === undefined) {
    throw new OpencodeNotConfiguredError('尚未配置 OpenCode Go 的 API Key，请在设置的模型页面配置后刷新。')
  }
  const token = resolved.auth.apiKey
  if (typeof token !== 'string' || token.length === 0) {
    throw new OpencodeNotConfiguredError('OpenCode Go 凭据缺少可用的 API Key，请在设置的模型页面重新配置。')
  }
  return { token, fingerprint: createHash('sha256').update(token).digest('hex') }
}

/** 缺失窗口保持为空；字段存在但不合法时拒绝响应，不把异常数据解释成零用量。 */
function parseUsage(payload: unknown): OpencodeUsageSnapshot {
  if (!isRecord(payload) || !isRecord(payload.usage)) throw invalidResponse()
  const usage = payload.usage
  const windows: OpencodeUsageWindow[] = []
  for (const id of WINDOW_IDS) {
    const window = usage[id]
    if (window === undefined) continue
    if (!isRecord(window)) throw invalidResponse()
    const percent = window.percent
    if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw invalidResponse()
    }
    const reset = window.resetsAt
    let resetAt: number | null = null
    if (typeof reset === 'string' && reset !== '') {
      const parsed = Date.parse(reset)
      if (!Number.isFinite(parsed) || parsed <= 0) throw invalidResponse()
      resetAt = parsed
    } else if (reset !== undefined && reset !== null) {
      throw invalidResponse()
    }
    windows.push({ id, usedPercent: percent, resetAt })
  }
  return { windows, fetchedAt: Date.now() }
}

/** 单进程短期缓存按凭据指纹隔离；配置变更使正在查询的旧结果一并失效。 */
export class OpencodeUsageReader {
  private generation = 0
  private cache: { readonly fingerprint: string; readonly data: OpencodeUsageSnapshot } | null = null
  private pending: PendingUsage | null = null

  clear(): void {
    this.generation += 1
    this.cache = null
    this.pending?.controller.abort()
    this.pending = null
  }

  async read(runtime: ModelRuntime, refresh: boolean): Promise<OpencodeUsageSnapshot> {
    const generation = this.generation
    const auth = await resolveAuth(runtime, AbortSignal.timeout(QUERY_TIMEOUT_MS))
    this.requireCurrent(generation)
    if (!refresh && this.cache?.fingerprint === auth.fingerprint
      && Date.now() - this.cache.data.fetchedAt < CACHE_TTL_MS) return this.cache.data
    if (this.pending?.fingerprint === auth.fingerprint) return this.pending.promise
    const controller = new AbortController()
    const promise: Promise<OpencodeUsageSnapshot> = this.query(runtime, auth, generation, controller.signal)
      .finally(() => {
        if (this.pending?.promise === promise) this.pending = null
      })
    this.pending = { fingerprint: auth.fingerprint, controller, promise }
    return promise
  }

  private requireCurrent(generation: number): void {
    if (generation !== this.generation) throw new Error('OpenCode Go 配置已变化，请重新刷新额度。')
  }

  private async query(
    runtime: ModelRuntime,
    auth: UsageAuth,
    generation: number,
    cancelled: AbortSignal
  ): Promise<OpencodeUsageSnapshot> {
    const signal = AbortSignal.any([cancelled, AbortSignal.timeout(QUERY_TIMEOUT_MS)])
    let response: Response
    try {
      response = await fetch(OPENCODE_USAGE_URL, {
        method: 'GET',
        // 不跟随重定向，避免把 API Key 发送到接口重定向的其他地址。
        redirect: 'error',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${auth.token}`,
          'user-agent': BROWSER_USER_AGENT
        },
        signal
      })
    } catch {
      this.requireCurrent(generation)
      throw new Error(signal.aborted
        ? 'OpenCode Go 额度查询超时，请重试。'
        : '无法连接 OpenCode Go 额度接口，请检查网络后刷新。')
    }
    if (!response.ok) {
      if (response.status === 401) throw new Error('OpenCode Go 的 API Key 已失效，请在设置的模型页面重新配置后刷新。')
      // 403 既可能是账户没有 Go 订阅，也可能是请求被 Cloudflare 拦截，两者都如实报出。
      if (response.status === 403) throw new Error('当前账户无法访问 OpenCode Go 额度接口（HTTP 403），请确认已订阅后再试。')
      if (response.status === 429) throw new Error('OpenCode Go 额度查询过于频繁，请稍后刷新（HTTP 429）。')
      throw new Error(`OpenCode Go 额度查询失败（HTTP ${response.status}），请稍后刷新。`)
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new Error(signal.aborted
        ? 'OpenCode Go 额度查询超时，请重试。'
        : 'OpenCode Go 额度接口未返回有效 JSON，请稍后刷新。')
    }
    const data = parseUsage(payload)
    this.requireCurrent(generation)
    // 配置可能在其他进程被修改；响应返回后再解析一次，避免展示旧账户的数据。
    const current = await resolveAuth(runtime, signal)
    this.requireCurrent(generation)
    if (current.fingerprint !== auth.fingerprint) {
      throw new Error('OpenCode Go 凭据已变化，请重新刷新额度。')
    }
    this.cache = { fingerprint: auth.fingerprint, data }
    return data
  }
}
