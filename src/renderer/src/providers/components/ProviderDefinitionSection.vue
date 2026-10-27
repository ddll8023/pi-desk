<!-- 自定义供应商条目编辑器：编辑 Pi 的 models.json 里 `providers` 下的一个供应商条目，作为弹窗内容挂载。
     表单与「原始 JSON」是同一份内容的两种视图：原始 JSON 文本是唯一事实来源，表单字段读写它。
     支持依据当前填写的 Base URL 与 API Key 向兼容端点探测并自动填充模型列表。
     密钥不回显：apiKey 与 headers 的值由主进程以哨兵文本回传，保存时按位置还原为磁盘上的原值。
     本区块只提交这一个条目，不提供 modelOverrides 的专用表单（仍可在原始 JSON 里编辑）；
     保存与取消按钮由弹窗 footer 承载，这里把提交入口、校验结论与脏状态暴露给弹窗。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { MODELS_CONFIG_SECRET_SENTINEL } from '../../../../shared/models-config-api'
import { useModelsConfigStore } from '../stores/models-config'
import { fetchEndpointModels } from '../services/models-config'
import AppButton from '../../ui/AppButton.vue'
import AppSelect from '../../ui/AppSelect.vue'

const props = defineProps<{
  /** 新建还是编辑既有条目；编辑时供应商 ID 被锁定。 */
  mode: 'create' | 'edit'
  /** 供应商 ID；编辑时是既有条目的 ID，新建时为空。 */
  providerId: string
  /** 条目的初始 JSON 文本；它是本区块内所有表单字段的事实来源。 */
  initialRawText: string
  /** models.json 里已存在的供应商 ID；新建时用它拦下重名。 */
  existingProviderIds: readonly string[]
}>()

const emit = defineEmits<{
  (event: 'saved', providerId: string): void
}>()

/** 兼容端点常用的 API 类型；取值来自 Pi 的 KnownApi，其他取值可直接在原始 JSON 里写。 */
const API_OPTIONS = [
  { value: 'openai-completions', label: 'openai-completions' },
  { value: 'openai-responses', label: 'openai-responses' },
  { value: 'anthropic-messages', label: 'anthropic-messages' },
  { value: 'google-generative-ai', label: 'google-generative-ai' },
  { value: 'mistral-conversations', label: 'mistral-conversations' },
  { value: 'azure-openai-responses', label: 'azure-openai-responses' }
]

/** 选择器分组；常量形式避免每次渲染都生成新数组，让浮层在重渲染时不重置高亮项。 */
const API_GROUPS = [{ options: API_OPTIONS }]

const store = useModelsConfigStore()
const { busy } = storeToRefs(store)

/** 正在从端点探测/拉取模型列表。 */
const fetchingModels = ref(false)
/** 拉取模型的轻量成功反馈。 */
const fetchModelsNotice = ref<string | null>(null)
/** 拉取模型失败的错误反馈。 */
const fetchModelsError = ref<string | null>(null)

/** 供应商 ID；只有新建时可改。 */
const providerId = ref(props.providerId)
/** 条目的 JSON 文本；唯一事实来源。 */
const rawText = ref(props.initialRawText)
/** 原始 JSON 编辑区是否展开。 */
const rawOpen = ref(false)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 表单控件读值：只在目标确实是输入控件时取值，不依赖模板里的类型断言。 */
function inputValue(event: Event): string {
  const target = event.target
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return target.value
  return ''
}

function inputChecked(event: Event): boolean {
  const target = event.target
  return target instanceof HTMLInputElement ? target.checked : false
}

