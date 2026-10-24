/** Runtime 的状态、目标、错误与命令契约：运行状态快照、Prompt、回退、压缩、切换模型，以及这些命令的请求与结果校验。 */

import type { ExtensionErrorEntry, OutputRate, ProjectionBatch, SessionUsage } from './projection'
import type { DesktopErrorCode } from '../desktop-api'

export const RUNTIME_STATUS_CHANNEL = 'desktop:runtime-status'
export const RUNTIME_PROMPT_CHANNEL = 'desktop:runtime-prompt'
/** 仅回退对话；目标由主进程核对，页面不能指定任意会话文件或 Pi 条目。 */
export const RUNTIME_REWIND_CHANNEL = 'desktop:runtime-rewind'
export const RUNTIME_ABORT_CHANNEL = 'desktop:runtime-abort'
export const RUNTIME_PROJECTION_CHANNEL = 'desktop:runtime-projection'
export const RUNTIME_PROJECTION_ACK_CHANNEL = 'desktop:runtime-projection-ack'
export const RUNTIME_CAPABILITIES_CHANNEL = 'desktop:runtime-capabilities'
export const RUNTIME_SET_MODEL_CHANNEL = 'desktop:runtime-set-model'
/** 手动压缩当前会话上下文；说明文本可选，压缩过程与结果由投影事件表达。 */
export const RUNTIME_COMPACT_CHANNEL = 'desktop:runtime-compact'
/** 只读：读取当前代际已加载的 Pi 资源清单（扩展命令、提示词与技能）。 */
export const RUNTIME_RESOURCES_CHANNEL = 'desktop:runtime-resources'
/**
 * 只读：Runtime 未启动时用一次性 Pi 进程预读资源、可用模型与默认模型。
 * 结果用于输入框补全、设置页与启动前模型选择；
 * Runtime 就绪后一律以运行中的清单为权威，两份数据不合并。
 * 带 `force` 的请求绕过主进程的进程内缓存，用于手动刷新或认证更新后重读。
 */
export const RUNTIME_RESOURCE_PREVIEW_CHANNEL = 'desktop:runtime-resource-preview'
/** 只读：读取当前代际的启动诊断尾部与 Extension 运行时错误。 */
export const RUNTIME_DIAGNOSTICS_CHANNEL = 'desktop:runtime-diagnostics'
/** 固定请求 `/mcp` 状态；不接受页面传入命令文本。 */
export const RUNTIME_MCP_STATUS_CHANNEL = 'desktop:runtime-mcp-status'
/** MCP 服务器 OAuth 登录、退出与重连；只接受受校验的服务器名，命令文本由主进程拼出。 */
export const RUNTIME_MCP_COMMAND_CHANNEL = 'desktop:runtime-mcp-command'
/**
 * 只读：用官方 CLI 的 `pi mcp list --json` 探测每个 MCP 服务器的连接状态、工具与错误。
 * 它与运行中的 Runtime 是两套独立连接（stdio 服务器会被再启动一次），因此只在用户显式请求时执行。
 */
export const RUNTIME_MCP_INSPECT_CHANNEL = 'desktop:runtime-mcp-inspect'
/** 零参数：中止一次进行中的 MCP 探测；没有进行中的探测时不做任何事。 */
export const RUNTIME_MCP_INSPECT_ABORT_CHANNEL = 'desktop:runtime-mcp-inspect-abort'
/**
 * 只读：列举 Pi 的 mcp.json 里配置的服务器（全局与项目两处），不连接服务器、不写配置文件。
 * `pi mcp list` 没有「只列举不连接」的模式，因此列表来源是配置文件本身，连接状态仍由探测补充。
 */
export const RUNTIME_MCP_CONFIG_CHANNEL = 'desktop:runtime-mcp-config'
/** 主进程到渲染进程的单向状态通知，payload 是 RuntimeStatus。 */
export const RUNTIME_STATUS_EVENT = 'desktop:runtime-status-changed'
/** 主进程到渲染进程的单向投影批次通知，payload 是 ProjectionBatch。 */
export const RUNTIME_PROJECTION_EVENT = 'desktop:runtime-projection-changed'

/**
 * 页面动作的二维目标：`runId` 定位运行实例，`runtimeId` 固定发起时所见绑定代际。
 * 主进程按注册表复核两者，不符时按未就绪拒绝，不向旧目标转发动作。
 */
export interface RuntimeTarget {
  readonly runId: number
  readonly runtimeId: number | null
}

/** 模型切换只针对发起时所见运行实例与绑定代际，不接受任意 RPC 或全局持久化参数。 */
export interface RuntimeSetModelRequest {
  readonly runId: number
  readonly runtimeId: number
  readonly provider: string
  readonly modelId: string
}

/**
 * `idle` 且 `runtimeId` 非空表示上一次 Runtime 已正常关闭；
 * `runtimeId` 仍为 null 表示从未启动。`failed` 表示异常退出或启动失败。
 */
export type RuntimeState = 'idle' | 'starting' | 'ready' | 'stopping' | 'failed'

