/**
 * 运行时 SDK 的解析：应用自有数据区下的运行时根目录，以及当前版本指针指向的 SDK 入口。
 *
 * 只做解析与只读自检，不创建目录、不安装、不改指针：目录缺失、指针非法或目标不完整时一律返回 null，
 * 由调用方回退到应用自带的版本。解析是同步的，因为受管进程的环境注入本身是同步的。
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import { resolveActiveRuntime, SDK_ENTRY_ENV } from '../runtime-install/runtime'

/** 运行时目录放在应用自有数据区：与桌面配置同级，清理与卸载语义一致，也不进入 Pi 的配置目录。 */
export function getRuntimeRoot(): string {
  return join(app.getPath('userData'), 'pi-runtime')
}

/**
 * 受管进程的 SDK 入口覆盖：有可用运行时时给出入口的文件 URL，否则不注入。
 * 用文件 URL 而不是路径：动态导入在 Windows 上不接受裸路径。
 */
export function getRuntimeSdkEnv(): NodeJS.ProcessEnv {
  const runtime = resolveActiveRuntime(getRuntimeRoot())
  if (runtime === null) return {}
  return { [SDK_ENTRY_ENV]: pathToFileURL(runtime.entryPath).href }
}
