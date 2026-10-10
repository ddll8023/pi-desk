<!-- 项目侧栏：最近项目列表、添加项目以及设置/返回对话入口；项目解析、持久化与切换编排都在主进程，会话切换走 /resume 与顶栏会话 chip。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { usePreferencesStore } from '../stores/preferences'
import { useProjectStore } from '../stores/project'
import AppButton from './ui/AppButton.vue'

const props = defineProps<{
  readonly settingsActive: boolean
}>()

const emit = defineEmits<{
  toggleSettings: []
}>()

const preferencesStore = usePreferencesStore()
const projectStore = useProjectStore()
const { sidebarCollapsed } = storeToRefs(preferencesStore)
const { view, projects, currentProjectId, choosing, switching } = storeToRefs(projectStore)

const busy = computed(() => choosing.value || switching.value)

function selectSavedProject(path: string): void {
  if (path === projectStore.currentProject?.path) return
  void projectStore.select(path, false)
}

function projectInitial(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?'
}

function projectColorIndex(id: string): number {
  let hash = 0
  for (const character of id) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0
  }
  return hash % 6
}
</script>

<template>
  <aside
    class="app-sidebar"
    :class="{ 'is-collapsed': sidebarCollapsed }"
    :aria-hidden="sidebarCollapsed"
    :inert="sidebarCollapsed"
    aria-label="项目"
  >
    <Transition name="sidebar-fade" appear>
      <div class="project-sidebar-header">
        <h2 class="project-sidebar-heading">项目</h2>
        <div class="flex gap-1">
          <AppButton
            variant="unstyled"
            class="project-sidebar-add"
            :disabled="busy"
            @click="projectStore.choose()"
          >
            {{ choosing ? '正在打开选择器' : '添加项目…' }}
          </AppButton>
        </div>
      </div>
    </Transition>

    <Transition name="sidebar-fade" appear>
      <div class="scroll-area min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <p v-if="view.phase === 'loading'" class="px-1 text-xs text-desk-muted">正在读取项目列表。</p>
      <div v-else-if="view.phase === 'error'" class="flex flex-wrap items-center gap-2">
        <p role="alert" class="text-xs text-desk-danger">{{ view.error.message }}</p>
        <AppButton variant="unstyled" class="icon-button" @click="projectStore.initialize()">重试</AppButton>
      </div>
      <p v-else-if="projects.length === 0" class="px-1 text-xs leading-6 text-desk-muted">
        尚无已保存的项目；点击上方「添加项目…」选择目录。
      </p>
      <template v-else>
        <h3 class="project-sidebar-section">最近项目</h3>
        <ul class="project-sidebar-list">
          <li v-for="project in projects" :key="project.id">
            <AppButton
              variant="unstyled"
              class="project-sidebar-item"
              :class="project.id === currentProjectId ? 'is-active' : ''"
              :aria-current="project.id === currentProjectId ? 'true' : 'false'"
              :disabled="busy"
              @click="selectSavedProject(project.path)"
            >
              <span
                class="project-sidebar-mark"
                :class="`project-sidebar-mark-${projectColorIndex(project.id)}`"
                aria-hidden="true"
              >
                {{ projectInitial(project.name) }}
              </span>
              <span class="project-sidebar-copy">
                <span class="project-sidebar-name">{{ project.name }}</span>
                <span class="project-sidebar-path">{{ project.path }}</span>
              </span>
            </AppButton>
          </li>
        </ul>
        <p class="mt-2 px-1 text-xs text-desk-muted">有运行中的操作时，切换会先请你确认是否中断。</p>
      </template>
      </div>
    </Transition>

    <div class="project-sidebar-footer">
      <AppButton
        variant="unstyled"
        class="project-sidebar-settings"
        :class="props.settingsActive ? 'is-active' : ''"
        :aria-current="props.settingsActive ? 'page' : undefined"
        @click="emit('toggleSettings')"
      >
        <span class="project-sidebar-settings-icon" aria-hidden="true">
          {{ props.settingsActive ? '←' : '⚙' }}
        </span>
        <span>{{ props.settingsActive ? '返回对话' : '设置' }}</span>
      </AppButton>
    </div>
  </aside>
</template>
