/**
 * 只构建认证辅助进程入口：输出独立 ESM 产物 `out/auth-helper/index.mjs`。
 *
 * 认证能力来自官方 SDK（ESM-only），不能并入主进程的 CJS 包，因此单独构建一次；
 * SDK 与 Node 内建模块保持外部引用，运行时按裸模块名从 node_modules 解析。
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: resolve('out/auth-helper'),
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    target: 'node22',
    ssr: resolve('src/auth-helper/index.ts'),
    rollupOptions: {
      external: ['@earendil-works/pi-coding-agent', /^node:/],
      output: {
        format: 'es',
        entryFileNames: 'index.mjs'
      }
    }
  }
})
