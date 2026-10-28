<!-- 手机访问设置：一键开启局域网入口并自动展示二维码，手机扫码即进入；连接码仅存内存，不落盘。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import qrcode from 'qrcode-generator'
import type { LanControlData, LanControlRequest, LanDevice, LanRemoteState } from '../../../../shared/lan-remote-api'
import { copyText } from '../../ui/clipboard'
import AppButton from '../../ui/AppButton.vue'
import ConfirmDialog from '../../ui/ConfirmDialog.vue'
import { controlLanRemote, subscribeLanRemote } from '../services/lan-remote'

const state = shallowRef<LanRemoteState | null>(null)
const busy = ref(false)
const loading = ref(true)
const action = ref<LanControlRequest['action'] | null>(null)
const error = ref('')
const feedback = ref('')
const pairError = ref('')
const pairBusy = ref(false)
const now = ref(Date.now())
const selectedOrigin = ref('')
const pairing = shallowRef<Extract<LanControlData, { kind: 'pairing' }> | null>(null)
const revokeDevice = shallowRef<LanDevice | null>(null)
let alive = true
let revision = 0
let pairEpoch = 0
let nextPairAttempt = 0
let release: (() => void) | null = null
let clock: ReturnType<typeof setInterval> | null = null

const running = computed(() => state.value?.phase === 'running')
const transitioning = computed(() => state.value?.phase === 'starting' || state.value?.phase === 'stopping')
const serviceError = computed(() => error.value || state.value?.lastError || '')
const validPairing = computed(() => pairing.value && pairing.value.expiresAt > now.value
  && pairing.value.serverId === state.value?.serverId && running.value ? pairing.value : null)
const activeOrigin = computed(() => state.value?.origins.includes(selectedOrigin.value)
  ? selectedOrigin.value : state.value?.origin ?? '')
const pairingLink = computed(() => {
  if (!validPairing.value || !activeOrigin.value) return ''
  const url = new URL(validPairing.value.url)
  return `${activeOrigin.value}${url.pathname}${url.hash}`
})
const qrImage = computed(() => {
  if (!pairingLink.value) return ''
  const code = qrcode(0, 'M')
  code.addData(pairingLink.value)
  code.make()
  return code.createDataURL(5, 20)
})
const phaseLabel = computed(() => {
  if (action.value === 'start') return '正在开启'
  if (action.value === 'stop') return '正在关闭'
  if (loading.value && !state.value) return '读取中'
  return ({ stopped: '未开启', starting: '正在开启', running: '已开启', stopping: '正在关闭' })[state.value?.phase ?? 'stopped']
})

function applyState(value: LanRemoteState): void {
  if (!alive) return
  revision += 1
  const previous = state.value
  const previousIds = new Set(previous?.devices.map(device => device.id) ?? [])
  const paired = previous !== null && value.devices.some(device => !previousIds.has(device.id))
  state.value = value
  if (!value.origins.includes(selectedOrigin.value)) selectedOrigin.value = value.origin ?? ''
  if (value.phase !== 'running' || previous?.serverId !== value.serverId || paired) {
    pairEpoch += 1
    pairing.value = null
    pairError.value = ''
    nextPairAttempt = 0
  }
  if (paired) feedback.value = '手机已连接，可以在手机上继续对话。'
  if (running.value) void createPairing()
}

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  const before = revision
  const result = await controlLanRemote({ action: 'state' })
  if (!alive) return
  loading.value = false
  if (result.ok && result.data.kind === 'state') {
    if (before === revision) applyState(result.data.state)
  } else if (!result.ok) error.value = result.error.message
}

async function run(request: LanControlRequest): Promise<void> {
  if (busy.value || loading.value || transitioning.value) return
  busy.value = true
  action.value = request.action
  error.value = ''
  feedback.value = ''
  const before = revision
  try {
    const result = await controlLanRemote(request)
    if (!alive) return
    if (!result.ok) { error.value = result.error.message; return }
    if (result.data.kind === 'state' && before === revision) applyState(result.data.state)
    if (request.action === 'revoke') feedback.value = '设备已断开，电脑上的任务不受影响。'
  } finally {
    if (alive) { busy.value = false; action.value = null }
  }
}

