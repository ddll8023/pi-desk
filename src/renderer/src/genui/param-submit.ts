/**
 * 界面参数的显式提交：把当前取值组装成一条用户消息，交给既有 `sendPrompt`。
 *
 * 只有用户点击提交才走这条路径：参数变化本身不触发任何请求，界面也不自动提交。
 * 提交文本是真实的用户消息，会进入历史与模型上下文，因此格式固定为「固定前缀 + 逐行参数」，
 * 前缀与扩展层提示词共用同一份定义（`GENUI_SUBMIT_PREFIX`），让模型能认出这是同一份界面的回填，
 * 也让用户在气泡里一眼看出它不是自己手打的。逐行输出全部已声明参数：条件未满足（界面上被隐藏）
 * 的那几行同样保留，并在行尾追加「条件未满足，未生效」，避免模型以为自己声明的参数丢了。
 *
 * 取值来源是渲染端内存（见 `param-state.ts`）：这里不读 session、不做派生计算；
 * 本机旁路文件由 `param-persistence.ts` 负责，提交时顺手把待写的变化落盘。
 * 自由文本参数会原样进入模型上下文，因此格式化时用「」包裹、空值明写为「未填写」：
 * 换行已在收敛层剥成空格，逐行结构不会被用户输入破坏。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import type { GenuiDocument, GenuiParam, GenuiParamValue } from '../../../shared/genui-api'
import { GENUI_SUBMIT_PREFIX, isGenuiParamVisible } from '../../../shared/genui-api'
import { useRuntimeStore } from '../stores/runtime'
import { flushGenuiParamPersistence } from './param-persistence'

/** 单个参数的展示文本；取值缺失或类型不符时用默认值，不输出空值。 */
function formatParamValue(param: GenuiParam, value: GenuiParamValue | undefined): string {
  switch (param.type) {
    case 'number': {
      const current = typeof value === 'number' && Number.isFinite(value) ? value : param.default
      return param.unit === undefined ? String(current) : `${current} ${param.unit}`
    }
    case 'select': {
      const current = typeof value === 'string' ? value : param.default
      const option = param.options.find((item) => item.value === current)
      if (option === undefined) return current
      // 标签与原始值不同时一并给出，模型拿到的仍是可枚举的 value。
      return option.label === current ? current : `${option.label}（${current}）`
    }
    case 'toggle':
      return (typeof value === 'boolean' ? value : param.default) ? '是' : '否'
    case 'text': {
      const current = typeof value === 'string' ? value : param.default
      // 空值不阻止提交，但要写清楚是用户留空，而不是模型漏了一个参数。
      if (current === '') return '（未填写）'
      // 包裹成引号，让用户文本与逐行前缀在视觉上分开，也降低被误读成格式指令的可能。
      return `「${current}」`
    }
  }
}

/**
 * 组装提交文本：第一行给界面身份与 documentId，后续每行一个参数。
 * 纯函数，便于界面上直接预览「将要发送什么」。
 *
 * 条件未满足（界面上被隐藏）的参数仍然输出，并追加「条件未满足，未生效」：
 * 静默省略会让模型以为自己声明的参数丢了，而保留取值又能让用户切回去时状态还在。
 * 可见性判断与控件、复制为 Markdown 共用 `isGenuiParamVisible`，不在这里另写一份。
 */
export function composeParamSubmitText(
  document: GenuiDocument,
  documentId: string,
  revision: number,
  values: Readonly<Record<string, GenuiParamValue>>
): string {
  const lines = [`${GENUI_SUBMIT_PREFIX}：《${document.title}》 documentId=${documentId} revision=${revision}`]
  for (const param of document.params ?? []) {
    const note = isGenuiParamVisible(param, values) ? '' : '（条件未满足，未生效）'
    lines.push(`- ${param.label}（${param.id}）：${formatParamValue(param, values[param.id])}${note}`)
  }
  return lines.join('\n')
}

/** 提交动作的展示状态；`accepted` 只表示 Pi 接受了这次输入，不代表本轮回答已结束。 */
export type ParamSubmitPhase = 'idle' | 'submitting' | 'accepted' | 'error'

export interface ParamSubmitState {
  readonly phase: Ref<ParamSubmitPhase>
  readonly error: Ref<string | null>
  /** 提交文本；被前置条件拦截时不产生任何状态变化，界面保持可再次提交。 */
  submit(text: string): Promise<void>
  /** 用户改动参数后清掉上一次的反馈，避免旧文案看着像刚提交过。 */
  reset(): void
}

/**
 * 提交动作的 composable：复用 Runtime store 既有的 `send` 与它的全部前置校验
 * （运行中、未同步、正在发送、模型切换中、回退结果未知等），这里不重复判断也不绕过。
 */
export function useParamSubmit(): ParamSubmitState {
  const runtimeStore = useRuntimeStore()
  const phase = ref<ParamSubmitPhase>('idle')
  const error = ref<string | null>(null)

  async function submit(text: string): Promise<void> {
    if (text === '' || phase.value === 'submitting') return
    phase.value = 'submitting'
    error.value = null
    // 提交是用户对当前取值的一次明确确认：顺手把节流窗口里的待写变化落盘，
    // 不让「已经发出去的参数」和「本机记着的参数」出现差异。不等待结果，失败由持久化层置标记。
    void flushGenuiParamPersistence()
    // `send` 被前置条件拦下时什么都不会发：用 promptView 的对象身份判断请求到底有没有发出，
    // 避免把「没发出去」显示成「已提交」。
    const before = runtimeStore.promptView
    try {
      await runtimeStore.send(text)
      if (runtimeStore.promptView === before) {
        phase.value = 'idle'
        return
      }
      if (runtimeStore.promptView.phase === 'accepted') {
        phase.value = 'accepted'
        return
      }
      if (runtimeStore.promptView.phase === 'error') {
        error.value = runtimeStore.promptView.error.message
        phase.value = 'error'
        return
      }
      phase.value = 'idle'
    } finally {
      if (phase.value === 'submitting') phase.value = 'idle'
    }
  }

  function reset(): void {
    if (phase.value === 'submitting') return
    phase.value = 'idle'
    error.value = null
  }

  return { phase, error, submit, reset }
}
