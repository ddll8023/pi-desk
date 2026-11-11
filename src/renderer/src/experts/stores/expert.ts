/**
 * 设置页「专家」分节的展示状态：清单与加载诊断、派生与删除动作、快速模式剔除清单。
 *
 * 清单每次进页面现读：自定义专家目录很小，缓存只会让刚派生的副本看起来没生效。
 * 动作状态与清单状态分开：派生或删除失败只影响一行提示，已读到的列表继续可用。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { SessionExpertIssue, SessionExpertView } from '../../../../shared/session-api'
import { deleteExpert, deriveExpert, listExperts, listFastModeExclusions } from '../services/expert'

type Phase = 'idle' | 'loading' | 'ready' | 'error'

export const useExpertStore = defineStore('experts', () => {
  const experts = ref<readonly SessionExpertView[]>([])
  const issues = ref<readonly SessionExpertIssue[]>([])
  const fastModeSkillIds = ref<readonly string[]>([])
  const phase = ref<Phase>('idle')
  const loadError = ref<string | null>(null)
  /** 正在派生或删除的专家标识；非空时禁用该行操作。 */
  const busyId = ref<string | null>(null)
  const actionError = ref<string | null>(null)
  const notice = ref<string | null>(null)

  const builtinExperts = computed(() => experts.value.filter(item => item.source === 'builtin'))
  const userExperts = computed(() => experts.value.filter(item => item.source === 'user'))
  const loaded = computed(() => phase.value === 'ready')

  async function load(): Promise<void> {
    phase.value = 'loading'
    loadError.value = null
    const [catalog, exclusions] = await Promise.all([listExperts(), listFastModeExclusions()])
    if (catalog.ok) {
      experts.value = catalog.data.experts
      issues.value = catalog.data.issues
      phase.value = 'ready'
    } else {
      experts.value = []
      issues.value = []
      phase.value = 'error'
      loadError.value = catalog.error.message
    }
    // 剔除清单只用于解释文案，读不到时不阻塞列表。
    fastModeSkillIds.value = exclusions.ok ? exclusions.data.skillIds : []
  }

  /** 派生：成功后重读清单，新副本的标识直接出现在列表里，不用自己拼视图。 */
  async function derive(builtinId: string): Promise<void> {
    if (busyId.value !== null) return
    busyId.value = builtinId
    actionError.value = null
    notice.value = null
    const result = await deriveExpert(builtinId)
    busyId.value = null
    if (!result.ok) {
      actionError.value = result.error.message
      return
    }
    notice.value = `已派生为 ${result.data.expertId}，正文在自定义专家目录的 expert.md，改完下一轮会话生效。`
    await load()
  }

  /** 删除：只对自定义专家开放；确认由界面负责，这里只执行。 */
  async function remove(expertId: string): Promise<void> {
    if (busyId.value !== null) return
    busyId.value = expertId
    actionError.value = null
    notice.value = null
    const result = await deleteExpert(expertId)
    busyId.value = null
    if (!result.ok) {
      actionError.value = result.error.message
      return
    }
    notice.value = `已删除专家 ${expertId}。`
    await load()
  }

  function clearNotice(): void {
    notice.value = null
    actionError.value = null
  }

  return {
    experts, issues, fastModeSkillIds, phase, loadError, busyId, actionError, notice,
    builtinExperts, userExperts, loaded, load, derive, remove, clearNotice
  }
})
