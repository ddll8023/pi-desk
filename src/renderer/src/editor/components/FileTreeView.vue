<!--
  文件树视图：查找输入、目录树与检索结果共用一列滚动容器；本组件不修改磁盘，打开文件交给工作区文件标签。

  输入非空时改由主进程的文件检索给出候选（最多 50 条），清空即回到目录树；目录树按层懒读取，
  展开状态与读取缓存由 store 持有，本组件只负责触发与展示。行点击对目录是展开折叠、对文件是在工作区
  打开文件标签（预览与编辑），符号链接与其他特殊文件不提供打开。行上另有拖动与右键菜单，两者都只把
  项目内相对路径交给下游，绝对路径、越界判定与平台分隔符一律由主进程解析。文件图标按扩展名分组着色，
  只用于快速辨认类型。

  拖动只在应用内成立（自定义 MIME，不写 text/plain），落点是终端面板与输入坞：终端写入绝对路径，
  输入坞插入项目相对路径文本；右键与键盘菜单键打开操作菜单，
  菜单项与动作在 FileTreeMenu 里，本组件只负责把被指向的那一行交给它，并在面板内回报一次性结果。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import type { ProjectDirectoryEntryKind } from '../../../../shared/project-file-api'
import { setProjectEntryDragData } from '../../ui/project-entry-drag'
import { useProjectDirectoryStore } from '../stores/project-directory'
import type { FileTreeRow } from '../stores/project-directory'
import { useProjectStore } from '../../projects/stores/project'
import { useWorkspaceTabsStore } from '../../workspace/stores/workspace-tabs'
import AppButton from '../../ui/AppButton.vue'
import FileTreeMenu from './FileTreeMenu.vue'

/** 连续输入合并窗口：主进程每次检索都要遍历项目文件索引，不能逐字发起。 */
const SEARCH_DEBOUNCE_MS = 180
/** 每层缩进；与行的基础内边距相加。 */
const INDENT_STEP_PX = 14
/** 面板内一次性提示的展示时长：足够读完一句结果，不长期占住列表顶部。 */
const NOTICE_MS = 4000

/** 面板内一次性提示（复制结果、路径解析失败等）；与提示行共用同一套样式。 */
interface FileTreeNotice {
  readonly text: string
  readonly tone: 'muted' | 'error'
}

/** 文件类型分组：只决定图标配色，不参与任何行为判断。 */
type FileTone = 'folder' | 'code' | 'data' | 'doc' | 'markup' | 'plain'

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'py', 'java', 'kt', 'kts', 'go', 'rs', 'rb', 'php', 'cs',
  'c', 'h', 'cc', 'cpp', 'hpp', 'swift', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'sql', 'lua', 'r', 'dart'
])
const DATA_EXTENSIONS = new Set([
  'json', 'jsonc', 'yml', 'yaml', 'toml', 'ini', 'env', 'xml', 'csv', 'tsv', 'lock', 'conf', 'properties'
])
const DOC_EXTENSIONS = new Set(['md', 'mdx', 'txt', 'rst', 'adoc', 'pdf', 'doc', 'docx', 'log'])
const MARKUP_EXTENSIONS = new Set(['html', 'htm', 'css', 'scss', 'sass', 'less', 'svg'])

const projectStore = useProjectStore()
const directoryStore = useProjectDirectoryStore()
const workspaceTabsStore = useWorkspaceTabsStore()
const { currentProject } = storeToRefs(projectStore)
const { rows, searchView, selectedPath } = storeToRefs(directoryStore)

const query = ref('')
let searchTimer: ReturnType<typeof setTimeout> | null = null
/** 面板内一次性提示；到点自动消失，不改变列表内容。 */
const notice = ref<FileTreeNotice | null>(null)
let noticeTimer: ReturnType<typeof setTimeout> | null = null
/** 操作菜单：右键或键盘菜单键打开，锚点就是被指向的那一行。 */
const menu = ref<InstanceType<typeof FileTreeMenu> | null>(null)
/** 正在拖动的那一行；只用于给拖动中的行降透明度。 */
const draggingPath = ref<string | null>(null)

const filtering = computed(() => query.value.trim() !== '')
const rootView = computed(() => (
  currentProject.value === null ? null : directoryStore.directoryView(currentProject.value.path, '')
))
/**
 * 检索是否还没出结果：击键到防抖到期之间 store 仍是 idle，此时同样按「正在查找」展示，
 * 不能先闪一句「没有匹配的文件」。
 */
const searchPending = computed(() => (
  filtering.value && (searchView.value.phase === 'idle' || searchView.value.phase === 'loading')
))
const busy = computed(() => (
  filtering.value ? searchPending.value : rootView.value?.phase === 'loading'
))
/** 检索失败原因；成功、读取中与空查询都为 null，模板据此避免在联合类型上取字段。 */
const searchError = computed(() => (
  searchView.value.phase === 'error' ? searchView.value.error.message : null
))

