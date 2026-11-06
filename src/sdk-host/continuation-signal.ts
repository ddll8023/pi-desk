/**
 * 延续判定的唯一实现：只用两个确定性信号，不做相似度打分。
 *
 * 中文正文不以空格分词，按词元算相似度会退化成「有没有出现文件后缀名」，
 * 因此这里只认显式措辞与上一轮改动文件的引用；两者都给不出结论时返回 null，
 * 由调用方退回指令层判断，不用猜测补一个结论。
 */
import type { SessionTurnFiles } from '../shared/runtime-api'

export interface ContinuationVerdict {
  readonly verdict: 'continuation' | 'new_task'
  readonly signal: 'wording' | 'file-reference'
}

/** 指向延续的措辞：只收文档 §4.1 已列出的说法，不扩充近义词表。 */
const CONTINUATION_PHRASES: readonly string[] = ['再加', '改成', '不对应该', '修复刚才']

/** 指向新任务的措辞。 */
const NEW_TASK_PHRASES: readonly string[] = ['现在做', '接下来', '另外']

/** 过短的文件名会在无关句子里误命中，只认能作为标识的片段。 */
const MIN_REFERENCE_CHARS = 4

function matchesAny(prompt: string, phrases: readonly string[]): boolean {
  return phrases.some(phrase => prompt.includes(phrase))
}

/** 命中上一轮改动文件的名字或路径，才算引用；只比对文件名，不比对目录。 */
function referencesLastTurn(prompt: string, turn: SessionTurnFiles | null): boolean {
  if (turn === null) return false
  for (const file of turn.files) {
    const name = file.label.split(/[\\/]/u).pop() ?? ''
    if (name.length < MIN_REFERENCE_CHARS) continue
    if (prompt.includes(name)) return true
  }
  return false
}

/**
 * 措辞优先于文件引用：同一句话里两种信号都出现时按措辞判，避免「接下来改 a.ts」被当成延续。
 * 措辞互相矛盾或都没有、且没有文件引用时返回 null。
 */
export function judgeContinuation(prompt: string, turn: SessionTurnFiles | null): ContinuationVerdict | null {
  const wantsContinuation = matchesAny(prompt, CONTINUATION_PHRASES)
  const wantsNewTask = matchesAny(prompt, NEW_TASK_PHRASES)
  if (wantsContinuation && !wantsNewTask) return { verdict: 'continuation', signal: 'wording' }
  if (wantsNewTask && !wantsContinuation) return { verdict: 'new_task', signal: 'wording' }
  if (wantsContinuation && wantsNewTask) return null
  return referencesLastTurn(prompt, turn) ? { verdict: 'continuation', signal: 'file-reference' } : null
}
