/**
 * 独立构建 ESM SDK 宿主、一次性 CLI 运行器与一次性版本检查脚本；只输出自身产物，不把官方包并入主进程或沙箱 preload。
 *
 * 三个入口共用同一份 external 与目标环境：宿主常驻并持有会话，运行器一次性执行主进程给定的 CLI 参数，
 * 版本检查一次性读取已安装与远端版本并输出 JSON。
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
    // 多入口 SSR 构建：入口取自 rollupOptions.input，产物名为 index.mjs、pi-cli.mjs 与 update-check.mjs。
    ssr: true,
    rollupOptions: {
      input: {
        index: resolve('src/sdk-host/index.ts'),
        'pi-cli': resolve('src/pi-cli/index.ts'),
        'update-check': resolve('src/update-check/index.ts')
      },
      external: ['@earendil-works/pi-coding-agent', /^node:/],
      output: {
        format: 'es',
        entryFileNames: '[name].mjs'
      }
    }
  }
})
