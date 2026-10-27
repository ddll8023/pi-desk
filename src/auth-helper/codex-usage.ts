/** Codex 账户额度查询：凭据只在辅助进程内解析与刷新，固定请求官方地址，仅缓存脱敏后的展示数据。 */
import { createHash } from 'node:crypto'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { CodexUsageSnapshot, CodexUsageWindow } from '../shared/auth-api'

/** ChatGPT 内部接口，不属于稳定公开 API；不使用自定义供应商的 baseUrl。 */
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CACHE_TTL_MS = 60_000
const QUERY_TIMEOUT_MS = 10_000

interface UsageAuth {
  readonly token: string
  readonly accountId: string
  readonly fingerprint: string
}

interface PendingUsage {
  readonly fingerprint: string
  readonly controller: AbortController
  readonly promise: Promise<CodexUsageSnapshot>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidResponse(): Error {
  return new Error('Codex 额度接口返回了无法识别的数据，请稍后刷新。')
}

/** JWT 只用于取得账户路由，不把解码结果当成身份认证，也不向页面传递。 */
function accountIdFromToken(token: string): string {
  try {
    const part = token.split('.')[1]
    if (part === undefined) return ''
    const claims: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    if (!isRecord(claims)) return ''
    const auth = claims['https://api.openai.com/auth']
    if (!isRecord(auth)) return ''
    const accountId = auth.chatgpt_account_id
    return typeof accountId === 'string' && /^[\w-]{1,256}$/.test(accountId) ? accountId : ''
  } catch {
    return ''
  }
}

/** 由 SDK 处理 OAuth 续期与跨进程凭据锁；不自行读取 auth.json 或回退到 API Key。 */
async function resolveAuth(runtime: ModelRuntime, signal: AbortSignal): Promise<UsageAuth> {
  let resolved: Awaited<ReturnType<ModelRuntime['getAuth']>>
  try {
    resolved = await runtime.getAuth('openai-codex', { signal })
  } catch {
    // SDK 的原始异常可能包含令牌刷新响应；不让它进入 JSONL、日志或页面。
    throw new Error(signal.aborted
      ? '读取 Codex 登录凭据超时，请重试。'
      : '无法读取或刷新 Codex 登录凭据，请在设置的模型页面重新登录 OpenAI Codex。')
  }
  if (resolved === undefined) {
    throw new Error('尚未登录 OpenAI Codex，请在设置的模型页面完成账户登录后刷新。')
  }
  const token = resolved.auth.apiKey
  if (resolved.source !== 'OAuth' || typeof token !== 'string' || token.length === 0) {
    throw new Error('额度查询需要 OpenAI Codex 账户登录，API Key 不支持此查询。')
  }
  const accountId = accountIdFromToken(token)
  if (accountId === '') {
    throw new Error('Codex 登录凭据缺少有效账户信息，请重新登录 OpenAI Codex。')
  }
  return { token, accountId, fingerprint: createHash('sha256').update(token).digest('hex') }
}

/** 缺失窗口保持为空；字段存在但不合法时拒绝响应，不把异常数据解释成零用量。 */
function parseUsage(payload: unknown): CodexUsageSnapshot {
  if (!isRecord(payload) || (!('rate_limit' in payload) && !('credits' in payload))) throw invalidResponse()
  if (payload.rate_limit != null && !isRecord(payload.rate_limit)) throw invalidResponse()
  const limit = isRecord(payload.rate_limit) ? payload.rate_limit : {}
  const windows: CodexUsageWindow[] = []
  for (const id of ['primary_window', 'secondary_window'] as const) {
    const window = limit[id]
    if (window == null) continue
    if (!isRecord(window)) throw invalidResponse()
    const seconds = window.limit_window_seconds
    const used = window.used_percent
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0
      || typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) throw invalidResponse()
    const reset = window.reset_at
    if (reset != null && (typeof reset !== 'number' || !Number.isFinite(reset) || reset < 0 || reset > 8.64e12)) {
      throw invalidResponse()
    }
    windows.push({
      id,
      seconds,
      remainingPercent: 100 - used,
      resetAt: typeof reset === 'number' && reset > 0 ? reset * 1000 : null
    })
  }
  windows.sort((a, b) => a.seconds - b.seconds)
  if (limit.limit_reached !== undefined && typeof limit.limit_reached !== 'boolean') throw invalidResponse()
  if (payload.credits != null && !isRecord(payload.credits)) throw invalidResponse()
  const credit = isRecord(payload.credits) ? payload.credits : null
  if (credit?.unlimited !== undefined && typeof credit.unlimited !== 'boolean') throw invalidResponse()
  if (credit?.has_credits !== undefined && typeof credit.has_credits !== 'boolean') throw invalidResponse()
  let credits: string | null = null
  if (credit !== null && credit.has_credits !== false && credit.balance != null) {
    const balance = credit.balance
    if (typeof balance !== 'string' && (typeof balance !== 'number' || !Number.isFinite(balance))) throw invalidResponse()
    const text = String(balance).trim()
    if (text.length > 128) throw invalidResponse()
    if (text !== '') credits = text
  }
  return {
    windows,
    credits,
    unlimited: credit?.unlimited === true,
    limitReached: limit.limit_reached === true,
    fetchedAt: Date.now()
  }
}

