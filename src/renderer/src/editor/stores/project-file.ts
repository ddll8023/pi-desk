/** @ 文件候选固定发起对话的工作区；切换环境立即撤销旧查询，不把同名路径串入另一任务。 */
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { DesktopError } from '../../../../shared/desktop-api'
import { workspaceTarget } from '../../../../shared/workspace-api'
import { searchProjectFiles } from '../services/project-file'
import { useProjectStore } from '../../projects/stores/project'
import { useTaskWorkspacesStore } from '../../workspace/stores/task-workspaces'

export const useProjectFileStore = defineStore('project-file', () => {
  const projects = useProjectStore()
  const workspaces = useTaskWorkspacesStore()
  const entries = ref<readonly string[]>([])
  const pending = ref(false)
  const error = ref<DesktopError | null>(null)
  let sequence = 0
  watch(() => [projects.currentProject?.path ?? null, workspaces.selected(projects.currentProject?.path ?? null)?.id ?? null], () => {
    sequence += 1; entries.value = []; pending.value = false; error.value = null
  }, { flush: 'sync' })
  async function search(query: string): Promise<void> {
    const projectPath = projects.currentProject?.path ?? null
    if (!projectPath || workspaces.pendingProjects.includes(projectPath)) return
    let ticket = ++sequence
    pending.value = true
    try {
      const context = await workspaces.ensure(projectPath)
      if (projects.currentProject?.path !== projectPath || ticket !== sequence) return
      if (!workspaces.selected(projectPath)) {
        workspaces.select(context)
        ticket = ++sequence
        pending.value = true
      }
      const result = await searchProjectFiles(query, workspaceTarget(context))
      if (ticket !== sequence || workspaces.selected(projectPath)?.id !== context.id) return
      if (!result.ok) { error.value = result.error; entries.value = []; return }
      if (result.data.projectPath !== projectPath || result.data.workspaceId !== context.id) return
      error.value = null
      entries.value = result.data.entries
    } catch (caught) {
      if (ticket === sequence) { entries.value = []; error.value = { code: 'BRIDGE_CALL_FAILED', message: caught instanceof Error ? caught.message : '文件候选查询失败。' } }
    } finally { if (ticket === sequence) pending.value = false }
  }
  return { entries, pending, error, search }
})
