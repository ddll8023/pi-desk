<!-- 生成式界面根容器：标题、节点树、复制入口，以及有可调参数时底部的提交区。
     载荷已在投影层按协议完整校验，这里只负责渲染与未知类型降级，不重复校验、不补造内容。
     同一份界面只有最高版本可交互：被取代的版本由父级折叠传入，本组件把控件与提交都置为只读。
     复制为 Markdown 不写任何状态，因此只读版本也给这个入口：它输出的是文档与当前取值。
     参数取值只在渲染端内存里：界面底部常驻说明「不随历史恢复」这一降级口径，
     只有用户点击提交才会调用 sendPrompt，参数变化本身不发请求。 -->
<script setup lang="ts">
import { computed, onUnmounted, ref, useId, watch } from 'vue'
import '../../assets/genui.css'
import type { GenuiPayload } from '../../../../shared/genui-api'
import { copyText } from '../../clipboard'
import { genuiDocumentToMarkdown } from '../../genui/markdown'
import { provideGenuiParams } from '../../genui/param-state'
import { composeParamSubmitText, useParamSubmit } from '../../genui/param-submit'
import GenuiNode from './GenuiNode.vue'
import AppButton from '../ui/AppButton.vue'

const props = defineProps<{
  readonly payload: GenuiPayload
  /** 提交被父级禁用时的原因（运行中、未同步等）；与消息动作栏共用同一套口径。 */
  readonly submitDisabled?: boolean
  readonly submitDisabledReason?: string | null
  /** 该界面已被更高版本取代时的版本号；非 null 即只读。 */
  readonly supersededBy?: number | null
}>()

const titleId = useId()
const doc = computed(() => props.payload.document)
const params = computed(() => doc.value.params ?? [])
const superseded = computed(() => props.supersededBy ?? null)
const context = provideGenuiParams({
  documentId: props.payload.documentId,
  revision: props.payload.revision,
  params: params.value,
  // 传函数而不是当前布尔值：新版本交付后旧界面会从可交互转为只读，
  // 控件与提交按钮必须看同一个实时判定。
  readOnly: () => superseded.value !== null
})
const { phase, error, submit, reset } = useParamSubmit()

const submitting = computed(() => phase.value === 'submitting')
const submitBlocked = computed(() => superseded.value !== null || props.submitDisabled === true || submitting.value)
const submitText = computed(() => (submitting.value ? '提交中…' : doc.value.submitLabel ?? '提交参数'))
const submitTitle = computed(() => {
  if (superseded.value !== null) return `已被第 ${superseded.value} 版取代，请在新版界面提交参数。`
  if (props.submitDisabled === true) return props.submitDisabledReason ?? '当前不能提交参数。'
  return submitting.value ? '正在提交参数…' : '把当前参数作为一条消息发给 Agent'
})
/** 参数因条目淘汰或旧取值超期被重置过；提示一次，不让用户以为自己的调节丢了。 */
const expired = computed(() => context.expired)

/** 参数一变，上一次的提交反馈就过期了：清掉它，避免旧文案看着像刚提交过。 */
watch(context.values, () => reset())

function onSubmit(): void {
  if (submitBlocked.value || params.value.length === 0) return
  void submit(composeParamSubmitText(doc.value, props.payload.documentId, props.payload.revision, context.values))
}

/** 复制反馈：成功短暂显示勾选，失败保留可见提示，不让失败看着像没点。 */
const copyFeedback = ref<'idle' | 'copied' | 'failed'>('idle')
let copyTimer: number | null = null

onUnmounted(() => {
  if (copyTimer !== null) window.clearTimeout(copyTimer)
})

async function copyMarkdown(): Promise<void> {
  let copied = false
  try {
    copied = await copyText(genuiDocumentToMarkdown(doc.value, context.values))
  } catch {
    // 剪贴板回退路径也可能受环境限制：下面统一按失败处理，不留永久状态。
  }
  copyFeedback.value = copied ? 'copied' : 'failed'
  if (copyTimer !== null) window.clearTimeout(copyTimer)
  copyTimer = null
  if (!copied) return
  copyTimer = window.setTimeout(() => {
    copyFeedback.value = 'idle'
    copyTimer = null
  }, 1800)
}
</script>

<template>
  <section class="genui-document" :class="{ 'is-readonly': superseded !== null }" :aria-labelledby="titleId">
    <header class="genui-document-header">
      <span class="genui-document-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <path d="M14 15h7m-7 5h7" />
        </svg>
      </span>
      <div class="genui-document-heading">
        <div class="genui-document-eyebrow">
          <span>生成式界面</span>
          <span class="genui-document-version">{{ payload.revision === 0 ? '初版' : `第 ${payload.revision} 版` }}</span>
        </div>
        <h3 :id="titleId" class="genui-document-title">{{ doc.title }}</h3>
      </div>
      <div class="genui-document-actions">
        <AppButton
          variant="unstyled"
          class="genui-document-copy"
          :class="{ 'is-copied': copyFeedback === 'copied' }"
          :aria-label="copyFeedback === 'failed' ? '复制 Markdown 失败' : '复制为 Markdown'"
          @click="copyMarkdown"
        >
          <svg v-if="copyFeedback === 'copied'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="m5 12 4 4L19 6" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <rect x="8" y="8" width="12" height="12" rx="2" />
            <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
          </svg>
          <span>{{ copyFeedback === 'copied' ? '已复制' : copyFeedback === 'failed' ? '复制失败' : '复制' }}</span>
        </AppButton>
        <span class="genui-document-mode">{{ superseded !== null ? '只读' : params.length > 0 ? '可交互' : '结构化视图' }}</span>
      </div>
    </header>
    <div class="genui-document-body genui-stack">
      <GenuiNode v-for="(node, index) in doc.nodes" :key="index" :node="node" />
    </div>

    <!-- 展示型文档没有虚构的操作区；只有声明参数才提供显式提交入口。 -->
    <footer v-if="params.length > 0" class="genui-document-footer">
      <div class="genui-submit-row">
        <p class="genui-submit-note">
          <template v-if="superseded !== null">这一版已被第 {{ superseded }} 版取代，只能查看，不能调参或提交。</template>
          <template v-else>调整不会自动发送。参数仅保存在当前窗口，不随对话历史保存；重启后恢复默认值。</template>
        </p>
        <AppButton
          variant="primary" class="genui-submit"
          :disabled="submitBlocked"
          :title="submitTitle"
          @click="onSubmit"
        >
          {{ submitText }}
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 8h10m-4-4 4 4-4 4" /></svg>
        </AppButton>
      </div>
      <p v-if="expired" class="genui-feedback genui-tone-warning" role="status">参数已过期，已回到默认值。</p>
      <p v-if="phase === 'accepted'" class="genui-feedback genui-tone-success" role="status">已提交参数。</p>
      <p
        v-else-if="phase === 'error' && error !== null"
        class="genui-feedback genui-tone-danger"
        role="alert"
      >{{ error }}</p>
    </footer>
  </section>
</template>
