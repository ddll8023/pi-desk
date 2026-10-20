/**
 * 守护进程侧的终端模拟器：用 headless xterm 复刻每个终端的画面与滚动历史，并在接回时序列化成快照。
 *
 * 为什么需要它：应用退出期间 PTY 仍在输出，重新打开时要还原「退出期间的输出 + 之前的滚动历史」。
 * 只保存原始输出也能回放，但长历史回放慢、且无法表达当前画面；headless 模拟器让快照等于当前状态，
 * 体积远小于原始字节流。序列化由官方 addon 完成，包含滚动缓冲与模式恢复序列（备用屏、光标、SGR 等）。
 *
 * 写入是异步的：xterm 把写入排队解析，因此这里把所有写入与改尺寸串成一条链，序列化前先等链排空，
 * 否则快照会丢掉最后一段输出。链上任何一步失败都不影响后续写入，只记一次日志。
 *
 * 边界：这里只维护画面状态，不碰 PTY、不碰文件、不判断终端是否退出；行数与回滚量由会话管理给出。
 */
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'

export class HeadlessEmulator {
  private readonly term: Terminal
  private readonly serializer: SerializeAddon
  /** 写入与改尺寸的串行链；序列化前等它排空。 */
  private pending: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(
    cols: number,
    rows: number,
    private readonly scrollbackLines: number,
    private readonly onError: (error: unknown) => void
  ) {
    this.term = new Terminal({
      cols,
      rows,
      scrollback: scrollbackLines,
      // 序列化插件用到的部分接口仍在 proposed 阶段；headless 终端没有 UI，放开它没有副作用。
      allowProposedApi: true
    })
    this.serializer = new SerializeAddon()
    this.term.loadAddon(this.serializer)
  }

  /** 写入一段输出；顺序由链保证，不等待完成。 */
  write(chunk: string): void {
    if (this.disposed || chunk === '') return
    this.pending = this.pending.then(() => new Promise<void>((resolve) => {
      if (this.disposed) {
        resolve()
        return
      }
      try {
        this.term.write(chunk, () => resolve())
      } catch (error) {
        this.onError(error)
        resolve()
      }
    }))
  }

  /** 同步尺寸；与写入同链，避免在解析中途改尺寸导致换行错位。 */
  resize(cols: number, rows: number): void {
    if (this.disposed) return
    this.pending = this.pending.then(() => {
      if (this.disposed) return
      try {
        this.term.resize(cols, rows)
      } catch (error) {
        this.onError(error)
      }
    })
  }

  /** 等链排空并序列化当前画面；`scrollback` 给出要带上的历史行数。 */
  async serialize(): Promise<string> {
    if (this.disposed) return ''
    await this.pending
    try {
      return this.serializer.serialize({ scrollback: this.scrollbackLines })
    } catch (error) {
      this.onError(error)
      return ''
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try {
      this.term.dispose()
    } catch (error) {
      this.onError(error)
    }
  }
}
