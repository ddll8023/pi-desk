<!--
  专家团编辑对话框：新建或修改一份自定义团队（身份、团长、成员、协作约定）。

  表单由本对话框持有，保存交给团队 store：成功后由 store 关闭并重读清单，失败时保留已填内容并就地展示原因。
  团长单选、成员多选都从当前专家清单里选：标识要手写且容易写错，而团长与成员必须指向真实存在的专家。
  团长不能同时是成员——派活只校验「在成员名单里」，团长进了成员就会被开出一个绕过「团长不生产」的成员会话，
  因此选中团长时把它从成员里移除，成员勾选格也禁用它。
  简介会进入团长的系统提示段；协作约定正文只供查看与编辑，不进入提示，界面如实标注这一点。
  新建时标识由主进程分配，界面不提供标识输入——标识即目录名且创建后不可改。
-->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue'
import { MAX_TEAM_DISPLAY_NAME_LENGTH, MAX_TEAM_SUMMARY_LENGTH } from '../../../../shared/teams-api'
import type { TeamSaveRequest } from '../../../../shared/teams-api'
import type { SessionExpertView } from '../../../../shared/session-api'
import { useExpertStore } from '../stores/expert'
import { useTeamStore } from '../stores/team'
import AppButton from '../../ui/AppButton.vue'
import AppSelect from '../../ui/AppSelect.vue'

const props = defineProps<{
  /** 弹层由父级常驻挂载，`open` 控制进入/退出与焦点、快捷键生命周期。 */
  readonly open: boolean
  /** 编辑目标；`null` 表示新建。 */
  readonly teamId: string | null
}>()

const emit = defineEmits<{
  cancel: []
}>()

const teamStore = useTeamStore()
const expertStore = useExpertStore()
const panel = ref<HTMLElement | null>(null)
const titleId = useId()
const leadGroupId = useId()
/** 打开前的焦点元素；关闭后把焦点还给它。 */
let opener: HTMLElement | null = null

const displayName = ref('')
const summary = ref('')
const leadExpertId = ref('')
const memberExpertIds = ref<readonly string[]>([])
const body = ref('')
/** 成员候选项的搜索词：专家多时按名称与标识过滤。 */
const memberQuery = ref('')
const loading = ref(false)
const loadError = ref<string | null>(null)
const saveError = ref<string | null>(null)

const editing = computed(() => props.teamId !== null)
const title = computed(() => (editing.value ? '编辑专家团' : '新建专家团'))
const saving = computed(() => teamStore.saving)
const experts = computed<readonly SessionExpertView[]>(() => expertStore.experts)
const expertLoading = computed(() => !expertStore.loaded && expertStore.loadError === null)

/** 团长候选：一个空选项表示未选，其余是可选的专家。 */
const leadGroups = computed(() => [{
  options: [
    { value: '', label: '未选择' },
    ...experts.value.map(expert => ({
      value: expert.id,
      label: expert.displayName,
      description: expert.summary,
      tag: expert.source === 'builtin' ? '内置' : '自定义'
    }))
  ]
}])

/** 成员候选：按搜索词过滤，团长已被排除在名单外但仍保留在列表里（禁用，说明原因）。 */
const memberRows = computed<readonly SessionExpertView[]>(() => {
  const keyword = memberQuery.value.trim().toLowerCase()
  if (keyword === '') return experts.value
  return experts.value.filter(expert => expert.displayName.toLowerCase().includes(keyword)
    || expert.id.toLowerCase().includes(keyword))
})

const canSave = computed(() => !saving.value
  && displayName.value.trim() !== ''
  && summary.value.trim() !== ''
  && leadExpertId.value !== ''
  && memberExpertIds.value.length > 0)

function toggleMember(expertId: string, event: Event): void {
  if (expertId === leadExpertId.value) return
  const checked = event.target instanceof HTMLInputElement && event.target.checked
  const current = memberExpertIds.value
  memberExpertIds.value = checked
    ? [...current.filter(id => id !== expertId), expertId]
    : current.filter(id => id !== expertId)
}

