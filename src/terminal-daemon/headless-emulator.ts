/** 守护进程画面解析器：批量消费输出、计量解析积压，并由唯一模拟器回答终端协议查询与上报标题。 */
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'
import { TERMINAL_SNAPSHOT_MAX_CHARS } from '../shared/terminal-daemon-protocol'

type Operation = { readonly kind: 'data'; readonly chunk: string }
  | { readonly kind: 'resize'; readonly cols: number; readonly rows: number }
const PARSE_BATCH_CHARS = 64 * 1024

export class HeadlessEmulator {
  private readonly term: Terminal
  private readonly serializer = new SerializeAddon()
  private readonly stopTitle: { dispose(): void }
  private operations: Operation[] = []
  private queuedChars = 0
  private busy = false
  private timer: NodeJS.Timeout | null = null
  private disposed = false
  private waiters: (() => void)[] = []

  constructor(
    cols: number,
    rows: number,
    private readonly scrollbackLines: number,
    private readonly onError: (error: unknown) => void,
    private readonly onConsumed: () => void = () => {},
    onReply: (data: string) => void = () => {},
    /** 程序通过 OSC 设置的标题；守护进程侧据此持久化，应用重启后标签标题不回退。 */
    onTitle: (title: string) => void = () => {}
  ) {
    this.term = new Terminal({ cols, rows, scrollback: scrollbackLines, allowProposedApi: true })
    this.term.loadAddon(this.serializer)
    this.term.onData(onReply)
    this.stopTitle = this.term.onTitleChange(onTitle)
    this.term.parser.registerCsiHandler({ final: 't' }, (params) => {
      if (params[0] !== 18) return false
      onReply(`\u001b[8;${this.term.rows};${this.term.cols}t`)
      return true
    })
    // headless 没有浏览器颜色服务，显式回答颜色查询，避免后台程序等不到回复。
    for (const code of [4, 10, 11, 12]) {
      this.term.parser.registerOscHandler(code, (data) => {
        if (!data.includes('?')) return false
        if (code === 4) {
          const values = data.split(';')
          for (let index = 0; index + 1 < values.length; index += 2) {
            const color = Number(values[index])
            if (values[index + 1] === '?' && Number.isInteger(color) && color >= 0 && color <= 255) {
              onReply(`\u001b]4;${color};${indexedColor(color)}\u001b\\`)
            }
          }
        } else {
          onReply(`\u001b]${code};${code === 11 ? 'rgb:0000/0000/0000' : 'rgb:ffff/ffff/ffff'}\u001b\\`)
        }
        return true
      })
    }
  }

  get pendingChars(): number { return this.queuedChars }

  write(chunk: string): void {
    if (this.disposed || chunk === '') return
    for (let offset = 0; offset < chunk.length; offset += PARSE_BATCH_CHARS) {
      this.operations.push({ kind: 'data', chunk: chunk.slice(offset, offset + PARSE_BATCH_CHARS) })
    }
    this.queuedChars += chunk.length
    this.schedule()
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return
    const last = this.operations[this.operations.length - 1]
    if (last?.kind === 'resize') this.operations.pop()
    this.operations.push({ kind: 'resize', cols, rows })
    this.schedule()
  }

  private schedule(): void {
    if (this.busy || this.timer !== null || this.disposed) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.pump()
    }, 0)
  }

  /** 一个批次只创建一个写入回调，不给每个 PTY 块再包一层 Promise。 */
  private pump(): void {
    if (this.disposed || this.busy) return
    const first = this.operations[0]
    if (first === undefined) { this.settleIdle(); return }
    if (first.kind === 'resize') {
      this.operations.shift()
      try { this.term.resize(first.cols, first.rows) } catch (error) { this.onError(error) }
      this.schedule()
      return
    }
    const chunks: string[] = []
    let chars = 0
    let count = 0
    for (const operation of this.operations) {
      if (operation.kind !== 'data' || (chars > 0 && chars + operation.chunk.length > PARSE_BATCH_CHARS)) break
      chunks.push(operation.chunk)
      chars += operation.chunk.length
      count += 1
    }
    this.operations.splice(0, count)
    this.busy = true
    const consumed = (): void => {
      this.queuedChars = Math.max(0, this.queuedChars - chars)
      this.busy = false
      this.onConsumed()
      // 回调执行时 xterm 尚未移除当前块；让它先完成内部收尾，再提交下一批。
      if (this.operations.length > 0) this.schedule()
      else this.settleIdle()
    }
    try { this.term.write(chunks.join(''), consumed) } catch (error) { this.onError(error); consumed() }
  }

  async serialize(): Promise<string> {
    if (this.disposed) return ''
    if (this.busy || this.operations.length > 0) {
      await new Promise<void>((resolve) => { this.waiters.push(resolve); this.schedule() })
    }
    if (this.disposed) return ''
    // 超长快照减少回滚部分，不截断 ANSI 字节流；活动屏仍过大时明确拒绝恢复。
    let scrollback = this.scrollbackLines
    while (true) {
      const ansi = this.serializer.serialize({ scrollback })
      if (ansi.length <= TERMINAL_SNAPSHOT_MAX_CHARS) return ansi
      if (scrollback === 0) throw new Error('终端画面超过恢复容量，请缩小终端尺寸后重试。')
      scrollback = Math.floor(scrollback / 2)
    }
  }

  private settleIdle(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.operations = []
    this.queuedChars = 0
    this.settleIdle()
    this.stopTitle.dispose()
    try { this.term.dispose() } catch (error) { this.onError(error) }
  }
}

/** 没有显示服务时采用终端标准调色板，不把页面是否挂载作为查询能否完成的条件。 */
function indexedColor(index: number): string {
  const ansi = ['000000', 'cd0000', '00cd00', 'cdcd00', '0000ee', 'cd00cd', '00cdcd', 'e5e5e5',
    '7f7f7f', 'ff0000', '00ff00', 'ffff00', '5c5cff', 'ff00ff', '00ffff', 'ffffff']
  let values: number[]
  if (index < 16) {
    const hex = ansi[index] ?? '000000'
    values = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
  } else if (index < 232) {
    const color = index - 16
    const level = (value: number): number => value === 0 ? 0 : 55 + value * 40
    values = [level(Math.floor(color / 36)), level(Math.floor(color / 6) % 6), level(color % 6)]
  } else {
    values = Array<number>(3).fill(8 + (index - 232) * 10)
  }
  return `rgb:${values.map((value) => (value * 257).toString(16).padStart(4, '0')).join('/')}`
}
