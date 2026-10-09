<!-- 项目侧栏：最近项目列表与添加项目入口；项目解析、持久化与切换编排都在主进程，会话切换走 /resume 与顶栏会话 chip。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { usePreferencesStore } from '../stores/preferences'
import { useProjectStore } from '../stores/project'

const preferencesStore = usePreferencesStore()
const projectStore = useProjectStore()
const { sidebarCollapsed } = storeToRefs(preferencesStore)
const { view, projects, currentProjectId, choosing, switching } = storeToRefs(projectStore)

const busy = computed(() => choosing.value || switching.value)

function selectSavedProject(path: string): void {
  if (path === projectStore.currentProject?.path) return
  void projectStore.select(path, false)
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
      <div class="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-desk-line px-3">
        <h2 class="text-sm font-semibold">项目</h2>
        <div class="flex gap-1">
          <button
            type="button"
            class="icon-button"
            :disabled="busy"
            @click="projectStore.choose()"
          >
            {{ choosing ? '正在打开选择器' : '添加项目…' }}
          </button>
        </div>
      </div>
    </Transition>

    <Transition name="sidebar-fade" appear>
      <div class="scroll-area min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <p v-if="view.phase === 'loading'" class="px-1 text-xs text-desk-muted">正在读取项目列表。</p>
      <div v-else-if="view.phase === 'error'" class="flex flex-wrap items-center gap-2">
        <p role="alert" class="text-xs text-desk-danger">{{ view.error.message }}</p>
        <button type="button" class="icon-button" @click="projectStore.initialize()">重试</button>
      </div>
      <p v-else-if="projects.length === 0" class="px-1 text-xs leading-6 text-desk-muted">
        尚无已保存的项目；点击上方「添加项目…」选择目录。
      </p>
      <template v-else>
        <h3 class="section-label mb-1.5 px-1">最近项目</h3>
        <ul class="space-y-1.5">
          <li v-for="project in projects" :key="project.id">
            <button
              type="button"
              class="list-item"
              :class="project.id === currentProjectId ? 'list-item-active' : ''"
              :aria-current="project.id === currentProjectId ? 'true' : 'false'"
              :disabled="busy"
              @click="selectSavedProject(project.path)"
            >
              <span class="block truncate text-xs font-medium">{{ project.name }}</span>
              <span class="mt-0.5 block break-all font-mono text-2xs text-desk-muted">{{ project.path }}</span>
            </button>
          </li>
        </ul>
        <p class="mt-2 px-1 text-xs text-desk-muted">有运行中的操作时，切换会先请你确认是否中断。</p>
      </template>
      </div>
    </Transition>
  </aside>
</template>
