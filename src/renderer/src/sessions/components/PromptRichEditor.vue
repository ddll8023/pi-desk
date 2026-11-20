<!-- 提示词输入坞的富文本输入：纯文本与引用胶囊（文件、命令）在同一行内混排。
     契约：草稿字符串是唯一文本真源，本组件只是它的视图——输入后序列化上报，
     外部写入时按文本重建 DOM（胶囊由「行首 /命令」与「路径形状」两条规则识别），
     因此会话留底、回退回填、界面命令拦截与提交都不需要新的数据结构。
     边界：胶囊是 contenteditable=false 的整块节点，退格整块删除；粘贴一律按纯文本写入，
     避免带入外部 HTML；输入法组合态期间不重建 DOM，否则候选词会被打断。 -->
<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { PROJECT_FILE_QUERY_MAX_CHARS } from '../../../../shared/project-file-api'

interface Props {
  readonly modelValue: string
  readonly placeholder: string
  /** 补全弹层是否展开：展开期间方向键、Tab、Esc 交给上层处理，不移动光标。 */
  readonly popupOpen: boolean
  /** Enter 是否被补全占用（文件候选未定），占用时 Enter 接受候选而不是发送。 */
  readonly enterConsumes: boolean
  readonly controls?: string | undefined
  readonly expanded?: boolean
  readonly describedBy?: string | undefined
}

const props = defineProps<Props>()
const emit = defineEmits<{
  'update:modelValue': [text: string]
  submit: []
  'paste-files': [files: File[]]
  /** 光标前的 `@` 引用查询串；不在引用里时为 null。 */
  'file-query': [query: string | null]
  /** 光标前的斜杠命令查询串；不在命令里时为 null。 */
  'command-query': [query: string | null]
  nav: [direction: 'up' | 'down' | 'accept' | 'dismiss']
}>()

const root = ref<HTMLElement | null>(null)
/** 输入法组合态：此期间不读光标也不重建 DOM，只等 compositionend 后统一上报。 */
const composing = ref(false)
/** 失焦后仍要能插入引用（文件树拖入），因此记住最后一次光标所在的文本偏移。 */
const lastOffset = ref(0)
/** 上一次上报的两类查询串，避免每次按键都重复触发检索。 */
let lastQuery: string | null = null
let lastCommandQuery: string | null = null

/**
 * 引用识别：命令必须位于行首或空白之后（与宿主的技能调用判定一致）；
 * 路径允许中文与其他非 ASCII 字符，因此字符类按「非空白、非引号、非常见标点」取，不用 \w。
 */
