<!--
  设置页的快捷命令区块：按作用域分组列出全部命令，支持搜索、添加、编辑与删除。

  作用域是清单的第一分层：全局组恒在首位（0 条时也保留，作为按组新增的落点），其后按侧栏项目顺序列出有条目的项目；
  项目已不在列表中时用路径作组名单独列出，避免残留命令找不到归属。分组只影响展示，保存仍是原数组顺序的整份替换。
  搜索会跨作用域得到扁平结果，此时结构丢失，范围改由每行的徽标表达。
  列表是唯一的管理入口，因此每条命令都直接给出编辑与删除；删除走确认弹窗，确认后提交整份清单。
  编辑与新增都用同一个弹窗（QuickCommandDialog），这里只负责持有「正在编辑哪一条」与「待删除哪一条」。
  保存失败时保留清单并就地展示主进程原因，不把失败当成已保存。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { MAX_QUICK_COMMANDS } from '../../../shared/quick-commands-api'
import type { QuickCommand, QuickCommandScope } from '../../../shared/quick-commands-api'
import { useProjectStore } from '../stores/project'
import { useQuickCommandsStore } from '../stores/quick-commands'
import AppButton from '../ui/AppButton.vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import QuickCommandDialog from './QuickCommandDialog.vue'

/** 展示用的一组命令：组头表达作用域，组内不再逐行重复范围。 */
interface CommandGroup {
  readonly key: string
  readonly scope: QuickCommandScope
  /** 项目组的项目路径；全局组为 null，用于按组新增时预填。 */
  readonly projectPath: string | null
  readonly title: string
  /** 项目组的归属说明（路径或「已不在列表」）；全局组没有。 */
  readonly subtitle: string | null
  readonly commands: readonly QuickCommand[]
  /** 搜索结果没有组头，也没有按组新增入口。 */
  readonly showHeader: boolean
}

const store = useQuickCommandsStore()
const projectStore = useProjectStore()

/** 搜索词；只过滤展示，不改变已保存的清单。 */
const query = ref('')
/** 正在编辑的命令；null 表示当前没有打开编辑弹窗。 */
const editorTarget = ref<QuickCommand | null>(null)
const editorOpen = ref(false)
/** 新增时的预填范围；编辑时由弹窗以命令自身的范围为准。 */
const editorScope = ref<QuickCommandScope>('global')
const editorProjectPath = ref<string | null>(null)
/** 待确认删除的命令；null 表示没有待确认的删除。 */
const pendingRemoval = ref<QuickCommand | null>(null)

const saving = computed(() => store.view.phase === 'saving')
const saveError = computed(() => (store.view.phase === 'error' ? store.view.error : null))
const atLimit = computed(() => store.commands.length >= MAX_QUICK_COMMANDS)
const searching = computed(() => query.value.trim() !== '')
const filtered = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  if (needle === '') return store.commands
  return store.commands.filter((command) => (
    command.label.toLocaleLowerCase().includes(needle)
    || command.command.toLocaleLowerCase().includes(needle)
  ))
})

/** 项目路径对应的项目名；项目已不在列表里时返回 null，由调用方决定用什么兜底。 */
function projectNameOf(path: string | null): string | null {
  if (path === null) return null
  return projectStore.projects.find((project) => project.path === path)?.name ?? null
}

/** 扁平结果里的范围徽标：项目范围显示项目名，路径兜底避免只剩一个看不出归属的范围词。 */
function scopeLabel(command: QuickCommand): string {
  if (command.scope === 'global') return '全局'
  return projectNameOf(command.projectPath) ?? command.projectPath ?? '项目'
}

/**
 * 分组：全局组恒在首位，其后按侧栏项目顺序列出有条目的项目，未知路径追加在末尾。
 * 只有全局组允许为空，因为按组新增需要一个落点。
 */
const groups = computed<CommandGroup[]>(() => {
  const knownPaths = new Set(projectStore.projects.map((project) => project.path))
  const projectGroups = projectStore.projects
    .map((project) => ({
      key: `project:${project.path}`,
      scope: 'project' as const,
      projectPath: project.path,
      title: project.name,
      subtitle: project.path,
      commands: store.commandsOfProject(project.path),
      showHeader: true
    }))
    .filter((group) => group.commands.length > 0)
  const orphanPaths = [...new Set(
    store.commands.flatMap((command) => (
      command.scope === 'project'
        && command.projectPath !== null
        && !knownPaths.has(command.projectPath)
        ? [command.projectPath]
        : []
    ))
  )]
  const orphanGroups = orphanPaths.map((path) => ({
    key: `project:${path}`,
    scope: 'project' as const,
    projectPath: path,
    title: path,
    subtitle: '该项目已不在侧栏列表中',
    commands: store.commandsOfProject(path),
    showHeader: true
  }))
  return [
    {
      key: 'global',
      scope: 'global' as const,
      projectPath: null,
      title: '全局',
      subtitle: null,
      commands: store.globalCommands,
      showHeader: true
    },
    ...projectGroups,
    ...orphanGroups
  ]
})

