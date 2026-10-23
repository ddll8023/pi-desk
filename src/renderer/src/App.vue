<!-- 页面组合根：只装配外壳骨架、弹层宿主与启动编排。布局与响应式在 shell/AppShell.vue，工作区在 shell/WorkspaceView.vue，弹层在 shell/AppDialogHost.vue，Store 初始化与释放顺序在 shell/use-app-startup.ts。 -->
<script setup lang="ts">
import AppDialogHost from './shell/components/AppDialogHost.vue'
import AppShell from './shell/components/AppShell.vue'
import { useAppStartup } from './shell/use-app-startup'

useAppStartup()
</script>

<template>
  <AppShell />
  <AppDialogHost />
</template>
