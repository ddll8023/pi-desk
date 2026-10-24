/**
 * 会话投影检查点：首页与稳定活动分别缓存，互不覆盖，也不共享失效规则。
 *
 * 边界：真相始终是 Pi 写出的 JSONL。首页匹配文件戳与分支尾；活动匹配项目、会话与规范文件身份，
 * 并由消费方在受文件戳保护的预检中复核已处理前缀及投影版本，绑定时再核对实际 SDK 分支。
 * 缓存只在本宿主进程内有效，不落盘、不跨进程传递。活动只保存轻量稳定事实，不保存实时执行状态。
 * 首页身份来自官方条目（`history:<entryId>`）；活动前缀摘要也不使用绑定代际作为恢复证据。
 */
import { stat } from 'node:fs/promises'
import type { HistoryPage } from '../../shared/runtime-api'
import { ACTIVITY_STATE_VERSION } from './activity-projection'
import type { ActivityCheckpointState } from './activity-projection'

export interface ActivityCheckpointIdentity {
  readonly projectPath: string
  readonly sessionId: string
  readonly sessionFile: string
}

/** 路径已由主进程规范化与授权；会话 id 相同也不能跨项目、跨文件复用活动。 */
function activityKey(identity: ActivityCheckpointIdentity): string {
  return `${identity.projectPath}\u0000${identity.sessionId}\u0000${identity.sessionFile}`
}

export interface SessionCheckpoint {
  /** 生成这一页时的文件戳；文件被追加或改写后即失效。 */
  readonly fileStamp: string
  /** 生成这一页时的分支尾条目；尾部变化说明历史已变，首页可能不再是最新一页。 */
  readonly tailEntryId: string | null
  readonly page: HistoryPage
}

/** 参与文件戳的字段：只有这几项一起相同，才能说明「还是同一份文件、且读的时候没被改写」。 */
export interface FileStampInfo {
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
}

export function stampOf(info: FileStampInfo): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}

/** 与主进程授权的文件戳同构；读不到文件时由调用方按「没有检查点」处理。 */
export async function fileStampOf(filePath: string): Promise<string> {
  return stampOf(await stat(filePath, { bigint: true }))
}

/** 只保留少量会话的检查点：多项目、多会话连续查看时不会无限占用内存。 */
const CAPACITY = 8
/** 活动状态的序列化体积守卫，不代表实际堆内存上限；超大记录只参与本次计算，不保留。 */
const ACTIVITY_CHECKPOINT_BYTES = 8 * 1024 * 1024

export class ProjectionCheckpoints {
  /** 按会话 id 保存；写入即移到队尾，超容量时丢弃最久未用的。 */
  private readonly entries = new Map<string, SessionCheckpoint>()
  private readonly activities = new Map<string, { readonly state: ActivityCheckpointState; readonly bytes: number }>()
  private activityBytes = 0

  remember(sessionId: string, checkpoint: SessionCheckpoint): void {
    this.entries.delete(sessionId)
    this.entries.set(sessionId, checkpoint)
    while (this.entries.size > CAPACITY) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  /** 命中条件是两个身份都一致；命中后刷新使用顺序，未命中一律由调用方重建。 */
  take(sessionId: string, fileStamp: string, tailEntryId: string | null): HistoryPage | null {
    const saved = this.entries.get(sessionId)
    if (saved === undefined || saved.fileStamp !== fileStamp || saved.tailEntryId !== tailEntryId) return null
    this.entries.delete(sessionId)
    this.entries.set(sessionId, saved)
    return saved.page
  }

  /** 只失效请求所见的文件版本；日志分页失败不连带清理独立的活动状态。 */
  forget(sessionId: string, fileStamp: string): void {
    if (this.entries.get(sessionId)?.fileStamp === fileStamp) this.entries.delete(sessionId)
  }

  /** 候选不是权威基准；调用方仍须核对文件版本和完整前缀。 */
  activityOf(identity: ActivityCheckpointIdentity): ActivityCheckpointState | null {
    const key = activityKey(identity)
    const saved = this.activities.get(key)
    if (saved === undefined) return null
    if (saved.state.version !== ACTIVITY_STATE_VERSION) {
      this.forgetActivity(identity, saved.state)
      return null
    }
    this.activities.delete(key)
    this.activities.set(key, saved)
    return saved.state
  }

  /** 只接收累计器导出的独立稳定快照；序列化失败或超出预算时放弃缓存，不影响会话。 */
  rememberActivity(identity: ActivityCheckpointIdentity, state: ActivityCheckpointState): void {
    this.forgetActivity(identity)
    if (state.version !== ACTIVITY_STATE_VERSION) return
    let bytes: number
    try {
      bytes = Buffer.byteLength(JSON.stringify(state), 'utf8')
    } catch {
      return
    }
    if (bytes > ACTIVITY_CHECKPOINT_BYTES) return
    this.activities.set(activityKey(identity), { state, bytes })
    this.activityBytes += bytes
    while (this.activities.size > CAPACITY || this.activityBytes > ACTIVITY_CHECKPOINT_BYTES) {
      const oldest = this.activities.keys().next().value
      if (oldest === undefined) break
      const saved = this.activities.get(oldest)
      this.activities.delete(oldest)
      if (saved !== undefined) this.activityBytes -= saved.bytes
    }
  }

  /** 迟到的预检只能删除它实际取得的候选，不能清掉另一轮刚更新的状态。 */
  forgetActivity(identity: ActivityCheckpointIdentity, expected?: ActivityCheckpointState): void {
    const key = activityKey(identity)
    const saved = this.activities.get(key)
    if (saved === undefined || (expected !== undefined && saved.state !== expected)) return
    this.activities.delete(key)
    this.activityBytes -= saved.bytes
  }
}
