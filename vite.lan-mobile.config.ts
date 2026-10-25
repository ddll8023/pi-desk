/** 独立手机网页构建：复用 Vue 与主题资源，不包含 Electron preload、桌面组合根或开发服务器代理。 */
import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve('src/lan-mobile'),
  base: '/',
  plugins: [vue(), tailwindcss()],
  build: {
    outDir: resolve('out/lan-mobile'),
    emptyOutDir: true,
    rollupOptions: { input: resolve('src/lan-mobile/index.html') }
  }
})
