<!--
  工作流标签页：左侧定义清单，中间节点图画布，右侧节点检查器，下方运行面板。

  一个标签对应一份定义：标签键是 `workflow:<标识>`，标识为空串时是一张还没保存的新图。
  草稿按标签键存在 store 里，两个标签同时打开时各自编辑自己的图。
  画布只管形态与配置，运行在主进程推进；切到另一份定义时若有未保存改动，先要求保存，
  不静默丢弃——画布上的改动没有撤销栈可回退。
  新建节点与连线都走工具条：节点点击选中后在右侧配置，拖拽连线按当前选中的路由建边。
-->
<script setup lang="ts">
import { computed, markRaw, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { Background, Controls, MiniMap, VueFlow } from '@xyflow/vue'
import type { Connection } from '@xyflow/vue'
import '@xyflow/vue/style.css'
import { WORKFLOW_EDGE_ROUTE_LABELS, WORKFLOW_EDGE_ROUTES } from '../../../../shared/workflow-api'
import type {
  WorkflowConditionKind,
  WorkflowEdgeRoute,
  WorkflowNode,
  WorkflowNodeStatus,
  WorkflowParameter
} from '../../../../shared/workflow-api'
import { useExpertStore } from '../../experts/stores/expert'
import { useProjectStore } from '../../projects/stores/project'
import { useWorkflowStore } from '../stores/workflow'
import { useWorkflowRunStore } from '../stores/workflow-run'
import AppButton from '../../ui/AppButton.vue'
import WorkflowNodeCard from './WorkflowNodeCard.vue'
import WorkflowNodeInspector from './WorkflowNodeInspector.vue'
import WorkflowEdgeInspector from './WorkflowEdgeInspector.vue'
import WorkflowRunPanel from './WorkflowRunPanel.vue'
import WorkflowParameterEditor from './WorkflowParameterEditor.vue'
import WorkflowRunDialog from './WorkflowRunDialog.vue'
import WorkflowSchedulePanel from './WorkflowSchedulePanel.vue'

const props = defineProps<{
  /** 标签键：草稿按它分开存。 */
  readonly tabKey: string
  /** 标签键里的工作流标识；空串表示未保存的新图。 */
  readonly workflowId: string
}>()

const emit = defineEmits<{
  /** 新图首次保存成功后报出真实标识，由标签层把标签改绑到它。 */
  saved: [workflowId: string]
}>()

const store = useWorkflowStore()
const runStore = useWorkflowRunStore()
const expertStore = useExpertStore()
const projectStore = useProjectStore()
const { definitions, saving, loadError, loaded } = storeToRefs(store)
const { run, runs, busy: runBusy, error: runError, waitingNodeId } = storeToRefs(runStore)
const { experts } = storeToRefs(expertStore)

/** 连线后使用的路由：工具条上选择，拖拽出来的边按它落库。 */
const connectRoute = ref<WorkflowEdgeRoute>('always')
const nodeTypes = { workflow: markRaw(WorkflowNodeCard) }
/** 定义级对话框：参数定义、启动前填参、定时任务。 */
const parameterOpen = ref(false)
const runOpen = ref(false)
const scheduleOpen = ref(false)

const draft = computed(() => store.draftOf(props.tabKey))
const dirty = computed(() => store.isDirty(props.tabKey))
const currentNode = computed(() => store.currentNodeOf(props.tabKey))
const selectedEdge = computed(() => store.selectedEdge(props.tabKey))
/** 提示按标签键分开：一个标签的校验错误不显示在另一个标签上。 */
const messages = computed(() => store.messagesOf(props.tabKey))

const expertNames = computed(() => new Map(experts.value.map(expert => [expert.id, expert.displayName])))

/**
 * 画布节点与边的形状由本页自己声明：Vue Flow 2.x 只导出组件与 `Connection` 这类交互类型，
 * 图数据形状在这里已经是自有契约（`WorkflowNode`），不需要再借库的泛型。
 */
interface FlowNode {
  readonly id: string
  readonly type: string
  readonly position: { readonly x: number; readonly y: number }
  readonly data: {
    readonly node: WorkflowNode
    readonly expertName: string | null
    readonly runStatus: WorkflowNodeStatus | null
  }
}

interface FlowEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly label: string
  readonly class: string
}