/** 搜索时压成一组无头结果：跨作用域查找，范围由每行徽标表达。 */
const displayGroups = computed<CommandGroup[]>(() => {
  if (!searching.value) return groups.value
  return [{
    key: 'search',
    scope: 'global',
    projectPath: null,
    title: '',
    subtitle: null,
    commands: filtered.value,
    showHeader: false
  }]
})

/** 打开编辑弹窗；新增时按来源组预填范围与项目，编辑时以命令自身为准。 */
function openEditor(command: QuickCommand | null, scope: QuickCommandScope = 'global', projectPath: string | null = null): void {
  editorTarget.value = command
  editorScope.value = scope
  editorProjectPath.value = projectPath
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
        保存常用命令，在标签栏的「命令」菜单或终端右键里一键运行；运行时新开一个终端标签执行。
      </p>
    </header>

    <section class="settings-section" aria-labelledby="settings-quick-commands-title">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-quick-commands-title" class="settings-section-title">命令清单</h2>
          <p class="mt-1 text-xs text-desk-muted">命令按作用域分组；搜索会跨全局与所有项目。</p>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-2xs text-desk-muted">{{ store.commands.length }} / {{ MAX_QUICK_COMMANDS }}</span>
          <AppButton
            variant="compact"
            :disabled="saving || atLimit"
            :title="atLimit ? `已达到 ${MAX_QUICK_COMMANDS} 条上限，删除一条后可继续添加。` : '新增一条全局命令'"
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
      <p v-else-if="searching && filtered.length === 0" class="mt-4 text-xs text-desk-muted">
        没有命令与此搜索匹配。
      </p>

      <!-- 分组态没有逐行范围徽标：作用域由组头表达，徽标只在搜索后的扁平结果里出现。 -->
      <div v-else class="mt-4 space-y-5">
        <section
          v-for="group in displayGroups"
          :key="group.key"
          class="space-y-2"
          :aria-label="group.showHeader ? `${group.title}的快捷命令` : '搜索结果'"
        >
          <div v-if="group.showHeader" class="flex flex-wrap items-center justify-between gap-2">
            <p class="flex min-w-0 items-center gap-2">
              <span class="scope-dot" :class="group.scope === 'project' ? 'is-project' : ''" aria-hidden="true"></span>
              <span class="min-w-0 truncate text-sm font-medium">{{ group.title }}</span>
              <span class="text-2xs text-desk-muted">{{ group.commands.length }}</span>
            </p>
            <AppButton
              variant="compact"
              :disabled="saving || atLimit"
              :title="atLimit ? `已达到 ${MAX_QUICK_COMMANDS} 条上限，删除一条后可继续添加。` : '在这个作用域新增一条命令'"
              @click="openEditor(null, group.scope, group.projectPath)"
            >
              {{ group.scope === 'project' ? '在此项目添加' : '添加全局命令' }}
            </AppButton>
          </div>

          <p v-if="group.subtitle !== null" class="break-all text-2xs text-desk-muted">
            {{ group.subtitle }}
          </p>

          <p v-if="group.commands.length === 0" class="text-xs text-desk-muted">
            还没有全局命令，点右侧「添加全局命令」新建一条。
          </p>

          <ul v-else class="space-y-2">
            <li v-for="command in group.commands" :key="command.id" class="list-card">
              <div class="flex items-start gap-3">
                <div class="min-w-0 flex-1">
                  <p class="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span class="min-w-0 break-words">{{ command.label }}</span>
                    <span
                      v-if="!group.showHeader"
                      class="scope-badge"
                      :class="command.scope === 'project' ? 'is-project' : 'is-global'"
                    >{{ scopeLabel(command) }}</span>
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
      </div>
    </section>

    <QuickCommandDialog
      :open="editorOpen"
      :command="editorTarget"
      :default-scope="editorScope"
      :default-project-path="editorProjectPath"
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
