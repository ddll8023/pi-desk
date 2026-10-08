/** 分别构建主进程、沙箱 preload 和浏览器页面，不在此配置 Pi 或发行流程。 */
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'electron-vite'

const developmentCsp = [
  "default-src 'none'",
  "script-src 'self'",
  // Vite 开发期通过样式节点更新 CSS；正式页面不保留此权限。
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws://127.0.0.1:5173",
  "img-src 'self'",
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
      port: 5173,
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
