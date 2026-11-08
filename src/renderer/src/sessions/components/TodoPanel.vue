<!-- 待办清单面板：显示当前轮的待办清单，挂在输入坞上方。
     数据来自宿主活动投影（本轮 `todo_write` 结果的 details）；新一轮开始或模型提交空清单时
     宿主给出 null，整块不渲染，不留上一轮的旧清单。本组件只做展示与进度计数，不判定门禁、不改写清单。
     标题行就是折叠开关：默认展开，收起后只留完成进度，折叠状态不持久化。
     条目只有一段文本，标题里的文件名就地渲染成 chip：句子保持完整，不额外重复一份文件列表。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SessionTodoItem, SessionTodoList } from '../../../../shared/runtime-api'
import AppButton from '../../ui/AppButton.vue'

/** 正文分段：普通文本原样输出，文件名渲染成 chip；两段之间不插入空格，避免改写模型原文。 */
type TodoSegment =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'file'; readonly value: string; readonly path: string }

/** 一条待办拆给模板用的行数据：序号取自清单顺序，正文按文件名切成文本段与文件段。 */
interface TodoRow {
  readonly key: string
  readonly index: number
  readonly status: SessionTodoItem['status']
  readonly segments: readonly TodoSegment[]
}

const props = defineProps<{ readonly todos: SessionTodoList | null }>()

const expanded = ref(true)

/** 带目录的文件路径；后缀之后不能再接标识符字符，免得把 `foo.tsx` 截成 `foo.ts`。 */
const FILE_TOKEN = /[\w@~.-]*(?:\/[\w@.-]+)*\/[\w@.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|vue|json|md|mdx|css|scss|less|html|py|go|rs|java|kt|sh|bash|zsh|yml|yaml|toml|ini|sql|txt|xml)(?![\w])/g

/** 不带目录的文件名同样要成 chip：路径版只覆盖含 `/` 的写法，这里补同目录写法。 */
const BARE_FILE_TOKEN = /[\w@~-]+\.[A-Za-z0-9]+(?![A-Za-z0-9])/g

/** 视为文件的后缀；不在此列的扩展名按普通文本处理，避免把 URL 片段误判成文件。 */
const FILE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'json', 'md', 'mdx', 'css', 'scss', 'less',
  'html', 'py', 'go', 'rs', 'java', 'kt', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'ini',
  'sql', 'txt', 'xml'
])

function isFileToken(token: string): boolean {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return false
  return FILE_EXTENSIONS.has(token.slice(dot + 1).toLowerCase())
}

/** chip 只显示文件名，全路径放进 title：dock 宽度有限，长路径会撑爆整行。 */
function fileLabel(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? path : path.slice(slash + 1)
}

/** 按出现顺序合并两类 token 的匹配位置，重叠时保留更靠前、更长的一段。 */
function splitSegments(text: string): readonly TodoSegment[] {
  const hits: { start: number; end: number }[] = []
  for (const pattern of [FILE_TOKEN, BARE_FILE_TOKEN]) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0
      const end = start + match[0].length
      if (!isFileToken(match[0])) continue
      if (hits.some(hit => start < hit.end && end > hit.start)) continue
      hits.push({ start, end })
    }
  }
  if (hits.length === 0) return [{ kind: 'text', value: text }]

  hits.sort((left, right) => left.start - right.start)
  const segments: TodoSegment[] = []
  let cursor = 0
  for (const hit of hits) {
    if (hit.start > cursor) segments.push({ kind: 'text', value: text.slice(cursor, hit.start) })
    const path = text.slice(hit.start, hit.end)
    segments.push({ kind: 'file', value: fileLabel(path), path })
    cursor = hit.end
  }
  if (cursor < text.length) segments.push({ kind: 'text', value: text.slice(cursor) })
  return segments
}

const rows = computed<readonly TodoRow[]>(() =>
  (props.todos?.items ?? []).map((item, index) => ({
    key: `${index}-${item.text}`,
    index: index + 1,
    status: item.status,
    segments: splitSegments(item.text)
  }))
)

const doneCount = computed(() => rows.value.filter(row => row.status === 'completed').length)
const title = computed(() => `待办 ${doneCount.value}/${rows.value.length}`)

/** 状态用文字表达在胶囊里，不只用颜色：读屏与色觉差异场景下同样可辨。 */
function statusLabel(status: SessionTodoItem['status']): string {
  if (status === 'completed') return '已完成'
  return status === 'in_progress' ? '进行中' : '待处理'
}
</script>

<template>
  <section v-if="rows.length > 0" class="prompt-todo" aria-labelledby="prompt-todo-title">
    <AppButton
      variant="unstyled"
      class="prompt-todo-head"
      :aria-expanded="expanded"
      aria-controls="prompt-todo-list"
      :title="expanded ? '折叠待办清单，只留完成进度' : '展开待办清单'"
      @click="expanded = !expanded"
    >
      <span id="prompt-todo-title" class="prompt-todo-title">{{ title }}</span>
      <span class="prompt-todo-chevron" aria-hidden="true">{{ expanded ? '⌃' : '⌄' }}</span>
    </AppButton>
    <ul v-show="expanded" id="prompt-todo-list" class="prompt-todo-list scroll-area" role="list">
      <li
        v-for="row in rows"
        :key="row.key"
        class="prompt-todo-item"
        :class="`is-${row.status}`"
      >
        <span class="prompt-todo-ring" aria-hidden="true">
          <span v-if="row.status === 'completed'" class="prompt-todo-ring-check">✓</span>
        </span>
        <span class="prompt-todo-index" aria-hidden="true">{{ row.index }}.</span>
        <span class="prompt-todo-text">
          <template v-for="(segment, segmentIndex) in row.segments" :key="segmentIndex">
            <span
              v-if="segment.kind === 'file'"
              class="prompt-todo-file"
              :title="segment.path"
            >{{ segment.value }}</span>
            <template v-else>{{ segment.value }}</template>
          </template>
        </span>
        <span class="prompt-todo-status">{{ statusLabel(row.status) }}</span>
      </li>
    </ul>
  </section>
</template>
