<!-- 设置页的终端分节：展示常驻终端守护进程的状态，并提供明确的清理入口。

     终端由独立守护进程持有，关闭应用窗口不会结束终端与其中运行的命令；因此这里必须能看清「还有几个终端在跑」，
     并提供一次结束全部终端的动作。清理是不可逆的破坏性操作，走确认对话框，不就地二次点击。

     状态在进入本页时读取一次，并随守护进程状态事件更新；读取失败只就地展示原因，不清空上一次的结果。
     旧版本守护进程（协议版本不符）单独提示：它的终端当前版本接不回来，结束它需要用户显式操作。 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useTerminalStore } from '../stores/terminal'
import AppButton from './ui/AppButton.vue'
import ConfirmDialog from './ConfirmDialog.vue'

const terminalStore = useTerminalStore()
const { daemonStatus, error } = storeToRefs(terminalStore)

/** 关闭全部终端的确认框；清理会结束进程，必须显式确认。 */
const confirmOpen = ref(false)
const closing = ref(false)
const feedback = ref<string | null>(null)

const connected = computed(() => daemonStatus.value?.connected === true)
const statusLabel = computed(() => (connected.value ? '已连接' : '未连接'))
const sessionSummary = computed(() => {
  const status = daemonStatus.value
  if (status === null) return '—'
  return `${status.sessionCount} 个（运行中 ${status.runningCount}，历史恢复 ${status.restoredCount}）`
})
const daemonDetail = computed(() => {
  const status = daemonStatus.value
  if (status === null || status.pid === null) return '尚未启动：第一次打开终端时会自动启动。'
  const version = status.protocolVersion === null ? '未知' : `v${status.protocolVersion}`
  return `进程 ${status.pid} · 协议 ${version}`
})
const stale = computed(() => daemonStatus.value?.stale ?? null)

onMounted(() => {
  void terminalStore.refreshDaemonStatus()
})

// 状态事件到达即视为一次新的读取结果，清掉上一次的操作反馈。
watch(() => daemonStatus.value, () => {
  feedback.value = null
})

/** 关闭全部终端：成功后报告结果，失败原因由 store 的错误提示展示。 */
async function closeAll(): Promise<void> {
  confirmOpen.value = false
  closing.value = true
  try {
    feedback.value = await terminalStore.closeAllTerminals() ? '已关闭全部终端。' : null
  } finally {
    closing.value = false
  }
}

/** 结束旧版本守护进程：它会连带结束其中仍在运行的终端，因此同样走确认。 */
const stopStale = ref(false)
const stoppingStale = ref(false)

async function stopStaleDaemon(): Promise<void> {
  stopStale.value = false
  stoppingStale.value = true
  try {
    feedback.value = await terminalStore.stopStaleDaemon() ? '已发送旧版本终端守护进程结束请求。' : null
  } finally {
    stoppingStale.value = false
  }
}

/** 停止守护进程：同样结束全部终端，用于覆盖解压前释放文件占用。 */
const stopOpen = ref(false)
const stopping = ref(false)

async function stopDaemon(): Promise<void> {
  stopOpen.value = false
  stopping.value = true
  try {
    feedback.value = await terminalStore.stopDaemon() ? '已发送停止请求，终端历史保留。' : null
  } finally {
    stopping.value = false
  }
}
</script>

