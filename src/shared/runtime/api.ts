/**
 * Runtime 桥接对象的完整接口：把状态与命令、投影、模型能力、资源与 MCP 四组方法聚合成一个
 * 页面可见的契约。四个域文件互不引用，跨域类型集中在这里引用。
 */

import type { CapabilitiesResult } from './models'
import type { McpCommandAction, McpCommandResult, McpConfigResult, McpInspectAbortResult, McpInspectionResult, McpStatusResult, ResourcePreviewResult, ResourcesResult } from './resources'
import type { HistoryData, ProjectionBatch, ProjectionResult, RuntimeHistoryRequest } from './projection'
import type { PromptImageInput, PromptResult, RuntimeCompactRequest, RuntimeDiagnosticsResult, RuntimeHistoryResult, RuntimeResult, RuntimeRewindRequest, RuntimeRewindResult, RuntimeSetModelRequest, RuntimeStatus, RuntimeTarget } from './status'


export interface RuntimeApi {
  readonly getRuntimeStatus: () => Promise<RuntimeResult>
  /** 提交 Prompt 到目标运行实例的当前绑定；成功只表达接受、排队或已处理。 */
  readonly sendPrompt: (target: RuntimeTarget, message: string, images?: readonly PromptImageInput[]) => Promise<PromptResult>
  /** 请求中止目标运行实例的当前操作；成功只表示 Pi 已确认取消，运行状态仍以事件流为准。 */
  readonly abortRuntime: (target: RuntimeTarget) => Promise<RuntimeResult>
  /** 回退到指定用户消息之前：Pi 的 fork 会新建会话并保留来源文件；不撤销项目文件改动。 */
  readonly rewindRuntime: (request: RuntimeRewindRequest) => Promise<RuntimeRewindResult>
  /** 读取目标运行实例当前绑定的投影快照；未绑定时返回空基准。 */
  readonly getRuntimeProjection: (target: RuntimeTarget) => Promise<ProjectionResult>
  readonly readRuntimeHistory: (request: RuntimeHistoryRequest) => Promise<RuntimeHistoryResult>
  /** 读取目标运行实例当前绑定的可用模型；失败原因由结果表达。 */
  readonly getRuntimeCapabilities: (target: RuntimeTarget) => Promise<CapabilitiesResult>
  /**
   * 只切换当前会话模型；成功返回 Pi 刷新后的实际状态，不改变全局默认。
   * 失败或超时不保证模型未改变，不自动重发；实际模型以 Runtime 状态为准。
   */
  readonly setRuntimeModel: (request: RuntimeSetModelRequest) => Promise<RuntimeResult>
  /**
   * 手动压缩当前会话上下文；说明可选，成功返回 Pi 刷新后的实际状态。
   * 压缩是整段操作（含一次摘要 LLM 调用），完成后才返回；过程与结果由投影中的压缩记录表达。
   */
  readonly compactRuntime: (request: RuntimeCompactRequest) => Promise<RuntimeResult>
  /** 读取目标运行实例当前绑定已加载的 Pi 资源清单；来源是会话内已加载的扩展、提示词与技能。 */
  readonly getRuntimeResources: (target: RuntimeTarget) => Promise<ResourcesResult>
  /** 预读资源、可用模型与默认模型及分项错误；项目与信任由主进程决定，`force` 绕过进程内缓存。 */
  readonly getResourcePreview: (force: boolean) => Promise<ResourcePreviewResult>
  /** 读取目标运行实例当前绑定的 SDK 会话创建期诊断与 Extension 运行时错误。 */
  readonly getRuntimeDiagnostics: (target: RuntimeTarget) => Promise<RuntimeDiagnosticsResult>
  /** 固定请求目标运行实例的 `/mcp` 状态；状态文本由 notify 捕获后返回，不在页面拼造。 */
  readonly readRuntimeMcpStatus: (target: RuntimeTarget) => Promise<McpStatusResult>
  /** MCP 服务器 OAuth 登录、退出或重连；服务器名由页面给出但由主进程校验，命令文本由主进程拼出。 */
  readonly runRuntimeMcpCommand: (target: RuntimeTarget, action: McpCommandAction, serverName: string) => Promise<McpCommandResult>
  /**
   * 只读列举 Pi 的 mcp.json 配置：零参数，agent 目录与当前项目由主进程决定；
   * 不连接服务器、不写配置文件，项目级配置是否生效由主进程按信任决定回传。
   */
  readonly getRuntimeMcpConfig: () => Promise<McpConfigResult>
  /** MCP 服务器状态探测：零参数，主进程用当前项目与信任决定执行固定的 `pi mcp list --json`。 */
  readonly inspectRuntimeMcpServers: () => Promise<McpInspectionResult>
  /** 中止进行中的 MCP 探测；零参数，没有进行中的探测时返回 `aborted: false`。 */
  readonly abortRuntimeMcpInspection: () => Promise<McpInspectAbortResult>
  /** 确认目标运行实例已应用到的最高序号；即发即忘，结果不影响页面。 */
  readonly ackRuntimeProjection: (target: RuntimeTarget, seq: number) => void
  /** 订阅状态变化；返回释放函数，页面卸载时必须调用。 */
  readonly onRuntimeStatusChanged: (listener: (status: RuntimeStatus) => void) => () => void
  /** 订阅投影批次；返回释放函数，页面卸载时必须调用。 */
  readonly onRuntimeProjectionChanged: (listener: (batch: ProjectionBatch) => void) => () => void
}
