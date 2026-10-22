# 生成式界面

模块 ID：`genui`。返回 [总览](../项目结构文档.md)。

## 职责与入口

负责内置声明式 UI 工具、文档修改／检索、工具结果载荷、Vue 原生界面渲染，以及可交互参数的页面内状态、本机留档和提交。入口为 SDK 内置扩展工具、聊天消息内界面和设置页“功能”。

不执行模型生成的任意 HTML、CSS 或脚本，不取代普通聊天 Markdown，不以本机参数缓存代替会话历史。输入结构以共享契约为准，不在本文重复节点字段和容量数值。

## 专属文件

### 工具与协议

| 文件 | 用途 |
| --- | --- |
| `src/extensions/genui/index.ts` | 内置扩展工厂与注册失败降级 |
| `src/extensions/genui/tools.ts` | 界面交付、patch、目录与检查工具注册和结果 |
| `src/extensions/genui/catalog.ts` | 按主题读取工具字段说明 |
| `src/extensions/genui/diagnostics.ts` | 交付内容的非阻断诊断 |
| `src/extensions/genui/outline.ts` | 声明式文档的大纲与路径 |
| `src/extensions/genui/patch.ts` | 文档 patch 应用与约束 |
| `src/extensions/genui/session-scan.ts` | 从会话条目定位界面和版本 |
| `src/shared/genui-api.ts` | 节点、文档、版本、载荷和校验 |
| `src/shared/genui-params-api.ts` | 本机参数保存、读取、清除与校验 |

### 渲染与参数

| 文件 | 用途 |
| --- | --- |
| `src/renderer/src/components/genui/UiDocument.vue` | 文档容器、版本和用户动作 |
| `src/renderer/src/components/genui/GenuiMountGate.vue` | 界面实例挂载边界 |
| `src/renderer/src/components/genui/GenuiNode.vue` | 按节点类型分发渲染 |
| `src/renderer/src/components/genui/GenuiControls.vue` | 参数控件 |
| `src/renderer/src/components/genui/GenuiTable.vue` | 表格与本地操作 |
| `src/renderer/src/components/genui/GenuiTabs.vue` | 文档内页签 |
| `src/renderer/src/components/genui/GenuiCollapse.vue` | 文档内折叠 |
| `src/renderer/src/components/genui/GenuiChart.vue` | 图表渲染 |
| `src/renderer/src/components/genui/GenuiDiagram.vue` | 机制图解 |
| `src/renderer/src/components/genui/GenuiSvgShapes.vue` | 受限 SVG 图形渲染 |
| `src/renderer/src/genui/chart-geometry.ts` | 图表几何与数据布局 |
| `src/renderer/src/genui/diagram-geometry.ts` | 机制图解几何与派生数值 |
| `src/renderer/src/genui/svg-shapes.ts` | 图形定义与生成 |
| `src/renderer/src/genui/markdown.ts` | 声明式界面到 Markdown 的复制表达 |
| `src/renderer/src/genui/param-state.ts` | 运行期参数真源、版本迁移及写钩子 |
| `src/renderer/src/genui/param-submit.ts` | 参数提交到真实用户消息的编排 |
| `src/renderer/src/genui/param-persistence.ts` | 启动补齐、节流写回、清除及失败标记 |
| `src/renderer/src/services/genui-params.ts` | 参数旁路存储桥接 |
| `src/renderer/src/assets/genui.css` | 声明式界面的业务样式 |
| `src/renderer/src/components/GenuiSettingsSection.vue` | 能力开关与本机参数清除入口 |
| `src/main/genui/genui-param-store.ts` | `genui-params.json` 的唯一读写、容错和限量存储 |

扩展工厂、集成位置及参数持久化已读；节点、工具与几何文件结合契约、组件和会话集成引用定位。源码中生成式界面是产品内置能力，不需要用户另行安装同名扩展。

## 公共与跨模块引用

- [会话](sessions-chat.md)：`src/sdk-host/session-runtime.ts` 创建内置工厂；`src/projection/tool-projection.ts` 接收结果载荷，`activity-projection.ts` 统计交付；`ChatMessageItem.vue` 分发界面，历史读取带回原工具事实。
- [F-runtime-state](shared.md#f-runtime-state综合-runtime-状态混合)：综合 Runtime 契约包含工具上的 UI 载荷，Store 在合并历史与实时内容时维护版本事实。
- [F-assembly](shared.md#f-assembly进程与页面组装混合)：参数 IPC、preload 固定接口，以及 App 的参数预加载与页面关闭写回。
- [偏好](preferences.md)、[F-config](shared.md#f-configdesktop-配置混合)：能力开关写 Desktop 配置；宿主创建／重载时读取，不与参数缓存混存。
- [F-ui](shared.md#f-ui前端共享展示共享)、[F-style](shared.md#f-style全局主题与业务样式混合)：复制、按钮、主题与图表颜色令牌。

## 数据流与存储

1. SDK 会话注册内置工具，模型交付结构化文档；共享契约与工具层处理文档形态及版本。
2. 工具结果进入会话投影，聊天消息选择生成式渲染分支；Vue 节点组件只实现受支持声明，不执行任意脚本。
3. 参数变动首先更新 `param-state.ts`，在本地完成派生展示；显式提交经会话链发出真实用户消息。
4. `param-persistence.ts` 按文档合并写回，主进程落到 `userData/genui-params.json`。冷启动仅补尚未被用户新选择替代的记录。
5. 清除本机参数不删除会话工具结果；旧文档和最新修订的展示由界面版本事实约束。

生成式文档在 SDK 会话条目中留有工具结果事实，本机参数是独立旁路。高频参数不写 `desktop-config.json`，避免放大项目配置的整文件写入。能力开关与已建立会话的实际装载状态也分开，资源重载属于会话模块。

用户能力、节点和工具的详细说明见 [生成式界面功能清单](../生成式界面功能清单.md)。
