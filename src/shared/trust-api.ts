/** 只定义 Project Trust 查询与决定 IPC 的固定通道、结果类型与跨进程响应校验。 */
import type { DesktopError } from './desktop-api'

export const TRUST_STATUS_CHANNEL = 'desktop:trust-status'
export const TRUST_DECIDE_CHANNEL = 'desktop:trust-decide'

/** Desktop 侧保存的信任决定；`--approve` / `--no-approve` 的取值来源。 */
export type TrustDecision = 'trusted' | 'untrusted'

/** 决定接口接受的取值；`unset` 表示清除已保存的决定，下次启动重新询问。 */
export type TrustDecisionInput = TrustDecision | 'unset'

/**
 * 触发信任要求的受保护资源类型，与官方清单一一对应：
 * 项目目录下的 `.pi` 资源，以及祖先目录的 `.agents/skills`。
 */
export type TrustResourceKind =
  | 'settings'
  | 'mcp'
  | 'extensions'
  | 'skills'
  | 'prompts'
  | 'themes'
  | 'systemMd'
  | 'appendSystemMd'
  | 'agentSkills'

/** 探测到的受保护资源；`path` 是资源的绝对路径，只用于展示。 */
export interface TrustResource {
  readonly path: string
  readonly kind: TrustResourceKind
}

/**
 * 当前项目的信任状态：`projectPath` 为 null 表示尚未选择项目；
 * `decision` 为 null 表示尚未做出决定；`resources` 是探测到的受保护资源。
 */
export interface TrustStatus {
  readonly projectPath: string | null
  readonly decision: TrustDecision | null
  readonly resources: readonly TrustResource[]
}

export type TrustStatusResult =
  | { readonly ok: true; readonly data: TrustStatus }
  | { readonly ok: false; readonly error: DesktopError }

/** 决定成功时返回更新后的状态；不改变项目选择，也不启动 Runtime。 */
export type TrustDecisionResult =
  | { readonly ok: true; readonly data: TrustStatus }
  | { readonly ok: false; readonly error: DesktopError }

export interface TrustApi {
  /** 读取当前项目的信任状态与探测到的受保护资源。 */
  readonly getTrustStatus: () => Promise<TrustStatusResult>
  /** 保存、更新或清除（`unset`）当前项目的信任决定；只接受当前项目。 */
  readonly decideTrust: (projectPath: string, decision: TrustDecisionInput) => Promise<TrustDecisionResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isTrustDecision(value: unknown): value is TrustDecision {
  return value === 'trusted' || value === 'untrusted'
}

export function isTrustDecisionInput(value: unknown): value is TrustDecisionInput {
  return isTrustDecision(value) || value === 'unset'
}

const TRUST_RESOURCE_KINDS: readonly TrustResourceKind[] = [
  'settings',
  'mcp',
  'extensions',
  'skills',
  'prompts',
  'themes',
  'systemMd',
  'appendSystemMd',
  'agentSkills'
]

function isTrustResource(value: unknown): value is TrustResource {
  if (!isRecord(value)) return false
  return typeof value.path === 'string'
    && value.path !== ''
    && TRUST_RESOURCE_KINDS.includes(value.kind as TrustResourceKind)
}

function isTrustStatus(value: unknown): value is TrustStatus {
  if (!isRecord(value)) return false
  return (value.projectPath === null || typeof value.projectPath === 'string')
    && (value.decision === null || isTrustDecision(value.decision))
    && Array.isArray(value.resources)
    && value.resources.every(isTrustResource)
}

// TypeScript 声明不能保证 invoke 的实际返回值；沙箱桥接只放行本契约。
export function isTrustStatusResult(value: unknown): value is TrustStatusResult {
  if (!isRecord(value)) return false

  if (value.ok === true) return isTrustStatus(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof message === 'string' && typeof code === 'string'
}

export function isTrustDecisionResult(value: unknown): value is TrustDecisionResult {
  return isTrustStatusResult(value)
}
