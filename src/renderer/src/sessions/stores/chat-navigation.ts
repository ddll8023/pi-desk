/**
 * 对话内跳转登记：消息区把当前会话每一轮的用户输入摘要与「当前读到哪一轮」发布出来，
 * 顶部栏据此渲染跳转列表并发出一次性跳转意图，消息区消费后按既有定位规则滚动。
 *
 * 滚动位置、折叠展开与生成式界面跳转的权威始终在消息区：本模块只搬运入口与意图，
 * 不读 DOM、不算位置。登记带会话键，键不一致时对外为空，切换会话不会把上一个会话的列表
 * 留在顶部栏，也不会把跳转意图交给新会话。意图只保留一条，后到的覆盖前一条。
 *
 * 发布发生在滚动与流式的每一帧，因此这里按值去重：只有入口数组或当前轮真的变了才写状态，
 * 顶部栏不会因为一次滚动而整条重渲染。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useSessionViewStore } from './session-view'

/** 跳转列表里的一轮：以该轮的用户消息为落点。 */
export interface ChatNavEntry {
  readonly id: string
  readonly label: string
  /**
   * 该轮用户消息的发送时间；消息没有时间戳时为 null，列表里就不显示时间。
   * 由消息区按投影字段透传，本模块不推算也不补造。
   */
  readonly time: string | null
  /** 本轮交付的生成式界面个数；大于 0 时列表里补一行说明。 */
  readonly uiCount: number
}

/** 跳转意图：带会话键，消费方复核后才执行。 */
export interface ChatNavJump {
  readonly ownerKey: string
  readonly messageId: string
}

const NO_ENTRIES: readonly ChatNavEntry[] = []

/** 比较两个导航条目列表是否一致，避免流式对话期间因数组实例重建而触发无意义的响应式更新。 */
function sameNavEntries(a: readonly ChatNavEntry[], b: readonly ChatNavEntry[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const left = a[i]
    const right = b[i]
    if (
      left.id !== right.id ||
      left.label !== right.label ||
      left.time !== right.time ||
      left.uiCount !== right.uiCount
    ) {
      return false
    }
  }
  return true
}

export const useChatNavigationStore = defineStore('chat-navigation', () => {
  const sessionView = useSessionViewStore()
  /** 登记所属的会话键；与当前会话不一致时对外视为没有登记。 */
  const ownerKey = ref<string | null>(null)
  const publishedEntries = ref<readonly ChatNavEntry[]>(NO_ENTRIES)
  const publishedActiveId = ref<string | null>(null)
  /** 待消费的跳转目标：由顶部栏发出，消息区取走后清空。 */
  const pending = ref<ChatNavJump | null>(null)

  /** 当前会话的入口列表；没有登记或登记属于别的会话时为空。 */
  const entries = computed<readonly ChatNavEntry[]>(() => (
    ownerKey.value === sessionView.key ? publishedEntries.value : NO_ENTRIES
  ))

  /** 正文当前所在的那一轮；仅在登记与当前会话一致时有效。 */
  const activeId = computed<string | null>(() => (
    ownerKey.value === sessionView.key ? publishedActiveId.value : null
  ))

  /** 消息区发布入口与当前轮；同一帧内重复调用只保留最后一次结果。 */
  function publish(key: string, nextEntries: readonly ChatNavEntry[], nextActiveId: string | null): void {
    if (ownerKey.value !== key) {
      ownerKey.value = key
      publishedEntries.value = nextEntries
    } else if (!sameNavEntries(publishedEntries.value, nextEntries)) {
      publishedEntries.value = nextEntries
    }
    if (publishedActiveId.value !== nextActiveId) publishedActiveId.value = nextActiveId
  }

  /** 消息区卸载或会话切换时撤回登记，顶部栏随即回到「没有可跳转轮次」。 */
  function clear(key: string): void {
    if (ownerKey.value === key) {
      ownerKey.value = null
      publishedEntries.value = NO_ENTRIES
      publishedActiveId.value = null
    }
    if (pending.value?.ownerKey === key) pending.value = null
  }

  /** 顶部栏发出跳转意图；消息区消费时按会话键复核，避免把意图交给新会话。 */
  function requestJump(key: string, messageId: string): void {
    pending.value = { ownerKey: key, messageId }
  }

  /** 取走待跳转目标；没有或不属于当前会话时返回 null。 */
  function takeJump(key: string): string | null {
    const request = pending.value
    if (request === null) return null
    pending.value = null
    return request.ownerKey === key ? request.messageId : null
  }

  return { entries, activeId, pending, publish, clear, requestJump, takeJump }
})