async function createPairing(): Promise<void> {
  const serverId = state.value?.serverId
  if (!alive || !running.value || !serverId || pairBusy.value || validPairing.value || Date.now() < nextPairAttempt) return
  const epoch = pairEpoch
  pairBusy.value = true
  pairError.value = ''
  nextPairAttempt = Date.now() + 10_000
  try {
    const result = await controlLanRemote({ action: 'pair' })
    if (!alive || epoch !== pairEpoch || !running.value || state.value?.serverId !== serverId) return
    if (!result.ok) { pairError.value = result.error.message; return }
    if (result.data.kind === 'pairing' && result.data.serverId === serverId) {
      pairing.value = result.data
      now.value = Date.now()
    }
  } finally { if (alive) pairBusy.value = false }
}

function retryPairing(): void {
  nextPairAttempt = 0
  void createPairing()
}

async function copyLink(): Promise<void> {
  if (!pairingLink.value) return
  const copied = await copyText(pairingLink.value)
  if (alive) feedback.value = copied ? '连接链接已复制，在手机浏览器打开即可。' : '复制失败，请直接扫描二维码。'
}

function revoke(): void {
  const device = revokeDevice.value
  revokeDevice.value = null
  if (device) void run({ action: 'revoke', deviceId: device.id })
}

onMounted(() => {
  release = subscribeLanRemote(applyState)
  clock = setInterval(() => {
    now.value = Date.now()
    void createPairing()
  }, 1000)
  void refresh()
})
onBeforeUnmount(() => {
  alive = false
  release?.()
  if (clock) clearInterval(clock)
  pairing.value = null
})
</script>

<template>
  <div class="settings-section-stack" :aria-busy="loading || busy">
    <header>
      <h1 class="text-xl font-semibold tracking-tight">手机访问</h1>
      <p class="mt-1 text-sm text-desk-muted">手机与电脑连接同一 Wi-Fi，扫码继续对话。</p>
    </header>

    <section class="settings-section" aria-labelledby="lan-connect-title">
      <div class="settings-section-heading">
        <div class="lan-heading">
          <h2 id="lan-connect-title" class="settings-section-title">局域网连接</h2>
          <span class="chip lan-state" :data-running="running && !busy" role="status">{{ phaseLabel }}</span>
        </div>
        <AppButton
          :variant="running ? 'default' : 'primary'"
          :disabled="busy || loading || transitioning || !state"
          :aria-pressed="running"
          @click="run({ action: running ? 'stop' : 'start' })"
        >{{ action === 'start' ? '正在开启…' : action === 'stop' ? '正在关闭…' : running ? '关闭手机访问' : '开启手机访问' }}</AppButton>
      </div>

      <div v-if="serviceError" class="mt-4 status-notice status-notice-error" role="alert">
        <p>{{ serviceError }}</p>
        <AppButton v-if="!state" variant="compact" class="mt-2" :disabled="loading" @click="refresh">重新读取状态</AppButton>
      </div>

      <div v-if="running" class="lan-connect" :aria-busy="pairBusy">
        <div class="lan-code-frame">
          <img v-if="qrImage" :src="qrImage" alt="手机连接二维码，扫码自动进入项目页面" width="224" height="224" />
          <div v-else class="lan-code-placeholder" role="status">{{ pairError ? '二维码暂不可用' : '正在准备二维码…' }}</div>
        </div>
        <div class="lan-connect-detail">
          <h3 class="text-base font-semibold">用手机相机扫一扫</h3>
          <p class="mt-2 text-sm leading-6 text-desk-muted">扫码后直接进入项目页面，无需填写或确认。</p>
          <code class="lan-address">{{ activeOrigin }}</code>
          <AppButton variant="compact" :disabled="!pairingLink" @click="copyLink">复制连接链接</AppButton>
          <p class="mt-3 text-xs text-desk-muted">二维码自动更新；电脑和应用需保持运行。</p>
          <div v-if="pairError" class="mt-3" role="alert">
            <p class="text-sm text-desk-danger">{{ pairError }}</p>
            <AppButton variant="compact" class="mt-2" :disabled="pairBusy" @click="retryPairing">重试</AppButton>
          </div>
          <details v-if="state && state.origins.length > 1" class="lan-network">
            <summary>其他网络地址</summary>
            <label for="lan-network-origin" class="field-label mt-3 block">连接地址</label>
            <select id="lan-network-origin" v-model="selectedOrigin" class="text-control mt-2">
              <option v-for="origin in state.origins" :key="origin" :value="origin">{{ origin }}</option>
            </select>
          </details>
        </div>
      </div>
      <p v-else class="mt-4 text-sm text-desk-muted">{{ loading ? '正在读取连接状态…' : '开启后显示二维码，手机扫码即可使用。' }}</p>
      <p class="lan-footnote">每次启动应用默认关闭。关闭访问不会停止电脑上正在运行的任务。</p>
    </section>

    <p v-if="feedback" role="status" class="mt-3 text-sm text-desk-muted">{{ feedback }}</p>

    <details v-if="state?.devices.length" class="settings-section">
      <summary class="lan-devices-summary">
        <span class="settings-section-title">已配对设备</span>
        <span class="chip">{{ state.devices.length }}</span>
      </summary>
      <div v-for="device in state.devices" :key="device.id" class="lan-device-row">
        <div class="min-w-0">
          <h3 class="break-words text-sm font-medium">{{ device.name }}</h3>
          <p class="mt-1 text-xs text-desk-muted">{{ new Date(device.createdAt).toLocaleString() }} 连接</p>
        </div>
        <AppButton variant="quiet-danger" :disabled="busy || loading || transitioning" @click="revokeDevice = device">撤销连接</AppButton>
      </div>
    </details>

    <ConfirmDialog :open="revokeDevice !== null" title="撤销设备连接" description="该设备会立即断开，重新扫码即可再次连接。" detail="电脑上的会话与正在执行的任务不会被删除或停止。" confirm-label="撤销连接" @confirm="revoke" @cancel="revokeDevice = null" />
  </div>
