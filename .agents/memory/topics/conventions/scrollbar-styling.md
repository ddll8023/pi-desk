# 滚动条样式

### 只用 ::-webkit-scrollbar 定制，不设 scrollbar-width 与 scrollbar-color

约定：滚动条尺寸、轨道与滑块的样式只在 `src/renderer/src/assets/styles/ui.css` 的共享选择器名单里维护，用 `::-webkit-scrollbar` 系列伪元素表达；任何样式文件都不得用 `scrollbar-width` 或 `scrollbar-color` 去调宽或上色。需要完全隐藏滚动条的容器（侧栏大纲、工作区标签条）是例外：它们本来就不在这份名单里，现有写法同时给 `scrollbar-width: none` 与 `::-webkit-scrollbar { display: none }`，新增同类容器沿用。

适用：新增滚动容器、给现有容器补滚动条样式，或改动 `ui.css` 的名单时。

原因：Chromium 里这两个属性一旦不是 `auto` 就会覆盖 `::-webkit-scrollbar`，半透明细条退回成按 `scrollbar-color` 上色的原生滚动条；本应用只跑 Electron，不需要 `scrollbar-color` 的兼容回退。完全隐藏滚动条的容器不受这条约束影响，因为它本来就不指望细条样式。

### 滚动容器要么带 scroll-area 类，要么进 ui.css 名单

约定：模板里能加类的新滚动容器一律加 `scroll-area`；结构上拿不到类的容器（组件库生成节点、scoped 样式内的元素、走独立样式入口的文件）必须同时在该名单中补选择器，否则会露出原生滚动条。

适用：新增任何 `overflow: auto`／`overflow-y: auto` 的容器，或把容器移出原有组件时。

原因：全局选择器进不了 SFC 的 scoped 样式，也无法命中运行时生成的节点；名单是手工维护的，遗漏只会表现为个别容器滚动条不一致，没有报错可循。

### 预留滚动条槽位只给纵向滚动容器

约定：`scrollbar-gutter: stable` 只加在会纵向滚动的容器上；纯横向滚动容器显式退回 `auto`，因为 `overflow-x: auto` 会把 `overflow-y` 计算成 `auto`，否则右侧白占一列宽度。

适用：给滚动容器补 `scroll-area` 类，或调整槽位规则时。

原因：内容左对齐的容器多出的槽位是纯浪费；居中内容才需要槽位来避免有无滚动条时横向跳动。
