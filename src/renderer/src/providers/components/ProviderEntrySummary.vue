<!-- models.json 条目摘要：只展示「指向哪里、有哪些模型」的关键字段与写入入口，完整编辑在弹窗里进行。
     条目的 JSON 文本来自 models.json 快照，密钥已由主进程替换为哨兵，这里只报告有无，不解析密钥值。 -->
<script setup lang="ts">
import { computed } from 'vue'
import type { ModelsConfigProvider } from '../../../../shared/models-config-api'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  /** 当前供应商在 models.json 里的条目；null 表示它用的是 Pi 内置定义。 */
  readonly entry: ModelsConfigProvider | null
  /** models.json 尚未读完；为真时不判定「没有条目」。 */
  readonly loading: boolean
  /** models.json 无法解析的原因；非空时暂停写入入口。 */
  readonly parseError: string | null
  /** 写动作进行中；用于禁用入口，避免重复提交。 */
  readonly busy: boolean
}>()

const emit = defineEmits<{
  edit: []
  create: []
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
  <div class="space-y-2">
    <p v-if="loading" class="hint-text">正在读取 models.json…</p>
    <p v-else-if="parseError !== null" class="hint-text">
      models.json 目前无法解析，先在外部修正文件再点「重新读取」，这里才会显示它的条目。
    </p>
    <template v-else-if="summary === null">
      <p class="hint-text">
        这个供应商不在 models.json 的 providers 里，用的是 Pi 内置定义。还没有 models.json 时，新增供应商会创建它。
      </p>
      <AppButton variant="compact" :disabled="busy" @click="emit('create')">
        添加到 models.json
      </AppButton>
    </template>
    <template v-else>
      <dl class="space-y-1 text-xs">
        <div class="flex flex-wrap items-baseline gap-1.5">
          <dt class="text-desk-muted">API</dt>
          <dd class="font-mono">{{ summary.api }}</dd>
        </div>
        <div class="flex flex-wrap items-baseline gap-1.5">
          <dt class="text-desk-muted">Base URL</dt>
          <dd class="break-all font-mono">{{ summary.baseUrl }}</dd>
        </div>
        <div class="flex flex-wrap items-baseline gap-1.5">
          <dt class="text-desk-muted">模型</dt>
          <dd>
            {{ summary.modelCount }} 个条目<span v-if="summary.hasApiKey"> · 已配置密钥</span>
          </dd>
        </div>
      </dl>
      <AppButton variant="compact" :disabled="busy" @click="emit('edit')">
        编辑条目
      </AppButton>
    </template>
  </div>
</template>
