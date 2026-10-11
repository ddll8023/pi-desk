<!-- 自定义供应商设置：读写 Pi 的 models.json 里 `providers` 下的第三方供应商条目。
     表单与「原始 JSON」是同一份内容的两种视图：原始 JSON 文本是唯一事实来源，表单字段读写它。
     密钥不回显：apiKey 与 headers 的值由主进程以哨兵文本回传，保存时按位置还原为磁盘上的原值。
     本视图不修改 Pi 的其他配置，也不提供 modelOverrides 的专用表单（仍可在原始 JSON 里编辑）。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { MODELS_CONFIG_SECRET_SENTINEL } from '../../../shared/models-config-api'
import type { ModelsConfigProvider } from '../../../shared/models-config-api'
import { useModelsConfigStore } from '../stores/models-config'
import AppButton from './ui/AppButton.vue'
import AppSelect from './ui/AppSelect.vue'
import ConfirmDialog from './ConfirmDialog.vue'

/** 编辑器状态；`rawText` 是唯一事实来源，表单字段与原始 JSON 编辑区都读写它。 */
interface EditorState {
  readonly mode: 'create' | 'edit'
  /** 供应商 ID；编辑时锁定（改 ID 等于换一个供应商），只有创建时可改。 */
  providerId: string
  rawText: string
  rawOpen: boolean
}

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
const { view, providers, snapshot, parseError, busy, actionError } = storeToRefs(store)

/** 供应商 ID 过滤词；只过滤展示，不改变清单来源。 */
const filter = ref('')
/** 当前编辑器；null 表示列表视图。 */
const editor = ref<EditorState | null>(null)
/** 最近一次写成功的提示；只在本次停留期间展示。 */
const notice = ref<string | null>(null)
/** 待确认的删除目标；确认后才发出删除请求。 */
const pendingDelete = ref<string | null>(null)
/** headers 的本地编辑行；允许暂时留空名字，写入时丢弃空名字行。 */
const headerDraft = ref<{ name: string; value: string }[]>([])

const visibleProviders = computed(() => {
  const query = filter.value.trim().toLocaleLowerCase()
  if (query === '') return providers.value
  return providers.value.filter((provider) => provider.id.toLocaleLowerCase().includes(query))
})

/** 快照读取失败与写动作失败分别成串：模板只展示字符串，不依赖对联合类型的收窄。 */
const loadErrorMessage = computed(() => (view.value.phase === 'error' ? view.value.error.message : null))
const actionErrorMessage = computed(() => actionError.value?.message ?? null)

/** 解析失败时禁止新增：主进程会拒绝写入，先让用户修正文件。 */
const writable = computed(() => parseError.value === null)

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
  const state = editor.value
  if (state === null) return null
  try {
    const value: unknown = JSON.parse(state.rawText)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
})

