/**
 * 独立构建 ESM SDK 宿主与一次性 CLI 运行器；只输出自身产物，不把官方包并入主进程或沙箱 preload。
 *
 * 两个入口共用同一份 external 与目标环境：宿主常驻并持有会话，运行器一次性执行主进程给定的 CLI 参数。
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: resolve('out/sdk-host'),
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    target: 'node22',
    // 多入口 SSR 构建：入口取自 rollupOptions.input，产物名为 index.mjs 与 pi-cli.mjs。
    ssr: true,
    rollupOptions: {
      input: {
        index: resolve('src/sdk-host/index.ts'),
        'pi-cli': resolve('src/pi-cli/index.ts')
      },
      external: ['@earendil-works/pi-coding-agent', /^node:/],
      output: {
        format: 'es',
        entryFileNames: '[name].mjs'
      }
    }
  }
})
