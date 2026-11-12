/**
 * 设置页「专家」分节的展示状态：清单与加载诊断、派生、保存与删除动作、编辑对话框、快速模式剔除清单。
 *
 * 清单每次进页面现读：自定义专家目录很小，缓存只会让刚派生或刚保存的定义看起来没生效。
 * 动作状态与清单状态分开：派生、保存或删除失败只影响一行提示，已读到的列表继续可用。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { SessionExpertIssue, SessionExpertView } from '../../../../shared/session-api'
import type { ExpertEditableDefinition, ExpertSaveRequest, ExpertSaveResult } from '../../../../shared/experts-api'
import {
  deleteExpert,
  deriveExpert,
  listExperts,
  listFastModeExclusions,
  readExpertDefinition,
  saveExpert
} from '../services/expert'

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
  /** 编辑对话框是否打开；`editingId` 为 null 表示新建。 */
  const editorOpen = ref(false)
  const editingId = ref<string | null>(null)
  /** 保存进行中：对话框据此禁用重复提交，与列表行的 `busyId` 分开。 */
  const saving = ref(false)

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

  function openCreate(): void {
    clearNotice()
    editingId.value = null
    editorOpen.value = true
  }

  function openEdit(expertId: string): void {
    clearNotice()
    editingId.value = expertId
    editorOpen.value = true
  }

  function closeEditor(): void {
    editorOpen.value = false
    editingId.value = null
  }

  /**
   * 读取一份自定义专家定义供对话框回填；失败时只写提示并返回 null，
   * 对话框保持空白，不拿半份数据让用户误以为定义就是那样。
   */
  async function readDefinition(expertId: string): Promise<ExpertEditableDefinition | null> {
    const result = await readExpertDefinition(expertId)
    if (!result.ok) {
      actionError.value = result.error.message
      return null
    }
    return result.data
  }

  /** 保存：成功后就地重读清单并关闭对话框；失败把结果原样交给对话框就地展示。 */
  async function save(request: ExpertSaveRequest): Promise<ExpertSaveResult> {
    if (saving.value) {
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: '正在保存，请稍候。' } }
    }
    saving.value = true
    actionError.value = null
    notice.value = null
    const result = await saveExpert(request)
    saving.value = false
    if (!result.ok) return result
    notice.value = result.data.unavailableSkillIds.length > 0
      ? `已保存 ${result.data.expertId}；引用的技能当前不可用：${result.data.unavailableSkillIds.join('、')}。`
      : `已保存 ${result.data.expertId}，改完下一轮会话生效。`
    editorOpen.value = false
    editingId.value = null
    await load()
    return result
  }

  return {
    experts, issues, fastModeSkillIds, phase, loadError, busyId, actionError, notice,
    editorOpen, editingId, saving,
    builtinExperts, userExperts, loaded, load, derive, remove, clearNotice,
    openCreate, openEdit, closeEditor, readDefinition, save
  }
})
