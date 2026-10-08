/** 初始化单页 Vue 应用及仅用于展示状态的 Pinia，不拥有 Pi Runtime。 */
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import './assets/main.css'

createApp(App).use(createPinia()).mount('#app')
