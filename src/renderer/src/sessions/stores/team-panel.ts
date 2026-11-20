/**
 * 团队面板状态：成员登记清单与单个成员的只读详情。
 *
 * 成员会话只读：这里只发读取请求，不提供输入、派活或停止入口。
 * 定位由「项目路径 + 根会话」确定；切换会话后旧请求的结果按定位丢弃，
 * 不覆盖当前面板——否则切到另一个会话会看到上一个会话的成员。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { listTeamSessions, readTeamSession, readTeamSessionHistory } from '../services/team-sessions'
import type { TeamSessionContent, TeamSessionHistory, TeamSessionView } from '../../../../shared/team-session-api'

/** 成员弹窗默认读的最近消息条数：够看结论与最近的往返，不拉整份会话。 */
const MEMBER_HISTORY_LIMIT = 20

export type TeamPanelPhase = 'idle' | 'loading' | 'ready' | 'failed'
export type TeamDetailPhase = 'idle' | 'loading' | 'ready' | 'failed'

export const useTeamPanelStore = defineStore('team-panel', () => {
  const members = ref<readonly TeamSessionView[]>([])
  const phase = ref<TeamPanelPhase>('idle')
  const error = ref<string | null>(null)
  const selectedId = ref<string | null>(null)
  const content = ref<TeamSessionContent | null>(null)
  const history = ref<TeamSessionHistory | null>(null)
  const detailPhase = ref<TeamDetailPhase>('idle')
  const detailError = ref<string | null>(null)

  /** 最近一次已发出请求的定位；用来判断结果是否仍属于当前会话。 */
  let loadedKey: string | null = null

  const hasMembers = computed(() => members.value.length > 0)
  const selectedMember = computed(() => (selectedId.value === null
    ? null
    : members.value.find(item => item.memberExpertId === selectedId.value) ?? null))

  function locate(projectPath: string | null, rootSessionId: string | null): string | null {
    return projectPath === null || rootSessionId === null ? null : `${projectPath}\n${rootSessionId}`
  }

  /** 清空面板：不在团队会话、或根会话标识还没就绪时调用。 */
  function clear(): void {
    loadedKey = null
    members.value = []
    phase.value = 'idle'
    error.value = null
    close()
  }

  /**
   * 读取成员登记；同一会话已读过时直接复用，`force` 用于用户主动刷新与派活后的重读。
   * 并发请求不互相覆盖：只有最后发出的那个定位能写回状态。
   */
  async function load(projectPath: string | null, rootSessionId: string | null, force = false): Promise<void> {
    const key = locate(projectPath, rootSessionId)
    if (key === null) {
      clear()
      return
    }
    if (!force && key === loadedKey && (phase.value === 'ready' || phase.value === 'loading')) return
    loadedKey = key
    if (!force) members.value = []
    phase.value = 'loading'
    error.value = null
    const result = await listTeamSessions(projectPath as string, rootSessionId as string)
    if (loadedKey !== key) return
    if (!result.ok) {
      members.value = []
      phase.value = 'failed'
      error.value = result.error.message
      return
    }
    members.value = result.data.sessions
    phase.value = 'ready'
  }

  /** 打开成员详情：并发取头部与近期正文，失败只落在详情状态上，不影响成员清单。 */
  async function open(projectPath: string, rootSessionId: string, memberExpertId: string): Promise<void> {
    const key = locate(projectPath, rootSessionId)
    if (key === null) return
    selectedId.value = memberExpertId
    content.value = null
    history.value = null
    detailPhase.value = 'loading'
    detailError.value = null
    const [head, recent] = await Promise.all([
      readTeamSession(projectPath, rootSessionId, memberExpertId),
      readTeamSessionHistory(projectPath, rootSessionId, memberExpertId, MEMBER_HISTORY_LIMIT)
    ])
    if (loadedKey !== key || selectedId.value !== memberExpertId) return
    if (!head.ok) {
      detailPhase.value = 'failed'
      detailError.value = head.error.message
      return
    }
    content.value = head.data
    // 还没有会话文件时历史读取会失败；这属于「尚未派活」，不是错误。
    history.value = recent.ok ? recent.data : null
    detailPhase.value = 'ready'
  }

  /** 关闭成员详情：只清详情，不清成员清单。 */
  function close(): void {
    selectedId.value = null
    content.value = null
    history.value = null
    detailPhase.value = 'idle'
    detailError.value = null
  }

  return {
    members, phase, error, selectedId, selectedMember, content, history, detailPhase, detailError,
    hasMembers, load, open, close, clear
  }
})