const nodes = ref<FlowNode[]>([])

/** 按草稿与运行状态重建画布节点：位置以草稿为准，状态从运行快照取。 */
function rebuildNodes(): void {
  const statuses = new Map((run.value?.nodes ?? []).map(item => [item.nodeId, item.status]))
  nodes.value = (draft.value?.nodes ?? []).map(node => ({
    id: node.id,
    type: 'workflow',
    position: { x: node.x, y: node.y },
    data: {
      node,
      expertName: node.expertId === null ? null : expertNames.value.get(node.expertId) ?? null,
      runStatus: statuses.get(node.id) ?? null
    }
  }))
}

/**
 * 草稿结构变化时重建节点。运行时只就地换 `data.runStatus`，不重建坐标——
 * 否则运行快照每推一次就把正在拖的节点拉回原位。
 */
watch([() => draft.value?.nodes, expertNames], () => { rebuildNodes() }, { immediate: true })
watch(() => run.value?.nodes, items => {
  const statuses = new Map((items ?? []).map(item => [item.nodeId, item.status]))
  nodes.value = nodes.value.map(node => ({
    ...node,
    data: { ...node.data, runStatus: statuses.get(node.id) ?? null }
  }))
})

const edges = computed<FlowEdge[]>(() => (draft.value?.edges ?? []).map(edge => ({
  id: edge.id,
  source: edge.source,
  target: edge.target,
  label: WORKFLOW_EDGE_ROUTE_LABELS[edge.route],
  class: `workflow-edge is-${edge.route}`
})))

onMounted(async () => {
  await store.load()
  await expertStore.load()
  await store.open(props.tabKey, props.workflowId)
  runStore.setContext(props.workflowId === '' ? null : props.workflowId)
  if (props.workflowId !== '') void runStore.loadRuns(props.workflowId)
})

watch(() => props.workflowId, async workflowId => {
  // 标签改绑或外部切换：草稿有未保存改动时拦住，与列表切换同一套守卫。
  if (dirty.value && workflowId !== draft.value?.id) {
    store.notify(props.tabKey, '当前图有未保存改动，先保存再切换。')
    return
  }
  await store.open(props.tabKey, workflowId)
  runStore.reset()
  runStore.setContext(workflowId === '' ? null : workflowId)
  if (workflowId !== '') void runStore.loadRuns(workflowId)
})

// 不在卸载时丢弃草稿：切换项目会让整个标签层重建，而标签本身仍在，
// 未保存的图不能因此消失；草稿按标签键保留，重新打开同一标签时会重新读取定义。

/** 切换定义：有未保存改动时先拦住，避免一次点击丢掉整张图。 */
async function selectDefinition(workflowId: string): Promise<void> {
  if (workflowId === draft.value?.id) return
  if (dirty.value) {
    store.clearMessages()
    store.notify(props.tabKey, '当前图有未保存改动，先保存再切换。')
    return
  }
  await store.open(props.tabKey, workflowId)
  runStore.reset()
}

function createDefinition(): void {
  if (dirty.value) {
    store.notify(props.tabKey, '当前图有未保存改动，先保存再新建。')
    return
  }
  void store.open(props.tabKey, '')
  runStore.reset()
}

function onConnect(connection: Connection): void {
  store.connect(props.tabKey, connection.source, connection.target, connectRoute.value)
}

function onNodeClick(payload: { node?: { id?: string } }): void {
  const nodeId = payload.node?.id
  if (nodeId === undefined) return
  store.selectNode(props.tabKey, nodeId)
}

/** 节点检查器的改动落到当前选中节点：同理不让模板处理可能为空的值。 */
function onNodeUpdate(patch: Partial<Omit<WorkflowNode, 'id' | 'type'>>): void {
  const node = currentNode.value
  if (node === null) return
  store.updateNode(props.tabKey, node.id, patch)
}

