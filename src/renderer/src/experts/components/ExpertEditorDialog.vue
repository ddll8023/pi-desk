<!--
  专家编辑对话框：新建或修改一份自定义专家（显示名称、一句话简介、技能引用、正文）。

  表单由本对话框持有，保存交给专家 store：成功后由 store 关闭并重读清单，失败时保留已填内容并就地展示原因。
  技能引用按逗号分隔的标识输入；写法不合法的引用在保存时被主进程拒绝，不可用的引用只在保存结果里回报。
  新建时标识由主进程分配，界面不提供标识输入——标识即目录名且创建后不可改，让用户填只会填错。
-->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue'
import { MAX_EXPERT_DISPLAY_NAME_LENGTH, MAX_EXPERT_SUMMARY_LENGTH } from '../../../../shared/experts-api'
import { useExpertStore } from '../stores/expert'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  /** 弹层由父级常驻挂载，`open` 控制进入/退出与焦点、快捷键生命周期。 */
  readonly open: boolean
  /** 编辑目标；`null` 表示新建。 */
  readonly expertId: string | null
}>()

const emit = defineEmits<{
  cancel: []
}>()

const store = useExpertStore()
const panel = ref<HTMLElement | null>(null)
const titleId = useId()
/** 打开前的焦点元素；关闭后把焦点还给它。 */
let opener: HTMLElement | null = null

const displayName = ref('')
const summary = ref('')
/** 技能引用按逗号分隔的文本编辑；保存时拆成数组，空串表示不引用。 */
const skillsText = ref('')
const body = ref('')
const loading = ref(false)
const loadError = ref<string | null>(null)
const saveError = ref<string | null>(null)

const editing = computed(() => props.expertId !== null)
const title = computed(() => (editing.value ? '编辑专家' : '新建专家'))
const saving = computed(() => store.saving)
const skillIds = computed(() => skillsText.value
  .split(/[,，\s]+/)
  .map(item => item.trim())
  .filter(item => item !== ''))
const canSave = computed(() => !saving.value
  && displayName.value.trim() !== ''
  && summary.value.trim() !== ''
  && body.value.trim() !== '')

/** 打开时重置表单并按编辑目标回填；关闭时解绑快捷键并把焦点还回去。 */
watch(
  () => props.open,
  (open) => {
    if (open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      displayName.value = ''
      summary.value = ''
      skillsText.value = ''
      body.value = ''
      loadError.value = null
      saveError.value = null
      window.addEventListener('keydown', onKeydown)
      void nextTick(() => panel.value?.focus())
      const target = props.expertId
      if (target !== null) void fill(target)
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

/** 读取已有定义回填表单；读不到时保留空白表单并说明原因，不拿半份数据当定义。 */
async function fill(expertId: string): Promise<void> {
  loading.value = true
  const definition = await store.readDefinition(expertId)
  loading.value = false
  if (definition === null) {
    loadError.value = '没能读到这份定义，可以关闭后重试，或直接改定义文件。'
    return
  }
  displayName.value = definition.displayName
  summary.value = definition.summary
  skillsText.value = definition.skillIds.join(', ')
  body.value = definition.body
}

async function submit(): Promise<void> {
  if (!canSave.value) return
  saveError.value = null
  const result = await store.save({
    expertId: props.expertId,
    displayName: displayName.value.trim(),
    summary: summary.value.trim(),
    skillIds: skillIds.value,
    body: body.value
  })
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
                  专家正文在新建会话召唤后作为独立系统提示段注入；标识创建后不可改，显示名称与正文可以随时改。
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
                    :maxlength="MAX_EXPERT_DISPLAY_NAME_LENGTH"
                    placeholder="例如：文档评审官"
                    :disabled="saving || loading"
                  >
                </label>

                <label class="block space-y-1">
                  <span class="field-label">一句话简介</span>
                  <input
                    v-model="summary"
                    class="text-control"
                    type="text"
                    :maxlength="MAX_EXPERT_SUMMARY_LENGTH"
                    placeholder="说明这个专家负责什么、不负责什么"
                    :disabled="saving || loading"
                  >
                </label>

                <label class="block space-y-1">
                  <span class="field-label">引用的技能</span>
                  <input
                    v-model="skillsText"
                    class="text-control font-mono"
                    type="text"
                    placeholder="逗号分隔的技能标识，例如 memory, frontend-design"
                    :disabled="saving || loading"
                  >
                  <span class="hint-text">留空表示不引用；技能可见集不因专家而变，这里只是声明本专家会用到哪些技能。</span>
                </label>

                <label class="block space-y-1">
                  <span class="field-label">正文</span>
                  <textarea
                    v-model="body"
                    class="text-control font-mono"
                    rows="12"
                    placeholder="身份、方法论、工作流程与输出规范；这部分会整段进入系统提示"
                    :disabled="saving || loading"
                  ></textarea>
                  <span class="hint-text">正文超过注入上限时只在召唤时截断，定义文件保留全文。</span>
                </label>
              </div>
            </div>

            <div class="dialog-footer">
              <p v-if="saveError !== null" role="alert" class="mr-auto text-xs text-desk-danger">
                {{ saveError }}
              </p>
              <p v-else-if="!canSave && !loading" class="mr-auto hint-text">
                显示名称、简介与正文都不能为空。
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