const TOKEN_PATTERN = /(^|\s)(\/[A-Za-z][\w:.-]*)|(^|\s)("[^"\n]+"|[^\s"'`,;:()[\]<>]+[./\\][^\s"'`,;:()[\]<>]*\.[A-Za-z0-9]{1,8})/g

/** 浏览器粘贴时可能生成的块级元素；序列化时按换行处理。 */
const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'PRE'])

function baseName(value: string): string {
  const slash = value.lastIndexOf('/')
  return slash >= 0 ? value.slice(slash + 1) : value
}

/** 胶囊节点：图标 + 短标签，完整值放在 dataset 与 title，序列化时以它为准。 */
function createToken(kind: 'file' | 'command', value: string): HTMLElement {
  const token = document.createElement('span')
  token.className = `prompt-token prompt-token-${kind}`
  token.contentEditable = 'false'
  token.dataset.token = kind
  token.dataset.value = value
  token.title = value
  const glyph = document.createElement('span')
  glyph.className = 'prompt-token-glyph'
  glyph.setAttribute('aria-hidden', 'true')
  glyph.textContent = kind === 'file' ? '＠' : '/'
  const label = document.createElement('span')
  label.className = 'prompt-token-label'
  label.textContent = kind === 'file' ? baseName(value) : value.replace(/^\//u, '')
  token.append(glyph, label)
  return token
}

/** 把纯文本片段写进节点：换行还原成 br，空片段不产生文本节点。 */
function appendText(parent: Node, value: string): void {
  const lines = value.split('\n')
  lines.forEach((line, index) => {
    if (index > 0) parent.appendChild(document.createElement('br'))
    if (line !== '') parent.appendChild(document.createTextNode(line))
  })
}

/** 文本 → 视图：按引用规则切段，非引用部分是纯文本。 */
function render(text: string): void {
  const element = root.value
  if (element === null) return
  const fragment = document.createDocumentFragment()
  let cursor = 0
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    // 两个分支各带一个前置空白分组，未参与匹配的一侧为 undefined，不能直接取长度。
    const lead = match[1] ?? match[3] ?? ''
    const token = match[2] ?? match[4] ?? ''
    if (token === '') continue
    const start = match.index + lead.length
    if (start > cursor) appendText(fragment, text.slice(cursor, start))
    fragment.appendChild(createToken(match[2] !== undefined ? 'command' : 'file', token))
    cursor = start + token.length
  }
  if (cursor < text.length) appendText(fragment, text.slice(cursor))
  element.replaceChildren(fragment)
}

/** 视图 → 文本：胶囊取其完整值，br 与块级元素按换行处理，其余取文本内容。 */
function serialize(node: ParentNode | null): string {
  if (node === null) return ''
  let text = ''
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      text += child.textContent ?? ''
      return
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return
    const element = child as HTMLElement
    const value = element.dataset.value
    if (value !== undefined) {
      text += value
      return
    }
    if (element.tagName === 'BR') {
      text += '\n'
      return
    }
    if (BLOCK_TAGS.has(element.tagName)) {
      if (text !== '' && !text.endsWith('\n')) text += '\n'
      text += serialize(element)
      return
    }
    text += serialize(element)
  })
  // contenteditable 会把行尾普通空格写成不换行空格，提交时必须还原成普通空格。
  return text.replace(/\u00a0/gu, ' ')
}

/** 光标两侧的文本；范围外（未聚焦、选区不在组件内）时返回 null。 */
function caretTexts(): { before: string; after: string } | null {
  const element = root.value
  if (element === null) return null
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!element.contains(range.startContainer)) return null
  const before = range.cloneRange()
  before.selectNodeContents(element)
  before.setEnd(range.startContainer, range.startOffset)
  const after = range.cloneRange()
  after.selectNodeContents(element)
  after.setStart(range.endContainer, range.endOffset)
  return { before: serialize(before.cloneContents()), after: serialize(after.cloneContents()) }
}

/** 把光标放到文本偏移处；只处理本组件自己生成的节点（文本、br、胶囊）。 */
function placeCaret(offset: number): void {
  const element = root.value
  if (element === null) return
  const selection = window.getSelection()
  if (selection === null) return
  const range = document.createRange()
  let remaining = Math.max(0, offset)
  for (const child of Array.from(element.childNodes)) {
    const length = child.nodeType === Node.ELEMENT_NODE && (child as HTMLElement).dataset.value !== undefined
      ? ((child as HTMLElement).dataset.value ?? '').length
      : child.nodeType === Node.ELEMENT_NODE && (child as HTMLElement).tagName === 'BR'
        ? 1
        : (child.textContent ?? '').length
    if (child.nodeType === Node.TEXT_NODE && remaining <= length) {
      range.setStart(child, remaining)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
      lastOffset.value = Math.max(0, offset)
      return
    }
    if (remaining <= 0) {
      // 光标停在胶囊或 br 之前
      range.setStartBefore(child)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
      lastOffset.value = Math.max(0, offset)
      return
    }
    remaining -= length
  }
  range.selectNodeContents(element)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
  lastOffset.value = Math.max(0, offset)
}

function notifyText(): void {
  emit('update:modelValue', serialize(root.value))
}

/** 写入新文本并落光标：所有插入路径都走这里，保证视图与上报值始终一致。 */
function applyText(text: string, caret: number): void {
  render(text)
  notifyText()
  void nextTick(() => {
    // 先拿焦点再落光标：对未聚焦的可编辑区先设选区会被 focus 重置到开头。
    root.value?.focus()
    placeCaret(caret)
    refreshQueries()
  })
}

/** `@` 引用的起点：`@` 必须在行首或空白之后，查询串不含空白且不超长度上限。 */
function fileQueryStart(before: string): number | null {
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/u.test(before.charAt(at - 1))) return null
  const query = before.slice(at + 1)
  if (query.length > PROJECT_FILE_QUERY_MAX_CHARS) return null
  if (/\s/u.test(query)) return null
  return at
}

/** 斜杠命令的起点：`/` 必须在行首或空白之后，查询串不含空白（仍在命令名内）。 */
function commandQueryStart(before: string): number | null {
  const slash = before.lastIndexOf('/')
  if (slash < 0) return null
  if (slash > 0 && !/\s/u.test(before.charAt(slash - 1))) return null
  if (/\s/u.test(before.slice(slash + 1))) return null
  return slash
}

/** 重算并上报两类查询（`@` 引用与斜杠命令）；光标不在引用里时各上报 null。 */
function refreshQueries(): void {
  const texts = caretTexts()
  if (texts === null) {
    if (lastQuery !== null) {
      lastQuery = null
      emit('file-query', null)
    }
    if (lastCommandQuery !== null) {
      lastCommandQuery = null
      emit('command-query', null)
    }
    return
  }

  const at = fileQueryStart(texts.before)
  const query = at === null ? null : texts.before.slice(at + 1)
  lastOffset.value = texts.before.length
  if (query !== lastQuery) {
    lastQuery = query
    emit('file-query', query)
  }

  const slash = commandQueryStart(texts.before)
  const commandQuery = slash === null ? null : texts.before.slice(slash + 1)
  if (commandQuery !== lastCommandQuery) {
    lastCommandQuery = commandQuery
    emit('command-query', commandQuery)
  }
}

/** 清空两类查询的上报状态：程序写入后光标位置已变，不能让旧候选留着。 */
function clearQueries(): void {
  lastQuery = null
  lastCommandQuery = null
  emit('file-query', null)
  emit('command-query', null)
}

/**
 * 在光标处插一条命令：先把正在输入的 `/查询串` 换成这条命令，再补一个空格供追加参数。
 * 命令可以出现在输入内容的任意位置——用户可以在一条消息里插入多条；
 * 宿主只会展开消息开头的那一条（`_expandSkillCommand`），后面的会作为普通文本发给模型。
 */
function insertCommand(command: string): void {
  const texts = caretTexts()
  const full = serialize(root.value)
  const fallback = Math.min(lastOffset.value, full.length)
  const before = texts?.before ?? full.slice(0, fallback)
  const after = texts?.after ?? full.slice(fallback)

  // 正在输入的命令串整段替换：从 `/` 起删到光标，查询串本身不含空白。
  const queryStart = commandQueryStart(before)
  const head = queryStart === null ? before : before.slice(0, queryStart)
  const inserted = `${command} `
  clearQueries()
  applyText(`${head}${inserted}${after}`, (head + inserted).length)
}

/** 接受 `@` 搜索候选：把 `@查询串` 换成引用值（含末尾空格），光标停在插入内容之后。 */
function acceptFileQuery(value: string): void {
  const texts = caretTexts() ?? { before: serialize(root.value), after: '' }
  const at = fileQueryStart(texts.before)
  const before = at === null ? texts.before : texts.before.slice(0, at)
  clearQueries()
  applyText(`${before}${value}${texts.after}`, before.length + value.length)
}

/** 在光标处插入引用；组件已失焦时回落到最后一次记录的位置（文件树拖入走这里）。 */
function insertText(value: string): void {
  if (value === '') return
  const texts = caretTexts()
  if (texts !== null) {
    applyText(`${texts.before}${value}${texts.after}`, texts.before.length + value.length)
    return
  }
  const current = serialize(root.value)
  const at = Math.min(lastOffset.value, current.length)
  applyText(`${current.slice(0, at)}${value}${current.slice(at)}`, at + value.length)
}

function focus(): void {
  root.value?.focus()
  void nextTick(() => placeCaret(lastOffset.value))
}

function onKeydown(event: KeyboardEvent): void {
  // 输入法组合态下方向键与确认键属于候选词操作，不参与补全也不发送。
  if (composing.value || event.isComposing || event.keyCode === 229) return

  if (props.popupOpen) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      emit('nav', event.key === 'ArrowDown' ? 'down' : 'up')
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      emit('nav', 'accept')
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      emit('nav', 'dismiss')
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && props.enterConsumes) {
      // 引用没选完时宁可吞掉 Enter，也不把半截路径发出去。
      event.preventDefault()
      emit('nav', 'accept')
      return
    }
  }

  if (event.key !== 'Enter') return
  event.preventDefault()
  if (event.shiftKey) {
    insertText('\n')
    return
  }
  emit('submit')
}

function onInput(): void {
  const element = root.value
  if (element !== null) {
    // 浏览器偶尔会留下空的 div/br 组合，规范化只在确有块级残留时按文本重建，避免打扰正常输入。
    const stray = Array.from(element.children).some((child) => BLOCK_TAGS.has(child.tagName))
    if (stray) {
      const text = serialize(element)
      render(text)
      placeCaret(text.length)
    }
  }
  if (composing.value) return
  notifyText()
  refreshQueries()
}

function onPaste(event: ClipboardEvent): void {
  const files = [...(event.clipboardData?.files ?? [])]
  if (files.some((file) => file.type.startsWith('image/'))) {
    event.preventDefault()
    emit('paste-files', files)
    return
  }
  // 一律按纯文本粘贴：外部 HTML 会带进样式与块结构，胶囊识别也会被它打乱。
  event.preventDefault()
  const text = event.clipboardData?.getData('text/plain') ?? ''
  if (text !== '') insertText(text.replace(/\r\n/gu, '\n'))
}

function onCompositionStart(): void {
  composing.value = true
}

function onCompositionEnd(): void {
  composing.value = false
  notifyText()
  refreshQueries()
}

/** 光标移动同样会改变 `@` 引用（方向键、点击），因此额外跟随一次选区变化。 */
function onSelectionChange(): void {
  if (composing.value) return
  const element = root.value
  if (element === null) return
  if (!element.contains(document.activeElement)) return
  refreshQueries()
}

onMounted(() => {
  render(props.modelValue)
  document.addEventListener('selectionchange', onSelectionChange)
})

onUnmounted(() => {
  document.removeEventListener('selectionchange', onSelectionChange)
})

/** 外部写入（会话切换、回退回填、命令清空、补全写入）：与当前视图一致时不做任何事。 */
watch(() => props.modelValue, (text) => {
  if (text === serialize(root.value)) return
  render(text)
  lastQuery = null
  emit('file-query', null)
  void nextTick(() => {
    const element = root.value
    if (element !== null && element.contains(document.activeElement)) {
      placeCaret(text.length)
      refreshQueries()
    }
  })
})

defineExpose({ focus, insertText, acceptFileQuery, insertCommand, getText: () => serialize(root.value), element: root })
</script>

<template>
  <div
    ref="root"
    class="prompt-composer-rich"
    role="textbox"
    aria-multiline="true"
    aria-autocomplete="list"
    :aria-controls="controls"
    :aria-expanded="expanded === true ? 'true' : 'false'"
    :aria-describedby="describedBy"
    :data-placeholder="placeholder"
    contenteditable="true"
    spellcheck="false"
    @keydown="onKeydown"
    @input="onInput"
    @paste="onPaste"
    @compositionstart="onCompositionStart"
    @compositionend="onCompositionEnd"
    @click="refreshQueries"
    @focus="refreshQueries"
  ></div>
</template>
