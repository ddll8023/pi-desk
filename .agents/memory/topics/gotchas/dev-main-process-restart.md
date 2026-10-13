# 主进程改动在 dev 下不生效

### 不带 --watch 的 electron-vite dev：主进程与 preload 只构建一次，源码改了不重启就不生效

现象：dev 会话中改了主进程源码（`src/main/**`、`src/preload/**`、`src/sdk-host/**`），应用行为仍是旧的；同一会话里改渲染层却立刻生效，容易误判为「改动写错了」。

根因：`npm run dev` 走的是不带 `-w/--watch` 的 `electron-vite dev`。此时主进程与 preload 只构建一次并以该产物启动应用，带 `--watch` 时重建才会 kill 并重启 Electron；渲染层始终由 Vite dev server 提供并热更新。两部分的生效条件不同。

处置：改主进程或 preload 后重启 dev 进程。判断当前进程用的是哪份构建，可比对 `out/main/index.cjs`、`out/preload/index.cjs` 的 mtime 与源码 mtime；重启会中断正在运行的一轮对话，会话内容由 Pi 落盘保留。

排除：不要把渲染层的新行为当成主进程改动已生效的证据；也不要指望只重启应用窗口就能加载新的主进程构建。
