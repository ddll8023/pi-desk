/**
 * 启动时一次性对齐项目身份：把旧的随机项目 ID 换成按项目名派生的稳定 ID。
 *
 * 先迁移记忆库里的旧归属，全部成功后才改写配置，避免出现「配置已换、记录仍在旧 ID」的半截状态。
 * 失败只记录一次日志并保留旧 ID，下次启动幂等重试；对齐失败不阻断启动。
 */
import type { DesktopConfigStore } from './desktop-config-store'
import type { MemoryManager } from '../memory/memory-manager'

export async function alignProjectIdentities(store: DesktopConfigStore, memory: MemoryManager): Promise<void> {
  try {
    const changes = await store.identityChanges()
    if (changes.length === 0) return
    const result = await memory.reassignProjects(
      changes.map(change => ({ id: change.id, name: change.name, next: change.next }))
    )
    if (result.failed.length > 0) {
      console.error(`项目身份对齐未完成，保留旧 ID 并在下次启动重试：${result.failed.join('、')}`)
      return
    }
    await store.applyIdentityChanges(changes)
  } catch (error) {
    console.error(`项目身份对齐失败，下次启动重试：${error instanceof Error ? error.message : String(error)}`)
  }
}
