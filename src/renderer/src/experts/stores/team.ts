/**
 * 设置页「专家团」分节的展示状态：团队清单与加载诊断。
 *
 * 清单每次进页面现读：团队目录很小，缓存只会让刚改动过的定义看起来没生效。
 * 本阶段只有读取，没有写入动作，因此状态比专家分节少一层「动作失败」。
 * 读失败时清空列表并把原因留在 `loadError`，不用空列表冒充「没有团队」。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { TeamIssueView, TeamView } from '../../../../shared/teams-api'
import { listTeams } from '../services/team'

type Phase = 'idle' | 'loading' | 'ready' | 'error'

export const useTeamStore = defineStore('teams', () => {
  const teams = ref<readonly TeamView[]>([])
  const issues = ref<readonly TeamIssueView[]>([])
  const phase = ref<Phase>('idle')
  const loadError = ref<string | null>(null)

  const builtinTeams = computed(() => teams.value.filter(item => item.source === 'builtin'))
  const userTeams = computed(() => teams.value.filter(item => item.source === 'user'))
  const loaded = computed(() => phase.value === 'ready')
  const hasTeams = computed(() => teams.value.length > 0)

  async function load(): Promise<void> {
    phase.value = 'loading'
    loadError.value = null
    const result = await listTeams()
    if (!result.ok) {
      teams.value = []
      issues.value = []
      phase.value = 'error'
      loadError.value = result.error.message
      return
    }
    teams.value = result.data.teams
    issues.value = result.data.issues
    phase.value = 'ready'
  }

  return { teams, issues, phase, loadError, builtinTeams, userTeams, loaded, hasTeams, load }
})
