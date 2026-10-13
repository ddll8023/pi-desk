<!-- 设置页的快捷输入区块：编辑输入坞快捷发送下拉的候选短语。
     编辑只改本地草稿，点保存才写入界面偏好；主进程保存成功后才提交，失败保留草稿并就地提示。
     规范化规则与主进程存储层保持一致，用户看到的就是实际会被保存的内容。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { MAX_QUICK_SEND_MESSAGES, MAX_QUICK_SEND_MESSAGE_LENGTH } from '../../../shared/preferences-api'
import { usePreferencesStore } from '../stores/preferences'
import AppButton from './ui/AppButton.vue'

const preferencesStore = usePreferencesStore()
const { quickSendMessages, quickSendView, ready } = storeToRefs(preferencesStore)

/** 编辑中的短语；顺序即下拉展示顺序。 */
const draft = ref<string[]>([...quickSendMessages.value])
/** 折叠状态：编辑器较长，默认收起只占卡片头一行；属于界面临时状态，不写入偏好也不落盘。 */
const expanded = ref(false)

/** 与主进程一致的规范化：trim、空白折叠为单空格、丢弃空项、去重（保留首个）、截断到上限。 */
function normalize(messages: readonly string[]): string[] {
  const accepted: string[] = []
  const seen = new Set<string>()
  for (const entry of messages) {
    const message = entry.replace(/\s+/gu, ' ').trim().slice(0, MAX_QUICK_SEND_MESSAGE_LENGTH)
    if (message === '' || seen.has(message)) continue
    seen.add(message)
    accepted.push(message)
    if (accepted.length >= MAX_QUICK_SEND_MESSAGES) break
  }
  return accepted
}

const normalized = computed(() => normalize(draft.value))
const saving = computed(() => quickSendView.value.phase === 'saving')
/** 用不可见分隔符拼接后比较，避免短语内容本身影响判定。 */
const dirty = computed(() => normalized.value.join('\u0000') !== quickSendMessages.value.join('\u0000'))
const canSave = computed(() => ready.value && !saving.value && dirty.value && normalized.value.length > 0)
const atLimit = computed(() => draft.value.length >= MAX_QUICK_SEND_MESSAGES)
/** 保存会改写草稿内容（存在空项或重复短语）时的提示；条数不同即说明规范化会丢弃内容。 */
const willNormalize = computed(() => normalized.value.length !== draft.value.length)

// 保存成功或读取结束后回到已保存内容；本区块是这份偏好的唯一编辑入口，因此直接覆盖草稿。
watch(quickSendMessages, (next) => {
  draft.value = [...next]
})

function addMessage(): void {
  if (atLimit.value) return
  draft.value = [...draft.value, '']
}

function removeMessage(index: number): void {
  draft.value = draft.value.filter((_, position) => position !== index)
}

/** 上移或下移一位；越界时不动，不把首尾项绕到另一端。 */
function moveMessage(index: number, step: number): void {
  const target = index + step
  if (target < 0 || target >= draft.value.length) return

  const next = [...draft.value]
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved ?? '')
  draft.value = next
}

function resetDraft(): void {
  draft.value = [...quickSendMessages.value]
}

async function save(): Promise<void> {
  if (!canSave.value) return
  // 提交规范化后的内容：主进程仍会重新校验，这里的规范化只为让用户看到实际保存结果。
  if (await preferencesStore.saveQuickSendMessages(normalized.value)) {
    draft.value = [...quickSendMessages.value]
  }
}
</script>

<template>
  <section class="settings-section" aria-labelledby="settings-quick-send-title">
    <div class="settings-section-heading">
      <div>
        <h2 id="settings-quick-send-title" class="settings-section-title">快捷输入</h2>
        <p class="mt-1 text-xs text-desk-muted">输入坞快捷发送下拉里的短语，点一下就用该短语直接发送。</p>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-2xs text-desk-muted">{{ draft.length }} / {{ MAX_QUICK_SEND_MESSAGES }}</span>
        <AppButton
          variant="compact"
          :aria-expanded="expanded"
          aria-controls="settings-quick-send-body"
          :aria-label="expanded ? '收起快捷输入' : '展开快捷输入'"
          @click="expanded = !expanded"
        >
          {{ expanded ? '收起' : '展开' }}
        </AppButton>
      </div>
    </div>

    <!-- 用 v-show 而不是 v-if：收起时保留编辑器节点，aria-controls 指向的元素始终存在。 -->
    <div v-show="expanded" id="settings-quick-send-body">
      <ul v-if="draft.length > 0" class="mt-4 space-y-2">
        <li v-for="(message, index) in draft" :key="index" class="flex items-center gap-2">
          <input
            v-model="draft[index]"
            type="text"
            class="text-control flex-1"
            :maxlength="MAX_QUICK_SEND_MESSAGE_LENGTH"
            :disabled="saving"
            :aria-label="`第 ${index + 1} 条快捷输入`"
            placeholder="例如：继续"
          >
          <AppButton
            variant="compact"
            :disabled="saving || index === 0"
            aria-label="上移"
            title="上移"
            @click="moveMessage(index, -1)"
          >
            ↑
          </AppButton>
          <AppButton
            variant="compact"
            :disabled="saving || index === draft.length - 1"
            aria-label="下移"
            title="下移"
            @click="moveMessage(index, 1)"
          >
            ↓
          </AppButton>
          <AppButton
            variant="quiet-danger"
            :disabled="saving"
            :aria-label="`删除第 ${index + 1} 条快捷输入`"
            title="删除"
            @click="removeMessage(index)"
          >
            ✕
          </AppButton>
        </li>
      </ul>

      <p v-else class="mt-4 text-xs text-desk-muted">还没有短语，添加至少一条后才能保存。</p>

      <AppButton
        variant="compact"
        class="mt-2"
        :disabled="saving || atLimit"
        aria-label="添加快捷输入"
        @click="addMessage"
      >
        添加
      </AppButton>

      <div class="settings-row">
        <p class="text-xs text-desk-muted">
          <template v-if="atLimit">已达到 {{ MAX_QUICK_SEND_MESSAGES }} 条上限，删除一条后可继续添加。</template>
          <template v-else-if="willNormalize">保存时会忽略空白项、合并重复短语。</template>
          <template v-else>每条 {{ MAX_QUICK_SEND_MESSAGE_LENGTH }} 字以内，顺序即下拉里的顺序。</template>
        </p>
        <div class="flex items-center gap-2">
          <AppButton variant="compact" :disabled="saving || !dirty" @click="resetDraft">恢复</AppButton>
          <AppButton variant="primary" :disabled="!canSave" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </AppButton>
        </div>
      </div>

      <p v-if="quickSendView.phase === 'error'" role="alert" class="mt-3 text-xs text-desk-danger">
        {{ quickSendView.error.message }}
      </p>
    </div>
  </section>
</template>
