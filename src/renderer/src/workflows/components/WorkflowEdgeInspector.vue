<!--
  边检查器：选中一条边后配置它的路由与条件。

  状态边（成功、失败、总是）按节点终态走；条件边按源节点的结论文本求值。
  切到条件路由时必须填条件，否则保存会因「缺少条件」被拒——这里先把话说明白，
  不靠保存失败来提示。条件只作用于「没有状态边可走」的分支，规则写在面板里。
  路由下拉的取值按枚举核对后才上报：手改 DOM 或旧稿里的非法值不会写进草稿。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  WORKFLOW_CONDITION_KINDS,
  WORKFLOW_CONDITION_LABELS,
  WORKFLOW_EDGE_ROUTE_LABELS,
  WORKFLOW_EDGE_ROUTES,
  MAX_WORKFLOW_CONDITION_LENGTH
} from '../../../../shared/workflow-api'
import type {
  WorkflowConditionKind,
  WorkflowEdge,
  WorkflowEdgeRoute,
  WorkflowNode
} from '../../../../shared/workflow-api'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  readonly edge: WorkflowEdge
  readonly nodes: readonly WorkflowNode[]
}>()

const emit = defineEmits<{
  update: [patch: { readonly route?: WorkflowEdgeRoute; readonly condition?: { kind: WorkflowConditionKind; value: string } | null }]
  remove: []
}>()

const kind = ref<WorkflowConditionKind>('contains')
const value = ref('')
const conditionError = ref<string | null>(null)

const sourceTitle = computed(() => props.nodes.find(node => node.id === props.edge.source)?.title ?? props.edge.source)
const targetTitle = computed(() => props.nodes.find(node => node.id === props.edge.target)?.title ?? props.edge.target)

watch(() => props.edge, edge => {
  kind.value = edge.condition?.kind ?? 'contains'
  value.value = edge.condition?.value ?? ''
  conditionError.value = null
}, { immediate: true })

/** 下拉只认枚举里的路由：非法取值直接忽略，并说明为什么没生效。 */
function toEdgeRoute(candidate: string): WorkflowEdgeRoute | null {
  return WORKFLOW_EDGE_ROUTES.find(route => route === candidate) ?? null
}

function changeRoute(event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  const route = toEdgeRoute(target.value)
  if (route === null) {
    conditionError.value = '无法识别的路由，按原值保留。'
    return
  }
  if (route === 'condition') {
    const current = value.value.trim()
    emit('update', {
      route,
      condition: current === '' ? null : { kind: kind.value, value: current }
    })
    return
  }
  emit('update', { route })
}

function applyCondition(): void {
  const text = value.value.trim()
  if (text === '') {
    conditionError.value = '条件不能为空。'
    emit('update', { condition: null })
    return
  }
  if (text.length > MAX_WORKFLOW_CONDITION_LENGTH) {
    conditionError.value = `条件不能超过 ${MAX_WORKFLOW_CONDITION_LENGTH} 个字符。`
    return
  }
  if (kind.value === 'regex') {
    try {
      new RegExp(text)
    } catch {
      conditionError.value = '正则写错了，保存时也会被拒绝。'
      return
    }
  }
  conditionError.value = null
  emit('update', { route: 'condition', condition: { kind: kind.value, value: text } })
}
</script>

<template>
  <section class="workflow-inspector">
    <header class="workflow-inspector-head">
      <h2 class="text-sm font-semibold">连线</h2>
      <span class="text-2xs text-desk-muted">{{ sourceTitle }} → {{ targetTitle }}</span>
    </header>

    <label class="block space-y-1">
      <span class="field-label">路由</span>
      <select class="text-control" :value="edge.route" @change="changeRoute($event)">
        <option v-for="route in WORKFLOW_EDGE_ROUTES" :key="route" :value="route">
          {{ WORKFLOW_EDGE_ROUTE_LABELS[route] }}
        </option>
      </select>
    </label>

    <template v-if="edge.route === 'condition'">
      <label class="block space-y-1">
        <span class="field-label">判定方式</span>
        <select v-model="kind" class="text-control" @change="applyCondition">
          <option v-for="item in WORKFLOW_CONDITION_KINDS" :key="item" :value="item">
            {{ WORKFLOW_CONDITION_LABELS[item] }}
          </option>
        </select>
      </label>

      <label class="block space-y-1">
        <span class="field-label">条件</span>
        <input
          v-model="value"
          class="text-control"
          :maxlength="MAX_WORKFLOW_CONDITION_LENGTH"
          placeholder="对源节点的结论文本求值"
          @change="applyCondition"
        >
      </label>
      <p v-if="conditionError !== null" class="text-xs text-desk-danger">{{ conditionError }}</p>
      <p class="text-xs text-desk-muted">状态边优先：只有当源节点没有可走的成功／失败／总是边时，条件边才参与判定。</p>
    </template>

    <AppButton variant="danger" class="mt-2 w-full" @click="emit('remove')">
      删除连线
    </AppButton>
  </section>
</template>

<style scoped>
.workflow-inspector {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.workflow-inspector-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
