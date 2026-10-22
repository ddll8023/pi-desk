/**
 * Pi Desktop 主进程入口：只做装配与启动顺序编排。
 *
 * 业务实例在 `services.ts` 建立，窗口在 `window.ts`，资产边界在 `asset-protocol.ts`，
 * 应用生命周期在 `app-lifecycle.ts`，各能力 IPC 在对应能力目录的 `ipc.ts`。
 * 本文件不注册具体业务逻辑，只按固定顺序把上述部分接起来。
 */
import { app } from 'electron'
import { acquireSingleInstance, prepareApplication, registerLifecycle, startApplication } from './app-lifecycle'

// 必须在 ready 前注册协议与应用目录，并在获得单实例锁后才建立生命周期监听。
prepareApplication()

if (!acquireSingleInstance()) {
  app.exit(0)
} else {
  registerLifecycle()
  app.whenReady().then(startApplication).catch(() => {
    console.error('Pi Desktop 无法加载桌面页面。')
    app.exit(1)
  })
}
