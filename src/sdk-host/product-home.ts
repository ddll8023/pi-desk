/**
 * 把 SDK 宿主内的 `os.homedir()` 指向产品自有的 home 目录。
 *
 * 背景：产品已经用 `PI_CODING_AGENT_DIR` 把会话、凭据与设置固定在应用数据目录，但部分第三方扩展
 * 直接读 `os.homedir()`（例如 `@ayulab/pi-rewind` 的检查点存储在 `~/.pi/agent/ayu`），会在用户
 * 主目录生成 `~/.pi`，与「产品已和 pi CLI 分离」的隔离边界冲突；用户清理该目录还会让运行中的会话
 * 每次落检查点都失败。主进程把目标目录经 `PI_DESK_PRODUCT_HOME` 交给本进程，这里只做改写。
 *
 * 边界：只改写内置模块的 CJS 导出对象（即 `import os from 'node:os'` 拿到的那个对象）上的 `homedir`，
 * 不调用 `syncBuiltinESMExports()`。因此 `import { homedir } from 'node:os'` 的调用方（官方 SDK、
 * pi-web-access、pi-mcp-extension）以及依赖 `process.env.USERPROFILE` 的能力（浏览器 cookie 导入）
 * 仍拿到真实用户主目录；未收到可用路径时完全不改写，保持宿主原本行为。
 *
 * 退出条件：上游扩展改为遵循 `PI_CODING_AGENT_DIR` 后，删除本文件与入口处的 import。
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'

const target = process.env.PI_DESK_PRODUCT_HOME

if (target !== undefined && isAbsolute(target)) {
  const productHome = target
  // 内置模块的 CJS 导出与 ESM default 是同一对象，改它才能影响 `import os from 'node:os'` 的扩展。
  const osModule: typeof import('node:os') = createRequire(import.meta.url)('node:os')
  let prepared = false
  Object.defineProperty(osModule, 'homedir', {
    value: (): string => {
      if (!prepared) {
        prepared = true
        // 建目录失败不在这里抛出：保留路径让调用方的后续读写给出真实错误，而不是让 homedir() 本身失败。
        try {
          mkdirSync(productHome, { recursive: true })
        } catch {
          /* 目录不可写由调用方的实际 IO 暴露 */
        }
      }
      return productHome
    },
    writable: true,
    configurable: true
  })
}
