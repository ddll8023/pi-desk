/** 模型能力契约：模型标识、摘要、agent 能力清单及其校验。被偏好、Pi 默认模型等契约引用。 */

import type { RuntimeError } from './status'


/** 模型的复合身份；只保存供应商和模型 ID，不携带凭据或任意启动参数。 */
export interface ModelIdentity {
  readonly provider: string
  readonly modelId: string
}

/** 可用模型的精简投影；仅保留模型选择与展示、Provider 状态与图片输入判断所需字段。 */
export interface ModelSummary {
  readonly provider: string
  readonly id: string
  /** 模型显示名；目录未提供时为 null。 */
  readonly name: string | null
  /** 上下文窗口大小（token）；目录未提供或形状不符时为 null。 */
  readonly contextWindow: number | null
  /** 是否支持图片输入；未知时为 null。 */
  readonly imageInput: boolean | null
}

/** 当前 Runtime 代际的可用模型；模型列表失败与空列表保持区分。 */
export interface AgentCapabilities {
  readonly runtimeId: number
  readonly models: readonly ModelSummary[]
  readonly modelsError: string | null
}

export type CapabilitiesResult =
  | { readonly ok: true; readonly data: AgentCapabilities }
  | { readonly ok: false; readonly error: RuntimeError }
