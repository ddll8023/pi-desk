/**
 * 桌面记忆配置在 SDK 宿主内的唯一持有者。
 *
 * 首次配置进进程环境：扩展工厂在资源加载阶段同步执行，早于宿主拿到资源加载器。
 * 后续变更在会话服务建立时改绑事件总线推送；配置缺失时扩展自行退回独立 CLI 行为。
 */
import { MEMORY_CONFIGURATION_ENV, serializeMemoryConfiguration } from '../shared-process/memory-runtime'
import type { MemoryHostConfiguration } from '../shared-process/memory-runtime'
import { MEMORY_CONFIGURATION_CHANGED } from './protocol'

interface ExtensionEventBus {
  on(channel: string, handler: (data: unknown) => void): () => void
  emit(channel: string, data: unknown): void
}

export class MemoryConfigurationHolder {
  private configuration: MemoryHostConfiguration | null = null
  private bus: ExtensionEventBus | null = null

  /** 服务重建时改绑新总线；旧总线随旧运行时一起丢弃，不需要额外解绑。 */
  attach(bus: ExtensionEventBus): void {
    this.bus = bus
  }

  current(): MemoryHostConfiguration | null {
    return this.configuration
  }

  /** 采纳新配置：同步更新进程环境，并把变更推给已加载扩展。 */
  apply(configuration: MemoryHostConfiguration): void {
    this.configuration = configuration
    try {
      process.env[MEMORY_CONFIGURATION_ENV] = serializeMemoryConfiguration(configuration)
    } catch { /* 环境写入失败只影响后续加载的扩展，不影响已加载会话。 */ }
    try {
      this.bus?.emit(MEMORY_CONFIGURATION_CHANGED, configuration)
    } catch { /* 订阅方异常不改变宿主配置真相。 */ }
  }
}
