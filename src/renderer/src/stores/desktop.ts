/** 保存当前页面的桌面连接展示状态；项目选择由主进程配置保存，本 Store 不保存消息或 Runtime 数据。 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { DesktopAppInfo, DesktopError } from '../../../shared/desktop-api'
import { getAppInfo } from '../services/desktop'

type DesktopConnectionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; info: DesktopAppInfo }
  | { status: 'error'; error: DesktopError }

export const useDesktopStore = defineStore('desktop', () => {
  const connection = ref<DesktopConnectionState>({ status: 'idle' })

  async function initialize(): Promise<void> {
    // 首次挂载与重试共用入口，不让重复点击产生并行初始化。
    if (connection.value.status === 'loading' || connection.value.status === 'ready') return

    connection.value = { status: 'loading' }
    const result = await getAppInfo()
    connection.value = result.ok
      ? { status: 'ready', info: result.data }
      : { status: 'error', error: result.error }
  }

  return { connection, initialize }
})