<template>
  <div>
    <header>
      <h1 class="text-xl font-semibold tracking-tight">终端</h1>
      <p class="mt-1 text-sm text-desk-muted">
        终端由独立守护进程持有，关闭应用窗口不会结束终端与其中运行的命令；重新打开应用时会接回原来的终端与保留窗口内的滚动历史。
      </p>
    </header>

    <section class="settings-section" aria-labelledby="settings-terminal-daemon-title">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-terminal-daemon-title" class="settings-section-title">常驻终端</h2>
          <p class="mt-1 text-xs text-desk-muted">{{ daemonDetail }}</p>
        </div>
        <AppButton variant="compact" :disabled="closing" @click="terminalStore.refreshDaemonStatus()">
          刷新状态
        </AppButton>
      </div>

      <div class="settings-row">
        <span class="text-sm font-medium">守护进程</span>
        <span class="text-sm" role="status">{{ statusLabel }}</span>
      </div>
      <div class="settings-row">
        <span class="text-sm font-medium">常驻终端</span>
        <span class="text-sm">{{ sessionSummary }}</span>
      </div>

      <p class="mt-3 text-xs text-desk-muted">
        终端资源上限约束运行中及正在保存画面的实例；已完成冷存储的历史记录不占模拟器额度。关闭应用后终端继续运行；
        结束终端请用下面的「关闭全部终端」，或直接关闭对应标签。
      </p>
    </section>

    <section class="settings-section" aria-labelledby="settings-terminal-cleanup-title">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-terminal-cleanup-title" class="settings-section-title">清理</h2>
          <p class="mt-1 text-xs text-desk-muted">关闭全部终端会结束其中的进程与构建任务，并丢弃它们的历史。</p>
        </div>
      </div>
      <div class="settings-row">
        <span class="text-sm font-medium">全部终端</span>
        <AppButton variant="quiet-danger" :disabled="closing" @click="confirmOpen = true">
          关闭全部终端
        </AppButton>
      </div>
      <p class="mt-3 text-xs text-desk-muted">
        关掉应用不影响终端；没有终端记录且没有应用连接时，守护进程闲置一段时间后自动退出。
      </p>
      <div class="settings-row">
        <span class="text-sm font-medium">守护进程</span>
        <AppButton variant="quiet-danger" :disabled="stopping" @click="stopOpen = true">
          停止守护进程
        </AppButton>
      </div>
      <p class="mt-3 text-xs text-desk-muted">
        覆盖解压新版本或更新前，先停止守护进程；它会结束全部终端并保留历史，下次新建终端时重新拉起。
      </p>
      <p v-if="feedback !== null" class="mt-3 text-xs text-desk-muted" role="status">{{ feedback }}</p>
      <p v-if="error !== null" class="mt-3 text-xs text-desk-danger" role="alert">{{ error }}</p>
    </section>

    <section v-if="stale !== null" class="settings-section" aria-labelledby="settings-terminal-stale-title">
      <div class="settings-section-heading">
        <div>
          <h2 id="settings-terminal-stale-title" class="settings-section-title">旧版本守护进程</h2>
          <p class="mt-1 text-xs text-desk-muted">
            检测到协议版本 v{{ stale.protocolVersion }} 的守护进程（进程 {{ stale.pid }}），它持有的终端当前版本接不回来。
            结束它会连带结束其中仍在运行的命令。
          </p>
        </div>
      </div>
      <div class="settings-row">
        <span class="text-sm font-medium">旧版本守护进程</span>
        <AppButton variant="quiet-danger" :disabled="stoppingStale" @click="stopStale = true">
          结束它
        </AppButton>
      </div>
    </section>

    <ConfirmDialog
      :open="confirmOpen"
      title="关闭全部终端"
      description="将结束全部终端及其中的进程与构建任务，并丢弃它们的历史。"
      detail="此操作不可撤销；正在运行的服务、构建与 agent 都会被中断。"
      confirm-label="关闭全部"
      @confirm="closeAll"
      @cancel="confirmOpen = false"
    />

    <ConfirmDialog
      :open="stopStale"
      title="结束旧版本守护进程"
      description="旧版本守护进程持有的终端无法被当前版本接回，结束它会终止其中仍在运行的命令。"
      detail="如果那些终端里还有没保存的工作，请先回到旧版本应用里处理。"
      confirm-label="结束进程"
      @confirm="stopStaleDaemon"
      @cancel="stopStale = false"
    />

    <ConfirmDialog
      :open="stopOpen"
      title="停止守护进程"
      description="将结束全部终端及其中的进程与构建任务，保留历史并退出守护进程。"
      detail="覆盖解压新版本或更新前需要停止它；下次打开终端会重新拉起守护进程。"
      confirm-label="停止守护进程"
      @confirm="stopDaemon"
      @cancel="stopOpen = false"
    />
  </div>
</template>
