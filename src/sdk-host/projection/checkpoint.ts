/**
 * 会话投影检查点：把一次日志解析得到的首页交给随后的绑定复用，避免同一会话被投影两次。
 *
 * 边界：检查点是派生缓存，真相始终是 Pi 写出的 JSONL。只有「文件戳 + 分支尾条目」都一致才允许复用，
 * 任一不一致都当作没有检查点，由绑定按当前分支重建；缓存只在本宿主进程内有效，不落盘、不跨进程传递。
 * 首页的消息身份由官方条目给出（`history:<entryId>`），与绑定代际无关，因此可以跨绑定复用。
 */
import { stat } from 'node:fs/promises'
import type { HistoryPage } from '../../shared/runtime-api'

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

export class ProjectionCheckpoints {
  /** 按会话 id 保存；写入即移到队尾，超容量时丢弃最久未用的。 */
  private readonly entries = new Map<string, SessionCheckpoint>()

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

  forget(sessionId: string): void {
    this.entries.delete(sessionId)
  }
}
