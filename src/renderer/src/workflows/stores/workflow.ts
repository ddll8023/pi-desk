/**
 * 工作流定义的状态：清单、按标签分开的草稿与提示、选中节点或边、保存结果。
 *
 * 草稿按标签键分开存：两个工作流标签同时打开时各自编辑自己的图，切回来仍是各自的改动。
 * 提示也按标签键分开：一个标签的校验错误不该出现在另一个标签上。
 * 草稿与已保存定义分开——画布上的改动先落在草稿里，保存成功才替换清单。
 * 图形校验在保存前跑一次，问题直接显示在提示条里，不等到主进程拒绝。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  MAX_WORKFLOW_EDGES,
  MAX_WORKFLOW_NODES,
  MAX_WORKFLOW_PARAMETERS,
  validateWorkflowGraph
} from '../../../../shared/workflow-api'
import type {
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowEdgeCondition,
  WorkflowEdgeRoute,
  WorkflowIssueView,
  WorkflowNode,
  WorkflowParameter,
  WorkflowParameterType,
  WorkflowView
} from '../../../../shared/workflow-api'
import * as service from '../services/desktop'

type Phase = 'idle' | 'loading' | 'ready' | 'error'

/** 草稿：与已保存定义同构，`id` 为空串表示还没落盘。 */
export interface WorkflowDraft {
  readonly id: string
  readonly name: string
  readonly summary: string
  readonly parameters: readonly WorkflowParameter[]
  readonly nodes: readonly WorkflowNode[]
  readonly edges: readonly WorkflowEdge[]
}

/** 一个标签的提示：错误、图形问题与普通说明分开，互不覆盖。 */
export interface WorkflowMessages {
  readonly error: string | null
  readonly issues: readonly WorkflowIssueView[]
  readonly notice: string | null
}

const EMPTY_MESSAGES: WorkflowMessages = { error: null, issues: [], notice: null }