function onNodeRemove(): void {
  const node = currentNode.value
  if (node === null) return
  store.removeNode(props.tabKey, node.id)
}

function onPaneClick(): void {
  store.selectNode(props.tabKey, null)
  store.selectEdge(props.tabKey, null)
}

function onEdgeClick(payload: { edge?: { id?: string } }): void {
  const edgeId = payload.edge?.id
  if (edgeId === undefined) return
  store.selectEdge(props.tabKey, edgeId)
}

/** 边检查器的改动落到当前选中的边：模板不直接取可能为空的 computed。 */
function onEdgeUpdate(patch: { readonly route?: WorkflowEdgeRoute; readonly condition?: { kind: WorkflowConditionKind; value: string } | null }): void {
  const edge = selectedEdge.value
  if (edge === null) return
  store.updateEdge(props.tabKey, edge.id, patch)
}

function onEdgeRemove(): void {
  const edge = selectedEdge.value
  if (edge === null) return
  store.removeEdge(props.tabKey, edge.id)
}

function onNodeDragStop(payload: { node?: { id?: string; position?: { x: number; y: number } } }): void {
  const node = payload.node
  if (node?.id === undefined || node.position === undefined) return
  store.moveNode(props.tabKey, node.id, node.position.x, node.position.y)
}

function addNode(): void {
  const count = draft.value?.nodes.length ?? 0
  store.addAgentNode(props.tabKey, 140 + (count % 4) * 60, 120 + count * 40)
}

function addApprovalNode(): void {
  const count = draft.value?.nodes.length ?? 0
  store.addApprovalNode(props.tabKey, 140 + (count % 4) * 60, 160 + count * 40)
}

async function saveDefinition(): Promise<void> {
  const wasDraft = draft.value?.id === ''
  const saved = await store.save(props.tabKey)
  if (!saved) return
  await runStore.reset()
  const savedId = draft.value?.id ?? ''
  if (wasDraft && savedId !== '') emit('saved', savedId)
  // 保存不清历史运行：面板上的回放列表与定义无关，重新拉一次即可。
  if (savedId !== '') void runStore.loadRuns(savedId)
}

async function startRun(): Promise<void> {
  const current = draft.value
  if (current === null) return
  if (current.id === '') {
    store.notify(props.tabKey, '先保存一次，再运行。')
    return
  }
  // 有参数就先填：缺必填值的运行会被主进程拒绝，不如在这里拦住。
  if (current.parameters.length > 0) {
    runOpen.value = true
    return
  }
  await runStore.start(current.id, projectStore.currentProject?.path ?? null, {})
}

async function submitRun(values: Record<string, string>): Promise<void> {
  const current = draft.value
  if (current === null) return
  const started = await runStore.start(current.id, projectStore.currentProject?.path ?? null, values)
  if (started) runOpen.value = false
}

function addParameter(): void {
  store.addParameter(props.tabKey)
}

function updateParameter(name: string, patch: Partial<Omit<WorkflowParameter, 'name'>>): void {
  store.updateParameter(props.tabKey, name, patch)
}

function removeParameter(name: string): void {
  store.removeParameter(props.tabKey, name)
}

async function deleteDefinition(workflowId: string): Promise<void> {
  const isCurrent = draft.value?.id === workflowId
  if (isCurrent && dirty.value) {
    store.notify(props.tabKey, '当前图有未保存改动，先保存再删除。')
    return
  }
  await store.remove(props.tabKey, workflowId)
  // 删掉的是当前打开的这份：换回空白图，否则草稿还指向已不存在的标识。
  if (isCurrent) {
    await store.open(props.tabKey, '')
    runStore.reset()
    runStore.setContext(null)
  }
}
</script>

