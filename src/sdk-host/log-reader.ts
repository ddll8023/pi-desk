/**
 * 会话日志读取：把主进程已授权的会话文件按查询解析成历史页、轮次页或原文续段。
 *
 * 边界：只读、只按查询换算一段历史，不缓存权威状态。不建立 AgentSession，也不加载技能、扩展与 MCP，
 * 所以未绑定的会话也能翻页查看；产出的内容只是展示副本，不能据此发送、回退或改写任何东西。
 * 解析结果按「会话文件 + 文件戳」保留最近一次：同一会话连续翻页不重复解析整份日志，文件戳变化即重建。
 * 读取前后各复核一次文件戳，读取期间被改写时按目标失效拒绝，不展示可能已经变化的内容。
 * 读到最新一页时顺带写入投影检查点，让随后的绑定直接复用这一页，而不是把同一会话再投影一次。
 */
import { readFile, stat } from 'node:fs/promises'
import type { SdkModule } from '../shared-process/runtime'
import type { HistoryData } from '../shared/runtime-api'
import type { SdkLogTarget } from './protocol'
import { readBranchHistory } from './projection/history-projection'
import { stampOf } from './projection/checkpoint'
import type { ProjectionCheckpoints } from './projection/checkpoint'
import { SdkSessionFailure } from './session-runtime'

/** 官方内存会话：只提供分支读取，没有任何执行入口。 */
type LogSession = ReturnType<SdkModule['SessionManager']['inMemory']>

/** 最近一次解析的会话；只留一份，避免为翻页常驻多个会话的内存副本。 */
let cached: { readonly stamp: string; readonly session: LogSession } | null = null

/**
 * 读取一段日志历史。`runtimeId` 传 0：日志读取不属于任何绑定代际，
 * 返回的消息身份仍是官方条目身份（`history:<entryId>`），与绑定后的权威投影一致。
 * 最新一页同时写入检查点；翻更早的分页不写入，绑定时需要的是最新一页。
 */
export async function readSessionLog(
  sdk: SdkModule, target: SdkLogTarget, checkpoints: ProjectionCheckpoints
): Promise<HistoryData> {
  const before = await stat(target.sessionFile, { bigint: true })
  if (!before.isFile() || stampOf(before) !== target.fileStamp) {
    throw new SdkSessionFailure('INVALID_SESSION_TARGET')
  }
  const session = await branchOf(sdk, target)
  const branch = session.getBranch()
  let data: HistoryData
  try {
    data = readBranchHistory(branch, target.query, 0)
  } catch {
    // 游标或续段位置已不属于当前分支：按目标失效报告，不返回半份历史。
    cached = null
    checkpoints.forget(target.sessionId)
    throw new SdkSessionFailure('INVALID_SESSION_TARGET')
  }
  if (stampOf(await stat(target.sessionFile, { bigint: true })) !== target.fileStamp) {
    cached = null
    checkpoints.forget(target.sessionId)
    throw new SdkSessionFailure('INVALID_SESSION_TARGET')
  }
  if (data.kind === 'page' && target.query.kind === 'page' && target.query.before === null) {
    checkpoints.remember(target.sessionId, {
      fileStamp: target.fileStamp, tailEntryId: branch.at(-1)?.id ?? null, page: data
    })
  }
  return data
}

/** 解析并缓存分支；文件戳未变时复用，避免每次翻页重读整份日志。 */
async function branchOf(sdk: SdkModule, target: SdkLogTarget): Promise<LogSession> {
  if (cached !== null && cached.stamp === target.fileStamp) return cached.session
  const entries = sdk.parseSessionEntries(await readFile(target.sessionFile, 'utf8'))
  const header = entries.find(entry => entry.type === 'session')
  if (header?.type !== 'session' || header.id !== target.sessionId) {
    throw new SdkSessionFailure('INVALID_SESSION_TARGET')
  }
  const session = sdk.SessionManager.inMemory(target.projectPath, undefined, entries)
  cached = { stamp: target.fileStamp, session }
  return session
}