export const useWorkflowStore = defineStore('workflows', () => {
  const definitions = ref<readonly WorkflowView[]>([])
  const phase = ref<Phase>('idle')
  const loadError = ref<string | null>(null)
  /** 标签键 → 草稿；标签关闭后草稿留在内存，重新打开同名标签时被新读取覆盖。 */
  const drafts = ref<Readonly<Record<string, WorkflowDraft>>>({})
  /** 标签键 → 选中节点标识。 */
  const selections = ref<Readonly<Record<string, string | null>>>({})
  /** 标签键 → 选中边标识；节点与边互斥选中，同一时刻只配置一个对象。 */
  const edgeSelections = ref<Readonly<Record<string, string | null>>>({})
  /** 有未保存改动的标签键。 */
  const dirtyKeys = ref<ReadonlySet<string>>(new Set())
  /** 标签键 → 提示。 */
  const messages = ref<Readonly<Record<string, WorkflowMessages>>>({})
  const saving = ref(false)

  const loaded = computed(() => phase.value === 'ready')

  function draftOf(key: string): WorkflowDraft | null {
    return drafts.value[key] ?? null
  }

  function messagesOf(key: string): WorkflowMessages {
    return messages.value[key] ?? EMPTY_MESSAGES
  }

  function patchMessages(key: string, patch: Partial<WorkflowMessages>): void {
    messages.value = { ...messages.value, [key]: { ...messagesOf(key), ...patch } }
  }

  /** 只写一条错误：画布在交互前拦截（未保存就切换、删节点越界）时用。 */
  function notify(key: string, message: string): void {
    patchMessages(key, { error: message })
  }

  function selectedOf(key: string): string | null {
    return selections.value[key] ?? null
  }

  function selectedEdgeOf(key: string): string | null {
    return edgeSelections.value[key] ?? null
  }

  function selectedEdge(key: string): WorkflowEdge | null {
    const current = draftOf(key)
    const edgeId = selectedEdgeOf(key)
    if (current === null || edgeId === null) return null
    return current.edges.find(edge => edge.id === edgeId) ?? null
  }

  function currentNodeOf(key: string): WorkflowNode | null {
    const current = draftOf(key)
    const nodeId = selectedOf(key)
    if (current === null || nodeId === null) return null
    return current.nodes.find(node => node.id === nodeId) ?? null
  }

  function isDirty(key: string): boolean {
    return dirtyKeys.value.has(key)
  }

  function setDraft(key: string, draft: WorkflowDraft, dirty: boolean): void {
    drafts.value = { ...drafts.value, [key]: draft }
    const next = new Set(dirtyKeys.value)
    if (dirty) next.add(key)
    else next.delete(key)
    dirtyKeys.value = next
  }

  async function load(): Promise<void> {
    phase.value = 'loading'
    loadError.value = null
    const result = await service.listWorkflows()
    if (!result.ok) {
      definitions.value = []
      phase.value = 'error'
      loadError.value = result.error.message
      return
    }
    definitions.value = result.data.workflows
    phase.value = 'ready'
  }

  function clearMessages(key: string): void {
    patchMessages(key, EMPTY_MESSAGES)
  }

  /** 打开一份已保存定义；`workflowId` 为空串时开一张新图（一个开始、一个结束、一条边）。 */
  async function open(key: string, workflowId: string): Promise<void> {
    clearMessages(key)
    // 选中态跟着换：上一张图的边 id 可能与新图的默认边相同，不清会立刻弹出检查器。
    selections.value = { ...selections.value, [key]: null }
    edgeSelections.value = { ...edgeSelections.value, [key]: null }
    if (workflowId === '') {
      setDraft(key, blankDraft(), false)
      return
    }
    const result = await service.readWorkflow(workflowId)
    if (!result.ok) {
      patchMessages(key, { error: result.error.message })
      return
    }
    setDraft(key, toDraft(result.data), false)
  }

  function blankDraft(): WorkflowDraft {
    const start: WorkflowNode = {
      id: 'n1', type: 'start', title: '开始', x: 80, y: 160, expertId: null, prompt: '', writeScope: null
    }
    const end: WorkflowNode = {
      id: 'n2', type: 'end', title: '结束', x: 520, y: 160, expertId: null, prompt: '', writeScope: null
    }
    const edge: WorkflowEdge = { id: 'e-n1-n2-always', source: 'n1', target: 'n2', route: 'always', condition: null }
    return { id: '', name: '未命名工作流', summary: '', parameters: [], nodes: [start, end], edges: [edge] }
  }

  function toDraft(definition: WorkflowDefinition): WorkflowDraft {
    return {
      id: definition.id,
      name: definition.name,
      summary: definition.summary,
      parameters: definition.parameters,
      nodes: definition.nodes,
      edges: definition.edges
    }
  }

  function withDraft(key: string, patch: Partial<WorkflowDraft>): void {
    const current = draftOf(key)
    if (current === null) return
    setDraft(key, { ...current, ...patch }, true)
  }

  function selectNode(key: string, nodeId: string | null): void {
    selections.value = { ...selections.value, [key]: nodeId }
    if (nodeId !== null) edgeSelections.value = { ...edgeSelections.value, [key]: null }
  }

  function selectEdge(key: string, edgeId: string | null): void {
    edgeSelections.value = { ...edgeSelections.value, [key]: edgeId }
    if (edgeId !== null) selections.value = { ...selections.value, [key]: null }
  }

  function setName(key: string, name: string): void {
    withDraft(key, { name })
  }

  function setSummary(key: string, summary: string): void {
    withDraft(key, { summary })
  }

  /** 下一个节点标识：在现有 id 里取最大编号加一，删掉的节点不会被复用。 */
  function nextNodeId(nodes: readonly WorkflowNode[]): string {
    let max = 0
    for (const node of nodes) {
      const matched = /^n(\d+)$/.exec(node.id)
      if (matched !== null) max = Math.max(max, Number(matched[1]))
    }
    return `n${max + 1}`
  }

  function addAgentNode(key: string, x: number, y: number): string | null {
    const current = draftOf(key)
    if (current === null) return null
    if (current.nodes.length >= MAX_WORKFLOW_NODES) {
      notify(key, `节点数不能超过 ${MAX_WORKFLOW_NODES} 个。`)
      return null
    }
    const id = nextNodeId(current.nodes)
    const node: WorkflowNode = {
      id,
      type: 'agent',
      title: `节点 ${id.slice(1)}`,
      x: Math.round(x),
      y: Math.round(y),
      expertId: null,
      prompt: '',
      writeScope: null
    }
    setDraft(key, { ...current, nodes: [...current.nodes, node] }, true)
    selectNode(key, id)
    return id
  }

  /** 审批门：不启进程的人工节点，只需要标题与一段给人看的说明。 */
  function addApprovalNode(key: string, x: number, y: number): string | null {
    const current = draftOf(key)
    if (current === null) return null
    if (current.nodes.length >= MAX_WORKFLOW_NODES) {
      notify(key, `节点数不能超过 ${MAX_WORKFLOW_NODES} 个。`)
      return null
    }
    const id = nextNodeId(current.nodes)
    const node: WorkflowNode = {
      id,
      type: 'approval',
      title: `审批 ${id.slice(1)}`,
      x: Math.round(x),
      y: Math.round(y),
      expertId: null,
      prompt: '',
      writeScope: null
    }
    setDraft(key, { ...current, nodes: [...current.nodes, node] }, true)
    selectNode(key, id)
    return id
  }

  function updateNode(key: string, nodeId: string, patch: Partial<Omit<WorkflowNode, 'id' | 'type'>>): void {
    const current = draftOf(key)
    if (current === null) return
    withDraft(key, {
      nodes: current.nodes.map(node => node.id === nodeId ? { ...node, ...patch } : node)
    })
  }

  /** 移动节点只改坐标：拖动结束时调用一次。 */
  function moveNode(key: string, nodeId: string, x: number, y: number): void {
    const current = draftOf(key)
    if (current === null) return
    const target = current.nodes.find(node => node.id === nodeId)
    if (target === undefined) return
    if (target.x === Math.round(x) && target.y === Math.round(y)) return
    withDraft(key, {
      nodes: current.nodes.map(node => node.id === nodeId
        ? { ...node, x: Math.round(x), y: Math.round(y) }
        : node)
    })
  }

  /** 删除节点连同它的边；开始与结束节点不允许删除，图必须始终有这两个端点。 */
  function removeNode(key: string, nodeId: string): void {
    const current = draftOf(key)
    if (current === null) return
    const target = current.nodes.find(node => node.id === nodeId)
    if (target === undefined) return
    if (target.type === 'start' || target.type === 'end') {
      notify(key, '开始与结束节点不能删除。')
      return
    }
    setDraft(key, {
      ...current,
      nodes: current.nodes.filter(node => node.id !== nodeId),
      edges: current.edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId)
    }, true)
    if (selectedOf(key) === nodeId) selectNode(key, null)
    selectEdge(key, null)
  }

  /** 参数名自动生成：在现有名字里取最大编号加一，删掉的不会被复用。 */
  function nextParameterName(parameters: readonly WorkflowParameter[]): string {
    let max = 0
    for (const parameter of parameters) {
      const matched = /^p(\d+)$/.exec(parameter.name)
      if (matched !== null) max = Math.max(max, Number(matched[1]))
    }
    return `p${max + 1}`
  }

  function addParameter(key: string): void {
    const current = draftOf(key)
    if (current === null) return
    if (current.parameters.length >= MAX_WORKFLOW_PARAMETERS) {
      notify(key, `参数不能超过 ${MAX_WORKFLOW_PARAMETERS} 个。`)
      return
    }
    const name = nextParameterName(current.parameters)
    setDraft(key, {
      ...current,
      parameters: [...current.parameters, {
        name,
        label: `参数 ${name.slice(1)}`,
        type: 'text',
        required: false,
        defaultValue: '',
        options: []
      }]
    }, true)
  }

  function updateParameter(
    key: string,
    name: string,
    patch: Partial<Omit<WorkflowParameter, 'name'>>
  ): void {
    const current = draftOf(key)
    if (current === null) return
    setDraft(key, {
      ...current,
      parameters: current.parameters.map(parameter => parameter.name === name
        ? { ...parameter, ...patch, type: (patch.type ?? parameter.type) as WorkflowParameterType }
        : parameter)
    }, true)
  }

  /** 删除参数：提示词里还引用它的话，保存会报「占位符没有对应参数」。 */
  function removeParameter(key: string, name: string): void {
    const current = draftOf(key)
    if (current === null) return
    withDraft(key, { parameters: current.parameters.filter(parameter => parameter.name !== name) })
  }

  /** 连线：同一来源的成功／失败各只能有一条，重复连线就地提示而不悄悄覆盖；条件边可以有多条。 */
  function connect(key: string, source: string, target: string, route: WorkflowEdgeRoute): boolean {
    const current = draftOf(key)
    if (current === null) return false
    if (source === target) {
      notify(key, '不能把节点连到它自己。')
      return false
    }
    if (current.edges.length >= MAX_WORKFLOW_EDGES) {
      notify(key, `边数不能超过 ${MAX_WORKFLOW_EDGES} 条。`)
      return false
    }
    if ((route === 'success' || route === 'failure')
      && current.edges.some(edge => edge.source === source && edge.route === route)) {
      notify(key, '同一节点上的这类路由已经有一条边了。')
      return false
    }
    const id = `e-${source}-${target}-${route}`
    if (current.edges.some(edge => edge.id === id)) return true
    setDraft(key, {
      ...current,
      edges: [...current.edges, { id, source, target, route, condition: null }]
    }, true)
    return true
  }

  /** 修改边的路由与条件：切到条件路由时必须有条件，否则清空。 */
  function updateEdge(
    key: string,
    edgeId: string,
    patch: { readonly route?: WorkflowEdgeRoute; readonly condition?: WorkflowEdgeCondition | null }
  ): void {
    const current = draftOf(key)
    if (current === null) return
    setDraft(key, {
      ...current,
      edges: current.edges.map(edge => {
        if (edge.id !== edgeId) return edge
        const route = patch.route ?? edge.route
        const condition = route === 'condition' ? (patch.condition ?? edge.condition) : null
        return { ...edge, route, condition }
      })
    }, true)
  }

  function removeEdge(key: string, edgeId: string): void {
    const current = draftOf(key)
    if (current === null) return
    withDraft(key, { edges: current.edges.filter(edge => edge.id !== edgeId) })
    if (selectedEdgeOf(key) === edgeId) selectEdge(key, null)
  }

  /** 保存：先本地校验，再交给主进程；成功后用返回的标识接管草稿。 */
  async function save(key: string): Promise<boolean> {
    const current = draftOf(key)
    if (current === null || saving.value) return false
    clearMessages(key)
    const graphIssues = validateWorkflowGraph(current)
    if (graphIssues.length > 0) {
      patchMessages(key, { issues: graphIssues })
      return false
    }
    saving.value = true
    const result = await service.saveWorkflow({
      workflowId: current.id,
      name: current.name,
      summary: current.summary,
      parameters: current.parameters,
      nodes: current.nodes,
      edges: current.edges
    })
    saving.value = false
    if (!result.ok) {
      patchMessages(key, { error: result.error.message, issues: result.issues ?? [] })
      return false
    }
    setDraft(key, { ...current, id: result.data.workflowId }, false)
    patchMessages(key, { notice: '已保存。' })
    await load()
    return true
  }

  async function remove(key: string, workflowId: string): Promise<void> {
    clearMessages(key)
    const result = await service.deleteWorkflow(workflowId)
    if (!result.ok) {
      patchMessages(key, { error: result.error.message })
      return
    }
    patchMessages(key, { notice: '已移入废纸篓。' })
    await load()
  }

  return {
    definitions,
    phase,
    loadError,
    loaded,
    drafts,
    saving,
    messagesOf,
    notify,
    clearMessages,
    draftOf,
    selectedEdge,
    currentNodeOf,
    isDirty,
    load,
    open,
    selectNode,
    selectEdge,
    setName,
    setSummary,
    addAgentNode,
    addApprovalNode,
    addParameter,
    updateParameter,
    removeParameter,
    updateNode,
    moveNode,
    removeNode,
    connect,
    updateEdge,
    removeEdge,
    save,
    remove
  }
})
