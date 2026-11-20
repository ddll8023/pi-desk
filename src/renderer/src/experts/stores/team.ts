/**
 * 设置页「专家与专家团」分节里团队部分的状态：清单与加载诊断、读取与保存、删除与编辑对话框。
 *
 * 清单每次进页面现读：团队目录很小，缓存只会让刚改动过的定义看起来没生效。
 * 动作状态与清单状态分开：保存或删除失败只影响一段提示，已读到的列表继续可用。
 * 本 store 不装配会话、不开团；开团仍由会话侧完成。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  TeamEditableDefinition,
  TeamIssueView,
  TeamSaveRequest,
  TeamSaveResult,
  TeamView
} from '../../../../shared/teams-api'
import { deleteTeam, listTeams, readTeamDefinition, saveTeam } from '../services/team'

type Phase = 'idle' | 'loading' | 'ready' | 'error'

export const useTeamStore = defineStore('teams', () => {
  const teams = ref<readonly TeamView[]>([])
  const issues = ref<readonly TeamIssueView[]>([])
  const phase = ref<Phase>('idle')
  const loadError = ref<string | null>(null)
  /** 正在删除的团队标识；非空时禁用该行操作。 */
  const busyId = ref<string | null>(null)
  const actionError = ref<string | null>(null)
  const notice = ref<string | null>(null)
  /** 编辑对话框是否打开；`editingId` 为 null 表示新建。 */
  const editorOpen = ref(false)
  const editingId = ref<string | null>(null)
  /** 保存进行中：对话框据此禁用重复提交，与列表行的 `busyId` 分开。 */
  const saving = ref(false)

  const loaded = computed(() => phase.value === 'ready')

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

  function clearNotice(): void {
    notice.value = null
    actionError.value = null
  }

  function openCreate(): void {
    clearNotice()
    editingId.value = null
    editorOpen.value = true
  }

  function openEdit(teamId: string): void {
    clearNotice()
    editingId.value = teamId
    editorOpen.value = true
  }

  function closeEditor(): void {
    editorOpen.value = false
    editingId.value = null
  }

  /**
   * 读取一份自定义团队定义供对话框回填；失败时只写提示并返回 null，
   * 对话框保持空白，不拿半份数据让用户误以为定义就是那样。
   */
  async function readDefinition(teamId: string): Promise<TeamEditableDefinition | null> {
    const result = await readTeamDefinition(teamId)
    if (!result.ok) {
      actionError.value = result.error.message
      return null
    }
    return result.data
  }

  /** 保存：成功后就地重读清单并关闭对话框；失败把结果原样交给对话框就地展示。 */
  async function save(request: TeamSaveRequest): Promise<TeamSaveResult> {
    if (saving.value) {
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: '正在保存，请稍候。' } }
    }
    saving.value = true
    actionError.value = null
    notice.value = null
    const result = await saveTeam(request)
    saving.value = false
    if (!result.ok) return result
    notice.value = `已保存团队 ${result.data.teamId}，改完在新建会话生效。`
    editorOpen.value = false
    editingId.value = null
    await load()
    return result
  }

  /** 删除：只对自定义团队开放；确认由界面负责，这里只执行。 */
  async function remove(teamId: string): Promise<void> {
    if (busyId.value !== null) return
    busyId.value = teamId
    actionError.value = null
    notice.value = null
    const result = await deleteTeam(teamId)
    busyId.value = null
    if (!result.ok) {
      actionError.value = result.error.message
      return
    }
    notice.value = `已删除团队 ${teamId}。`
    await load()
  }

  return {
    teams, issues, phase, loadError, busyId, actionError, notice,
    editorOpen, editingId, saving,
    loaded,
    load, clearNotice, openCreate, openEdit, closeEditor, readDefinition, save, remove
  }
})
