<!-- 项目切换面板内容：目录选择、最近项目、手动路径与本地配置提示；弹层开关与点外关闭由顶栏负责，切换编排仍在主进程。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { ref } from 'vue'
import { useProjectStore } from '../stores/project'

const emit = defineEmits<{
  close: []
}>()

const projectStore = useProjectStore()
const { projects, currentProject, currentProjectId, storageNotice, actionError, choosing, switching, view: projectView } = storeToRefs(projectStore)
const manualPath = ref('')

function chooseDirectory(): void {
  emit('close')
  void projectStore.choose()
}

/** 手输路径同样交给主进程归一化与校验，不在页面内判断路径形式。 */
function useManualPath(): void {
  const path = manualPath.value.trim()
  if (path === '') return
  emit('close')
  void projectStore.select(path, false)
}

function selectSavedProject(path: string): void {
  emit('close')
  if (path === currentProject.value?.path) return
  void projectStore.select(path, false)
}
</script>

<template>
  <div class="space-y-4">
    <div>
      <h2 class="section-heading mb-2">项目</h2>
      <template v-if="currentProject">
        <p class="text-sm font-medium">{{ currentProject.name }}</p>
        <p class="break-words font-mono text-xs text-desk-muted">{{ currentProject.path }}</p>
      </template>
      <p v-else class="text-sm text-desk-muted">
        尚未选择项目；Runtime 以当前项目目录作为工作目录。
      </p>
    </div>

    <p v-if="storageNotice" role="status" class="text-xs text-desk-muted">{{ storageNotice }}</p>
    <p v-if="actionError" role="alert" class="text-xs text-desk-danger">{{ actionError.message }}</p>

    <button
      type="button"
      class="control-button"
      :disabled="choosing || switching"
      @click="chooseDirectory"
    >
      {{ choosing ? '正在打开选择器' : '选择目录…' }}
    </button>

    <div>
      <label for="project-path" class="mb-1.5 block text-xs font-medium">手动输入绝对路径</label>
      <input
        id="project-path"
        v-model="manualPath"
        type="text"
        class="text-control font-mono"
        placeholder="输入项目的绝对路径"
        autocomplete="off"
        spellcheck="false"
        @keyup.enter="useManualPath"
      />
      <div class="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="icon-button"
          :disabled="manualPath.trim() === '' || switching"
          @click="useManualPath"
        >
          使用此路径
        </button>
        <p class="text-xs text-desk-muted">主进程会解析符号链接并校验为存在的绝对目录。</p>
      </div>
    </div>

    <div>
      <h3 class="mb-2 text-xs font-medium text-desk-muted">最近项目</h3>
      <p v-if="projectView.phase === 'loading'" class="text-sm text-desk-muted">正在读取项目列表。</p>
      <div v-else-if="projectView.phase === 'error'" class="flex flex-wrap items-center gap-2">
        <p role="alert" class="text-xs text-desk-danger">{{ projectView.error.message }}</p>
        <button type="button" class="icon-button" @click="projectStore.initialize()">重试</button>
      </div>
      <p v-else-if="projects.length === 0" class="text-sm text-desk-muted">尚无已保存的项目。</p>
      <ul v-else class="space-y-1">
        <li v-for="project in projects" :key="project.id">
          <button
            type="button"
            class="w-full rounded-md border px-2 py-1.5 text-left"
            :class="project.id === currentProjectId
              ? 'border-desk-accent bg-desk-canvas'
              : 'border-desk-line bg-desk-surface'"
            :aria-current="project.id === currentProjectId ? 'true' : 'false'"
            :disabled="switching"
            @click="selectSavedProject(project.path)"
          >
            <span class="block text-sm">{{ project.name }}</span>
            <span class="block break-words font-mono text-xs text-desk-muted">{{ project.path }}</span>
          </button>
        </li>
      </ul>
      <p class="mt-2 text-xs text-desk-muted">有运行中的操作时，切换会先请你确认是否中断。</p>
    </div>
  </div>
</template>