/** 换团长时把它从成员里移除：同一标识同时当团长与成员会让派活绕过「团长不生产」。 */
function selectLead(value: string): void {
  leadExpertId.value = value
  memberExpertIds.value = memberExpertIds.value.filter(id => id !== value)
}

function resetForm(): void {
  displayName.value = ''
  summary.value = ''
  leadExpertId.value = ''
  memberExpertIds.value = []
  body.value = ''
  memberQuery.value = ''
  loadError.value = null
  saveError.value = null
}

/** 打开时按编辑目标回填；`teamId` 为 null 时只清空表单。 */
async function loadForm(teamId: string | null): Promise<void> {
  loading.value = true
  resetForm()
  if (teamId === null) {
    loading.value = false
    return
  }
  const definition = await teamStore.readDefinition(teamId)
  if (definition === null) {
    loading.value = false
    loadError.value = '没能读到这份团队定义，可以关闭后重试，或直接改定义文件。'
    return
  }
  displayName.value = definition.displayName
  summary.value = definition.summary
  leadExpertId.value = definition.leadExpertId
  memberExpertIds.value = [...definition.memberExpertIds]
  body.value = definition.body
  loading.value = false
}

/** 打开时决定是否要回填；关闭时解绑快捷键并把焦点还回去。 */
watch(
  () => props.open,
  (open) => {
    if (open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      window.addEventListener('keydown', onKeydown)
      void nextTick(() => panel.value?.focus())
      void loadForm(props.teamId)
      return
    }
    window.removeEventListener('keydown', onKeydown)
    opener?.focus()
    opener = null
  },
  { immediate: true }
)

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})

/** 组装保存请求：成员名单里团长已由选择动作排除，这里再按当前团长过滤一次。 */
function buildRequest(): TeamSaveRequest {
  return {
    teamId: props.teamId,
    displayName: displayName.value.trim(),
    summary: summary.value.trim(),
    leadExpertId: leadExpertId.value,
    memberExpertIds: memberExpertIds.value.filter(id => id !== leadExpertId.value),
    body: body.value
  }
}

async function submit(): Promise<void> {
  if (!canSave.value) return
  saveError.value = null
  const result = await teamStore.save(buildRequest())
  if (!result.ok) saveError.value = result.error.message
}

