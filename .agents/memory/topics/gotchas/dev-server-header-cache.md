# 开发态页面响应头与缓存

### 改了 dev 页面响应头却不生效：Vite 的 304 不带自定义头，浏览器沿用缓存里的旧头

现象：改了开发态页面的响应头（例如 `electron.vite.config.ts` 里的 CSP），重启 dev server 与应用后页面行为仍是旧的——控制台报的 CSP 与配置不一致，按新配置放开的资源仍被拦。只重启应用无效。

根因：dev server 给 HTML 的响应是 `Cache-Control: no-cache` 加基于内容的弱 ETag。只改响应头、不改 HTML 内容时 ETag 不变，浏览器带 `If-None-Match` 重新校验，Vite 命中 ETag 后直接回 304 且不设置任何自定义响应头；按 HTTP 缓存语义，304 未出现的字段保留，缓存文档里的旧响应头继续生效。缓存与 ETag 都跨进程存活。

处置：开发态启动时清一次 HTTP 缓存——`src/main/index.ts` 的 `createWindow` 在加载开发页面（非 `app://`）之前调用 `session.defaultSession.clearCache()`；临时恢复也可以用忽略缓存的重载。生产页面由本地文件提供，不需要这一步。

排除：以为「重启 dev server 或应用」就等于配置已生效；配置里的响应头只影响新返回的响应，不影响浏览器已缓存的文档。
