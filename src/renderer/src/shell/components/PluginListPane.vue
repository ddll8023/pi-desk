<!--
  设置页插件分节的窄栏列表：搜索、条目选中与启停开关。

  只负责展示与派发意图：清单加载、切换与错误处理由设置页持有，本组件不直接调用桌面桥接，
  因此列表与右侧配置面板看到的是同一份数据。选中即切换右侧面板，所以这里没有单独的「配置」入口；
  启停需重启才完全生效，这条约束集中在列表底部一行，不在每条上重复解释。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import AppButton from '../../ui/AppButton.vue'
import type { PluginEntryView } from '../../../../shared/plugin-api'

interface Props {
  readonly plugins: readonly PluginEntryView[]
  /** 当前在右侧面板展示的插件标识；由设置页持有，本组件只用于标出选中行。 */
  readonly selectedId: string | null
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly error: string | null
  /** 正在切换的插件标识；期间整表开关禁用，避免并发请求被丢弃。 */
  readonly togglingId: string | null
}

const props = defineProps<Props>()

const emit = defineEmits<{
  select: [id: string]
  toggle: [id: string, enabled: boolean]
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
  if (!plugin.enabled) return 'is-off'
  return plugin.active ? 'is-on' : 'is-warn'
}
</script>

<template>
  <div class="plugin-list-pane">
    <div class="plugin-list-head">
      <h2 class="plugin-list-title">插件</h2>
      <span class="text-2xs text-desk-muted">{{ visiblePlugins.length }} / {{ plugins.length }}</span>
    </div>

    <div class="mt-2">
      <input
        v-model="query"
        type="search"
        class="text-control w-full"
        placeholder="搜索名称或说明"
        aria-label="搜索插件"
        autocomplete="off"
      >
    </div>

    <p v-if="phase === 'loading' || phase === 'idle'" role="status" class="plugin-list-note">正在读取插件清单…</p>

    <div v-else-if="phase === 'error'" class="plugin-list-error mt-3">
      <p role="alert" class="text-xs text-desk-danger">{{ error ?? '插件清单读取失败。' }}</p>
      <AppButton variant="compact" class="mt-2" @click="emit('reload')">重试</AppButton>
    </div>

    <p v-else-if="plugins.length === 0" class="plugin-list-note">当前没有可用的能力插件。</p>

    <p v-else-if="visiblePlugins.length === 0" class="plugin-list-note">
      没有匹配「{{ query.trim() }}」的插件。
    </p>

    <ul v-else class="plugin-list mt-2">
      <li v-for="plugin in visiblePlugins" :key="plugin.id">
        <div
          class="plugin-list-row"
          :class="{ 'is-selected': plugin.id === selectedId, 'is-off': !plugin.enabled }"
        >
          <button
            type="button"
            class="plugin-list-main"
            :aria-current="plugin.id === selectedId ? 'true' : undefined"
            :title="plugin.summary"
            @click="emit('select', plugin.id)"
          >
            <span class="plugin-list-name">{{ plugin.name }}</span>
            <span class="plugin-chip" :class="statusClass(plugin)">{{ statusLabel(plugin) }}</span>
          </button>
          <button
            type="button"
            role="switch"
            class="plugin-switch"
            :aria-checked="plugin.enabled"
            :aria-label="`启用 ${plugin.name}`"
            :disabled="togglingId !== null"
            @click="emit('toggle', plugin.id, !plugin.enabled)"
          >
            <span></span>
          </button>
        </div>
      </li>
    </ul>

    <p v-if="phase === 'ready' && plugins.length > 0" class="plugin-list-note">
      启停需要重启应用才完全生效；被停用的插件不再装配，其中没有独立通道的偏好项（快捷输入、执行模式）隐藏对应入口。
    </p>
  </div>
</template>