/** 面板内可聚焦元素；Tab 只在弹窗内循环。 */
function focusableElements(): HTMLElement[] {
  const root = panel.value
  if (root === null) return []
  const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  return [...root.querySelectorAll<HTMLElement>(selector)]
    .filter((element) => element.offsetParent !== null)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('cancel')
    return
  }
  if (event.key !== 'Tab') return
  const items = focusableElements()
  const first = items[0]
  const last = items[items.length - 1]
  if (first === undefined || last === undefined) return
  const active = document.activeElement
  if (event.shiftKey && (active === first || active === panel.value)) {
    event.preventDefault()
    last.focus()
    return
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div v-if="props.open" class="dialog-overlay" @click.self="emit('cancel')">
        <Transition name="dialog-panel-motion" appear>
          <div
            ref="panel"
            role="dialog"
            aria-modal="true"
            :aria-labelledby="titleId"
            tabindex="-1"
            class="dialog-panel max-w-2xl"
          >
            <div class="dialog-header">
              <div>
                <h2 :id="titleId" class="dialog-title">{{ title }}</h2>
                <p class="dialog-subtitle">
                  团长拆解任务、成员由独立会话执行；名称、团长与成员可以改，标识创建后不可修改。
                </p>
              </div>
            </div>

            <div class="dialog-body">
              <p v-if="loading" role="status" class="text-xs text-desk-muted">正在读取定义…</p>
              <p v-else-if="loadError !== null" role="alert" class="status-notice status-notice-error">
                {{ loadError }}
              </p>

              <div class="space-y-4">
                <label class="block space-y-1">
                  <span class="field-label">显示名称</span>
                  <input
                    v-model="displayName"
                    class="text-control"
                    type="text"
                    :maxlength="MAX_TEAM_DISPLAY_NAME_LENGTH"
                    placeholder="例如：文档交付小队"
                    :disabled="saving || loading"
                  >
                </label>

                <label class="block space-y-1">
                  <span class="field-label">一句话简介</span>
                  <input
                    v-model="summary"
                    class="text-control"
                    type="text"
                    :maxlength="MAX_TEAM_SUMMARY_LENGTH"
                    placeholder="这个团队交付什么；这句会写进团长的系统提示"
                    :disabled="saving || loading"
                  >
                  <span class="hint-text">会进入团长段的「团队目标」，成员看不到这句。</span>
                </label>

                <div class="space-y-1">
                  <span :id="leadGroupId" class="field-label">团长</span>
                  <p class="hint-text">
                    团长只做拆解、分配、验收与整合；开团时它就是这个会话绑定的专家。
                  </p>
                  <p v-if="expertLoading" role="status" class="text-xs text-desk-muted">正在读取专家清单…</p>
                  <AppSelect
                    v-else
                    id="team-lead"
                    label="团长"
                    :groups="leadGroups"
                    :model-value="leadExpertId"
                    :disabled="saving || loading"
                    @update:model-value="selectLead"
                  />
                  <p v-if="expertStore.loadError !== null" role="alert" class="text-xs text-desk-danger">
                    专家清单读取失败：{{ expertStore.loadError }}
                  </p>
                </div>

                <fieldset class="space-y-2 border-t border-desk-line pt-4">
                  <legend class="field-label">成员</legend>
                  <p class="hint-text">
                    成员由独立会话执行，能力与写入范围取自各自的专家定义；团长不能同时当成员。
                  </p>
                  <input
                    v-model="memberQuery"
                    class="text-control"
                    type="search"
                    placeholder="按名称或标识筛选专家"
                    :disabled="saving || loading"
                  >
                  <p class="text-2xs text-desk-muted">已选 {{ memberExpertIds.length }} 名</p>
                  <ul class="max-h-56 space-y-1 overflow-y-auto scroll-area">
                    <li v-for="expert in memberRows" :key="expert.id">
                      <label class="flex items-start gap-2 text-xs" :class="{ 'opacity-50': expert.id === leadExpertId }">
                        <input
                          type="checkbox"
                          :checked="memberExpertIds.includes(expert.id)"
                          :disabled="saving || loading || expert.id === leadExpertId"
                          @change="toggleMember(expert.id, $event)"
                        >
                        <span class="min-w-0">
                          <span class="font-medium">{{ expert.displayName }}</span>
                          <span class="ml-1 font-mono text-2xs text-desk-muted">{{ expert.id }}</span>
                          <span v-if="expert.id === leadExpertId" class="ml-1 text-2xs text-desk-muted">（当前团长）</span>
                          <span class="block text-2xs text-desk-muted">{{ expert.summary }}</span>
                        </span>
                      </label>
                    </li>
                    <li v-if="memberRows.length === 0" class="text-xs text-desk-muted">
                      没有匹配的专家；先到专家列表新建或派生一位。
                    </li>
                  </ul>
                </fieldset>

                <label class="block space-y-1">
                  <span class="field-label">协作约定</span>
                  <textarea
                    v-model="body"
                    class="text-control font-mono"
                    rows="8"
                    placeholder="这个团队怎么分工、交付要走哪些步骤；只供查看与编辑，目前不进入系统提示"
                    :disabled="saving || loading"
                  ></textarea>
                  <span class="hint-text">这段正文不会进入系统提示；实际约束来自团长与成员各自的专家定义。</span>
                </label>
              </div>
            </div>

            <div class="dialog-footer">
              <p v-if="saveError !== null" role="alert" class="mr-auto text-xs text-desk-danger">
                {{ saveError }}
              </p>
              <p v-else-if="!canSave && !loading" class="mr-auto hint-text">
                名称、简介与团长不能为空，成员至少要有一位。
              </p>
              <AppButton :disabled="saving" @click="emit('cancel')">取消</AppButton>
              <AppButton variant="primary" :disabled="!canSave" @click="submit">
                {{ saving ? '保存中…' : '保存' }}
              </AppButton>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
