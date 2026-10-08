/** 保存项目面板的展示状态：最近项目、当前项目与本地配置提示；归一化、持久化与切换编排都在主进程。 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Project, ProjectError, ProjectList } from '../../../shared/project-api'
import { chooseProjectDirectory, listProjects, setCurrentProject } from '../services/project'

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

  /** 打开系统目录选择器；取消不改变任何状态，也不作为错误提示。 */
  async function choose(): Promise<void> {
    if (choosing.value || switching.value) return

    choosing.value = true
    actionError.value = null
    try {
      const result = await chooseProjectDirectory()
      if (!result.ok) {
        actionError.value = result.error
        return
      }
      if (result.data === null) return
      await select(result.data.path, false)
    } finally {
      choosing.value = false
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
    initialize,
    choose,
    select,
    cancelPending
  }
})
