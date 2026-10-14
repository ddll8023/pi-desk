/**
 * 配置文件写入互斥：以原子创建 `<文件>.lock` 目录作为锁。
 *
 * 锁路径与原子原语（`mkdir`）都与官方 SDK 使用的 `proper-lockfile` 一致，因此桌面写入与 SDK
 * 自己加锁的配置写入（`auth.json`、`trust.json`、MCP OAuth 的每服务器锁）互斥。
 *
 * 边界：SDK 里未加锁的配置（`settings.json`、`models.json`、`mcp.json`）不受本锁保护，那几处
 * 仍只能靠文件标识比对发现外部改动，本模块不假装提供跨进程强互斥。锁只覆盖一次读-改-写、
 * 持有时间在毫秒级，因此不做心跳续期；只用锁目录的 mtime 判断陈旧锁并清理，避免异常退出
 * 留下永久锁。锁是尽力而为的协作机制，不是安全边界。
 */
import { mkdir, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 获取锁的重试间隔；只在真的被占用时才等待。 */
const RETRY_INTERVAL_MS = 25
/** 获取锁的等待上限；超时按可展示错误抛出，调用方不排队也不重放写入。 */
const ACQUIRE_TIMEOUT_MS = 5_000
/** 陈旧锁判定：超过这个时长的锁目录视为持有者已异常退出，可以清理。 */
const STALE_LOCK_MS = 10_000

/** 获取锁超时：调用方据此给出可重试的错误，而不是无界等待。 */
export class FileLockError extends Error {}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  return (error as NodeJS.ErrnoException).code
}

/** 锁目录的 mtime 超过陈旧阈值即为陈旧锁；已不存在时也按可重试处理。 */
async function isStale(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath)
    return Date.now() - info.mtimeMs > STALE_LOCK_MS
  } catch {
    return true
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

/**
 * 在锁内执行一次读-改-写。回调抛出的异常原样传播，锁一定会释放。
 * 目标文件的父目录在取锁前创建：锁目录必须与目标文件同目录，否则不同写入者会锁到不同位置。
 */
export async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${file}.lock`
  await mkdir(dirname(file), { recursive: true })

  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS
  for (;;) {
    try {
      await mkdir(lockPath)
      break
    } catch (error) {
      // 只有「已被占用」才重试；其他失败（权限、路径非法）直接抛出，不掩盖真实原因。
      if (errorCode(error) !== 'EEXIST') throw error
      if (await isStale(lockPath)) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
        continue
      }
      if (Date.now() >= deadline) {
        throw new FileLockError(`等待 ${file} 的写入锁超时；请稍后重试。`)
      }
      await delay(RETRY_INTERVAL_MS)
    }
  }

  try {
    return await fn()
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
  }
}