<template>
  <div class="workflow-view">
    <aside class="workflow-list">
      <header class="workflow-list-head">
        <h1 class="text-sm font-semibold">工作流</h1>
        <AppButton variant="compact" @click="createDefinition">新建</AppButton>
      </header>
      <p v-if="loadError !== null" class="workflow-error">{{ loadError }}</p>
      <p v-else-if="definitions.length === 0" class="text-xs text-desk-muted">还没有保存过工作流。</p>
      <ul v-else class="workflow-list-items">
        <li v-for="item in definitions" :key="item.id">
          <button
            type="button"
            class="workflow-list-item"
            :class="{ 'is-active': draft?.id === item.id }"
            @click="selectDefinition(item.id)"
          >
            <span class="workflow-list-item-name">{{ item.name }}</span>
            <span class="text-2xs text-desk-muted">{{ item.nodeCount }} 个节点</span>
          </button>
          <button type="button" class="workflow-list-remove" title="移入废纸篓" @click="deleteDefinition(item.id)">×</button>
        </li>
      </ul>
    </aside>

    <div class="workflow-main">
      <header class="workflow-toolbar">
        <input
          class="workflow-input workflow-name"
          :value="draft?.name ?? ''"
          maxlength="64"
          placeholder="工作流名称"
          :disabled="draft === null"
          @input="store.setName(tabKey, ($event.target as HTMLInputElement).value)"
        >
        <label class="workflow-route-picker">
          <span class="text-2xs text-desk-muted">新连线路由</span>
          <select v-model="connectRoute" class="workflow-input">
            <option v-for="route in WORKFLOW_EDGE_ROUTES" :key="route" :value="route">
              {{ WORKFLOW_EDGE_ROUTE_LABELS[route] }}
            </option>
          </select>
        </label>
        <div class="ml-auto flex items-center gap-2">
          <AppButton variant="compact" :disabled="draft === null" @click="addNode">添加节点</AppButton>
          <AppButton variant="compact" :disabled="draft === null" @click="addApprovalNode">添加审批门</AppButton>
          <AppButton variant="compact" :disabled="draft === null" @click="parameterOpen = true">
            参数{{ draft !== null && draft.parameters.length > 0 ? `（${draft.parameters.length}）` : '' }}
          </AppButton>
          <AppButton
            variant="compact"
            :disabled="draft === null || draft.id === ''"
            @click="scheduleOpen = true"
          >
            定时
          </AppButton>
          <AppButton variant="compact" :disabled="!loaded || saving" @click="saveDefinition">
            {{ saving ? '保存中…' : dirty ? '保存 *' : '保存' }}
          </AppButton>
          <AppButton variant="primary" :disabled="draft === null || draft.id === '' || runBusy" @click="startRun">
            运行
          </AppButton>
        </div>
      </header>

      <div class="workflow-canvas">
        <VueFlow
          v-if="draft !== null"
          v-model:nodes="nodes"
          :edges="edges"
          :node-types="nodeTypes"
          :min-zoom="0.3"
          :max-zoom="1.6"
          fit-view-on-init
          @connect="onConnect"
          @node-click="onNodeClick"
          @edge-click="onEdgeClick"
          @pane-click="onPaneClick"
          @node-drag-stop="onNodeDragStop"
        >
          <Background />
          <Controls />
          <MiniMap />
        </VueFlow>
        <p v-else class="workflow-canvas-empty">选择左侧的一份工作流，或点「新建」开始画。</p>
      </div>

      <div
        v-if="messages.error !== null || messages.notice !== null || messages.issues.length > 0 || runError !== null"
        class="workflow-messages"
      >
        <p v-if="messages.error !== null" class="workflow-error">{{ messages.error }}</p>
        <p v-if="runError !== null" class="workflow-error">{{ runError }}</p>
        <p v-if="messages.notice !== null" class="workflow-notice">{{ messages.notice }}</p>
        <ul v-if="messages.issues.length > 0" class="workflow-error">
          <li v-for="issue in messages.issues" :key="`${issue.kind}-${issue.nodeId ?? ''}-${issue.message}`">{{ issue.message }}</li>
        </ul>
      </div>

      <WorkflowRunPanel
        :run="run"
        :runs="runs"
        :nodes="draft?.nodes ?? []"
        :waiting-node-id="waitingNodeId"
        :busy="runBusy"
        @cancel="runStore.cancel()"
        @approve="approved => runStore.approve(approved)"
        @select-run="runId => runStore.selectRun(runId)"
      />
    </div>

    <aside class="workflow-side">
      <WorkflowEdgeInspector
        v-if="selectedEdge !== null"
        :edge="selectedEdge"
        :nodes="draft?.nodes ?? []"
        @update="onEdgeUpdate"
        @remove="onEdgeRemove"
      />
      <WorkflowNodeInspector
        v-else-if="currentNode !== null"
        :node="currentNode"
        :experts="experts"
        @update="onNodeUpdate"
        @remove="onNodeRemove"
      />
      <p v-else class="text-xs text-desk-muted">点选一个节点或一条连线来配置它。</p>
    </aside>

    <WorkflowParameterEditor
      :open="parameterOpen"
      :parameters="draft?.parameters ?? []"
      @close="parameterOpen = false"
      @add="addParameter"
      @update="updateParameter"
      @remove="removeParameter"
    />

    <WorkflowRunDialog
      :open="runOpen"
      :parameters="draft?.parameters ?? []"
      :busy="runBusy"
      :error="runError"
      @close="runOpen = false"
      @submit="submitRun"
    />

    <WorkflowSchedulePanel
      :open="scheduleOpen"
      :workflow-id="draft !== null && draft.id !== '' ? draft.id : null"
      :parameters="draft?.parameters ?? []"
      :project-path="projectStore.currentProject?.path ?? null"
      @close="scheduleOpen = false"
    />
  </div>