const jsonError = computed<string | null>(() => {
  const state = editor.value
  if (state === null) return null
  try {
    const value: unknown = JSON.parse(state.rawText)
    return isRecord(value) ? null : '条目必须是一个 JSON 对象。'
  } catch (error) {
    return `不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
  }
})

/** 表单可编辑的前提：JSON 可解析。否则表单会从空对象重建，把原文覆盖掉。 */
const formReady = computed(() => parsedDraft.value !== null)

const providerIdInput = computed({
  get: () => editor.value?.providerId ?? '',
  set: (value: string) => {
    if (editor.value !== null) editor.value.providerId = value
  }
})

/** 原始 JSON 编辑区：写入后重新读取 headers 行，保持两个视图一致。 */
const rawTextInput = computed({
  get: () => editor.value?.rawText ?? '',
  set: (value: string) => {
    const state = editor.value
    if (state === null) return
    state.rawText = value
    headerDraft.value = readHeaderRows()
  }
})

function updateDraft(mutate: (draft: Record<string, unknown>) => void): void {
  const state = editor.value
  const draft = parsedDraft.value
  if (state === null || draft === null) return
  const next: Record<string, unknown> = { ...draft }
  mutate(next)
  state.rawText = JSON.stringify(next, null, 2)
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
  const state = editor.value
  if (state !== null) state.rawOpen = !state.rawOpen
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
  const state = editor.value
  if (state === null) return null
  if (jsonError.value !== null) return '先修正 JSON 才能保存。'

  const id = state.providerId.trim()
  if (id === '') return '供应商 ID 不能为空。'
  if (state.mode === 'create' && providers.value.some((provider) => provider.id === id)) {
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

const canSave = computed(() => editor.value !== null && saveBlockReason.value === null && !busy.value)

function startCreate(): void {
  store.clearActionError()
  notice.value = null
  headerDraft.value = []
  editor.value = {
    mode: 'create',
    providerId: '',
    rawText: JSON.stringify({ api: 'openai-completions', models: [{ id: '' }] }, null, 2),
    rawOpen: false
  }
}

function startEdit(provider: ModelsConfigProvider): void {
  store.clearActionError()
  notice.value = null
  editor.value = {
    mode: 'edit',
    providerId: provider.id,
    rawText: provider.json,
    rawOpen: false
  }
  headerDraft.value = readHeaderRows()
}

function closeEditor(): void {
  editor.value = null
  headerDraft.value = []
}

/** 重新读取：主进程会用这次读取作为后续保存的比对基线。 */
function refresh(): void {
  store.clearActionError()
  notice.value = null
  void store.refresh()
}

async function submit(): Promise<void> {
  const state = editor.value
  if (state === null || !canSave.value) return

  const id = state.providerId.trim()
  // 失败原因由 store 的 actionError 展示，这里不再叠一层文案。
  if (!await store.save(id, state.rawText)) return
  notice.value = `已保存供应商 ${id}；改动需要重启 Runtime 后才会反映到顶栏的模型列表。`
  closeEditor()
}

async function confirmDelete(): Promise<void> {
  const id = pendingDelete.value
  if (id === null) return
  const removed = await store.remove(id)
  pendingDelete.value = null
  if (!removed) return
  notice.value = `已删除供应商 ${id}；改动需要重启 Runtime 后才会生效。`
}

onMounted(() => {
  void store.refresh()
})
</script>

<template>
  <div class="space-y-4">
    <header>
      <h1 class="text-xl font-semibold tracking-tight">自定义供应商</h1>
      <p class="mt-1 text-sm text-desk-muted">
        管理 Pi 的 <span class="font-mono">models.json</span> 里 <span class="font-mono">providers</span>
        下的第三方与兼容端点供应商。改动写入 Pi 自己的配置文件，需要重启 Runtime 后才会生效。
      </p>
    </header>

    <div class="flex flex-wrap items-center gap-2">
      <input
        v-model="filter"
        type="search"
        placeholder="按供应商 ID 过滤"
        class="text-control sm:max-w-64"
        :disabled="editor !== null"
      >
      <span class="chip">共 {{ providers.length }} 个供应商</span>
      <AppButton variant="compact" :disabled="busy" @click="refresh">重新读取</AppButton>
      <AppButton variant="compact" class="ml-auto" :disabled="busy || editor !== null || !writable" @click="startCreate">
        新增供应商
      </AppButton>
    </div>

    <p v-if="loadErrorMessage !== null" role="alert" class="status-notice status-notice-error">
      {{ loadErrorMessage }}
    </p>
    <p v-else-if="parseError !== null" role="alert" class="status-notice status-notice-error">
      models.json 无法解析，已暂停写入：{{ parseError }} 先在外部修正文件，再点「重新读取」。
    </p>
    <p v-if="actionErrorMessage !== null" role="alert" class="status-notice status-notice-error">
      {{ actionErrorMessage }}
    </p>
    <p v-if="notice !== null" class="status-notice status-notice-info">{{ notice }}</p>

    <p v-if="view.phase === 'loading' || view.phase === 'idle'" class="hint-text">正在读取 models.json…</p>

    <!-- 编辑器：表单与原始 JSON 是同一份内容的两种视图。 -->
    <section v-if="editor !== null" class="panel-section space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="panel-section-title">
          {{ editor.mode === 'create' ? '新增供应商' : `编辑供应商 ${editor.providerId}` }}
        </h2>
        <AppButton variant="compact" :disabled="busy" @click="closeEditor">取消</AppButton>
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <label class="space-y-1">
          <span class="field-label">供应商 ID</span>
          <input
            v-model="providerIdInput"
            class="text-control font-mono"
            placeholder="例如 my-endpoint"
            :readonly="editor.mode === 'edit'"
            :disabled="editor.mode === 'edit'"
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
      <div class="space-y-2">
        <div class="flex items-center justify-between gap-2">
          <h3 class="section-heading">请求头</h3>
          <AppButton variant="compact" :disabled="!formReady" @click="addHeader">添加请求头</AppButton>
        </div>
        <p v-if="headerDraft.length === 0" class="hint-text">没有额外的请求头。</p>
        <div
          v-for="(row, index) in headerDraft"
          :key="`header-${index}`"
          class="flex items-start gap-2"
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
      <div class="space-y-2">
        <div class="flex items-center justify-between gap-2">
          <h3 class="section-heading">模型</h3>
          <AppButton variant="compact" :disabled="!formReady" @click="addModel">添加模型</AppButton>
        </div>
        <p v-if="modelList.length === 0" class="hint-text">还没有模型；一个供应商至少需要一个模型。</p>
        <div
          v-for="index in modelIndexes"
          :key="`model-${index}`"
          class="list-card space-y-2"
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
      <div class="space-y-2">
        <div class="flex items-center justify-between gap-2">
          <h3 class="section-heading">原始 JSON</h3>
          <AppButton variant="compact" @click="toggleRaw">
            {{ editor.rawOpen ? '收起' : '展开' }}
          </AppButton>
        </div>
        <p v-if="!editor.rawOpen" class="hint-text">
          高级字段（compat、thinkingLevelMap、cost、modelOverrides 等）需要在这里编辑。
        </p>
        <template v-else>
          <p v-if="jsonError !== null" role="alert" class="status-notice status-notice-error">{{ jsonError }}</p>
          <textarea
            v-model="rawTextInput"
            class="text-control min-h-72 font-mono text-xs"
            spellcheck="false"
            aria-label="供应商条目原始 JSON"
          />
          <p class="hint-text">
            条目里已有的密钥显示为 <span class="font-mono">{{ MODELS_CONFIG_SECRET_SENTINEL }}</span>；
            保留它表示沿用原值，改成别的字面值才会替换。
          </p>
        </template>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <AppButton variant="primary" :disabled="!canSave" @click="submit">保存供应商</AppButton>
        <span v-if="saveBlockReason !== null" class="hint-text">{{ saveBlockReason }}</span>
      </div>
    </section>

    <!-- 列表 -->
    <template v-else-if="view.phase === 'ready' && parseError === null">
      <p class="font-mono text-2xs text-desk-muted">{{ snapshot?.filePath }}</p>
      <p v-if="snapshot?.truncated === true" class="status-notice status-notice-warn">
        条目过多，这里只展示了一部分；其余条目仍保留在文件里。
      </p>

      <p v-if="providers.length === 0" class="hint-text">
        {{ snapshot?.exists === true ? 'models.json 里还没有自定义供应商。' : '还没有 models.json；新增供应商时会创建它。' }}
      </p>
      <p v-else-if="visibleProviders.length === 0" class="hint-text">没有匹配的供应商。</p>

      <ul v-else class="space-y-1.5">
        <li v-for="provider in visibleProviders" :key="provider.id" class="list-card">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="font-mono text-sm">{{ provider.id }}</p>
              <p class="mt-0.5 text-2xs text-desk-muted">
                {{ provider.modelCount }} 个模型<span v-if="provider.hasApiKey"> · 已配置密钥</span>
              </p>
            </div>
            <div class="flex items-center gap-2">
              <AppButton variant="compact" :disabled="busy" @click="startEdit(provider)">编辑</AppButton>
              <AppButton variant="quiet-danger" :disabled="busy" @click="pendingDelete = provider.id">删除</AppButton>
            </div>
          </div>
        </li>
      </ul>
    </template>

    <section class="panel-section">
      <h2 class="panel-section-title">边界说明</h2>
      <ul class="list-disc space-y-1 pl-4 text-xs leading-5 text-desk-muted">
        <li>只写 <span class="font-mono">providers</span> 下被编辑的那一个条目；其他供应商、其他顶层键（含 <span class="font-mono">modelOverrides</span>）与条目里未涉及的字段原样保留。</li>
        <li>改动只落在 <span class="font-mono">models.json</span>；Pi 的认证、设置、MCP 与项目配置都不受影响。</li>
        <li>真实密钥以明文存在 <span class="font-mono">models.json</span>（Pi 自身的格式）；本页不回显已保存的密钥，也不会把它写进日志。</li>
        <li>Runtime 的模型列表是启动时的快照，改完需要重启 Runtime 才会反映到顶栏切换器。</li>
        <li>文件在应用之外被改过时，本次保存会被拒绝；点「重新读取」后再保存即可。</li>
      </ul>
    </section>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="删除自定义供应商"
      :description="`将从 models.json 中移除供应商 ${pendingDelete ?? ''} 的条目。`"
      detail="只删除这一个条目；其他供应商与 Pi 的其他配置都不受影响。删除后需要重启 Runtime 才会生效。"
      confirm-label="删除"
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />
  </div>
</template>
