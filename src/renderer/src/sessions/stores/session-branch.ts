/**
 * 会话多分支（Branching Session）管理 Store：
 * 当用户在某轮触发 Rewind 或修改重试时，将该轮原有的 AI 回答与工具执行记录在本地按分叉序号归档，
 * 支持在前端无损切换查看历史中不同方案的回答，无需重复发起 API 调用。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ChatMessageView } from '../chat-view'

export interface TurnBranchSnapshot {
  readonly branchIndex: number
  readonly responses: readonly ChatMessageView[]
  readonly responseCount: number
}

export const useSessionBranchStore = defineStore('session-branch', () => {
  /** 历史归档映射：sessionKey -> turnKey -> 历史分支快照列表 */
  const branchHistory = ref<Record<string, Record<string, TurnBranchSnapshot[]>>>({})
  /** 当前选中的分支索引：sessionKey -> turnKey -> 选中索引 (从 0 开始) */
  const selectedBranch = ref<Record<string, Record<string, number>>>({})

  /**
   * 将当前轮的 AI 回答归档为历史分支。
   */
  function archiveBranch(sessionKey: string, turnKey: string, responses: readonly ChatMessageView[]): void {
    if (responses.length === 0) return
    const sessionRecord = branchHistory.value[sessionKey] ?? {}
    const turnBranches = sessionRecord[turnKey] ?? []

    // 避免重复归档完全相同的分支
    const last = turnBranches[turnBranches.length - 1]
    if (last && last.responses.length === responses.length && last.responses[0]?.id === responses[0]?.id) {
      return
    }

    const newSnapshot: TurnBranchSnapshot = {
      branchIndex: turnBranches.length,
      responses: [...responses],
      responseCount: responses.length
    }

    branchHistory.value = {
      ...branchHistory.value,
      [sessionKey]: {
        ...sessionRecord,
        [turnKey]: [...turnBranches, newSnapshot]
      }
    }

    // 默认新分支建立后，将选中索引指向最新分支（将在随后渲染新活动分支）
    const selSession = selectedBranch.value[sessionKey] ?? {}
    selectedBranch.value = {
      ...selectedBranch.value,
      [sessionKey]: {
        ...selSession,
        [turnKey]: turnBranches.length + 1
      }
    }
  }

  /**
   * 切换查看该轮次的指定分支。
   */
  function selectBranch(sessionKey: string, turnKey: string, index: number): void {
    const selSession = selectedBranch.value[sessionKey] ?? {}
    selectedBranch.value = {
      ...selectedBranch.value,
      [sessionKey]: {
        ...selSession,
        [turnKey]: index
      }
    }
  }

  /**
   * 计算指定轮次的分支信息及当前应展示的回答列表：
   * - 历史归档列表中的快照对应索引 0 ~ history.length - 1；
   * - 当前活跃的 liveResponses 对应最后一个索引 history.length；
   */
  function getBranchState(
    sessionKey: string,
    turnKey: string,
    liveResponses: readonly ChatMessageView[]
  ): {
    readonly total: number
    readonly currentIndex: number
    readonly displayedResponses: readonly ChatMessageView[]
  } {
    const history = branchHistory.value[sessionKey]?.[turnKey] ?? []
    const hasLive = liveResponses.length > 0
    const total = history.length + (hasLive ? 1 : 0)

    if (total <= 1) {
      return {
        total: 1,
        currentIndex: 0,
        displayedResponses: liveResponses
      }
    }

    const activeIndex = selectedBranch.value[sessionKey]?.[turnKey] ?? (total - 1)
    const validIndex = Math.max(0, Math.min(activeIndex, total - 1))

    let displayed: readonly ChatMessageView[]
    if (validIndex < history.length) {
      const snap = history[validIndex]
      displayed = snap ? snap.responses : liveResponses
    } else {
      displayed = liveResponses
    }

    return {
      total,
      currentIndex: validIndex,
      displayedResponses: displayed
    }
  }

  return {
    branchHistory,
    selectedBranch,
    archiveBranch,
    selectBranch,
    getBranchState
  }
})
