/**
 * 会话运行注册表：应用级运行身份与绑定代际的唯一分配者，以及会话占用与运行实例归属的唯一登记处。
 *
 * 边界：只登记身份与归属，不持有宿主进程、不做授权判定、不编排会话生命周期；宿主监督在
 * sdk-host-manager，页面契约映射在 sdk-runtime-bridge。运行身份与绑定代际只在进程内有效，
 * 不持久化，也不能当作 Pi 的持久化会话身份使用。
 *
 * 会话占用的键是「归属项目 + 会话 id」：打开或新建之前先登记占位，绑定成功后收敛为运行中，
 * 退出或关闭结果未确认时保留占用，避免同一持久化会话被重复接管。宿主可跨项目复用，因此归属
 * 挂在占用上而不是运行实例上。
 */

/** 运行实例的生命周期阶段；`unconfirmed` 表示退出或关闭结果未确认，占用必须保留。 */
export type SessionRunPhase = 'idle' | 'opening' | 'running' | 'closing' | 'unconfirmed'

/** 运行实例的只读摘要：不含宿主对象，供按项目或全应用范围查询使用。 */
export interface SessionRunSummary {
  readonly runId: number
  readonly projectPath: string | null
  readonly sessionId: string | null
  readonly phase: SessionRunPhase
  readonly bindingGeneration: number | null
}

/** 只读查询端口；项目与应用范围的收敛判断只用登记结果，不用单份 Runtime 状态代替。 */
export interface SessionRunQuery {
  runsOfProject(projectPath: string): readonly SessionRunSummary[]
  allRuns(): readonly SessionRunSummary[]
}

/** 宿主监督需要的最小端口：归属项目查询与绑定代际分配。 */
export interface SdkHostRunRegistry {
  /** 该运行实例当前承载的归属项目；未承载会话时为 null。 */
  projectOfRun(runId: number): string | null
  /** 分配并登记应用级绑定代际；宿主不能自行编号。 */
  allocateGeneration(runId: number): number
  /** 记录宿主实际报告的绑定代际；未绑定时为 null。 */
  recordBinding(runId: number, generation: number | null): void
  /** 退出或关闭结果未确认：保留占用，未确认前不建立替代实例。 */
  markUnconfirmed(runId: number): void
}

/** 会话或项目已被占用：调用方据此拒绝重复接管，不排队也不重放。 */
export class SessionRunConflict extends Error {}

/** 运行实例登记；调用方只读，状态变更只经注册表方法（因此字段本身可写）。 */
export interface SessionRunRecord<T> {
  readonly runId: number
  readonly owner: T
  projectPath: string | null
  sessionId: string | null
  phase: SessionRunPhase
  bindingGeneration: number | null
  /** 打开或新建前的上一份占用；仅用于打开失败时回退。 */
  previous: { readonly projectPath: string | null; readonly sessionId: string | null; readonly phase: SessionRunPhase } | null
}

