/**
 * 子进程树的终止：POSIX 向独立进程组发信号，Windows 用系统 taskkill 定向终止。
 *
 * 只终止给定的那一个进程及其子进程，不按进程名清理同名的其他实例；只负责让进程树收敛，
 * 不判定成败、不记录状态，也不等待退出：何时调用、等多久、失败怎么处理都由调用方决定。
 * 受管一次性入口、MCP 探测与资源预读共用这一份实现。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'

export function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    try {
      const killer = spawn(taskkill, ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true
      })
      // 失败的 spawn 会异步 emit error，必须消费以避免拖垮主进程。
      killer.once('error', () => {})
      killer.unref()
    } catch {
      // taskkill 无法执行时回退到单进程终止。
    }
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // 进程已退出时不产生未处理异常。
    }
  }
}