</template>

<style scoped>
.lan-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.lan-state[data-running="true"] { color: var(--color-desk-success); background: var(--color-desk-success-soft); }
.lan-connect { display: grid; grid-template-columns: 224px minmax(0, 1fr); align-items: center; gap: 32px; margin-top: 24px; }
.lan-code-frame { width: 224px; max-width: 100%; overflow: hidden; border: 1px solid var(--color-desk-line); border-radius: var(--radius-desk-md); background: white; }
.lan-code-frame img { display: block; width: 100%; height: auto; image-rendering: pixelated; }
.lan-code-placeholder { display: grid; min-height: 222px; place-items: center; padding: 16px; background: var(--color-desk-surface-subtle); color: var(--color-desk-muted); font-size: 13px; }
.lan-connect-detail { min-width: 0; }
.lan-address { display: block; margin: 16px 0 12px; overflow-wrap: anywhere; color: var(--color-desk-muted); font-size: 13px; }
.lan-network { margin-top: 16px; color: var(--color-desk-muted); font-size: 12px; }
.lan-network summary { cursor: pointer; }
.lan-footnote { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--color-desk-line); color: var(--color-desk-muted); font-size: 12px; line-height: 1.7; }
.lan-devices-summary { cursor: pointer; }
.lan-devices-summary .chip { margin-left: 8px; }
.lan-device-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--color-desk-line); }
.lan-device-row > button { flex: none; }
.lan-network summary:focus-visible, .lan-devices-summary:focus-visible { outline: 2px solid var(--color-desk-accent); outline-offset: 4px; border-radius: var(--radius-desk-sm); }
@media (max-width: 640px) {
  .lan-connect { grid-template-columns: minmax(0, 1fr); gap: 24px; }
  .lan-code-frame { justify-self: center; }
  .lan-connect-detail { text-align: center; }
  .lan-network { text-align: left; }
}
</style>