/** 只投影页面需要的会话信息，不搬运 Pi 的完整状态或消息。 */
export interface RuntimeInfo {
  /** 当前模型的 provider 与 id；图片附件能力按模型目录精确匹配。 */
  readonly modelProvider: string | null
  readonly modelId: string | null
  readonly sessionId: string | null
  readonly messageCount: number
  readonly isStreaming: boolean
  /** 压缩或分支摘要正在进行；界面据此把运行中提示写成压缩文案。 */
  readonly isCompacting: boolean
  /** 会话累计用量与上下文占用；统计未取到或形状不符时为 null。 */
  readonly usage: SessionUsage | null
  /** 输出速率；未结算到有效值时为 null。 */
  readonly rate: OutputRate
}

export interface RuntimeStatus {
  readonly state: RuntimeState
  /** 来源运行实例；没有前台运行实例时为 null。 */
  readonly runId: number | null
  readonly runtimeId: number | null
  /**
   * 当前绑定或最近绑定的会话身份；未绑定时为 null。
   * 宿主已回收（空闲释放）时它是页面唯一的恢复目标：`state` 为 `idle` 但会话身份仍在，
   * 页面按「上次 Runtime 已关闭」展示并保留历史，下一次发送先恢复该会话。
   */
  readonly sessionId: string | null
  readonly info: RuntimeInfo | null
  /**
   * 前台宿主实际加载的 SDK 版本；宿主尚未启动或还没就绪时为 null。
   * 口径与版本检查快照里的版本不同：这里是「正在跑的那个」，快照里的版本是「下次启动会加载的」。
   */
  readonly sdkVersion: string | null
  readonly lastError: string | null
}

export type RuntimeErrorCode =
  | DesktopErrorCode
  | 'INVALID_PROJECT_PATH'
  | 'RUNTIME_NOT_READY'
  | 'RUNTIME_SPAWN_FAILED'
  | 'RUNTIME_EXITED'
  | 'RUNTIME_TIMEOUT'
  | 'RUNTIME_PROTOCOL_ERROR'
  /** Pi 以 `success: false` 拒绝了受支持的运行命令；消息带 Pi 的原因文本。 */
  | 'RUNTIME_COMMAND_REJECTED'
  /** 项目存在受保护资源且尚无信任决定；先完成信任决定再重试。 */
  | 'TRUST_REQUIRED'

export interface RuntimeError {
  readonly code: RuntimeErrorCode
  readonly message: string
}

export type RuntimeResult =
  | { readonly ok: true; readonly data: RuntimeStatus }
  | { readonly ok: false; readonly error: RuntimeError }

/** 消息 ID 仅在 Runtime 投影内有效；运行实例与会话身份防止确认弹窗的旧目标作用于新会话。 */
export interface RuntimeRewindRequest {
  readonly runId: number
  readonly runtimeId: number
  readonly sessionId: string
  readonly messageId: string
}

/** text 是 Pi 返回的完整原文；渲染端当前不消费该字段，回退与重新发送均使用页面编辑框内的文本。 */
export type RuntimeRewindResult =
  | { readonly ok: true; readonly data: { readonly status: RuntimeStatus; readonly cancelled: boolean; readonly text: string | null } }
  | { readonly ok: false; readonly error: RuntimeError; readonly blocked?: boolean }

/**
 * 手动压缩请求：目标身份之外只带可选的摘要说明（聚焦要保留的内容）。
 * 压缩过程与结果不在这里返回，而是由投影中的压缩记录表达。
 */
export interface RuntimeCompactRequest {
  readonly runId: number
  readonly runtimeId: number
  readonly sessionId: string
  readonly instructions: string | null
}

/** `handled` 表示被扩展或输入处理器消费，不表示本次一定启动了 Agent run。 */
export type PromptDisposition = 'started' | 'queued' | 'handled'

/**
 * 随 Prompt 提交的图片附件：`data` 是 base64 编码的图片本体。
 * MIME 白名单、大小与条数上限由主进程校验；页面传入的其他字段一律丢弃。
 */
export interface PromptImageInput {
  readonly name: string
  readonly mimeType: string
  readonly data: string
}

/**
 * 单条 Prompt 的图片条数上限；主进程校验与渲染端还原历史附件共用同一份，避免两处上限漂移。
 */
export const PROMPT_IMAGE_MAX_COUNT = 4

/** 单张图片 base64 编码后的字符数上限；主进程校验与渲染端还原历史附件共用同一份。 */
export const PROMPT_IMAGE_MAX_CHARS = 4_194_304

/** prompt 结果只表达请求被接受、排队或被处理，不等待 Agent 执行结束。 */
export type PromptResult =
  | { readonly ok: true; readonly data: { readonly disposition: PromptDisposition } }
  | { readonly ok: false; readonly error: RuntimeError }

/**
 * 当前 Runtime 代际的启动诊断与 Extension 运行时错误。
 * `stderrLines` 是宿主内 SDK 会话的创建期诊断文本（settings 与资源加载告警，按行有界），
 * 按不可信纯文本展示；宿主进程自身的输出不进入本通道。
 */
export interface RuntimeDiagnostics {
  readonly runtimeId: number | null
  readonly stderrLines: readonly string[]
  readonly extensionErrors: readonly ExtensionErrorEntry[]
}

export type RuntimeDiagnosticsResult =
  | { readonly ok: true; readonly data: RuntimeDiagnostics }
  | { readonly ok: false; readonly error: RuntimeError }

/** 压缩说明长度上限；超限文本按参数拒绝，不静默截断后当成另一条指令。 */
export const COMPACT_INSTRUCTIONS_MAX_CHARS = 2_000
