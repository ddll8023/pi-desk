/** 记忆资产的唯一读取入口：画像与风格列表、失败原因、刷新序列，以及概览读数需要的派生计数。
 * 页面只调 `refresh` 一处；两个列表组件不再各自持有加载态与错误，避免同一页出现多个刷新出口。 */
import { computed, ref, shallowRef } from 'vue'
import { MEMORY_PROFILE_DOMAINS } from '../../../shared/memory-api'
import type { MemoryProfileReadRecord, MemoryStyleReadRecord } from '../../../shared/memory-api'
import { loadMemoryProfiles, loadMemoryStyles } from './services/memory'

/** 概览带的读数：画像条数、覆盖到的领域数、风格条数与原句总数。 */
export interface MemoryAssetTotals {
  readonly profiles: number
  readonly domains: number
  readonly styles: number
  readonly samples: number
}

/** 读取画像与风格两类资产：两者同时读、同时成功，读数与列表才不会互相对不上。 */
export function useMemoryAssets() {
  const profiles = shallowRef<readonly MemoryProfileReadRecord[]>([])
  const styles = shallowRef<readonly MemoryStyleReadRecord[]>([])
  const loading = ref(false)
  /** 至少成功读过一次：失败时保留上一次的真实列表，不用空数组冒充「没有内容」。 */
  const loaded = ref(false)
  const error = ref<string | null>(null)
  /** 换代计数：连续刷新时，迟到的响应不能覆盖更新的列表。 */
  let loadSequence = 0

  async function refresh(): Promise<void> {
    const sequence = ++loadSequence
    loading.value = true
    const [profileResult, styleResult] = await Promise.all([loadMemoryProfiles(), loadMemoryStyles()])
    if (sequence !== loadSequence) return
    loading.value = false
    // 任一侧失败都按整次读取失败处理：只更新一半会让概览读数与列表对不上。
    if (!profileResult.ok) {
      error.value = profileResult.error.message
      return
    }
    if (!styleResult.ok) {
      error.value = styleResult.error.message
      return
    }
    error.value = null
    profiles.value = profileResult.data.profiles
    styles.value = styleResult.data.styles
    loaded.value = true
  }

  const totals = computed<MemoryAssetTotals>(() => ({
    profiles: profiles.value.length,
    domains: new Set(profiles.value
      .map(profile => profile.domain)
      .filter(domain => (MEMORY_PROFILE_DOMAINS as readonly string[]).includes(domain))).size,
    styles: styles.value.length,
    samples: styles.value.reduce((sum, style) => sum + style.samples.length, 0)
  }))

  return { profiles, styles, loading, loaded, error, totals, refresh }
}
