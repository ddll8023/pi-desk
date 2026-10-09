/**
 * 认证辅助进程入口：复用官方 SDK 的 `ModelRuntime` 完成 Provider 认证状态读取、API Key 与 OAuth
 * 登录流程、退出登录，凭据读写仍由官方实现落在 `<agent-dir>/auth.json`。
 *
 * 进程由主进程用 `ELECTRON_RUN_AS_NODE` 启动，只通过 stdin/stdout 的 JSONL 帧通信，不监听网络、
 * 不接受外部参数、不启动 Pi。约定：
 * - 不在启动期加载 SDK：先取得原始 stdout 写入引用，再用动态 import 加载官方包，避免第三方模块
 *   在导入时改写 `process.stdout` 影响帧通道。
 * - 建实例时固定 `allowModelNetwork: false` 与 `refreshOnCreate: false`，并使用内存型模型目录缓存，
 *   因此状态读取不发起模型目录的网络请求，也不写 Pi 的模型缓存（环境凭据仍由官方实现按本地规则解析）。
 * - 帧里只出现认证状态、提示形态与进度文本；密钥只在内存中用于本次登录，并作为脱敏词表使用，
 *   既不写入日志也不进入 stderr。
 */
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { CreateModelRuntimeOptions, ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { AuthMethod, AuthPrompt, AuthProviderStatus, AuthStatus } from '../shared/auth-api'
import {
  AUTH_HELPER_MAX_RECORD_CHARS,
  isAuthHelperRequest,
  normalizeAuthSource
} from './protocol'
import type { AuthHelperFrame, AuthHelperRequest, AuthNotifyEvent } from './protocol'

/** 本地凭据与模型可用性检查的等待上限；超时按读取失败上报，不返回未完成的快照。 */
const STATUS_TIMEOUT_MS = 20_000

/** 退出登录的等待上限；与 Pi TUI 的 `/logout` 一致。 */
const LOGOUT_TIMEOUT_MS = 15_000

/** 单行诊断的长度上限；stderr 只放非秘密诊断。 */
const MAX_DIAGNOSTIC_CHARS = 400

/** 直接用官方登录回调的参数类型，避免重复描述官方提示与通知的形状。 */
type PiAuthPrompt = Parameters<Parameters<ModelRuntime['login']>[2]['prompt']>[0]
type PiAuthNotifyEvent = Parameters<Parameters<ModelRuntime['login']>[2]['notify']>[0]

/** 内存中的模型目录缓存；避免建实例后的本地刷新写 Pi 的 models-store.json。 */
type ModelsStoreOption = NonNullable<CreateModelRuntimeOptions['modelsStore']>
type ModelsStoreEntry = NonNullable<Awaited<ReturnType<ModelsStoreOption['read']>>>

class InMemoryModelsStore implements ModelsStoreOption {
  private readonly entries = new Map<string, ModelsStoreEntry>()

  async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
    return this.entries.get(providerId)
  }

  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
    this.entries.set(providerId, entry)
  }

  async delete(providerId: string): Promise<void> {
    this.entries.delete(providerId)
  }
}

/** 等待用户回应的提示；`settle` 只能被调用一次。 */
interface PendingPrompt {
  readonly promptId: string
  readonly isSecret: boolean
  readonly optionIds: readonly string[]
  settle(value: string | null): void
}

interface LoginFlow {
  readonly flowId: string
  readonly controller: AbortController
  prompt: PendingPrompt | null
  /** 本次流程出现过的敏感输入；只用于错误文本脱敏，流程结束后随流程对象丢弃。 */
  readonly secrets: string[]
}

/** 原始写入引用在模块加载时取得；后续即使第三方模块改写 process.stdout 也不影响帧通道。 */
const writeStdout = process.stdout.write.bind(process.stdout)
const writeStderr = process.stderr.write.bind(process.stderr)