/** 解析当前原始 JSON；失败或不是对象时返回 null，表单据此禁用。 */
const parsedDraft = computed<Record<string, unknown> | null>(() => {
  try {
    const value: unknown = JSON.parse(rawText.value)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
})

const jsonError = computed<string | null>(() => {
  try {
    const value: unknown = JSON.parse(rawText.value)
    return isRecord(value) ? null : '条目必须是一个 JSON 对象。'
  } catch (error) {
    return `不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
  }
})

/** 表单可编辑的前提：JSON 可解析。否则表单会从空对象重建，把原文覆盖掉。 */
const formReady = computed(() => parsedDraft.value !== null)

/** headers 的本地编辑行；允许暂时留空名字，写入时丢弃空名字行。 */
const headerDraft = ref<{ name: string; value: string }[]>(readHeaderRows())

/** 原始 JSON 编辑区：写入后重新读取 headers 行，保持两个视图一致。 */
const rawTextInput = computed({
  get: () => rawText.value,
  set: (value: string) => {
    rawText.value = value
    headerDraft.value = readHeaderRows()
  }
})

function updateDraft(mutate: (draft: Record<string, unknown>) => void): void {
  const draft = parsedDraft.value
  if (draft === null) return
  const next: Record<string, unknown> = { ...draft }
  mutate(next)
  rawText.value = JSON.stringify(next, null, 2)
}

function readText(key: string): string {
  const value = parsedDraft.value?.[key]
  return typeof value === 'string' ? value : ''
}

function writeText(key: string, value: string): void {
  updateDraft((draft) => {
    if (value === '') delete draft[key]
    else draft[key] = value
  })
}

const providerName = computed({
  get: () => readText('name'),
  set: (value: string) => writeText('name', value)
})

const baseUrl = computed({
  get: () => readText('baseUrl'),
  set: (value: string) => writeText('baseUrl', value)
})

const apiType = computed({
  get: () => readText('api'),
  set: (value: string) => writeText('api', value)
})

/** 已保存的密钥以哨兵回传，因此输入框显示为空；留空即表示不改动。 */
const apiKeyInput = computed({
  get: () => (readText('apiKey') === MODELS_CONFIG_SECRET_SENTINEL ? '' : readText('apiKey')),
  set: (value: string) => {
    if (value !== '') {
      writeText('apiKey', value)
      return
    }
    const current = readText('apiKey')
    // 清空表示不改动已保存的密钥；原本没有密钥时删除该字段。
    writeText('apiKey', current === MODELS_CONFIG_SECRET_SENTINEL ? MODELS_CONFIG_SECRET_SENTINEL : '')
  }
})

const hasStoredApiKey = computed(() => readText('apiKey') === MODELS_CONFIG_SECRET_SENTINEL)

const modelList = computed<readonly unknown[]>(() => {
  const value = parsedDraft.value?.models
  return Array.isArray(value) ? value : []
})

/** 模型行的索引列表；模板只需要索引来读写条目，不需要再持有一份数据。 */
const modelIndexes = computed(() => modelList.value.map((_, index) => index))

function toggleRaw(): void {
  rawOpen.value = !rawOpen.value
}

function modelField(index: number, key: string): string {
  const model = modelList.value[index]
  if (!isRecord(model)) return ''
  const value = model[key]
  return typeof value === 'string' ? value : ''
}

function modelNumberField(index: number, key: string): string {
  const model = modelList.value[index]
  if (!isRecord(model)) return ''
  const value = model[key]
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

function modelFlag(index: number, key: string): boolean {
  const model = modelList.value[index]
  return isRecord(model) && model[key] === true
}

/** Pi 用 `input: ["text","image"]` 表达图片输入；只有勾选时才写入 image。 */
function modelHasImage(index: number): boolean {
  const model = modelList.value[index]
  if (!isRecord(model) || !Array.isArray(model.input)) return false
  return model.input.includes('image')
}

function updateModel(index: number, mutate: (model: Record<string, unknown>) => void): void {
  updateDraft((draft) => {
    const list = Array.isArray(draft.models) ? [...draft.models] : []
    const current = list[index]
    const model: Record<string, unknown> = isRecord(current) ? { ...current } : {}
    mutate(model)
    list[index] = model
    draft.models = list
  })
}

function writeModelField(index: number, key: string, value: string): void {
  updateModel(index, (model) => {
    if (value === '') delete model[key]
    else model[key] = value
  })
}

function writeModelNumber(index: number, key: string, raw: string): void {
  updateModel(index, (model) => {
    const trimmed = raw.trim()
    if (trimmed === '') {
      delete model[key]
      return
    }
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) model[key] = parsed
  })
}

function writeModelFlag(index: number, key: string, value: boolean): void {
  updateModel(index, (model) => {
    if (value) model[key] = true
    else delete model[key]
  })
}

function writeModelImage(index: number, value: boolean): void {
  updateModel(index, (model) => {
    const input = Array.isArray(model.input)
      ? model.input.filter((entry) => entry !== 'image')
      : ['text']
    if (value) input.push('image')
    model.input = input
  })
}

function addModel(): void {
  updateDraft((draft) => {
    const list = Array.isArray(draft.models) ? [...draft.models] : []
    list.push({ id: '' })
    draft.models = list
  })
}

function removeModel(index: number): void {
  updateDraft((draft) => {
    const list = Array.isArray(draft.models) ? [...draft.models] : []
    list.splice(index, 1)
    if (list.length === 0) delete draft.models
    else draft.models = list
  })
}

/** 从端点自动探测并填充模型列表。 */
async function onFetchEndpointModels(): Promise<void> {
  const url = baseUrl.value.trim()
  if (url === '') {
    fetchModelsError.value = '请先输入 Base URL，再拉取模型。'
    fetchModelsNotice.value = null
    return
  }
  fetchingModels.value = true
  fetchModelsNotice.value = null
  fetchModelsError.value = null

  const headersObj: Record<string, string> = {}
  for (const row of headerDraft.value) {
    if (row.name.trim() !== '') headersObj[row.name.trim()] = row.value
  }

  const result = await fetchEndpointModels({
    baseUrl: url,
    apiKey: apiKeyInput.value !== '' ? apiKeyInput.value : undefined,
    headers: Object.keys(headersObj).length > 0 ? headersObj : undefined,
    providerId: props.mode === 'edit' ? props.providerId : providerId.value.trim() || undefined
  })

  fetchingModels.value = false
  if (!result.ok) {
    fetchModelsError.value = result.error.message
    return
  }

  if (result.models.length === 0) {
    fetchModelsError.value = '端点未返回任何可用模型。'
    return
  }

  updateDraft((draft) => {
    const existingList = Array.isArray(draft.models) ? [...draft.models] : []
    const existingMap = new Map<string, Record<string, unknown>>()
    for (const item of existingList) {
      if (isRecord(item) && typeof item.id === 'string' && item.id.trim() !== '') {
        existingMap.set(item.id.trim(), item)
      }
    }
    const nextList: Record<string, unknown>[] = []
    for (const fetched of result.models) {
      const prev = existingMap.get(fetched.id)
      if (prev !== undefined) {
        nextList.push(prev)
        existingMap.delete(fetched.id)
      } else {
        nextList.push({
          id: fetched.id,
          ...(fetched.name ? { name: fetched.name } : {})
        })
      }
    }
    for (const remaining of existingMap.values()) {
      nextList.push(remaining)
    }
    draft.models = nextList
  })

  fetchModelsNotice.value = `已成功拉取 ${result.models.length} 个模型。`
}

function readHeaderRows(): { name: string; value: string }[] {
  const value = parsedDraft.value?.headers
  if (!isRecord(value)) return []
  return Object.entries(value).map(([name, headerValue]) => ({
    name,
    value: typeof headerValue === 'string' ? headerValue : ''
  }))
}

/** 把本地行写回条目：空名字的行只在界面上保留，不写入配置。 */
function syncHeadersToRaw(): void {
  const rows = headerDraft.value.filter((row) => row.name.trim() !== '')
  updateDraft((draft) => {
    if (rows.length === 0) {
      delete draft.headers
      return
    }
    const next: Record<string, string> = {}
    for (const row of rows) next[row.name.trim()] = row.value
    draft.headers = next
  })
}

function writeHeaderName(index: number, name: string): void {
  const row = headerDraft.value[index]
  if (row === undefined) return
  row.name = name
  syncHeadersToRaw()
}

function writeHeaderValue(index: number, value: string): void {
  const row = headerDraft.value[index]
  if (row === undefined) return
  row.value = value
  syncHeadersToRaw()
}

function addHeader(): void {
  headerDraft.value = [...headerDraft.value, { name: '', value: '' }]
}

function removeHeader(index: number): void {
  headerDraft.value = headerDraft.value.filter((_, current) => current !== index)
  syncHeadersToRaw()
}

/** 保存被阻止时的原因；为空表示可以保存。 */
const saveBlockReason = computed<string | null>(() => {
  if (jsonError.value !== null) return '先修正 JSON 才能保存。'

  const id = providerId.value.trim()
  if (id === '') return '供应商 ID 不能为空。'
  if (props.mode === 'create' && props.existingProviderIds.includes(id)) {
    return `供应商 ${id} 已存在；改用列表里的编辑入口。`
  }

  const draft = parsedDraft.value
  if (draft === null) return null
  const models = Array.isArray(draft.models) ? draft.models : []
  const overrides = draft.modelOverrides
  const hasOverrides = isRecord(overrides) && Object.keys(overrides).length > 0
  if (models.length === 0 && !hasOverrides) return '至少需要一个模型，或一段 modelOverrides。'
  if (!models.every((model) => isRecord(model) && typeof model.id === 'string' && model.id.trim() !== '')) {
    return '每个模型都需要一个非空的 id。'
  }
  return null
})

const canSave = computed(() => saveBlockReason.value === null && !busy.value)

/** 是否与传入的初始内容不同；弹窗在关闭前用它决定要不要先确认。 */
const dirty = computed(() => providerId.value !== props.providerId || rawText.value !== props.initialRawText)

async function submit(): Promise<void> {
  if (!canSave.value) return
  const id = providerId.value.trim()
  // 失败原因由 store 的 actionError 展示，这里不再叠一层文案。
  if (!await store.save(id, rawText.value)) return
  emit('saved', id)
}

// 弹窗 footer 承载保存与取消：这里只暴露提交入口与校验结论，按钮布局与文案由弹窗决定。
defineExpose({ submit, canSave, saveBlockReason, dirty })
</script>

<template>
  <div class="provider-definition">
    <div class="provider-definition__fields">
      <label class="space-y-1">
        <span class="field-label">供应商 ID</span>
        <input
          v-model="providerId"
          class="text-control font-mono"
          placeholder="例如 my-endpoint"
          :readonly="mode === 'edit'"
          :disabled="mode === 'edit'"
        >
      </label>
      <label class="space-y-1">
        <span class="field-label">显示名（可选）</span>
        <input
          v-model="providerName"
          class="text-control"
          placeholder="例如 My Endpoint"
          :disabled="!formReady"
        >
      </label>
      <label class="space-y-1">
        <span class="field-label">Base URL</span>
        <input
          v-model="baseUrl"
          class="text-control font-mono"
          placeholder="https://api.example.com/v1"
          :disabled="!formReady"
        >
      </label>
      <div class="space-y-1">
        <span class="field-label">API 类型</span>
        <AppSelect
          id="custom-provider-api"
          label="API 类型"
          :groups="API_GROUPS"
          :model-value="apiType"
          :disabled="!formReady"
          @update:model-value="apiType = $event"
        />
      </div>
      <label class="space-y-1 sm:col-span-2">
        <span class="field-label">API Key</span>
        <input
          v-model="apiKeyInput"
          type="password"
          autocomplete="off"
          class="text-control font-mono"
          :placeholder="hasStoredApiKey ? '已保存，留空表示不修改' : '直接填入字面值'"
          :disabled="!formReady"
        >
        <span class="hint-text">
          只支持字面值；已保存的密钥不回显，留空即保持原值。清空后重新填写才会替换它。
        </span>
      </label>
    </div>

    <!-- headers：空名字的行只在界面上保留，不会写进配置。 -->
    <div class="provider-definition__block">
      <div class="provider-definition__block-heading">
        <h3 class="provider-definition__block-title">请求头</h3>
        <AppButton variant="compact" :disabled="!formReady" @click="addHeader">添加请求头</AppButton>
      </div>
      <p v-if="headerDraft.length === 0" class="hint-text">没有额外的请求头。</p>
      <div
        v-for="(row, index) in headerDraft"
        :key="`header-${index}`"
        class="provider-definition__header-row"
      >
        <input
          class="text-control font-mono"
          placeholder="名称"
          :value="row.name"
          :disabled="!formReady"
          @input="writeHeaderName(index, inputValue($event))"
        >
        <input
          class="text-control font-mono"
          placeholder="值"
          :value="row.value"
          :disabled="!formReady"
          @input="writeHeaderValue(index, inputValue($event))"
        >
        <AppButton variant="icon" aria-label="移除该请求头" :disabled="!formReady" @click="removeHeader(index)">
          ×
        </AppButton>
      </div>
    </div>

    <!-- 模型：表单只覆盖常用字段，其余字段在原始 JSON 里编辑。 -->
    <div class="provider-definition__block">
      <div class="provider-definition__block-heading">
        <h3 class="provider-definition__block-title">模型</h3>
        <div class="flex items-center gap-2">
          <AppButton
            variant="compact"
            :disabled="!formReady || fetchingModels"
            @click="onFetchEndpointModels"
          >
            {{ fetchingModels ? '正在拉取…' : '从端点拉取模型' }}
          </AppButton>
          <AppButton variant="compact" :disabled="!formReady" @click="addModel">添加模型</AppButton>
        </div>
      </div>
      <p v-if="fetchModelsNotice !== null" class="hint-text text-desk-accent mb-2">
        {{ fetchModelsNotice }}
      </p>
      <p v-if="fetchModelsError !== null" role="alert" class="status-notice status-notice-error mb-2">
        {{ fetchModelsError }}
      </p>
      <p v-if="modelList.length === 0" class="hint-text">还没有模型；一个供应商至少需要一个模型。</p>
      <div
        v-for="index in modelIndexes"
        :key="`model-${index}`"
        class="provider-definition__model"
      >
        <div class="flex items-start gap-2">
          <input
            class="text-control font-mono"
            placeholder="模型 ID，例如 deepseek-chat"
            :value="modelField(index, 'id')"
            :disabled="!formReady"
            @input="writeModelField(index, 'id', inputValue($event))"
          >
          <AppButton variant="icon" aria-label="移除该模型" :disabled="!formReady" @click="removeModel(index)">
            ×
          </AppButton>
        </div>
        <div class="grid gap-2 sm:grid-cols-2">
          <input
            class="text-control"
            placeholder="显示名（可选）"
            :value="modelField(index, 'name')"
            :disabled="!formReady"
            @input="writeModelField(index, 'name', inputValue($event))"
          >
          <div class="flex items-center gap-4 pt-1 text-xs">
            <label class="flex items-center gap-2">
              <input
                type="checkbox"
                :checked="modelFlag(index, 'reasoning')"
                :disabled="!formReady"
                @change="writeModelFlag(index, 'reasoning', inputChecked($event))"
              >
              推理模型
            </label>
            <label class="flex items-center gap-2">
              <input
                type="checkbox"
                :checked="modelHasImage(index)"
                :disabled="!formReady"
                @change="writeModelImage(index, inputChecked($event))"
              >
              支持图片输入
            </label>
          </div>
          <label class="space-y-1">
            <span class="field-label">上下文窗口（token）</span>
            <input
              type="number"
              min="1"
              class="text-control"
              :value="modelNumberField(index, 'contextWindow')"
              :disabled="!formReady"
              @change="writeModelNumber(index, 'contextWindow', inputValue($event))"
            >
          </label>
          <label class="space-y-1">
            <span class="field-label">最大输出（token）</span>
            <input
              type="number"
              min="1"
              class="text-control"
              :value="modelNumberField(index, 'maxTokens')"
              :disabled="!formReady"
              @change="writeModelNumber(index, 'maxTokens', inputValue($event))"
            >
          </label>
        </div>
      </div>
    </div>

    <!-- 原始 JSON：高级字段（compat、thinkingLevelMap、cost、modelOverrides 等）在这里编辑。 -->
    <div class="provider-definition__block">
      <div class="provider-definition__block-heading">
        <h3 class="provider-definition__block-title">原始 JSON</h3>
        <AppButton variant="compact" @click="toggleRaw">
          {{ rawOpen ? '收起' : '展开' }}
        </AppButton>
      </div>
      <p v-if="!rawOpen" class="hint-text">
        高级字段（compat、thinkingLevelMap、cost、modelOverrides 等）需要在这里编辑。
      </p>
      <template v-else>
        <p v-if="jsonError !== null" role="alert" class="status-notice status-notice-error">{{ jsonError }}</p>
        <textarea
          v-model="rawTextInput"
          class="text-control provider-definition__json font-mono text-xs"
          spellcheck="false"
          aria-label="供应商条目原始 JSON"
        />
        <p class="hint-text">
          条目里已有的密钥显示为 <span class="font-mono">{{ MODELS_CONFIG_SECRET_SENTINEL }}</span>；
          保留它表示沿用原值，改成别的字面值才会替换。
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.provider-definition {
  display: grid;
  gap: 1.5rem;
}

.provider-definition__fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
}

.provider-definition__fields > label,
.provider-definition__fields > div {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: 0.375rem;
}

.provider-definition__fields > label:last-child {
  grid-column: 1 / -1;
}

.provider-definition :deep(.field-label) {
  color: var(--color-desk-muted);
  font-size: 0.6875rem;
  font-weight: 600;
}

.provider-definition__block {
  min-width: 0;
  border-top: 1px solid var(--color-desk-line);
  padding-top: 0.875rem;
}

.provider-definition__block-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.625rem;
}

.provider-definition__block-title {
  margin: 0;
  font-size: 0.8125rem;
  font-weight: 650;
}

.provider-definition__header-row {
  display: grid;
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr) auto;
  gap: 0.5rem;
  padding-block: 0.25rem;
}

.provider-definition__model {
  display: grid;
  gap: 0.75rem;
  border-top: 1px solid var(--color-desk-line);
  padding: 0.875rem 0;
}

.provider-definition__model > div:first-child {
  display: flex;
  gap: 0.5rem;
}

.provider-definition__model > div:first-child > input {
  min-width: 0;
  flex: 1;
}

.provider-definition__json {
  min-height: 18rem;
  line-height: 1.55;
  tab-size: 2;
}

.provider-definition :deep(.hint-text) {
  margin: 0;
}

@media (max-width: 640px) {
  .provider-definition__fields {
    grid-template-columns: minmax(0, 1fr);
  }

  .provider-definition__fields > label:last-child {
    grid-column: auto;
  }

  .provider-definition__header-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .provider-definition__header-row > input:nth-child(2) {
    grid-column: 1;
    grid-row: 2;
  }
}
</style>
