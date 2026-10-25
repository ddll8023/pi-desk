/** 手机网页组合根：仅挂载独立远程客户端，不初始化桌面 Store 或访问 Electron 桥接。 */
import { createApp } from 'vue'
import App from './App.vue'
import './mobile.css'

createApp(App).mount('#app')
