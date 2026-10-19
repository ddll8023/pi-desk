/**
 * 工作区文件标签的编辑状态：按项目保存已打开文件的读取结果、编辑模式、脏标记与磁盘冲突。
 *
 * 文件内容读写全经主进程：这里只保存「读到了什么、用户改没改、磁盘基线是什么」，
 * 不自行拼接绝对路径。读取结果分文本、图片与「不支持」三类；只有文本可编辑，
 * 且超过可编辑上限的文本只读：这类记录不会变脏，也不接受保存。
 *
 * 打开时的默认模式按文件类型与偏好决定：Markdown 按设置里的默认视图（默认预览，阅读是主要用途），
 * 其余文本进源码；用户在标签内切换后，同一个标签保持该选择，不会每次重读都跳回默认值。
 *
 * 脏标记由编辑器上报，保存时把当前文本交给主进程，并把返回的新磁盘基线写回记录；
 * 外部改动通过 `stat` 比对 size/mtimeMs 发现：未修改的文件自动重新载入，有未保存修改时
 * 只标记冲突，等用户选择覆盖保存或继续编辑，绝不静默丢弃改动。触发时机有两个：窗口重新聚焦，
 * 以及主进程的目录监听回报「这些目录变了」。
 *
 * 预览字号、Front Matter 显隐与源码自动换行是阅读偏好，只放在本窗口内存里：它们不改变文件内容，
 * 也不进偏好 IPC，重启后回默认值。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { DesktopError } from '../../../shared/desktop-api'
import { PROJECT_FILE_EDIT_MAX_BYTES } from '../../../shared/project-file-api'
import type {
  ProjectFileImageContent,
  ProjectFileTextContent,
  ProjectFileUnsupportedContent
} from '../../../shared/project-file-api'
import { fileNameOf, isMarkdownPath } from '../file-language'
import { readProjectFile, statProjectFile, writeProjectFile } from '../services/project-file'
import { usePreferencesStore } from './preferences'

/** 文件标签的展示模式：代码视图与 Markdown 预览；只有 Markdown 文件能切到预览。 */
export type FileEditorMode = 'code' | 'preview'

/** 预览字号档位：只给四档，避免任意值把阅读排版拉坏。 */
export const PREVIEW_FONT_SIZES = [13, 14, 15, 16] as const

/** 预览字号默认值：与聊天正文的 15px 对齐，切到文件预览不会有明显跳变。 */
const DEFAULT_PREVIEW_FONT_SIZE = 15

/** 一次读取的结果状态；错误与「不支持」分开，界面据此给出不同的提示与动作。 */
export type FileLoadView =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly content: ProjectFileTextContent | ProjectFileImageContent }
  | { readonly phase: 'unsupported'; readonly content: ProjectFileUnsupportedContent }
  | { readonly phase: 'error'; readonly error: DesktopError }

/** 一个打开的文件标签记录；`key` 与工作区标签键一致。 */
export interface FileEditorRecord {
  readonly key: string
  readonly projectPath: string
  readonly path: string
  readonly name: string
  readonly markdown: boolean
  readonly load: FileLoadView
  readonly mode: FileEditorMode
  readonly dirty: boolean
  /** 组件卸载前捕获的未保存文本；为 null 表示编辑区与磁盘内容一致。 */
  readonly draft: string | null
  readonly saving: boolean
  readonly saveError: string | null
  /** 磁盘文件在本次编辑期间被外部改动，且当前有未保存修改；需要用户选择如何处理。 */
  readonly conflict: boolean
}

const FILE_KEY_PREFIX = 'file:'

/** 条目的父目录相对路径；根层文件回空串，与目录监听的相对路径同一口径。 */
function parentDirectoryOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

/** 只有读取完成且未超过可编辑上限的文本文件才能编辑与保存。 */
function isEditable(record: FileEditorRecord): boolean {
  const load = record.load
  return load.phase === 'ready'
    && load.content.kind === 'text'
    && load.content.size <= PROJECT_FILE_EDIT_MAX_BYTES
}