const decoder = new StringDecoder('utf8')
const flows = new Map<string, LoginFlow>()
let sdk: typeof import('@earendil-works/pi-coding-agent') | null = null
let runtime: ModelRuntime | null = null
let statusReady = false
let inputBuffer = ''
let shuttingDown = false

function writeDiagnostic(text: string): void {
  const line = text.replace(/\s+/g, ' ').trim().slice(0, MAX_DIAGNOSTIC_CHARS)
  if (line === '') return
  writeStderr(`${line}\n`)
}

function writeFrame(frame: AuthHelperFrame, onFlushed?: () => void): void {
  const payload = `${JSON.stringify(frame)}\n`
  if (onFlushed === undefined) {
    writeStdout(payload)
    return
  }
  writeStdout(payload, onFlushed)
}

function respondOk(id: string, data: unknown): void {
  writeFrame({ type: 'response', id, ok: true, data })
}

function respondError(id: string, code: AuthHelperFrameResponseCode, message: string): void {
  writeFrame({ type: 'response', id, ok: false, code, message })
}

type AuthHelperFrameResponseCode =
  | 'AUTH_PROVIDER_UNKNOWN'
  | 'AUTH_LOGIN_NOT_FOUND'
  | 'AUTH_PROMPT_MISMATCH'
  | 'INVALID_REQUEST'
  | 'AUTH_HELPER_ERROR'

/** 官方 SDK 按需加载；失败时按辅助进程不可用如实上报，不静默降级。 */
async function loadSdk(): Promise<typeof import('@earendil-works/pi-coding-agent')> {
  sdk ??= await import('@earendil-works/pi-coding-agent')
  return sdk
}

async function modelRuntime(): Promise<ModelRuntime> {
  if (runtime !== null) return runtime
  const loaded = await loadSdk()
  runtime = await loaded.ModelRuntime.create({
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false
  })
  return runtime
}

/**
 * 首次读取状态时做一次本地可用性刷新（不发起模型目录网络请求）；之后的登录/退出由官方实现自行收敛。
 * 可用性检查超时（环境凭据解析可能很慢）不标记为已完成，而是如实报错，避免把未完成的快照当成真实状态。
 */
async function ensureStatus(runtime: ModelRuntime): Promise<void> {
  if (statusReady) return
  const signal = AbortSignal.timeout(STATUS_TIMEOUT_MS)
  await runtime.refresh({ allowNetwork: false, signal })
  if (signal.aborted) {
    throw new Error(`本地凭据与模型可用性检查超过 ${STATUS_TIMEOUT_MS} 毫秒未完成，请重试。`)
  }
  statusReady = true
}

/** 把官方的 Provider 与凭据信息投影为页面需要的状态；不含任何凭据内容。 */
async function readStatus(): Promise<AuthStatus> {
  const active = await modelRuntime()
  await ensureStatus(active)
  const credentials = await active.listCredentials()
  const storedTypes = new Map<string, AuthMethod>(
    credentials.map((credential) => [credential.providerId, credential.type])
  )
  const providers: AuthProviderStatus[] = active.getProviders().map((provider) => {
    const status = active.getProviderAuthStatus(provider.id)
    // 只列出能在这里完成的登录方式：仅靠环境变量或 models.json 的 Provider 不提供入口。
    const authTypes: AuthMethod[] = []
    if (provider.auth.apiKey?.login !== undefined) authTypes.push('api_key')
    if (provider.auth.oauth !== undefined) authTypes.push('oauth')
    // 已保存的凭据是权威事实：可用性快照没及时刷新时也不能把它报成未配置。
    const storedType = storedTypes.get(provider.id) ?? null
    const configured = status.configured || storedType !== null
    const source = status.configured
      ? normalizeAuthSource(status.source)
      : storedType === null ? null : 'stored'
    return {
      providerId: provider.id,
      name: provider.name,
      authTypes,
      subscription: provider.auth.oauth?.isSubscription === true,
      oauthLoginLabel: provider.auth.oauth?.loginLabel ?? null,
      configured,
      source,
      sourceLabel: status.label ?? null,
      storedType,
      modelCount: active.getModels(provider.id).length
    }
  })
  return { providers, configError: active.getError() ?? null, flow: null }
}

