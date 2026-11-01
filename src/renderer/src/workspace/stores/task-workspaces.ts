/** 托管工作区的页面展示副本；身份、路径和生命周期只采纳主进程响应，不在标签里自行创建或删除权威记录。 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { workspaceTarget } from '../../../../shared/workspace-api'
import type { WorkspaceContext, WorkspaceTarget } from '../../../../shared/workspace-api'
import { resolveTaskWorkspace } from '../services/task-workspaces'

export const useTaskWorkspacesStore = defineStore('task-workspaces', () => {
  const workspaces = ref<Readonly<Record<string, WorkspaceContext>>>({})
  const actionError = ref<string | null>(null)
  const activeIds = ref<Readonly<Record<string, string>>>({})
  const pendingProjects = ref<readonly string[]>([])
  const operationIds = ref<readonly string[]>([])
  function beginOperation(ids: readonly string[]): boolean {
    if (ids.some(id => operationIds.value.includes(id))) return false
    operationIds.value = [...operationIds.value, ...ids]
    return true
  }
  function endOperation(ids: readonly string[]): void { operationIds.value = operationIds.value.filter(id => !ids.includes(id)) }
  function isLocked(id: string): boolean { return operationIds.value.includes(id) }
  const resolving = new Map<string, Promise<WorkspaceContext>>()
  function accept(workspace: WorkspaceContext): void {
    if ((workspaces.value[workspace.id]?.revision ?? 0) > workspace.revision) return
    workspaces.value = { ...workspaces.value, [workspace.id]: workspace }
  }
  function of(id: string | null): WorkspaceContext | null {
    return id === null ? null : workspaces.value[id] ?? null
  }
  function selected(projectPath: string | null): WorkspaceContext | null {
    return projectPath === null || pendingProjects.value.includes(projectPath) ? null : of(activeIds.value[projectPath] ?? null)
  }
  function select(workspace: WorkspaceContext): void {
    accept(workspace)
    pendingProjects.value = pendingProjects.value.filter(path => path !== workspace.projectPath)
    activeIds.value = { ...activeIds.value, [workspace.projectPath]: workspace.id }
  }
  function selectPending(projectPath: string): void {
    if (!pendingProjects.value.includes(projectPath)) pendingProjects.value = [...pendingProjects.value, projectPath]
  }
  /** undefined 跟随调用时所选环境，null 明确请求项目主工作区；两者都不会改绑已打开的文件或会话。 */
  async function ensure(projectPath: string, requestedId?: string | null): Promise<WorkspaceContext> {
    if (requestedId === undefined && pendingProjects.value.includes(projectPath)) throw new Error('正在解析原标签工作区，未使用主目录代替。')
    const id = requestedId === undefined ? activeIds.value[projectPath] ?? null : requestedId
    const cached = id === null ? Object.values(workspaces.value).find(item => item.projectPath === projectPath && item.kind === 'project') : of(id)
    if (cached) {
      if (cached.projectPath !== projectPath) throw new Error('工作区不属于目标项目。')
      return cached
    }
    const key = JSON.stringify([projectPath, id])
    const existing = resolving.get(key)
    if (existing) return existing
    const work = (async () => {
      const result = await resolveTaskWorkspace(projectPath, id)
      if (!result.ok) throw new Error(result.error.message)
      if (result.workspace.projectPath !== projectPath || id !== null && result.workspace.id !== id) throw new Error('工作区响应归属不一致。')
      accept(result.workspace)
      return of(result.workspace.id) ?? result.workspace
    })()
    resolving.set(key, work)
    try { return await work } finally { if (resolving.get(key) === work) resolving.delete(key) }
  }
  async function target(projectPath: string, requestedId?: string | null): Promise<WorkspaceTarget> {
    return workspaceTarget(await ensure(projectPath, requestedId))
  }
  function fail(message: string): void { actionError.value = message }
  function clearError(): void { actionError.value = null }
  return { workspaces, activeIds, pendingProjects, operationIds, beginOperation, endOperation, isLocked, actionError, accept, of, selected, select, selectPending, ensure, target, fail, clearError }
})
