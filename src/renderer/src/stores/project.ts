/** 保存项目列表与候选添加状态；候选信任确认后才提交，项目持久化和 Runtime 切换由主进程编排。 */
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { Project, ProjectError, ProjectList, ProjectPathSelection } from '../../../shared/project-api'
import type { TrustDecision } from '../../../shared/trust-api'
import {
  addProject,
  chooseProjectDirectory,
  listProjects,
  removeProject,
  setCurrentProject
} from '../services/project'

/** 列表读取状态；单次动作失败放在 `actionError`，不影响已加载的列表。 */
type ProjectViewState =
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'error'; error: ProjectError }

export const useProjectStore = defineStore('project', () => {
  const view = ref<ProjectViewState>({ phase: 'loading' })
  const projects = ref<readonly Project[]>([])
  const currentProjectId = ref<string | null>(null)
  const storageNotice = ref<string | null>(null)
  const actionError = ref<ProjectError | null>(null)
  const choosing = ref(false)
  const switching = ref(false)
  /** 主进程拒绝了未确认的切换时保存待确认路径，确认后带 `allowInterrupt` 重试。 */
  const pendingPath = ref<string | null>(null)
  /** 目录选择后暂存候选；信任确认或取消之前不会切换当前项目或写入列表。 */
  /** 候选项目只在流程内只读使用，不需要深度响应式；用 shallowRef 避免把代理存下来并传过桥。 */
  const pendingAddition = shallowRef<ProjectPathSelection | null>(null)
  const pendingAdditionDecision = ref<TrustDecision | null>(null)

  const currentProject = computed<Project | null>(() => (
    projects.value.find((project) => project.id === currentProjectId.value) ?? null
  ))

  /** 主进程返回的列表是唯一真相；展示状态只做副本。 */
  function applyList(list: ProjectList): void {
    projects.value = list.projects
    currentProjectId.value = list.currentProjectId
    storageNotice.value = list.storageNotice
  }

  /** 首次挂载读取项目列表；重复调用不产生并行请求。 */
  async function initialize(): Promise<void> {
    if (view.value.phase === 'ready') return

    view.value = { phase: 'loading' }
    const result = await listProjects()
    if (!result.ok) {
      view.value = { phase: 'error', error: result.error }
      return
    }
    applyList(result.data)
    view.value = { phase: 'ready' }
  }

  /** 选择目录后先暂存候选；需要信任确认时等待 UI 决定，否则直接提交添加。 */
  async function choose(): Promise<void> {
    if (choosing.value || switching.value || pendingAddition.value !== null) return

    choosing.value = true
    actionError.value = null
    try {
      const result = await chooseProjectDirectory()
      if (!result.ok) {
        actionError.value = result.error
        return
      }
      if (result.data === null) return
      pendingAddition.value = result.data
      pendingAdditionDecision.value = null
    } finally {
      choosing.value = false
    }

    const candidate = pendingAddition.value
    if (candidate !== null
      && (candidate.trustStatus.resources.length === 0 || candidate.trustStatus.decision !== null)) {
      await commitAddition(false)
    }
  }

  /** 信任选择只暂存于内存；主进程确认切换成功时才与项目记录一起持久化。 */
  async function commitAddition(allowInterrupt: boolean, decision?: TrustDecision): Promise<void> {
    const candidate = pendingAddition.value
    if (candidate === null || switching.value) return
    if (decision !== undefined) pendingAdditionDecision.value = decision

    switching.value = true
    actionError.value = null
    try {
      const result = await addProject(
        candidate.path,
        candidate.trustStatus,
        pendingAdditionDecision.value,
        allowInterrupt
      )
      if (result.ok) {
        applyList(result.data)
        pendingPath.value = null
        pendingAddition.value = null
        pendingAdditionDecision.value = null
        return
      }
      if (result.error.code === 'PROJECT_SWITCH_BLOCKED' && !allowInterrupt) {
        pendingPath.value = candidate.path
        return
      }
      actionError.value = result.error
      pendingPath.value = null
      pendingAddition.value = null
      pendingAdditionDecision.value = null
    } finally {
      switching.value = false
    }
  }

  /** 取消候选项目；尚未提交时不会改变当前项目、列表或信任记录。 */
  function cancelAddition(): void {
    if (switching.value) return
    pendingAddition.value = null
    pendingAdditionDecision.value = null
    pendingPath.value = null
  }

  /** 删除 Desktop 列表项；目录文件不受影响。调用方须在中断确认后传入 allowInterrupt。 */
  async function remove(projectId: string, allowInterrupt: boolean): Promise<void> {
    if (switching.value) return
    switching.value = true
    actionError.value = null
    try {
      const result = await removeProject(projectId, allowInterrupt)
      if (!result.ok) {
        actionError.value = result.error
        return
      }
      applyList(result.data)
    } finally {
      switching.value = false
    }
  }

  /**
   * 把路径设为当前项目；`allowInterrupt` 为真表示用户已确认可以停止正在运行的操作。
   * 主进程拒绝未确认的切换时只记录待确认路径，由界面就地确认。
   */
  async function select(path: string, allowInterrupt: boolean): Promise<void> {
    if (switching.value) return

    switching.value = true
    actionError.value = null
    try {
      const result = await setCurrentProject(path, allowInterrupt)
      if (result.ok) {
        applyList(result.data)
        pendingPath.value = null
        return
      }
      if (result.error.code === 'PROJECT_SWITCH_BLOCKED' && !allowInterrupt) {
        pendingPath.value = path
        return
      }
      actionError.value = result.error
    } finally {
      switching.value = false
    }
  }

  /** 放弃待确认的切换；运行中的操作不受影响。 */
  function cancelPending(): void {
    pendingPath.value = null
    pendingAddition.value = null
    pendingAdditionDecision.value = null
  }

  return {
    view,
    projects,
    currentProjectId,
    currentProject,
    storageNotice,
    actionError,
    choosing,
    switching,
    pendingPath,
    pendingAddition,
    pendingAdditionDecision,
    initialize,
    choose,
    commitAddition,
    cancelAddition,
    remove,
    select,
    cancelPending
  }
})