/** 路径比较折叠 Windows 大小写；其他平台保持严格比较。 */
function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export class SessionRunRegistry<T> implements SessionRunQuery, SdkHostRunRegistry {
  /** 运行身份与绑定代际各自独立递增；同一个值不会被两处复用。 */
  private runSeed = 0
  private generationSeed = 0
  private readonly records = new Map<number, SessionRunRecord<T>>()
  private foregroundRunId: number | null = null

  /** 分配应用级运行身份；只在建立运行实例时调用。 */
  allocateRunId(): number {
    return ++this.runSeed
  }

  /** 登记运行实例；身份已登记时视为调用错误。 */
  registerRun(runId: number, owner: T): SessionRunRecord<T> {
    if (this.records.has(runId)) throw new Error('运行身份已登记，不能重复登记。')
    const record: SessionRunRecord<T> = {
      runId, owner, projectPath: null, sessionId: null, phase: 'idle',
      bindingGeneration: null, previous: null
    }
    this.records.set(runId, record)
    return record
  }

  /** 打开前为来源项目登记占位；同一会话已由其他运行实例接管时拒绝。 */
  beginOpen(runId: number, projectPath: string, sessionId: string | null): void {
    const record = this.requireRun(runId)
    if (record.phase === 'opening' || record.phase === 'closing') {
      throw new SessionRunConflict('该运行实例已有未收敛的生命周期操作。')
    }
    // 会话在登记时就绑定所属项目：运行实例承载其他项目的活动会话时不允许静默改绑。
    if (record.projectPath !== null && record.phase === 'running' && !samePath(record.projectPath, projectPath)) {
      throw new SessionRunConflict('该运行实例正在承载其他项目的会话，请先释放后再打开新项目。')
    }
    if (sessionId !== null) {
      for (const other of this.records.values()) {
        if (other.runId === runId || other.sessionId !== sessionId || other.projectPath === null) continue
        if (samePath(other.projectPath, projectPath)) throw new SessionRunConflict('该会话已由另一个运行实例接管。')
      }
    }
    record.previous = { projectPath: record.projectPath, sessionId: record.sessionId, phase: record.phase }
    record.projectPath = projectPath
    record.sessionId = sessionId
    record.phase = 'opening'
  }

  /** 打开成功：占用收敛为运行中的实际会话身份。 */
  settleOpen(runId: number, sessionId: string | null): void {
    const record = this.requireRun(runId)
    record.sessionId = sessionId
    record.phase = 'running'
    record.previous = null
  }

  /** 打开失败：回退到上一份占用，不留半开的占位。 */
  failOpen(runId: number): void {
    const record = this.requireRun(runId)
    const previous = record.previous
    record.previous = null
    record.projectPath = previous?.projectPath ?? null
    record.sessionId = previous?.sessionId ?? null
    record.phase = previous?.phase ?? 'idle'
    if (record.phase === 'opening') record.phase = 'idle'
  }

  /** 关闭或释放前标记：期间不再接受新的打开登记。 */
  beginClose(runId: number): void {
    const record = this.requireRun(runId)
    if (record.phase !== 'idle') record.phase = 'closing'
  }

  /** 释放占用：宿主仍在，只是不再承载会话。 */
  release(runId: number): void {
    const record = this.requireRun(runId)
    record.projectPath = null
    record.sessionId = null
    record.phase = 'idle'
    record.bindingGeneration = null
    record.previous = null
  }

  /** 退出或关闭结果未确认：保留占用，未确认前不建立替代实例。 */
  markUnconfirmed(runId: number): void {
    const record = this.records.get(runId)
    if (record === undefined || record.phase === 'idle') return
    record.phase = 'unconfirmed'
  }

  /** 分配并登记应用级绑定代际；每次实际重绑前调用一次。 */
  allocateGeneration(runId: number): number {
    const record = this.requireRun(runId)
    const generation = ++this.generationSeed
    record.bindingGeneration = generation
    return generation
  }

  /** 记录宿主实际报告的绑定代际。 */
  recordBinding(runId: number, generation: number | null): void {
    const record = this.records.get(runId)
    if (record !== undefined) record.bindingGeneration = generation
  }

  /** 该运行实例当前承载的归属项目。 */
  projectOfRun(runId: number): string | null {
    return this.records.get(runId)?.projectPath ?? null
  }

  /** 前台选择：页面当前寻址的运行实例；与占用不同，仅用于展示归属。 */
  foreground(): SessionRunRecord<T> | null {
    const runId = this.foregroundRunId
    if (runId === null) return null
    return this.records.get(runId) ?? null
  }

  /** 设置前台运行实例。 */
  setForeground(runId: number): void {
    this.requireRun(runId)
    this.foregroundRunId = runId
  }

  /** 清除前台选择；运行实例本身不被销毁。 */
  clearForeground(): void {
    this.foregroundRunId = null
  }

  /** 该会话是否已由某个运行实例占用（不含未命名会话）；命中时返回登记记录。 */
  runOfSession(projectPath: string, sessionId: string): SessionRunRecord<T> | null {
    for (const record of this.records.values()) {
      if (record.sessionId !== sessionId || record.projectPath === null) continue
      if (samePath(record.projectPath, projectPath)) return record
    }
    return null
  }

  /** 该项目是否仍有登记在册的运行实例（含打开中、运行中与未确认）。 */
  isProjectActive(projectPath: string): boolean {
    return this.runsOfProject(projectPath).length > 0
  }

  /** 该项目范围内的运行实例。 */
  runsOfProject(projectPath: string): readonly SessionRunRecord<T>[] {
    const found: SessionRunRecord<T>[] = []
    for (const record of this.records.values()) {
      if (record.projectPath === null || record.phase === 'idle') continue
      if (samePath(record.projectPath, projectPath)) found.push(record)
    }
    return found
  }

  /** 全应用范围的运行实例；退出编排按它逐个关闭。 */
  allRuns(): readonly SessionRunRecord<T>[] {
    return [...this.records.values()]
  }

  private requireRun(runId: number): SessionRunRecord<T> {
    const record = this.records.get(runId)
    if (record === undefined) throw new Error('运行身份未登记。')
    return record
  }
}