/** 检索结果按路径拆成「名称 + 所在目录」两段，名称优先、目录作为尾部提示。 */
const searchRows = computed(() => {
  const view = searchView.value
  if (view.phase !== 'ready') return []
  return view.entries.map((path) => {
    const slash = path.lastIndexOf('/')
    return {
      path,
      name: slash < 0 ? path : path.slice(slash + 1),
      directory: slash < 0 ? '' : path.slice(0, slash)
    }
  })
})

function toneOf(kind: ProjectDirectoryEntryKind, name: string): FileTone {
  if (kind === 'directory') return 'folder'
  if (kind !== 'file') return 'plain'
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'plain'
  const extension = name.slice(dot + 1).toLowerCase()
  if (CODE_EXTENSIONS.has(extension)) return 'code'
  if (DATA_EXTENSIONS.has(extension)) return 'data'
  if (DOC_EXTENSIONS.has(extension)) return 'doc'
  if (MARKUP_EXTENSIONS.has(extension)) return 'markup'
  return 'plain'
}

function indent(depth: number): string {
  return `${8 + depth * INDENT_STEP_PX}px`
}

/** 输入即检索，按固定间隔合并连续击键；空输入立即回到目录树。 */
function onQueryInput(): void {
  if (searchTimer !== null) clearTimeout(searchTimer)
  const value = query.value
  if (value.trim() === '') {
    searchTimer = null
    directoryStore.clearFilter()
    return
  }
  searchTimer = setTimeout(() => {
    searchTimer = null
    void directoryStore.search(value)
  }, SEARCH_DEBOUNCE_MS)
}

function clearQuery(): void {
  if (searchTimer !== null) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
  query.value = ''
  directoryStore.clearFilter()
}

/**
 * 目录行展开折叠，文件行在工作区打开；符号链接与特殊文件（kind 为 other）不提供打开，
 * 避免跟随链接读到项目外，也不对无法编辑的条目给出会落空的承诺。
 */
function onRowClick(row: FileTreeRow): void {
  if (row.type !== 'entry') return
  const projectPath = currentProject.value?.path
  if (projectPath === undefined) return
  if (row.kind === 'directory') {
    directoryStore.toggleDirectory(projectPath, row.path)
    return
  }
  directoryStore.select(row.path)
  if (row.kind === 'file') {
    workspaceTabsStore.openFileTab(row.path)
    return
  }
  showNotice({ text: '符号链接或特殊文件不提供预览与编辑。', tone: 'muted' })
}

/** 检索结果都是文件：点击直接在工作区打开。 */
function onSearchRowClick(path: string): void {
  directoryStore.select(path)
  workspaceTabsStore.openFileTab(path)
}

/** 切换项目时清掉上一个项目的查询串与选中行，并读取新项目的根层。 */
watch(() => currentProject.value?.path ?? null, (path) => {
  clearQuery()
  directoryStore.select(null)
  if (path !== null) void directoryStore.ensureLoaded(path, '')
}, { immediate: true })

/**
 * 拖动开始：载荷只带项目根、项目内相对路径与条目类型，绝对路径留到落点或菜单动作时由主进程解析。
 * 未选择项目时不给载荷，拖动自然失效。
 */
function startEntryDrag(event: DragEvent, path: string, name: string, kind: ProjectDirectoryEntryKind): void {
  const projectPath = currentProject.value?.path ?? null
  if (projectPath === null) {
    event.preventDefault()
    return
  }
  draggingPath.value = path
  setProjectEntryDragData(event, { projectPath, path, name, kind })
}

function onRowDragStart(row: FileTreeRow, event: DragEvent): void {
  if (row.type !== 'entry') return
  startEntryDrag(event, row.path, row.name, row.kind)
}

/** 检索结果都是文件：主进程的检索只回文件路径，不含目录。 */
function onSearchRowDragStart(row: { readonly path: string; readonly name: string }, event: DragEvent): void {
  startEntryDrag(event, row.path, row.name, 'file')
}

function endEntryDrag(): void {
  draggingPath.value = null
}

/** 右键与键盘菜单键共用同一入口：锚定被指向的那一行，位置与收起交给菜单自己。 */
function openEntryMenu(
  event: MouseEvent | KeyboardEvent,
  path: string,
  name: string,
  kind: ProjectDirectoryEntryKind
): void {
  const host = event.currentTarget
  if (!(host instanceof HTMLElement)) return
  menu.value?.open({ path, name, kind }, host)
}

function onRowMenu(row: FileTreeRow, event: MouseEvent | KeyboardEvent): void {
  if (row.type !== 'entry') return
  openEntryMenu(event, row.path, row.name, row.kind)
}

function onSearchRowMenu(row: { readonly path: string; readonly name: string }, event: MouseEvent | KeyboardEvent): void {
  openEntryMenu(event, row.path, row.name, 'file')
}

/** 菜单键与 Shift+F10 是右键的键盘等价入口；其余按键交给行本身的点击行为。 */
function isMenuKey(event: KeyboardEvent): boolean {
  return event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')
}