</template>

<style scoped>
.workflow-view {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr) 280px;
  min-height: 0;
  height: 100%;
}

.workflow-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-right: 1px solid var(--color-desk-border);
  overflow-y: auto;
}

.workflow-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.workflow-list-items {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.workflow-list-items li {
  display: flex;
  align-items: center;
  gap: 4px;
}

.workflow-list-item {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: 6px;
  text-align: left;
}

.workflow-list-item:hover {
  background: var(--color-desk-surface-subtle);
}

.workflow-list-item.is-active {
  background: var(--color-desk-accent-soft);
}

.workflow-list-item-name {
  font-size: 13px;
  line-height: 1.3;
}

.workflow-list-remove {
  padding: 2px 6px;
  color: var(--color-desk-muted);
}

.workflow-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.workflow-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-desk-border);
}

.workflow-name {
  width: 200px;
  border: 1px solid var(--color-desk-border);
  border-radius: 6px;
  background: transparent;
  font-size: 12px;
}

.workflow-input {
  padding: 5px 8px;
  border: 1px solid var(--color-desk-border);
  border-radius: 6px;
  background: transparent;
  font-size: 12px;
}

.workflow-route-picker {
  display: flex;
  align-items: center;
  gap: 6px;
}

.workflow-canvas {
  position: relative;
  flex: 1;
  min-height: 320px;
}

.workflow-canvas-empty {
  padding: 24px;
  font-size: 13px;
  color: var(--color-desk-muted);
}

.workflow-messages {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 12px;
}

.workflow-error {
  font-size: 12px;
  color: var(--color-desk-danger);
}

.workflow-notice {
  font-size: 12px;
  color: var(--color-desk-muted);
}

.workflow-run-panel {
  padding: 10px 12px;
  border-top: 1px solid var(--color-desk-border);
  max-height: 40%;
  overflow-y: auto;
}

.workflow-run-events {
  margin-top: 10px;
  font-size: 11px;
}

.workflow-run-events ul {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.workflow-run-events .is-warn { color: #b45309; }
.workflow-run-events .is-error { color: var(--color-desk-danger); }

.workflow-side {
  padding: 12px;
  border-left: 1px solid var(--color-desk-border);
  overflow-y: auto;
}
</style>