/** 错误文本脱敏：把本次流程出现过的敏感输入替换掉，避免密钥随错误信息外泄。 */
function redact(flow: LoginFlow | null, text: string): string {
  if (flow === null) return text
  let result = text
  for (const secret of flow.secrets) {
    if (secret.length === 0) continue
    result = result.split(secret).join('***')
  }
  return result
}

function emitNotify(flowId: string, event: PiAuthNotifyEvent): void {
  const mapped = toNotifyEvent(event)
  if (mapped !== null) writeFrame({ type: 'notify', flowId, event: mapped })
}

/** 官方通知映射为帧事件；`info` 的链接按纯文本附在消息后，不丢失信息。 */
function toNotifyEvent(event: PiAuthNotifyEvent): AuthNotifyEvent | null {
  switch (event.type) {
    case 'auth_url':
      return { kind: 'auth_url', url: event.url, instructions: event.instructions ?? null }
    case 'device_code':
      return { kind: 'device_code', userCode: event.userCode, verificationUri: event.verificationUri }
    case 'progress':
      return { kind: 'progress', message: event.message }
    case 'info': {
      const links = (event.links ?? []).map((link) => link.url).join(' ')
      return { kind: 'info', message: links === '' ? event.message : `${event.message}\n${links}` }
    }
    default:
      return null
  }
}

/** 提示转帧：只传递输入形态与文案，`select` 只带选项 id 与展示名。 */
function emitPrompt(flowId: string, prompt: AuthPrompt): void {
  writeFrame({ type: 'prompt', flowId, prompt })
}

function startLogin(
  request: Extract<AuthHelperRequest, { type: 'login' }>
): Promise<{ readonly code?: AuthHelperFrameResponseCode; readonly message?: string }> {
  return (async () => {
    const active = await modelRuntime()
    const provider = active.getProvider(request.providerId)
    if (provider === undefined) {
      return { code: 'AUTH_PROVIDER_UNKNOWN', message: `Pi 不认识 Provider「${request.providerId}」。` }
    }
    if (request.method === 'oauth' && provider.auth.oauth === undefined) {
      return { code: 'AUTH_PROVIDER_UNKNOWN', message: `Provider「${request.providerId}」不支持账户登录。` }
    }
    if (request.method === 'api_key' && provider.auth.apiKey?.login === undefined) {
      return {
        code: 'AUTH_PROVIDER_UNKNOWN',
        message: `Provider「${request.providerId}」不接受在应用内保存 API Key，凭据需要在 Pi 外部配置。`
      }
    }

    const flow: LoginFlow = {
      flowId: request.flowId,
      controller: new AbortController(),
      prompt: null,
      secrets: []
    }
    flows.set(flow.flowId, flow)
    void runLogin(active, flow, request).catch(() => undefined)
    return {}
  })()
}

async function runLogin(
  active: ModelRuntime,
  flow: LoginFlow,
  request: Extract<AuthHelperRequest, { type: 'login' }>
): Promise<void> {
  let message: string | null = null
  let cancelled = false
  let ok = true
  const deviceId = request.deviceId
  try {
    await active.login(
      request.providerId,
      request.method,
      {
        signal: flow.controller.signal,
        prompt: (prompt) => requestPrompt(flow, prompt),
        notify: (event) => emitNotify(flow.flowId, event)
      },
      deviceId === null ? undefined : { getDeviceId: () => deviceId }
    )
  } catch (error) {
    cancelled = flow.controller.signal.aborted
    const raw = error instanceof Error ? error.message : String(error)
    if (cancelled || raw === 'Login cancelled') {
      cancelled = true
      ok = false
      message = '登录已取消，未保存凭据。'
    } else if (sdk !== null && error instanceof sdk.CredentialSynchronizationError) {
      // 凭据已经保存，只是本地模型状态没同步上；如实告知，不当作登录失败。
      message = `凭据已保存，但本地模型状态同步失败：${redact(flow, raw)}`
    } else {
      ok = false
      message = redact(flow, raw)
    }
  } finally {
    settlePrompt(flow, null)
    flows.delete(flow.flowId)
    writeFrame({
      type: 'flow-end',
      flowId: flow.flowId,
      ok,
      cancelled,
      message: message === null ? null : redact(flow, message)
    })
  }
}