/** 单进程短期缓存按凭据指纹隔离；登录、退出使正在查询的旧结果一并失效。 */
export class CodexUsageReader {
  private generation = 0
  private cache: { readonly fingerprint: string; readonly data: CodexUsageSnapshot } | null = null
  private pending: PendingUsage | null = null

  clear(): void {
    this.generation += 1
    this.cache = null
    this.pending?.controller.abort()
    this.pending = null
  }

  async read(runtime: ModelRuntime, refresh: boolean): Promise<CodexUsageSnapshot> {
    const generation = this.generation
    const auth = await resolveAuth(runtime, AbortSignal.timeout(QUERY_TIMEOUT_MS))
    this.requireCurrent(generation)
    if (!refresh && this.cache?.fingerprint === auth.fingerprint
      && Date.now() - this.cache.data.fetchedAt < CACHE_TTL_MS) return this.cache.data
    if (this.pending?.fingerprint === auth.fingerprint) return this.pending.promise
    const controller = new AbortController()
    const promise: Promise<CodexUsageSnapshot> = this.query(runtime, auth, generation, controller.signal)
      .finally(() => {
        if (this.pending?.promise === promise) this.pending = null
      })
    this.pending = { fingerprint: auth.fingerprint, controller, promise }
    return promise
  }

  private requireCurrent(generation: number): void {
    if (generation !== this.generation) throw new Error('Codex 登录状态已变化，请重新刷新额度。')
  }

  private async query(
    runtime: ModelRuntime,
    auth: UsageAuth,
    generation: number,
    cancelled: AbortSignal
  ): Promise<CodexUsageSnapshot> {
    const signal = AbortSignal.any([cancelled, AbortSignal.timeout(QUERY_TIMEOUT_MS)])
    let response: Response
    try {
      response = await fetch(CODEX_USAGE_URL, {
        method: 'GET',
        // 不跟随重定向，避免把账户凭据发送到接口重定向的其他地址。
        redirect: 'error',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${auth.token}`,
          'chatgpt-account-id': auth.accountId,
          'user-agent': 'pi-desk'
        },
        signal
      })
    } catch {
      this.requireCurrent(generation)
      throw new Error(signal.aborted ? 'Codex 额度查询超时，请重试。' : '无法连接 Codex 额度接口，请检查网络后刷新。')
    }
    if (!response.ok) {
      if (response.status === 401) throw new Error('Codex 登录已失效，请重新登录 OpenAI Codex 后刷新。')
      if (response.status === 403) throw new Error('当前 Codex 账户无法访问额度接口（HTTP 403）。')
      if (response.status === 429) throw new Error('Codex 额度查询过于频繁，请稍后刷新（HTTP 429）。')
      throw new Error(`Codex 额度查询失败（HTTP ${response.status}），请稍后刷新。`)
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new Error(signal.aborted ? 'Codex 额度查询超时，请重试。' : 'Codex 额度接口未返回有效 JSON，请稍后刷新。')
    }
    const data = parseUsage(payload)
    this.requireCurrent(generation)
    // 另一进程也能更换 auth.json；响应返回后再解析一次，避免展示旧账户的数据。
    const current = await resolveAuth(runtime, signal)
    this.requireCurrent(generation)
    if (current.fingerprint !== auth.fingerprint) {
      throw new Error('Codex 登录凭据已变化，请重新刷新额度。')
    }
    this.cache = { fingerprint: auth.fingerprint, data }
    return data
  }
}
