/**
 * 会话日志读取：把主进程已授权的会话文件按查询解析成历史页、轮次页或原文续段。
 *
 * 边界：只读、只按查询换算一段历史，不缓存权威状态。不建立 AgentSession，也不加载技能、扩展与 MCP，
 * 所以未绑定的会话也能翻页查看；产出的内容只是展示副本，不能据此发送、回退或改写任何东西。
 * 解析结果按「项目 + 会话 + 规范文件路径 + 文件戳」有界复用；同版本并发读取共用一次解析。
 * 使用中的记录暂不淘汰，最后一次读取结束后按最近使用顺序裁剪空闲缓存；不保留原始日志文本。
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

/** 空闲缓存的资源守卫值，不代表实测最优值；源文件体积也不等于解析对象的堆内存。 */
const LOG_CACHE_CAPACITY = 8
const LOG_CACHE_SOURCE_BYTES = 64 * 1024 * 1024

interface CachedLog {
  readonly pending: Promise<LogSession>
  readonly sourceBytes: number
  readers: number
}

/** 在途与已解析记录共用一张表；读取租约保留对象，裁剪只移除空闲记录。 */
const cachedLogs = new Map<string, CachedLog>()

/** 路径已经过主进程规范化与授权；分隔符不能出现在真实路径中，文件版本不靠解析时间猜测。 */
function logKey(target: SdkLogTarget): string {
  return `${target.projectPath}\u0000${target.sessionId}\u0000${target.sessionFile}\u0000${target.fileStamp}`
}

/**
 * 读取一段日志历史。`runtimeId` 传 0：日志读取不属于任何绑定代际，
 * 返回的消息身份仍是官方条目身份（`history:<entryId>`），与绑定后的权威投影一致。
 * 最新一页同时写入检查点；翻更早的分页不写入，绑定时需要的是最新一页。
 */
export async function readSessionLog(
  sdk: SdkModule, target: SdkLogTarget, checkpoints: ProjectionCheckpoints
): Promise<HistoryData> {
  const key = logKey(target)
  let record: CachedLog | undefined
  try {
    const before = await stat(target.sessionFile, { bigint: true })
    if (!before.isFile() || stampOf(before) !== target.fileStamp) {
      throw new SdkSessionFailure('INVALID_SESSION_TARGET')
    }
    record = cachedLogs.get(key)
    if (record === undefined) {
      record = { pending: parseLog(sdk, target), sourceBytes: Number(before.size), readers: 0 }
      // 在等待解析前登记：同一版本的后续请求直接取得相同 Promise。
      cachedLogs.set(key, record)
    }
    record.readers += 1
    const session = await record.pending
    const branch = session.getBranch()
    let data: HistoryData
    try {
      data = readBranchHistory(branch, target.query, 0)
    } catch {
      // 游标或续段位置已不属于当前分支：按目标失效报告，不返回半份历史。
      throw new SdkSessionFailure('INVALID_SESSION_TARGET')
    }
    if (stampOf(await stat(target.sessionFile, { bigint: true })) !== target.fileStamp) {
      throw new SdkSessionFailure('INVALID_SESSION_TARGET')
    }
    if (data.kind === 'page' && target.query.kind === 'page' && target.query.before === null) {
      checkpoints.remember(target.sessionId, {
        fileStamp: target.fileStamp, tailEntryId: branch.at(-1)?.id ?? null, page: data
      })
    }
    return data
  } catch (error) {
    // 只移除本次版本及本次持有的记录；旧请求失败不能删掉另一请求刚建立的记录。
    if (record === undefined || cachedLogs.get(key) === record) cachedLogs.delete(key)
    checkpoints.forget(target.sessionId, target.fileStamp)
    throw error
  } finally {
    if (record !== undefined) {
      record.readers -= 1
      if (cachedLogs.get(key) === record) {
        cachedLogs.delete(key)
        // 超大日志可以供在途请求共用，但最后一次读取结束后不保留。
        if (record.readers > 0 || record.sourceBytes <= LOG_CACHE_SOURCE_BYTES) cachedLogs.set(key, record)
      }
      trimLogs()
    }
  }
}

/** 按最后一次读取完成的顺序裁剪空闲缓存；在途记录不占空闲预算，也不被移除。 */
function trimLogs(): void {
  let idleCount = 0
  let idleBytes = 0
  for (const record of cachedLogs.values()) {
    if (record.readers > 0) continue
    idleCount += 1
    idleBytes += record.sourceBytes
  }
  for (const [key, record] of cachedLogs) {
    if (idleCount <= LOG_CACHE_CAPACITY && idleBytes <= LOG_CACHE_SOURCE_BYTES) break
    if (record.readers > 0) continue
    cachedLogs.delete(key)
    idleCount -= 1
    idleBytes -= record.sourceBytes
  }
}

/** 只解析并建立官方内存会话，不把日志文本或任何可写会话保存在缓存里。 */
async function parseLog(sdk: SdkModule, target: SdkLogTarget): Promise<LogSession> {
  const entries = sdk.parseSessionEntries(await readFile(target.sessionFile, 'utf8'))
  const header = entries.find(entry => entry.type === 'session')
  if (header?.type !== 'session' || header.id !== target.sessionId) {
    throw new SdkSessionFailure('INVALID_SESSION_TARGET')
  }
  return sdk.SessionManager.inMemory(target.projectPath, undefined, entries)
}
