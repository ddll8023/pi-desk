<!--
  快捷命令编辑弹窗：新增或修改一条命令（标签、命令文本、是否追加回车、作用范围）。

  表单由本弹窗自己持有并直接提交给快捷命令 store：保存成功后关闭并把焦点还给打开它的元素，
  失败时保留已填内容并就地展示主进程的原因。范围选「项目」时出现项目选择，项目列表来自侧栏同一份项目数据，
  编辑的命令所属项目已不在列表时按路径补一项；命令文本按原样保存（不转义、不解析），写入终端时才会补回车。
-->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue'
import { MAX_QUICK_COMMAND_LABEL_LENGTH, MAX_QUICK_COMMAND_TEXT_LENGTH } from '../../../shared/quick-commands-api'
import type { QuickCommand, QuickCommandScope } from '../../../shared/quick-commands-api'
import { useProjectStore } from '../stores/project'
import { useQuickCommandsStore } from '../stores/quick-commands'
import AppButton from '../ui/AppButton.vue'
import AppSelect from '../ui/AppSelect.vue'

const props = defineProps<{
  /** 弹层由父级常驻挂载，`open` 控制进入/退出与焦点、快捷键生命周期。 */
  readonly open: boolean
  /** 编辑目标；`null` 表示新增。 */
  readonly command: QuickCommand | null
  /** 新增时的初始范围；编辑时以命令自身的范围为准。 */
  readonly defaultScope: QuickCommandScope
  /** 新增且范围为「项目」时的初始项目路径。 */
  readonly defaultProjectPath: string | null
}>()

const emit = defineEmits<{
  saved: []
  cancel: []
}>()

const store = useQuickCommandsStore()
const projectStore = useProjectStore()

const panel = ref<HTMLElement | null>(null)
const titleId = useId()
/** 打开前的焦点元素；关闭后把焦点还给它。 */
let opener: HTMLElement | null = null

const label = ref('')
const commandText = ref('')
const appendEnter = ref(true)
const scope = ref<QuickCommandScope>('global')
/** 项目选择用 AppSelect 的字符串模型；空串表示没有选中项目，保存时再转成 null。 */
const projectSelection = ref('')

const editing = computed(() => props.command !== null)
const title = computed(() => (editing.value ? '编辑快捷命令' : '添加快捷命令'))
const saving = computed(() => store.view.phase === 'saving')
const saveError = computed(() => (store.view.phase === 'error' ? store.view.error : null))
const canSave = computed(() => (
  !saving.value
  && label.value.trim() !== ''
  && commandText.value.trim() !== ''
  && (scope.value === 'global' || projectSelection.value !== '')
))

/**
 * 项目选择项：与侧栏同一份项目数据，展示名与路径一起给出。
 * 编辑的项目命令所属项目已不在列表时，补一条以路径为名的项，避免选中值退化成「选择项目」。
 */
const projectGroups = computed(() => {
  const options = projectStore.projects.map((project) => ({
    value: project.path,
    label: project.name,
    description: project.path
  }))
  const selectedPath = projectSelection.value
  if (selectedPath !== '' && !options.some((option) => option.value === selectedPath)) {
    options.push({ value: selectedPath, label: selectedPath, description: '该项目已不在侧栏列表中' })
  }
  return [{ options }]
})

