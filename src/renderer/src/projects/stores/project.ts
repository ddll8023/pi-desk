/** 保存项目列表与候选添加状态；候选信任确认后才提交，项目持久化和 Runtime 切换由主进程编排。 */
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import type { Project, ProjectError, ProjectList, ProjectPathSelection } from '../../../../shared/project-api'
import type { TrustDecision } from '../../../../shared/trust-api'
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
  /** 会话打开链引起的项目选择不应被标签侧的项目切换反应误认成用户的新选择。 */
  const selectionOrigin = ref<'user' | 'session' | null>(null)
  /** 项目选择按提交顺序收敛，不因另一次切换尚未完成而静默丢弃。 */
  let selectionTail: Promise<void> = Promise.resolve()
  /** 目录选择后暂存候选；信任确认或取消之前不会切换当前项目或写入列表。 */
  /** 候选项目只在流程内只读使用，不需要深度响应式；用 shallowRef 避免把代理存下来并传过桥。 */
  const pendingAddition = shallowRef<ProjectPathSelection | null>(null)
  const pendingAdditionDecision = ref<TrustDecision | null>(null)
  /** 待确认移除的项目；确认后按 allowInterrupt 提交移除，取消不改变列表。 */
  const pendingRemoval = shallowRef<Project | null>(null)

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

  /**
   * 信任选择只暂存于内存；主进程确认添加成功时才与项目记录一起持久化。
   * `allowInterrupt` 仍随请求提交：添加项目会顺带切换前台项目，但前台切换不中断任何后台会话。
   */
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
      if (!result.ok) {
        actionError.value = result.error
      } else {
        applyList(result.data)
      }
      // 无论成功还是失败，候选都不再保留：失败原因已在 actionError 中展示。
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

  /** 记下待移除的项目；确认前不会改列表，也不会关闭 Runtime。 */
  function requestRemoval(project: Project): void {
    pendingRemoval.value = project
  }

  function cancelRemoval(): void {
    pendingRemoval.value = null
  }

  /** 确认后按 allowInterrupt 提交移除：只移除记录，项目目录、代码与会话文件都不受影响。 */
  async function confirmRemoval(): Promise<void> {
    const project = pendingRemoval.value
    pendingRemoval.value = null
    if (project !== null) await remove(project.id, true)
  }

  /**
   * 把路径设为当前项目。前台切换只改变项目上下文，不停止任何后台会话，因此不再需要中断确认；
   * 切换后前台实例跟随该项目（该项目没有承载会话的实例时清空前台）；`allowInterrupt` 只为 IPC 契约保留。
   */
  async function select(path: string, allowInterrupt: boolean, origin: 'user' | 'session' = 'user'): Promise<void> {
    const selection = selectionTail.then(async () => {
      // 添加或移除项目也持有 switching，先等它收敛再提交选择。
      if (switching.value) {
        await new Promise<void>(resolve => {
          const stop = watch(switching, busy => {
            if (busy) return
            stop()
            resolve()
          }, { flush: 'sync' })
        })
      }
      switching.value = true
      selectionOrigin.value = origin
      actionError.value = null
      try {
        const result = await setCurrentProject(path, allowInterrupt)
        if (!result.ok) {
          actionError.value = result.error
          return
        }
        applyList(result.data)
      } finally {
        selectionOrigin.value = null
        switching.value = false
      }
    })
    selectionTail = selection.catch(() => {})
    await selection
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
    selectionOrigin,
    pendingAddition,
    pendingAdditionDecision,
    pendingRemoval,
    initialize,
    choose,
    commitAddition,
    cancelAddition,
    remove,
    requestRemoval,
    cancelRemoval,
    confirmRemoval,
    select
  }
})
