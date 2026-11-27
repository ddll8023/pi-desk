/**
 * 宿主进程内的装配耗时记录：写入主进程派生的同一个日志文件，便于与主进程时间线对照。
 *
 * 边界：只追加一行可读的分段毫秒数，不记录会话内容、路径或环境；没有日志路径（终端 CLI 直接运行时）
 * 或日志不可写时静默跳过，不改变会话行为，也不因为记时失败而失败。
 */
import { appendFileSync } from 'node:fs'

export const HOST_TIMING_LOG_ENV = 'PI_DESK_HOST_LOG'

/** 累计器：各段在装配过程中分别记时，最后一次性写成一行，避免多次写盘。 */
export type TimingSegments = Record<string, number>

/**
 * 记一行分段耗时：`stage` 是同一次装配的阶段名，段名与毫秒数按声明顺序排列。
 * 只在宿主内使用；主进程侧写日志走自己的 `appendHostLog`。
 */
export function logHostTiming(stage: string, segments: TimingSegments): void {
  const path = process.env[HOST_TIMING_LOG_ENV]
  if (path === undefined || path === '') return
  const parts = Object.entries(segments).map(([name, ms]) => `${name}=${Math.round(ms)}`).join(' ')
  try {
    appendFileSync(path, `${new Date().toISOString()} [timing] source=host stage=${stage} ${parts}\n`, 'utf8')
  } catch { /* 日志不可写不改变会话行为。 */ }
}