export const useProjectEditorStore = defineStore('project-editor', () => {
  const preferencesStore = usePreferencesStore()
  const records = ref<Readonly<Record<string, FileEditorRecord>>>({})
  /** 窗口级阅读偏好：同一窗口内切换文件保持不变，不写盘。 */
  const previewFontSize = ref<number>(DEFAULT_PREVIEW_FONT_SIZE)
  const showFrontmatter = ref(true)
  const codeWrap = ref(true)
  let nextFileTabId = 1
  /** 同一记录只采纳最后一次读取，关闭后也使在途结果失效。 */
  const loadVersions = new Map<string, number>()

  /** 按标签键取记录；不存在时为 null。 */
  function recordOf(key: string): FileEditorRecord | null {
    return records.value[key] ?? null
  }

  /** 同项目内已打开的文件键；用于「再次点击同一文件时聚焦已有标签」。 */
  function keyOf(projectPath: string, path: string): string | null {
    for (const record of Object.values(records.value)) {
      if (record.projectPath === projectPath && record.path === path) return record.key
    }
    return null
  }

  function update(key: string, patch: Partial<FileEditorRecord>): void {
    const record = records.value[key]
    if (record === undefined) return
    records.value = { ...records.value, [key]: { ...record, ...patch } }
  }

  /**
   * 打开一个文件：同项目同路径已打开时直接返回原键，由调用方聚焦该标签。
   * 新键先登记为读取中并立即返回，让标签先出现，读取结果随后写入；读取失败保留错误状态，
   * 不建立可编辑的假内容。Markdown 按偏好取默认视图，其余文本进源码。
   */
  function open(projectPath: string, path: string): string {
    const existing = keyOf(projectPath, path)
    if (existing !== null) return existing

    const key = `${FILE_KEY_PREFIX}${nextFileTabId}`
    nextFileTabId += 1
    const markdown = isMarkdownPath(path)
    const record: FileEditorRecord = {
      key,
      projectPath,
      path,
      name: fileNameOf(path),
      markdown,
      load: { phase: 'loading' },
      mode: markdown ? preferencesStore.markdownDefaultView : 'code',
      dirty: false,
      draft: null,
      saving: false,
      saveError: null,
      conflict: false
    }
    records.value = { ...records.value, [key]: record }
    void loadInto(key)
    return key
  }

  /** 读取或重新读取文件内容；成功后清掉脏标记、保存错误与冲突，失败保留可展示的原因。 */
  async function loadInto(key: string): Promise<void> {
    const record = records.value[key]
    if (record === undefined) return
    const version = (loadVersions.get(key) ?? 0) + 1
    loadVersions.set(key, version)
    update(key, { load: { phase: 'loading' }, dirty: false, draft: null, conflict: false, saveError: null })
    const result = await readProjectFile(record.projectPath, record.path)
    if (records.value[key] === undefined || loadVersions.get(key) !== version) return
    if (!result.ok) {
      update(key, { load: { phase: 'error', error: result.error } })
      return
    }
    const content = result.data
    if (content.kind === 'unsupported') {
      update(key, { load: { phase: 'unsupported', content } })
      return
    }
    // 读取只覆盖内容与保存状态：模式是用户的选择，重读时不回到默认值。
    update(key, { load: { phase: 'ready', content }, saveError: null })
  }

  /** 关闭文件标签：只清内存记录，不改动磁盘。 */
  function close(key: string): void {
    if (records.value[key] === undefined) return
    const next = { ...records.value }
    delete next[key]
    loadVersions.delete(key)
    records.value = next
  }

  /** 关闭某个项目的全部文件记录；项目被移除时调用，避免残留。 */
  function closeProject(projectPath: string): void {
    for (const record of Object.values(records.value)) {
      if (record.projectPath === projectPath) loadVersions.delete(record.key)
    }
    const next = Object.fromEntries(
      Object.entries(records.value).filter(([, record]) => record.projectPath !== projectPath)
    )
    records.value = next
  }

  /** 编辑器上报内容变化：只改脏标记，文本由编辑器自己持有，避免每次击键搬运整份内容。 */
  function markDirty(key: string): void {
    const record = records.value[key]
    if (record === undefined || record.dirty || !isEditable(record)) return
    update(key, { dirty: true })
  }

  /**
   * 组件卸载前捕获未保存文本：打开设置页或切换项目会卸载文件面板，草稿必须留在状态里，
   * 否则重新挂载后未保存的修改会静默丢失。文本与磁盘基线一致时不留草稿。
   */
  function captureDraft(key: string, text: string): void {
    const record = records.value[key]
    if (record === undefined || record.load.phase !== 'ready') return
    const content = record.load.content
    const draft = content.kind === 'text' && text !== content.text ? text : null
    if (record.draft === draft) return
    update(key, { draft, dirty: draft !== null })
  }

  /** 设置预览字号：只接受档位内的整数，越界值忽略，不改动当前字号。 */
  function setPreviewFontSize(size: number): void {
    if (!(PREVIEW_FONT_SIZES as readonly number[]).includes(size)) return
    previewFontSize.value = size
  }

  /** Front Matter 折叠块是否显示；只影响预览，不改动文件内容。 */
  function setShowFrontmatter(value: boolean): void {
    showFrontmatter.value = value
  }

  /** 源码模式是否自动换行；只读大文件仍由界面另行关闭换行。 */
  function setCodeWrap(value: boolean): void {
    codeWrap.value = value
  }

  /** 切换代码视图与 Markdown 预览；非 Markdown 文件忽略该动作。 */
  function setMode(key: string, mode: FileEditorMode): void {
    const record = records.value[key]
    if (record === undefined || !record.markdown) return
    if (record.mode === mode) return
    update(key, { mode })
  }

  /**
   * 保存当前文本：`force` 为真表示用户已确认覆盖外部改动，跳过磁盘基线比对。
   * 成功时把返回的新基线写回记录，并清除脏标记与冲突；失败保留原因，CONFLICT 额外标记冲突。
   */
  async function save(key: string, text: string, force = false): Promise<boolean> {
    const record = records.value[key]
    if (record === undefined || record.load.phase !== 'ready' || !isEditable(record)) return false
    const content = record.load.content
    if (content.kind !== 'text' || record.saving) return false

    update(key, { saving: true, saveError: null })
    const expected = force ? null : { size: content.size, mtimeMs: content.mtimeMs }
    const result = await writeProjectFile(record.projectPath, record.path, text, content.eol, content.bom, expected)
    if (records.value[key] === undefined) return false
    if (!result.ok) {
      update(key, {
        saving: false,
        saveError: result.error.message,
        conflict: result.error.code === 'CONFLICT'
      })
      return false
    }
    update(key, {
      saving: false,
      dirty: false,
      draft: null,
      conflict: false,
      saveError: null,
      load: {
        phase: 'ready',
        content: { ...content, text, size: result.data.size, mtimeMs: result.data.mtimeMs }
      }
    })
    return true
  }

  /**
   * 检查磁盘是否被外部改动。未修改的文件自动重新载入；有未保存修改时只标记冲突。
   * 已在冲突状态或正在保存时不重复检查，避免覆盖用户的选择。
   * 等待 `stat` 期间保存可能已经完成，因此拿到结果后重新取一次记录再比对，不用旧基线覆盖新状态。
   */
  async function checkExternal(key: string): Promise<void> {
    const initial = records.value[key]
    if (initial === undefined || initial.load.phase !== 'ready' || initial.saving || initial.conflict) return

    const baselineAtRequest = initial.load.content
    const result = await statProjectFile(initial.projectPath, initial.path)
    const latest = records.value[key]
    if (latest === undefined || latest.load.phase !== 'ready' || latest.saving || latest.conflict
      || latest.load.content !== baselineAtRequest) return
    if (!result.ok) return

    const baseline = latest.load.content
    if (!result.data.exists) {
      if (latest.dirty) update(key, { conflict: true })
      else update(key, {
        load: { phase: 'error', error: { code: 'INTERNAL_ERROR', message: '文件已被删除，可能由外部程序移动或删除。' } }
      })
      return
    }
    if (result.data.size === baseline.size && result.data.mtimeMs === baseline.mtimeMs) return
    if (latest.dirty) {
      update(key, { conflict: true })
      return
    }
    await loadInto(key)
  }

  /** 按磁盘内容重新读取：用于读取失败后的重试与外部改动后的自动载入；保存进行中时不打断。 */
  async function reload(key: string): Promise<void> {
    const record = records.value[key]
    if (record === undefined || record.saving) return
    await loadInto(key)
  }

  /**
   * 目录监听回报一批目录变化：父目录命中的已打开文件逐个重新比对磁盘基线。
   * 与窗口聚焦走同一套判断（`checkExternal`），只读 `stat`，不写盘也不抢用户的未保存改动。
   */
  function checkChangedDirectories(projectPath: string, directories: readonly string[]): void {
    if (directories.length === 0) return
    const changed = new Set(directories)
    for (const record of Object.values(records.value)) {
      if (record.projectPath !== projectPath || !changed.has(parentDirectoryOf(record.path))) continue
      void checkExternal(record.key)
    }
  }

  /**
   * 重新比对全部已打开文件的磁盘基线：用于拿不到具体目录的整树刷新（如目录监听 overflow）。
   * 代价只是每个标签一次 `stat`，文件不多时可以接受。
   */
  function checkAllExternal(projectPath: string): void {
    for (const record of Object.values(records.value)) {
      if (record.projectPath === projectPath) void checkExternal(record.key)
    }
  }

  return {
    records,
    recordOf,
    keyOf,
    previewFontSize,
    showFrontmatter,
    codeWrap,
    setPreviewFontSize,
    setShowFrontmatter,
    setCodeWrap,
    open,
    close,
    closeProject,
    markDirty,
    captureDraft,
    setMode,
    save,
    checkExternal,
    checkChangedDirectories,
    checkAllExternal,
    reload
  }
})
