/**
 * 桌面记忆配置在 SDK 宿主内的唯一持有者。
 *
 * 首次配置进进程环境：扩展工厂在资源加载阶段同步执行，早于宿主拿到资源加载器。
 * 后续变更通过 SDK 事件总线推送；总线由宿主创建后显式交给资源加载器，
 * 因为 `ExtensionRuntime` 不对外暴露 `events`（由 `pi` 工厂参数提供），不能从加载结果反取。
 * 配置缺失时扩展自行退回独立 CLI 行为。
 */
import type { EventBus } from '@earendil-works/pi-coding-agent'
import { MEMORY_CONFIGURATION_ENV, serializeMemoryConfiguration } from '../shared-process/memory-runtime'
import type { MemoryHostConfiguration } from '../shared-process/memory-runtime'
import { MEMORY_CONFIGURATION_CHANGED } from './protocol'

export class MemoryConfigurationHolder {
  private configuration: MemoryHostConfiguration | null = null

  /** 全进程唯一的扩展事件总线；服务重建沿用同一总线，已加载扩展的订阅不会失效。 */
  constructor(readonly bus: EventBus) {}

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
      this.bus.emit(MEMORY_CONFIGURATION_CHANGED, configuration)
    } catch { /* 订阅方异常不改变宿主配置真相。 */ }
  }
}
