<!--
  右侧面板外壳：位于顶部栏之下、工作区之后的第三列，头部是当前项目与刷新入口，主体按页签在
  「文件树」与「源代码管理」之间切换。

  折叠与宽度来自界面偏好：折叠时宽度归零并置 inert（与左侧栏同一手法），宽度在拖拽期间只在本组件内
  生效，松手或键盘调整结束才提交一次，避免每帧写配置。分隔条可拖拽也可用方向键调整，并作为分隔控件
  进入无障碍树。窄窗口下整块不显示（见样式里的 799px 断点），因为右侧面板在窄窗会遮住正文。

  页签选择同样存在界面偏好里（重启后保持）。头部只有一个刷新入口，按当前页签决定刷哪一份数据；
  源代码管理的状态跟踪与文件树的目录监听都在这里启动而不是在各自的页签里，这样未打开该页签时
  页签角标也能显示改动数，两个页签切换时自动刷新也不中断。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { MAX_RIGHT_PANEL_WIDTH, MIN_RIGHT_PANEL_WIDTH } from '../../../../shared/preferences-api'
import { usePreferencesStore } from '../../preferences/stores/preferences'
import { useProjectDirectoryStore } from '../../editor/stores/project-directory'
import { useProjectStore } from '../../projects/stores/project'
import AppButton from '../../ui/AppButton.vue'
import FileTreeView from '../../editor/components/FileTreeView.vue'
import GitPanel from '../../git/components/GitPanel.vue'
import RightPanelTabs from './RightPanelTabs.vue'
import { useGitStatusStore } from '../../git/stores/git-status'

const props = defineProps<{
  readonly collapsed: boolean
}>()

const preferencesStore = usePreferencesStore()
const projectStore = useProjectStore()
const directoryStore = useProjectDirectoryStore()
const { rightPanelWidth, rightPanelTab } = storeToRefs(preferencesStore)
const { currentProject } = storeToRefs(projectStore)

const gitStore = useGitStatusStore()
const { entries: gitEntries } = storeToRefs(gitStore)

/** 拖拽期间的临时宽度；null 表示未在拖拽，此时宽度取偏好里的值。 */
const draggingWidth = ref<number | null>(null)
const resizing = ref(false)
const refreshing = ref(false)
/** 拖拽起点：指针横坐标与开始时的面板宽度；为空表示当前没有拖拽。 */
let dragOrigin: { readonly pointerX: number; readonly width: number } | null = null

const panelWidth = computed(() => draggingWidth.value ?? rightPanelWidth.value)
const projectName = computed(() => currentProject.value?.name ?? '未选择项目')
const projectPath = computed(() => currentProject.value?.path ?? '尚未选择项目')
const showingGit = computed(() => rightPanelTab.value === 'source-control')
const refreshLabel = computed(() => (showingGit.value ? '刷新 Git 状态' : '刷新文件树'))

function clampWidth(width: number): number {
  return Math.min(MAX_RIGHT_PANEL_WIDTH, Math.max(MIN_RIGHT_PANEL_WIDTH, Math.round(width)))
}

function onResizeStart(event: PointerEvent): void {
  const handle = event.currentTarget
  if (!(handle instanceof HTMLElement)) return
  handle.setPointerCapture(event.pointerId)
  dragOrigin = { pointerX: event.clientX, width: panelWidth.value }
  draggingWidth.value = panelWidth.value
  resizing.value = true
}

/** 向左拖是变宽：宽度按指针左移的距离增加。 */
function onResizeMove(event: PointerEvent): void {
  if (dragOrigin === null) return
  draggingWidth.value = clampWidth(dragOrigin.width + (dragOrigin.pointerX - event.clientX))
}

function onResizeEnd(): void {
  if (dragOrigin === null) return
  dragOrigin = null
  resizing.value = false
  const width = draggingWidth.value
  draggingWidth.value = null
  if (width !== null) void preferencesStore.setRightPanelWidth(width)
}

/** 键盘调整：方向键一次 16px，Home/End 直达边界；调整后立即提交。 */
function onResizeKeydown(event: KeyboardEvent): void {
  const step = event.key === 'ArrowLeft' ? 16 : event.key === 'ArrowRight' ? -16 : 0
  const target = event.key === 'Home'
    ? MIN_RIGHT_PANEL_WIDTH
    : event.key === 'End' ? MAX_RIGHT_PANEL_WIDTH : clampWidth(rightPanelWidth.value + step)
  if (target === rightPanelWidth.value) return
  event.preventDefault()
  void preferencesStore.setRightPanelWidth(target)
}

/** 头部唯一的刷新入口：按当前页签刷新对应视图，避免两个视图各放一个按钮。 */
async function refresh(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await (showingGit.value ? gitStore.refresh() : directoryStore.refresh())
  } finally {
    refreshing.value = false
  }
}

function selectTab(tab: 'files' | 'source-control'): void {
  void preferencesStore.setRightPanelTab(tab)
}

// 状态跟踪放在外壳而不是面板里：切到文件页签时页签角标仍然要显示改动数。
// 文件树的目录监听同样在这里启动：两个页签互相切换时自动刷新不中断。
onMounted(() => {
  gitStore.initialize()
  directoryStore.initialize()
})

onBeforeUnmount(() => {
  gitStore.dispose()
  directoryStore.dispose()
})
</script>

<template>
  <aside
    class="app-right-panel"
    :class="{ 'is-collapsed': props.collapsed, 'is-resizing': resizing }"
    :style="{ '--panel-width': `${panelWidth}px` }"
    :aria-hidden="props.collapsed"
    :inert="props.collapsed"
    aria-label="项目面板"
  >
    <div class="right-panel-content">
      <header class="right-panel-header">
        <span class="right-panel-project" :title="projectPath">
          <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M3 10h18" /></svg>
          <span class="right-panel-project-name">{{ projectName }}</span>
        </span>
        <AppButton
          variant="unstyled"
          class="right-panel-action"
          :disabled="refreshing || currentProject === null"
          :aria-label="refreshLabel"
          :title="refreshing ? `正在${refreshLabel}` : refreshLabel"
          @click="refresh"
        >
          <svg class="panel-icon" :class="{ 'is-spinning': refreshing }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 4v5h-5" /></svg>
        </AppButton>
      </header>

      <RightPanelTabs :active="rightPanelTab" :changes="gitEntries.length" @select="selectTab" />

      <FileTreeView v-if="!showingGit" />
      <GitPanel v-else />
    </div>

    <!-- 分隔条贴着面板左缘：拖拽改宽，方向键微调，Home/End 直达宽度边界。 -->
    <div
      class="right-panel-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整面板宽度"
      :aria-valuenow="panelWidth"
      :aria-valuemin="MIN_RIGHT_PANEL_WIDTH"
      :aria-valuemax="MAX_RIGHT_PANEL_WIDTH"
      tabindex="0"
      @pointerdown="onResizeStart"
      @pointermove="onResizeMove"
      @pointerup="onResizeEnd"
      @pointercancel="onResizeEnd"
      @keydown="onResizeKeydown"
    ></div>
  </aside>
</template>