/** 等待用户回应的提示；流程取消或提示自身被取消时以 `Login cancelled` 结束。 */
function requestPrompt(flow: LoginFlow, prompt: PiAuthPrompt): Promise<string> {
  const promise = new Promise<string>((resolve, reject) => {
    const promptId = randomUUID()
    const isSecret = prompt.type === 'secret' || prompt.type === 'manual_code'
    // 只有 select 带候选项，只有 text/secret/manual_code 带占位符；按类型分支后再取，不跨分支读字段。
    const options = prompt.type === 'select' ? prompt.options : []
    const placeholder = prompt.type === 'select' ? null : prompt.placeholder ?? null
    const optionIds = options.map((option) => option.id)
    let settled = false

    const onAbort = (): void => {
      if (settled) return
      settled = true
      flow.prompt = null
      writeFrame({ type: 'prompt-void', flowId: flow.flowId, promptId })
      reject(new Error('Login cancelled'))
    }

    const pending: PendingPrompt = {
      promptId,
      isSecret,
      optionIds,
      settle: (value) => {
        if (settled) return
        settled = true
        prompt.signal?.removeEventListener('abort', onAbort)
        flow.controller.signal.removeEventListener('abort', onAbort)
        if (value === null) {
          reject(new Error('Login cancelled'))
          return
        }
        if (isSecret) flow.secrets.push(value)
        resolve(value)
      }
    }

    flow.prompt = pending
    prompt.signal?.addEventListener('abort', onAbort, { once: true })
    flow.controller.signal.addEventListener('abort', onAbort, { once: true })
    emitPrompt(flow.flowId, {
      promptId,
      kind: prompt.type,
      message: prompt.message,
      placeholder,
      options: options.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description ?? null
      }))
    })
  })
  // 流程结束时提示可能已无人等待；这里附一个空处理，避免孤立拒绝被当成未处理异常。
  promise.catch(() => undefined)
  return promise
}

/** 结束当前挂起的提示；值只在 `prompt-response` 路径传入。 */
function settlePrompt(flow: LoginFlow, value: string | null): boolean {
  const pending = flow.prompt
  if (pending === null) return false
  flow.prompt = null
  pending.settle(value)
  return true
}

function handlePromptResponse(
  request: Extract<AuthHelperRequest, { type: 'prompt-response' }>
): { readonly code?: AuthHelperFrameResponseCode; readonly message?: string } {
  const flow = flows.get(request.flowId)
  if (flow === undefined) return { code: 'AUTH_LOGIN_NOT_FOUND', message: '登录流程不存在或已结束。' }
  const pending = flow.prompt
  if (pending === null || pending.promptId !== request.promptId) {
    return { code: 'AUTH_PROMPT_MISMATCH', message: '该提示已经不再等待回应。' }
  }
  if (request.value === null) {
    settlePrompt(flow, null)
    return {}
  }
  if (pending.optionIds.length > 0 && !pending.optionIds.includes(request.value)) {
    return { code: 'INVALID_REQUEST', message: '选项回应不在本次提示的候选中。' }
  }
  settlePrompt(flow, request.value)
  return {}
}

