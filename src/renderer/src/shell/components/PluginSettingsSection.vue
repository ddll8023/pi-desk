<!--
  设置页的插件列表：逐条列出可启停的能力插件，提供搜索、启用开关与配置入口。

  只负责展示与派发意图：清单加载、切换与错误处理由设置页持有，本组件不直接调用桌面桥接，
  因此列表与详情看到的是同一份数据。启停需重启才完全生效，这条约束写在页头提示里，
  不在每条插件的操作上重复解释。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import AppButton from '../../ui/AppButton.vue'
import type { PluginEntryView } from '../../../../shared/plugin-api'

interface Props {
  readonly plugins: readonly PluginEntryView[]
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly error: string | null
  /** 正在切换的插件标识；期间整表开关禁用，避免并发请求被丢弃。 */
  readonly togglingId: string | null
}

const props = defineProps<Props>()

const emit = defineEmits<{
  toggle: [id: string, enabled: boolean]
  open: [id: string]
  reload: []
}>()

/** 搜索词：只匹配名称、说明与标识，匹配在 computed 里完成，模板不叠加过滤条件。 */
const query = ref('')

const visiblePlugins = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (keyword === '') return props.plugins
  return props.plugins.filter(plugin => (
    plugin.name.toLowerCase().includes(keyword)
    || plugin.summary.toLowerCase().includes(keyword)
    || plugin.id.includes(keyword)
  ))
})

/** 启用但未装配 = 依赖缺席；被自己停用时不再重复解释，那由开关状态表达。 */
function statusLabel(plugin: PluginEntryView): string {
  if (!plugin.enabled) return '已停用'
  return plugin.active ? '已启用' : '依赖缺席'
}

function statusClass(plugin: PluginEntryView): string {
  if (!plugin.enabled) return 'bg-desk-surface-subtle text-desk-muted'
  return plugin.active ? 'bg-desk-success-soft text-desk-success' : 'bg-desk-warning-soft text-desk-warning'
}
</script>

<template>
  <div class="settings-section-stack">
    <header>
      <h1 class="text-xl font-semibold tracking-tight">插件</h1>
      <p class="mt-1 text-sm text-desk-muted">
        每项能力的设置与状态都在它自己的条目里。停用的插件在下次启动时不再装配，通道也不会注册。
      </p>
    </header>

    <section class="settings-section" aria-labelledby="settings-plugin-list-title">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-plugin-list-title" class="settings-section-title">能力清单</h2>
          <p class="mt-1 text-xs text-desk-muted">启停需要重启应用才完全生效；已打开的会话保持启动时的能力集。</p>
        </div>
        <span class="text-2xs text-desk-muted">{{ visiblePlugins.length }} / {{ plugins.length }}</span>
      </div>

      <label class="mt-4 block">
        <span class="text-xs font-medium">搜索插件</span>
        <input
          v-model="query"
          type="search"
          class="text-control mt-1.5 w-full"
          placeholder="名称、说明或标识"
          autocomplete="off"
        >
      </label>

      <p v-if="phase === 'loading' || phase === 'idle'" role="status" class="mt-4 text-xs text-desk-muted">正在读取插件清单…</p>

      <div v-else-if="phase === 'error'" class="mt-4 rounded-desk-sm border border-desk-line bg-desk-surface-subtle px-3 py-2">
        <p role="alert" class="text-xs text-desk-danger">{{ error ?? '插件清单读取失败。' }}</p>
        <AppButton variant="compact" class="mt-2" @click="emit('reload')">重试</AppButton>
      </div>

      <p v-else-if="plugins.length === 0" class="mt-4 text-xs text-desk-muted">当前没有可用的能力插件。</p>

      <p v-else-if="visiblePlugins.length === 0" class="mt-4 text-xs text-desk-muted">
        没有匹配「{{ query.trim() }}」的插件。
      </p>

      <ul v-else class="mt-4 space-y-2">
        <li
          v-for="plugin in visiblePlugins"
          :key="plugin.id"
          class="rounded-desk-sm border border-desk-line px-3 py-3"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="text-sm font-semibold">{{ plugin.name }}</h3>
                <span class="rounded-full px-2 py-0.5 text-2xs" :class="statusClass(plugin)">
                  {{ statusLabel(plugin) }}
                </span>
              </div>
              <p class="mt-1 text-xs text-desk-muted">{{ plugin.summary }}</p>
              <p v-if="plugin.unavailableReason" class="mt-1 text-xs text-desk-warning">{{ plugin.unavailableReason }}</p>
              <p v-else-if="plugin.dependencies.length > 0" class="mt-1 text-2xs text-desk-muted">
                依赖：{{ plugin.dependencies.join('、') }}
              </p>
            </div>

            <div class="flex shrink-0 items-center gap-2">
              <button
                type="button"
                role="switch"
                :aria-checked="plugin.enabled"
                :aria-label="`启用 ${plugin.name}`"
                :disabled="togglingId !== null"
                class="inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-desk-accent motion-reduce:transition-none disabled:opacity-60"
                :class="plugin.enabled ? 'border-desk-accent bg-desk-accent' : 'border-desk-line-strong bg-desk-surface-subtle'"
                @click="emit('toggle', plugin.id, !plugin.enabled)"
              >
                <span
                  class="block size-3.5 rounded-full transition-transform duration-150 motion-reduce:transition-none"
                  :class="plugin.enabled ? 'translate-x-4 bg-desk-on-accent' : 'translate-x-0.5 bg-desk-surface'"
                ></span>
              </button>
              <AppButton variant="compact" :disabled="!plugin.enabled" @click="emit('open', plugin.id)">
                配置
              </AppButton>
            </div>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>
