/**
 * 只构建终端守护进程入口：输出独立 CJS 产物 `out/terminal-daemon/index.cjs`。
 *
 * 它必须能脱离 Electron 主进程运行（用 Electron 自带的 Node 以 `ELECTRON_RUN_AS_NODE` 启动），
 * 因此单独构建一次，产物路径与主进程相邻，应用按固定相对子路径拉起。
 *
 * node-pty 是原生模块，@xterm/headless 与序列化插件只供守护进程使用：三者都保持外部引用，
 * 运行时从应用目录的 node_modules 解析，不并入产物。
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: resolve('out/terminal-daemon'),
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    target: 'node22',
    lib: {
      entry: resolve('src/terminal-daemon/index.ts'),
      formats: ['cjs']
    },
    rollupOptions: {
      external: ['node-pty', '@xterm/headless', '@xterm/addon-serialize', /^node:/],
      output: {
        format: 'cjs',
        entryFileNames: 'index.cjs'
      }
    }
  }
})