async function handleRequest(request: AuthHelperRequest): Promise<void> {
  switch (request.type) {
    case 'status': {
      try {
        respondOk(request.id, await readStatus())
      } catch (error) {
        respondError(request.id, 'AUTH_HELPER_ERROR', describeError(error))
      }
      return
    }
    case 'login': {
      try {
        const failure = await startLogin(request)
        if (failure.code !== undefined) {
          respondError(request.id, failure.code, failure.message ?? '无法启动登录流程。')
          return
        }
        respondOk(request.id, { started: true })
      } catch (error) {
        respondError(request.id, 'AUTH_HELPER_ERROR', describeError(error))
      }
      return
    }
    case 'prompt-response': {
      const failure = handlePromptResponse(request)
      if (failure.code !== undefined) {
        respondError(request.id, failure.code, failure.message ?? '无法回应提示。')
        return
      }
      respondOk(request.id, { accepted: true })
      return
    }
    case 'cancel': {
      const flow = flows.get(request.flowId)
      if (flow === undefined) {
        respondError(request.id, 'AUTH_LOGIN_NOT_FOUND', '登录流程不存在或已结束。')
        return
      }
      flow.controller.abort(new Error('Login cancelled'))
      respondOk(request.id, { cancelled: true })
      return
    }
    case 'logout': {
      try {
        const active = await modelRuntime()
        if (active.getProvider(request.providerId) === undefined) {
          respondError(request.id, 'AUTH_PROVIDER_UNKNOWN', `Pi 不认识 Provider「${request.providerId}」。`)
          return
        }
        await active.logout(request.providerId, { signal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS) })
        statusReady = false
        respondOk(request.id, { loggedOut: true })
      } catch (error) {
        respondError(request.id, 'AUTH_HELPER_ERROR', describeError(error))
      }
      return
    }
    case 'shutdown': {
      shuttingDown = true
      // 响应先落到管道再退出：stdout 写回调返回时数据已经交给系统管道。
      writeFrame({ type: 'response', id: request.id, ok: true, data: { stopped: true } }, () => {
        process.exit(0)
      })
      return
    }
  }
}

/** 错误文本只保留信息本身，不附带堆栈；脱敏由调用方负责。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function handleLine(line: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    writeDiagnostic('收到无法解析的请求记录，已忽略。')
    return
  }
  if (!isAuthHelperRequest(parsed)) {
    writeDiagnostic('收到形状不符的请求记录，已忽略。')
    return
  }
  void handleRequest(parsed).catch((error: unknown) => {
    writeDiagnostic(`处理请求失败：${describeError(error)}`)
  })
}

function consumeInput(chunk: string): void {
  inputBuffer += chunk
  let index = inputBuffer.indexOf('\n')
  while (index >= 0) {
    const line = inputBuffer.slice(0, index)
    inputBuffer = inputBuffer.slice(index + 1)
    const record = line.endsWith('\r') ? line.slice(0, -1) : line
    if (record.length > 0) handleLine(record)
    index = inputBuffer.indexOf('\n')
  }
  if (inputBuffer.length > AUTH_HELPER_MAX_RECORD_CHARS) {
    inputBuffer = ''
    writeDiagnostic(`单条请求记录超过 ${AUTH_HELPER_MAX_RECORD_CHARS} 字符，已丢弃。`)
  }
}

process.stdin.on('data', (chunk: Buffer) => consumeInput(decoder.write(chunk)))
process.stdin.once('end', () => {
  if (!shuttingDown) process.exit(0)
})
process.stdin.on('error', () => process.exit(0))
process.stdout.on('error', () => process.exit(0))
process.stderr.on('error', () => process.exit(0))
process.on('uncaughtException', (error: Error) => {
  writeDiagnostic(`未捕获的异常：${error.name}`)
  process.exit(1)
})
process.on('unhandledRejection', () => {
  // 孤立的拒绝不终止进程：认证流程仍在进行时更需要继续服务后续请求。
  writeDiagnostic('未处理的 Promise 拒绝。')
})
