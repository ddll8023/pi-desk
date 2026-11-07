/**
 * 子任务取消登记：把页面发起的定向取消送到具体委派任务。
 *
 * 委派扩展运行在 SDK 宿主内、以工具调用为边界；页面只能发出任务标识，
 * 不能指定进程或任意路径。登记表由宿主会话持有，随绑定换代清空。
 */

/** 宿主向委派扩展注入的控制端：每次工具调用登记自身的取消入口。 */
export interface SubAgentControl {
  /**
   * 登记一组任务标识与对应取消入口，返回注销函数。
   * 注销必须在工具结束或取消完成后调用，避免后续请求命中已结束的任务。
   */
  track(taskIds: readonly string[], cancel: (taskIds: readonly string[]) => void): () => void
}

/** 纯内存实现：只保留当前绑定内仍在途的任务。 */
export class SubAgentControlRegistry implements SubAgentControl {
  private readonly entries = new Map<string, (taskIds: readonly string[]) => void>()

  track(taskIds: readonly string[], cancel: (taskIds: readonly string[]) => void): () => void {
    for (const taskId of taskIds) this.entries.set(taskId, cancel)
    return () => {
      for (const taskId of taskIds) {
        // 只删除仍指向本次登记入口的键：任务可能已被后续调用复用同名标识。
        if (this.entries.get(taskId) === cancel) this.entries.delete(taskId)
      }
    }
  }

  /** 按任务标识转发取消；未知标识直接忽略，不报错也不影响其他任务。 */
  cancel(taskIds: readonly string[]): void {
    const handlers = new Set<(taskIds: readonly string[]) => void>()
    const matched: string[] = []
    for (const taskId of taskIds) {
      const handler = this.entries.get(taskId)
      if (handler === undefined) continue
      handlers.add(handler)
      matched.push(taskId)
    }
    for (const handler of handlers) {
      handler(matched.filter(taskId => this.entries.get(taskId) === handler))
    }
  }

  /** 绑定失效或会话关闭时清空：不再接受旧任务的取消请求。 */
  clear(): void {
    this.entries.clear()
  }
}
