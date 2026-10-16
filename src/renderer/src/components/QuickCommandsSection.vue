<!--
  设置页的快捷命令区块：列出全部命令（全局与项目混排），支持搜索、添加、编辑与删除。

  列表是唯一的管理入口，因此每条命令都直接给出编辑与删除；删除走确认弹窗，确认后提交整份清单。
  编辑与新增都用同一个弹窗（QuickCommandDialog），这里只负责持有「正在编辑哪一条」与「待删除哪一条」。
  保存失败时保留清单并就地展示主进程原因，不把失败当成已保存。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { MAX_QUICK_COMMANDS } from '../../../shared/quick-commands-api'
import type { QuickCommand } from '../../../shared/quick-commands-api'
import { useProjectStore } from '../stores/project'
import { useQuickCommandsStore } from '../stores/quick-commands'
import AppButton from './ui/AppButton.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import QuickCommandDialog from './QuickCommandDialog.vue'

const store = useQuickCommandsStore()
const projectStore = useProjectStore()

/** 搜索词；只过滤展示，不改变已保存的清单。 */
const query = ref('')
/** 正在编辑的命令；null 表示当前没有打开编辑弹窗。 */
const editorTarget = ref<QuickCommand | null>(null)
const editorOpen = ref(false)
/** 待确认删除的命令；null 表示没有待确认的删除。 */
const pendingRemoval = ref<QuickCommand | null>(null)

const saving = computed(() => store.view.phase === 'saving')
const saveError = computed(() => (store.view.phase === 'error' ? store.view.error : null))
const atLimit = computed(() => store.commands.length >= MAX_QUICK_COMMANDS)
const filtered = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  if (needle === '') return store.commands
  return store.commands.filter((command) => (
    command.label.toLocaleLowerCase().includes(needle)
    || command.command.toLocaleLowerCase().includes(needle)
  ))
})

/** 项目范围显示项目名；项目已不在列表里时退回路径，避免只剩一个范围词看不出归属。 */
function scopeLabel(command: QuickCommand): string {
  if (command.scope === 'global') return '全局'
  const path = command.projectPath
  if (path === null) return '项目'
  return projectStore.projects.find((project) => project.path === path)?.name ?? path
}

function openEditor(command: QuickCommand | null): void {
  editorTarget.value = command
  editorOpen.value = true
}

function closeEditor(): void {
  editorOpen.value = false
  editorTarget.value = null
}

function requestRemoval(command: QuickCommand): void {
  pendingRemoval.value = command
}

function cancelRemoval(): void {
  pendingRemoval.value = null
}

async function confirmRemoval(): Promise<void> {
  const command = pendingRemoval.value
  pendingRemoval.value = null
  if (command !== null) await store.removeCommand(command.id)
}
</script>

<template>
  <div class="space-y-4">
    <header>
      <h1 class="text-xl font-semibold tracking-tight">快捷命令</h1>
      <p class="mt-1 text-sm text-desk-muted">
        保存常用命令，在标签栏的「命令」菜单或终端右键里一键运行。
      </p>
    </header>

    <section class="settings-section" aria-labelledby="settings-quick-commands-title">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-quick-commands-title" class="settings-section-title">命令清单</h2>
          <p class="mt-1 text-xs text-desk-muted">全局命令在每个项目都可用，项目命令只在对应项目出现。</p>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-2xs text-desk-muted">{{ store.commands.length }} / {{ MAX_QUICK_COMMANDS }}</span>
          <AppButton
            variant="compact"
            :disabled="saving || atLimit"
            :title="atLimit ? `已达到 ${MAX_QUICK_COMMANDS} 条上限，删除一条后可继续添加。` : '新增一条命令'"
            @click="openEditor(null)"
          >
            添加命令
          </AppButton>
        </div>
      </div>

      <div class="mt-4">
        <input
          v-model="query"
          class="text-control sm:max-w-64"
          type="search"
          placeholder="搜索命令…"
          aria-label="搜索命令"
        >
      </div>

      <p v-if="saveError !== null" role="alert" class="mt-3 text-xs text-desk-danger">
        {{ saveError.message }}
      </p>

      <p v-if="store.commands.length === 0" class="mt-4 text-xs text-desk-muted">
        还没有快捷命令，点「添加命令」新建一条。
      </p>
      <p v-else-if="filtered.length === 0" class="mt-4 text-xs text-desk-muted">
        没有命令与此搜索匹配。
      </p>

      <ul v-else class="mt-4 space-y-2">
        <li v-for="command in filtered" :key="command.id" class="list-card">
          <div class="flex items-start gap-3">
            <div class="min-w-0 flex-1">
              <p class="flex flex-wrap items-center gap-2 text-sm font-medium">
                <span class="min-w-0 break-words">{{ command.label }}</span>
                <span class="chip">{{ scopeLabel(command) }}</span>
              </p>
              <p class="mt-1 break-words font-mono text-2xs text-desk-muted">{{ command.command }}</p>
              <p class="mt-1 text-2xs text-desk-muted">
                {{ command.appendEnter ? '写入后立即运行' : '只插入文本，不回车' }}
              </p>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <AppButton variant="compact" :disabled="saving" @click="openEditor(command)">编辑</AppButton>
              <AppButton variant="quiet-danger" :disabled="saving" @click="requestRemoval(command)">删除</AppButton>
            </div>
          </div>
        </li>
      </ul>
    </section>

    <QuickCommandDialog
      :open="editorOpen"
      :command="editorTarget"
      default-scope="global"
      :default-project-path="projectStore.currentProject?.path ?? null"
      @saved="closeEditor"
      @cancel="closeEditor"
    />

    <ConfirmDialog
      :open="pendingRemoval !== null"
      :title="`删除快捷命令「${pendingRemoval?.label ?? ''}」？`"
      description="该快捷命令会从保存的清单里移除，菜单与终端右键里不再出现。"
      :detail="pendingRemoval?.command ?? ''"
      confirm-label="删除"
      @confirm="confirmRemoval"
      @cancel="cancelRemoval"
    />
  </div>
</template>
