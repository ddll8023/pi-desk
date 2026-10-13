/** 分别构建主进程、沙箱 preload 和浏览器页面，不在此配置 Pi 或发行流程。 */
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'electron-vite'
import { DEV_SERVER_PORT } from './src/shared/dev-server'

const developmentCsp = [
  "default-src 'none'",
  "script-src 'self'",
  // Vite 开发期通过样式节点更新 CSS；正式页面不保留此权限。
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' ws://127.0.0.1:${DEV_SERVER_PORT}`,
  // data: 与 blob: 仅用于本地图片附件的缩略图展示，与生产 CSP 保持一致；不放开远程图片。
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

export default defineConfig({
  main: {
    build: {
      outDir: resolve('out/main'),
      lib: {
        entry: resolve('src/main/index.ts'),
        formats: ['cjs']
      },
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      }
    }
  },
  preload: {
    build: {
      outDir: resolve('out/preload'),
      // 沙箱不能 require 本地拆分模块，只保留 Electron 自身为外部引用。
      externalizeDeps: false,
      lib: {
        entry: resolve('src/preload/index.ts'),
        formats: ['cjs']
      },
      rollupOptions: {
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs',
          inlineDynamicImports: true
        }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [vue(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      port: DEV_SERVER_PORT,
      strictPort: true,
      allowedHosts: ['127.0.0.1'],
      cors: false,
      headers: {
        'Content-Security-Policy': developmentCsp,
        'X-Content-Type-Options': 'nosniff'
      }
    },
    build: {
      outDir: resolve('out/renderer'),
      rollupOptions: {
        input: resolve('src/renderer/index.html')
      }
    }
  }
})