/** 打开时按编辑目标或初始范围重置表单；关闭时解绑快捷键并把焦点还回去。 */
watch(
  () => props.open,
  (open) => {
    if (open) {
      const target = props.command
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      label.value = target?.label ?? ''
      commandText.value = target?.command ?? ''
      appendEnter.value = target?.appendEnter ?? true
      scope.value = target?.scope ?? props.defaultScope
      projectSelection.value = target?.projectPath
        ?? (props.defaultScope === 'project' ? props.defaultProjectPath ?? '' : '')
      store.clearError()
      window.addEventListener('keydown', onKeydown)
      void nextTick(() => panel.value?.focus())
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

/** 切换范围时清掉另一个范围的值：全局命令不保留项目路径，避免保存出前后不一致的条目。 */
function selectScope(next: QuickCommandScope): void {
  scope.value = next
  if (next === 'global') projectSelection.value = ''
  else if (projectSelection.value === '') projectSelection.value = projectStore.currentProject?.path ?? ''
}

async function submit(): Promise<void> {
  if (!canSave.value) return
  const target = props.command
  const next: QuickCommand = {
    id: target?.id ?? crypto.randomUUID(),
    label: label.value.trim(),
    command: commandText.value.trim(),
    appendEnter: appendEnter.value,
    scope: scope.value,
    projectPath: scope.value === 'project' && projectSelection.value !== '' ? projectSelection.value : null
  }
  if (await store.upsertCommand(next)) emit('saved')
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
            class="dialog-panel max-w-xl"
          >
            <div class="dialog-header">
              <div>
                <h2 :id="titleId" class="dialog-title">{{ title }}</h2>
                <p class="dialog-subtitle">
                  命令直接写入当前终端；勾选「追加回车」时立即执行，否则只插入文本。
                </p>
              </div>
            </div>

            <div class="dialog-body">
              <div class="space-y-4">
                <label class="block space-y-1">
                  <span class="field-label">标签</span>
                  <input
                    v-model="label"
                    class="text-control"
                    type="text"
                    :maxlength="MAX_QUICK_COMMAND_LABEL_LENGTH"
                    placeholder="例如：启动开发服务器"
                    :disabled="saving"
                  >
                </label>

                <label class="block space-y-1">
                  <span class="field-label">命令文本</span>
                  <textarea
                    v-model="commandText"
                    class="text-control font-mono"
                    rows="4"
                    :maxlength="MAX_QUICK_COMMAND_TEXT_LENGTH"
                    placeholder="例如：npm run dev"
                    :disabled="saving"
                  ></textarea>
                </label>

                <div class="flex flex-wrap items-center justify-between gap-4">
                  <label class="flex items-center gap-2 text-xs">
                    <input v-model="appendEnter" type="checkbox" :disabled="saving">
                    追加回车，写入后立即运行
                  </label>
                </div>

                <div class="space-y-2">
                  <span class="field-label">作用范围</span>
                  <div class="segment max-w-sm" role="group" aria-label="作用范围">
                    <AppButton
                      variant="unstyled"
                      class="segment-option"
                      :class="scope === 'global' ? 'is-selected' : ''"
                      :aria-pressed="scope === 'global'"
                      :disabled="saving"
                      @click="selectScope('global')"
                    >
                      全局
                    </AppButton>
                    <AppButton
                      variant="unstyled"
                      class="segment-option"
                      :class="scope === 'project' ? 'is-selected' : ''"
                      :aria-pressed="scope === 'project'"
                      :disabled="saving"
                      @click="selectScope('project')"
                    >
                      项目
                    </AppButton>
                  </div>

                  <!-- 选「项目」时项目选择直接跟在同一块里：范围与项目是同一件事的两个字段，不拆成两段。 -->
                  <template v-if="scope === 'project'">
                    <AppSelect
                      id="quick-command-project"
                      v-model="projectSelection"
                      label="项目"
                      searchable
                      search-placeholder="搜索项目…"
                      empty-label="选择项目"
                      empty-results-label="没有匹配的项目"
                      :groups="projectGroups"
                      :disabled="saving"
                    />
                    <p class="hint-text">只在这个项目可用。</p>
                  </template>
                </div>
              </div>
            </div>

            <div class="dialog-footer">
              <p v-if="saveError !== null" role="alert" class="mr-auto text-xs text-desk-danger">
                {{ saveError.message }}
              </p>
              <p v-else-if="label.trim() === '' || commandText.trim() === ''" class="mr-auto hint-text">
                标签与命令文本都不能为空。
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
