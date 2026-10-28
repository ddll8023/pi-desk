/**
 * 标签侧读取会话状态的唯一入口：只读查询加两个打开链收敛动作，不提供提交打开的通道。
 *
 * 提供者由组合根（`shell/use-app-startup.ts`）一次性注册，标签模块只 import 本文件而不 import 会话 Store，
 * 打开链因此不再形成「会话调标签、标签调会话」的模块环。视图属性是 getter，模板与 watch 仍能正常追踪。
 */
import type { SessionError, SessionSummary } from '../../../../shared/session-api'
import type { ProjectError } from '../../../../shared/project-api'

/** 标签需要的会话状态视图：只含展示与收敛动作需要的那部分，不含分片细节与其他动作。 */
export interface SessionTabState {
  /** 有打开动作排队或进行中时，标签不再提交新的意图。 */
  readonly opening: boolean
  /** 最新打开意图固定的项目路径，用于判断该项目的打开是否已在处理。 */
  readonly openingProjectPath: string | null
  /** 单次动作失败原因；来自会话或项目切换，界面按 message 展示。 */
  readonly actionError: SessionError | ProjectError | null
  readonly awaitingTrust: boolean
  readonly awaitingInterrupt: boolean
  /** 已落盘的会话身份；未落盘的新会话不作为标签身份。 */
  readonly loadedSessionIds: ReadonlySet<string>
  sessionsOf(projectPath: string): readonly SessionSummary[]
  /** 本地已提交但未交接的输入也占用标签，不能作为空白标签复用。 */
  hasPendingPrompt(projectPath: string, tabKey: string): boolean
  /** 等待已提交的打开动作收敛并给出实际实例身份。 */
  waitForOpenActions(): Promise<void>
  /** 撤销标签侧的选择意图，不中断已发送的宿主动作。 */
  invalidateOpenSelection(): void
}

let source: (() => SessionTabState) | null = null
let view: SessionTabState | null = null

/** 组合根注册提供者；提供者在首次读取时才执行，避免装配阶段提前实例化 Store。 */
export function registerSessionTabState(provider: () => SessionTabState): void {
  source = provider
  view = null
}

/** 取会话状态视图。未注册说明组合根漏了装配，直接失败而不是返回空状态掩盖问题。 */
export function sessionTabState(): SessionTabState {
  if (view !== null) return view
  if (source === null) throw new Error('会话状态提供者尚未注册：标签无法读取会话状态。')
  view = source()
  return view
}
