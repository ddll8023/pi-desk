<!--
  默认能力卡片：设置页里唯一改动「专家继承什么」的地方。

  只有一份集合：勾选即当前可用的技能与 MCP 服务器；勾满等于「不限制」。
  因此界面没有「继承全部／只保留选中」的模式切换，也没有第二份状态。
  保存时按集合是否等于全集归一：等于写 null（不限制），否则写白名单。
  技能至少保留一个（清空会让继承型专家连随包技能都拿不到），MCP 允许清空。
  保存后由主进程写进 agent 目录，新建会话按新范围生效；工具与权限不在这里管。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ExpertCapabilities, ExpertCapabilityDefaults } from '../../../../shared/experts-api'
import AppButton from '../../ui/AppButton.vue'
import { skillSourceLabel } from '../skill-source-label'
import ExpertCapabilityPicker from './ExpertCapabilityPicker.vue'

const props = defineProps<{
  readonly capabilities: ExpertCapabilities | null
  readonly error: string | null
  readonly saving: boolean
}>()

const emit = defineEmits<{
  save: [defaults: ExpertCapabilityDefaults]
}>()

const skills = computed(() => props.capabilities?.skills ?? [])
const mcpServers = computed(() => props.capabilities?.mcpServers ?? [])
const ready = computed(() => props.capabilities !== null)
const allSkillIds = computed(() => skills.value.map(item => item.id))
const allMcpNames = computed(() => mcpServers.value.map(item => item.name))

/** 当前可用的技能与服务器；基线里 `null` 等于全部候选。 */
const selectedSkills = ref<readonly string[]>([])
const selectedMcp = ref<readonly string[]>([])
/** 两个区块默认展开：收起会把候选重新藏起来，不应成为默认。 */
const skillsExpanded = ref(true)
const mcpExpanded = ref(true)

/** 候选或已保存的基线变化时重建勾选；未保存的编辑会被覆盖，但基线只在保存后才变。 */
watch(
  () => props.capabilities,
  (capabilities) => {
    if (capabilities === null) return
    selectedSkills.value = capabilities.defaults.skills ?? allSkillIds.value
    selectedMcp.value = capabilities.defaults.mcpServers ?? allMcpNames.value
  },
  { immediate: true }
)

/** 选择器需要统一的行形状；默认基线里没有「相对基线」的概念，因此状态列留空。 */
const skillRows = computed(() => skills.value.map(skill => ({
  id: skill.id,
  label: skill.source === 'shared' ? '' : skillSourceLabel(skill.source),
  unavailable: false,
  state: ''
})))

const mcpRows = computed(() => mcpServers.value.map(server => ({
  id: server.name,
  label: server.enabled ? '' : '配置里已停用',
  unavailable: false,
  state: ''
})))

/** 勾满时只说结论，部分选中才给数量。 */
const skillCount = computed(() => {
  const total = skills.value.length
  if (total === 0) return ''
  return selectedSkills.value.length === total
    ? `${total} 个全部可用`
    : `已选 ${selectedSkills.value.length} / ${total}`
})
const mcpCount = computed(() => {
  const total = mcpServers.value.length
  if (total === 0) return ''
  return selectedMcp.value.length === total
    ? `${total} 个全部可用`
    : `已选 ${selectedMcp.value.length} / ${total}`
})

/** `null` 表示不限制，比较时按全集展开，避免「显式全选」与「不限制」被当成脏改动。 */
function sameSelection(current: readonly string[], stored: readonly string[] | null, all: readonly string[]): boolean {
  const left = [...current].sort()
  const right = [...(stored ?? all)].sort()
  return left.length === right.length && left.every((item, index) => item === right[index])
}

const dirty = computed(() => {
  const defaults = props.capabilities?.defaults
  if (defaults === undefined) return false
  return !sameSelection(selectedSkills.value, defaults.skills, allSkillIds.value)
    || !sameSelection(selectedMcp.value, defaults.mcpServers, allMcpNames.value)
})

/** 技能清空会让继承型专家连随包技能都拿不到，所以至少保留一个。 */
const skillsEmpty = computed(() => ready.value && skills.value.length > 0 && selectedSkills.value.length === 0)

/** 勾满写 `null`（不限制），否则写白名单。 */
function normalized(current: readonly string[], all: readonly string[]): readonly string[] | null {
  return current.length === all.length ? null : [...current]
}

function submit(): void {
  if (skillsEmpty.value) return
  emit('save', {
    skills: normalized(selectedSkills.value, allSkillIds.value),
    mcpServers: normalized(selectedMcp.value, allMcpNames.value)
  })
}
</script>

<template>
  <section class="settings-section" aria-labelledby="settings-experts-defaults-title">
    <div class="settings-section-heading">
      <div>
        <h2 id="settings-experts-defaults-title" class="settings-section-title">默认能力</h2>
      </div>
    </div>

    <p v-if="error !== null" role="alert" class="status-notice status-notice-error mt-3">
      读取能力候选失败：{{ error }}
    </p>

    <div class="mt-5 border-t border-desk-line pt-5">
      <ExpertCapabilityPicker
        title="技能范围"
        :selected="selectedSkills"
        :rows="skillRows"
        :count-text="skillCount"
        select-all-label="全选"
        search-placeholder="按名称筛选技能"
        empty-text="没有匹配的技能。"
        no-rows-text="随包、产品目录与共享目录里都没有技能。"
        :ready="ready"
        :disabled="saving"
        collapsible
        :collapsed="!skillsExpanded"
        @toggle-collapse="skillsExpanded = !skillsExpanded"
        @select-all="selectedSkills = [...allSkillIds]"
        @update:selected="selectedSkills = $event"
      />
      <p v-if="skillsExpanded" class="hint-text">项目自带技能始终可用，不受此处限制。</p>
    </div>

    <div class="mt-5 border-t border-desk-line pt-5">
      <ExpertCapabilityPicker
        title="MCP 服务器"
        :selected="selectedMcp"
        :rows="mcpRows"
        :count-text="mcpCount"
        select-all-label="全选"
        search-placeholder="按名称筛选服务器"
        empty-text="没有匹配的服务器。"
        no-rows-text="全局 mcp.json 里还没有服务器；先到资源页添加，再回来勾选。"
        :ready="ready"
        :disabled="saving"
        collapsible
        :collapsed="!mcpExpanded"
        @toggle-collapse="mcpExpanded = !mcpExpanded"
        @select-all="selectedMcp = [...allMcpNames]"
        @update:selected="selectedMcp = $event"
      />
    </div>

    <div class="mt-5 flex flex-wrap items-center gap-3 border-t border-desk-line pt-5">
      <AppButton
        variant="primary"
        :disabled="saving || !ready || !dirty || skillsEmpty"
        @click="submit"
      >
        {{ saving ? '保存中…' : '保存默认能力' }}
      </AppButton>
      <span v-if="skillsEmpty" class="hint-text text-desk-warning">至少保留一个技能。</span>
      <span v-else-if="dirty" class="hint-text">有未保存的改动；保存后对新建会话生效。</span>
    </div>
  </section>
</template>
