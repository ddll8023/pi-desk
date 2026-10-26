/** 分别构建主进程、沙箱 preload 和浏览器页面，不在此配置 Pi 或发行流程。 */
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'electron-vite'
import { devServerPortFromEnv } from './src/shared/dev-server'

/** 开发态端口只取一次：CSP 与 dev server 必须用同一个值，否则开发页面打不开。 */
const devServerPort = devServerPortFromEnv(process.env.PI_DESK_DEV_SERVER_PORT)

const developmentCsp = [
  "default-src 'none'",
  "script-src 'self'",
  // Vite 开发期通过样式节点更新 CSS，终端组件也在运行时写样式；两边都放开内联样式，脚本与连接源保持严格限制。
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' ws://127.0.0.1:${devServerPort}`,
  // data: 与 blob: 仅用于本地图片附件的缩略图展示，与生产 CSP 保持一致；不放开远程图片。
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "object-src 'none'",
  // frame-src 允许嵌入受限的 webview 网页容器，支持 http/https/about 外部页面。
  "frame-src 'self' http: https: about: data:",
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
        // node-pty 是原生模块：只能保持外部引用，运行时从应用目录的 node_modules 加载，不能进 bundle。
        external: ['node-pty'],
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
    plugins: [
      vue({
        template: {
          compilerOptions: {
            isCustomElement: (tag) => tag === 'webview'
          }
        }
      }),
      tailwindcss()
    ],
    server: {
      host: '127.0.0.1',
      port: devServerPort,
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
