<!--
  文件标签的代码编辑器：CodeMirror 6 的薄封装，只负责创建/销毁编辑器、受控文本同步与内容变化上报。

  文本由编辑器自己持有：内容变化只上报 `change`（不搬运整份文本），保存时由父级调用 `getText()` 取当前值，
  避免每次击键都把整份文件通过 props/事件往返一次。保存快捷键由面板统一处理，编辑器不重复绑定。
  `modelValue` 只在外部重新载入时变化，此时重建编辑器状态并清空撤销历史；自身编辑回声因文本相同而不会触发重建。

  语言按文件名/扩展名从 `@codemirror/language-data` 按需动态加载，加载失败退化为纯文本。
  自动换行由父级控制：只读预览大文件时关闭换行，避免超长行参与折行测量。
  主题与高亮颜色全部引用 `--color-desk-*` 令牌，跟随应用的亮/暗主题，无需在脚本里判断模式。
  正文左右留出内边距，长行与折行都不贴行号栏和右边界；行号栏只留一条分隔线，不再用整块底色压住正文。
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { basicSetup } from 'codemirror'
import { Compartment, EditorState } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as highlightTags } from '@lezer/highlight'
import { languageDescriptionForPath } from '../file-language'

const props = defineProps<{
  /** 外部文本；只在重新载入或初次挂载时使用。 */
  readonly modelValue: string
  /** 项目内相对路径；只用于语言匹配与无障碍标签。 */
  readonly path: string
  readonly readOnly: boolean
  /** 是否自动换行；只读大文件与用户关闭换行时都为假，减少长行的折行测量。 */
  readonly wrap: boolean
}>()

const emit = defineEmits<{
  change: []
}>()

/** 编辑器外观：颜色全部走令牌，字体复用应用等宽字体。 */
const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--color-desk-ink)',
    backgroundColor: 'var(--color-desk-surface)',
    fontSize: '13px'
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.65' },
  '.cm-content': { caretColor: 'var(--color-desk-accent)', padding: '12px 16px' },
  '.cm-gutters': {
    backgroundColor: 'var(--color-desk-surface)',
    color: 'var(--color-desk-muted)',
    border: 'none',
    borderRight: '1px solid var(--color-desk-line)',
    paddingRight: '4px'
  },
  '.cm-lineNumbers .cm-gutterElement': { fontSize: '11px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--color-desk-accent-soft) 35%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--color-desk-accent-soft)', color: 'var(--color-desk-ink)' },
  '.cm-cursor': { borderLeftColor: 'var(--color-desk-accent)' },
  '.cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--color-desk-accent) 22%, transparent)'
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--color-desk-accent) 28%, transparent)'
  },
  '.cm-panels': { backgroundColor: 'var(--color-desk-surface-subtle)', color: 'var(--color-desk-ink)' },
  '.cm-panel input, .cm-panel button': { fontFamily: 'var(--font-sans)' },
  '.cm-searchMatch': { backgroundColor: 'var(--color-desk-warning-soft)', outline: '1px solid var(--color-desk-warning)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--color-desk-accent-soft)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--color-desk-surface)',
    border: '1px solid var(--color-desk-line-strong)',
    color: 'var(--color-desk-ink)'
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--color-desk-surface-subtle)',
    border: '1px solid var(--color-desk-line)',
    color: 'var(--color-desk-muted)'
  }
})

/** 语法高亮：语义色只区分结构，不引入第二套配色体系。 */
const editorHighlight = HighlightStyle.define([
  { tag: highlightTags.keyword, color: 'var(--color-desk-accent)' },
  { tag: [highlightTags.comment, highlightTags.lineComment, highlightTags.blockComment], color: 'var(--color-desk-muted)', fontStyle: 'italic' },
  { tag: [highlightTags.string, highlightTags.special(highlightTags.string)], color: 'var(--color-desk-success)' },
  { tag: [highlightTags.number, highlightTags.bool, highlightTags.null], color: 'var(--color-desk-warning)' },
  { tag: [highlightTags.typeName, highlightTags.className, highlightTags.namespace], color: 'var(--color-desk-accent)' },
  { tag: [highlightTags.function(highlightTags.variableName), highlightTags.labelName], color: 'var(--color-desk-accent)' },
  { tag: [highlightTags.operator, highlightTags.punctuation], color: 'var(--color-desk-muted)' },
  { tag: [highlightTags.tagName], color: 'var(--color-desk-accent)' },
  { tag: [highlightTags.attributeName], color: 'var(--color-desk-warning)' },
  { tag: [highlightTags.heading], fontWeight: '600' },
  { tag: [highlightTags.link, highlightTags.url], color: 'var(--color-desk-accent)', textDecoration: 'underline' },
  { tag: [highlightTags.invalid], color: 'var(--color-desk-danger)' }
])

const host = ref<HTMLElement | null>(null)
let view: EditorView | null = null
/** 当前语言扩展；重建状态时复用最近一次加载结果。 */
let languageSupport: Extension = []
/** 语言异步加载的序号：连续切换文件时只让最后一次生效。 */
let languageToken = 0
const languageCompartment = new Compartment()
const readOnlyCompartment = new Compartment()
const wrapCompartment = new Compartment()

/** 换行开关按需生效；关闭时超长行横向滚动，不参与折行测量。 */
function wrapExtensions(): Extension {
  return props.wrap ? EditorView.lineWrapping : []
}

/** 只读态同时关闭编辑与输入，避免内容仍可被粘贴修改。 */
function readOnlyExtensions(): Extension {
  return props.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []
}

/** 组装一份完整编辑器状态；撤销历史随状态重建。 */
function buildState(text: string): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      basicSetup,
      wrapCompartment.of(wrapExtensions()),
      editorTheme,
      syntaxHighlighting(editorHighlight),
      languageCompartment.of(languageSupport),
      readOnlyCompartment.of(readOnlyExtensions()),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) emit('change')
      })
    ]
  })
}

/** 按路径加载语言包；失败或匹配不到时退化为纯文本，不阻塞编辑器可用。 */
async function applyLanguage(path: string): Promise<void> {
  const token = ++languageToken
  const description = languageDescriptionForPath(path)
  let support: Extension = []
  if (description !== null) {
    try {
      support = await description.load()
    } catch {
      support = []
    }
  }
  if (token !== languageToken) return
  languageSupport = support
  view?.dispatch({ effects: languageCompartment.reconfigure(support) })
}

onMounted(() => {
  if (host.value === null) return
  view = new EditorView({ state: buildState(props.modelValue), parent: host.value })
  void applyLanguage(props.path)
})

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})

// 外部重新载入：文本确实不同才重建，避免把自身编辑回声当成外部改动。
watch(() => props.modelValue, (text) => {
  if (view === null || view.state.doc.toString() === text) return
  view.setState(buildState(text))
})

watch(() => props.path, (path) => {
  void applyLanguage(path)
})

watch(() => props.readOnly, () => {
  view?.dispatch({ effects: readOnlyCompartment.reconfigure(readOnlyExtensions()) })
})

watch(() => props.wrap, () => {
  view?.dispatch({ effects: wrapCompartment.reconfigure(wrapExtensions()) })
})

defineExpose({
  /** 保存时取当前文本；编辑器尚未建立时退回初始值。 */
  getText: (): string => view?.state.doc.toString() ?? props.modelValue,
  focus: (): void => view?.focus()
})
</script>

<template>
  <div ref="host" class="file-editor-code" :aria-label="`编辑 ${props.path}`"></div>
</template>