function onRowMenuKeydown(row: FileTreeRow, event: KeyboardEvent): void {
  if (!isMenuKey(event)) return
  event.preventDefault()
  event.stopPropagation()
  onRowMenu(row, event)
}

function onSearchRowMenuKeydown(row: { readonly path: string; readonly name: string }, event: KeyboardEvent): void {
  if (!isMenuKey(event)) return
  event.preventDefault()
  event.stopPropagation()
  onSearchRowMenu(row, event)
}

/** 面板内一次性提示：复制结果与路径解析失败都就近回报，不静默失败。 */
function showNotice(next: FileTreeNotice): void {
  notice.value = next
  if (noticeTimer !== null) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    noticeTimer = null
    notice.value = null
  }, NOTICE_MS)
}

onBeforeUnmount(() => {
  if (searchTimer !== null) clearTimeout(searchTimer)
  if (noticeTimer !== null) clearTimeout(noticeTimer)
})
</script>

<template>
  <div class="file-tree">
    <div class="file-tree-filter">
      <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></svg>
      <input
        v-model="query"
        class="file-tree-input"
        type="text"
        placeholder="查找文件"
        aria-label="按名称查找文件"
        autocomplete="off"
        spellcheck="false"
        @input="onQueryInput"
      />
      <AppButton v-if="query !== ''" variant="unstyled" class="file-tree-clear" aria-label="清除查找" @click="clearQuery">
        <svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </AppButton>
    </div>

    <div class="file-tree-scroll scroll-area" :aria-busy="busy">
      <!-- 一次性提示放在列表之上：复制结果与路径解析失败都在这里就近回报。 -->
      <p v-if="notice !== null" class="file-tree-notice" :class="`is-${notice.tone}`" role="status">{{ notice.text }}</p>

      <p v-if="currentProject === null" class="file-tree-notice is-muted">尚未选择项目，先在左侧添加或切换项目。</p>

      <template v-else-if="filtering">
        <p v-if="searchPending" class="file-tree-notice is-muted">正在查找…</p>
        <p v-else-if="searchError !== null" class="file-tree-notice is-error">{{ searchError }}</p>
        <p v-else-if="searchRows.length === 0" class="file-tree-notice is-muted">没有匹配的文件。</p>
        <ul v-else class="file-tree-list">
          <li v-for="row in searchRows" :key="row.path">
            <button
              type="button"
              class="file-tree-row"
              :class="{ 'is-selected': row.path === selectedPath, 'is-dragging': draggingPath === row.path }"
              :title="row.path"
              draggable="true"
              @click="onSearchRowClick(row.path)"
              @dragstart="onSearchRowDragStart(row, $event)"
              @dragend="endEntryDrag"
              @contextmenu.prevent="onSearchRowMenu(row, $event)"
              @keydown="onSearchRowMenuKeydown(row, $event)"
            >
              <span class="file-tree-chevron is-empty"></span>
              <span class="file-tree-icon" :class="`is-${toneOf('file', row.name)}`">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3v5h5" /><path d="M6 3h8l5 5v13H6z" /></svg>
              </span>
              <span class="file-tree-name">{{ row.name }}</span>
              <span v-if="row.directory !== ''" class="file-tree-dir">{{ row.directory }}</span>
            </button>
          </li>
        </ul>
      </template>

      <ul v-else class="file-tree-list">
        <li v-for="row in rows" :key="row.key">
          <button
            v-if="row.type === 'entry'"
            type="button"
            class="file-tree-row"
            :class="{
              'is-selected': row.path === selectedPath,
              'is-directory': row.kind === 'directory',
              'is-dragging': draggingPath === row.path
            }"
            :style="{ paddingLeft: indent(row.depth) }"
            :aria-expanded="row.kind === 'directory' ? row.expanded : undefined"
            :title="row.path"
            draggable="true"
            @click="onRowClick(row)"
            @dragstart="onRowDragStart(row, $event)"
            @dragend="endEntryDrag"
            @contextmenu.prevent="onRowMenu(row, $event)"
            @keydown="onRowMenuKeydown(row, $event)"
          >
            <span class="file-tree-chevron" :class="{ 'is-open': row.expanded, 'is-empty': row.kind !== 'directory' }">
              <svg v-if="row.kind === 'directory'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
            </span>
            <span class="file-tree-icon" :class="`is-${toneOf(row.kind, row.name)}`">
              <svg v-if="row.kind === 'directory'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3v5h5" /><path d="M6 3h8l5 5v13H6z" /></svg>
            </span>
            <span class="file-tree-name">{{ row.name }}</span>
            <span v-if="row.symlink" class="file-tree-tag">链接</span>
          </button>
          <p v-else class="file-tree-notice" :class="`is-${row.tone}`" :style="{ paddingLeft: indent(row.depth) }">
            {{ row.text }}
          </p>
        </li>
      </ul>
    </div>

    <!-- 操作菜单渲染到 body：锚点是被右键的那一行，位置与收起由菜单自己管。 -->
    <FileTreeMenu ref="menu" @notice="showNotice" />
  </div>
</template>
