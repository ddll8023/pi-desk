<!-- models.json 条目摘要：展示「指向哪里、有哪些模型」的关键字段并提供编辑与从云端刷新模型入口，
     完整编辑在弹窗里进行。内置供应商提供覆盖配置入口，条目文本来自 models.json 快照。 -->
<script setup lang="ts">
import { computed } from 'vue'
import type { ModelsConfigProvider } from '../../../../shared/models-config-api'
import AppButton from '../../ui/AppButton.vue'

const props = withDefaults(
  defineProps<{
    /** 当前供应商在 models.json 里的条目；null 表示它用的是 Pi 内置定义。 */
    readonly entry: ModelsConfigProvider | null
    /** models.json 尚未读完；为真时不判定「没有条目」。 */
    readonly loading: boolean
    /** models.json 无法解析的原因；非空时暂停写入入口。 */
    readonly parseError: string | null
    /** 写动作进行中；用于禁用入口，避免重复提交。 */
    readonly busy: boolean
    /** 是否正在从云端刷新模型。 */
    readonly refreshing?: boolean
  }>(),
  {
    refreshing: false
  }
)

const emit = defineEmits<{
  edit: []
  create: []
  'refresh-models': []
}>()

/**
 * 条目摘要：只挑能说明端点的字段，其余（compat、cost、modelOverrides 等）留给弹窗里的原始 JSON。
 * 条目文本无法解析时不猜字段，全部按「未指定」展示，避免把坏文件描述成正常配置。
 */
const summary = computed(() => {
  const entry = props.entry
  if (entry === null) return null
  let parsed: unknown = null
  try {
    parsed = JSON.parse(entry.json)
  } catch {
    parsed = null
  }
  const record = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
  return {
    api: typeof record.api === 'string' && record.api !== '' ? record.api : '未指定',
    baseUrl: typeof record.baseUrl === 'string' && record.baseUrl !== '' ? record.baseUrl : '未指定',
    modelCount: entry.modelCount,
    hasApiKey: entry.hasApiKey
  }
})
</script>

<template>
  <div class="provider-entry-summary">
    <p v-if="loading" class="provider-entry-summary__message">正在读取 models.json…</p>
    <p v-else-if="parseError !== null" class="provider-entry-summary__message">
      models.json 目前无法解析，先在外部修正文件再点「重新读取」，这里才会显示它的条目。
    </p>
    <template v-else-if="summary === null">
      <div class="provider-entry-summary__builtin">
        <p class="provider-entry-summary__message">
          使用 Pi 内置默认端点与模型定义。如需覆盖 Base URL 或模型列表，可添加自定义配置。
        </p>
        <AppButton variant="ghost" :disabled="busy" @click="emit('create')">
          自定义端点配置
        </AppButton>
      </div>
    </template>
    <template v-else>
      <dl class="provider-entry-summary__fields">
        <div>
          <dt>API</dt>
          <dd>{{ summary.api }}</dd>
        </div>
        <div>
          <dt>Base URL</dt>
          <dd>{{ summary.baseUrl }}</dd>
        </div>
        <div>
          <dt>模型</dt>
          <dd>{{ summary.modelCount }} 个条目<span v-if="summary.hasApiKey"> · 已配置密钥</span></dd>
        </div>
      </dl>
      <div class="provider-entry-summary__actions">
        <AppButton variant="compact" :disabled="busy" @click="emit('edit')">
          编辑条目
        </AppButton>
        <AppButton
          variant="compact"
          :disabled="busy || props.refreshing"
          @click="emit('refresh-models')"
        >
          {{ props.refreshing ? '正在刷新…' : '从云端刷新模型' }}
        </AppButton>
      </div>
    </template>
  </div>
</template>

<style scoped>
.provider-entry-summary {
  display: grid;
  justify-items: start;
  gap: 0.625rem;
}

.provider-entry-summary__actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.provider-entry-summary__message {
  max-width: 42rem;
  margin: 0;
  color: var(--color-desk-muted);
  font-size: 0.75rem;
  line-height: 1.6;
}

.provider-entry-summary__builtin {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1rem;
}

.provider-entry-summary__fields {
  display: grid;
  width: 100%;
  grid-template-columns: minmax(7rem, 0.55fr) minmax(12rem, 2fr) minmax(8rem, 0.8fr);
  gap: 0.75rem 1rem;
  margin: 0;
}

.provider-entry-summary__fields > div {
  min-width: 0;
}

.provider-entry-summary__fields dt {
  margin-bottom: 0.25rem;
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
}

.provider-entry-summary__fields dd {
  overflow-wrap: anywhere;
  margin: 0;
  color: var(--color-desk-ink);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.55;
}

.provider-entry-summary__fields > div:last-child dd {
  font-family: var(--font-sans);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 620px) {
  .provider-entry-summary__fields {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }

  .provider-entry-summary__fields > div:nth-child(2) {
    grid-column: 1 / -1;
    grid-row: 2;
  }
}
</style>
