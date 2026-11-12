<!--
  默认能力卡片：设置页里唯一改动「专家继承什么」的地方。

  两个维度各自两种口径：继承全部（不落盘列表），或只保留选中的子集。候选项可能很多，
  因此复用能力选择器（自绘勾选行 + 可选筛选），而不是平铺标签。继承模式下不展示候选：
  这一层只决定默认子集，逐项加减留给专家自己。保存后由主进程写进 agent 目录，
  继承模式的专家下一次装配按新范围生效；工具与权限不在这里管。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ExpertCapabilities, ExpertCapabilityDefaults } from '../../../../shared/experts-api'
import AppButton from '../../ui/AppButton.vue'
import ExpertCapabilityPicker from './ExpertCapabilityPicker.vue'

const props = defineProps<{
  readonly capabilities: ExpertCapabilities | null
  readonly error: string | null
  readonly saving: boolean
}>()

const emit = defineEmits<{
  save: [defaults: ExpertCapabilityDefaults]
}>()

/** 两个维度各自的口径；`all` 表示不限制，落盘为 null。 */
const skillsMode = ref<'all' | 'only'>('all')
const mcpMode = ref<'all' | 'only'>('all')
const selectedSkills = ref<readonly string[]>([])
const selectedMcp = ref<readonly string[]>([])

const skills = computed(() => props.capabilities?.skills ?? [])
const mcpServers = computed(() => props.capabilities?.mcpServers ?? [])
const ready = computed(() => props.capabilities !== null)

/** 候选或已保存的基线变化时重建本地勾选；未保存的编辑会被覆盖，但基线只在保存后才变。 */
watch(
  () => props.capabilities?.defaults,
  (defaults) => {
    if (defaults === undefined) return
    skillsMode.value = defaults.skills === null ? 'all' : 'only'
    selectedSkills.value = defaults.skills ?? []
    mcpMode.value = defaults.mcpServers === null ? 'all' : 'only'
    selectedMcp.value = defaults.mcpServers ?? []
  },
  { immediate: true }
)

/** 选择器需要统一的行形状；默认基线里没有「相对基线」的概念，因此状态列留空。 */
const skillRows = computed(() => skills.value.map(skill => ({
  id: skill.id,
  label: skill.source === 'builtin' ? '随包' : '共享目录',
  unavailable: false,
  state: ''
})))

const mcpRows = computed(() => mcpServers.value.map(server => ({
  id: server.name,
  label: server.enabled ? '全局配置' : '配置里已停用',
  unavailable: false,
  state: ''
})))

/** 顺序无关的比较：保存后主进程可能按别的顺序回写，不能因此提示「未保存」。 */
function sameList(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (left === null || right === null) return left === right
  const a = [...left].sort()
  const b = [...right].sort()
  return a.length === b.length && a.every((item, index) => item === b[index])
}

const dirty = computed(() => {
  const defaults = props.capabilities?.defaults
  if (defaults === undefined) return false
  const nextSkills = skillsMode.value === 'all' ? null : [...selectedSkills.value]
  const nextMcp = mcpMode.value === 'all' ? null : [...selectedMcp.value]
  return !sameList(nextSkills, defaults.skills) || !sameList(nextMcp, defaults.mcpServers)
})

function submit(): void {
  emit('save', {
    skills: skillsMode.value === 'all' ? null : [...selectedSkills.value],
    mcpServers: mcpMode.value === 'all' ? null : [...selectedMcp.value]
  })
}
</script>

<template>
  <section class="settings-section" aria-labelledby="settings-experts-defaults-title">
    <div class="settings-section-heading">
      <div>
        <h2 id="settings-experts-defaults-title" class="settings-section-title">默认能力</h2>
        <p class="mt-1 text-xs text-desk-muted">
          专家继承这里的技能与 MCP 范围，再按各自定义增减；工具与权限不受影响。
        </p>
      </div>
    </div>

    <p v-if="error !== null" role="alert" class="status-notice status-notice-error mt-3">
      读取能力候选失败：{{ error }}
    </p>

    <div class="mt-5 border-t border-desk-line pt-5">
      <ExpertCapabilityPicker
        title="技能范围"
        group-label="默认技能范围"
        :mode="skillsMode === 'all' ? 'inherit' : 'only'"
        :selected="selectedSkills"
        :rows="skillRows"
        :max-refs="skills.length"
        inherit-label="继承全部技能"
        only-label="只保留选中"
        inherit-hint="默认全部技能可用；要排除个别项时切到「只保留选中」。"
        only-hint="未勾选的技能不会装配到继承型专家的会话里。"
        search-placeholder="按名称筛选技能"
        empty-text="没有匹配的技能。"
        no-rows-text="随包与共享目录里都没有技能。"
        :ready="ready"
        :disabled="saving"
        @update:mode="skillsMode = $event === 'inherit' ? 'all' : 'only'"
        @update:selected="selectedSkills = $event"
      />
    </div>

    <div class="mt-5 border-t border-desk-line pt-5">
      <ExpertCapabilityPicker
        title="MCP 服务器"
        group-label="默认 MCP 服务器范围"
        :mode="mcpMode === 'all' ? 'inherit' : 'only'"
        :selected="selectedMcp"
        :rows="mcpRows"
        :max-refs="mcpServers.length"
        inherit-label="继承全部服务器"
        only-label="只保留选中"
        inherit-hint="默认连接全部已配置的服务器；要排除个别项时切到「只保留选中」。"
        only-hint="未勾选的服务器在会话里不连接，不启动子进程也不占凭据。"
        search-placeholder="按名称筛选服务器"
        empty-text="没有匹配的服务器。"
        no-rows-text="全局 mcp.json 里还没有服务器；先到资源页添加，再回来勾选。"
        :ready="ready"
        :disabled="saving"
        @update:mode="mcpMode = $event === 'inherit' ? 'all' : 'only'"
        @update:selected="selectedMcp = $event"
      />
    </div>

    <div class="mt-5 flex flex-wrap items-center gap-3 border-t border-desk-line pt-5">
      <AppButton variant="primary" :disabled="saving || !ready || !dirty" @click="submit">
        {{ saving ? '保存中…' : '保存默认能力' }}
      </AppButton>
      <span class="hint-text">
        {{ dirty ? '有未保存的改动。' : '与已保存的基线一致。' }}保存后新建会话生效。
      </span>
    </div>
  </section>
</template>
