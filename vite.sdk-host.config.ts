/** 独立构建 ESM SDK 宿主；只输出自身产物，不把官方包并入主进程或沙箱 preload。 */
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: resolve('out/sdk-host'),
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    target: 'node22',
    ssr: resolve('src/sdk-host/index.ts'),
    rollupOptions: {
      external: ['@earendil-works/pi-coding-agent', /^node:/],
      output: {
        format: 'es',
        entryFileNames: 'index.mjs'
      }
    }
  }
})
