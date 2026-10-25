# 手机访问

模块 ID：`lan-remote`。返回 [总览](../项目结构文档.md)。

## 职责与入口

负责手机访问本地回环入口的启停、一次性配对与设备授权、手机网页资源挂载，以及已授权项目与会话的受限远程接入。入口为设置页「手机访问」分节；手机网页经用户配置的可信 HTTPS 代理访问本地 HTTP 服务，HTTPS 证书由外部代理管理。

执行仍在电脑上：本模块不另建会话运行时，也不隔离项目文件。手机页面不提供文件、终端、Git 与设置入口，也不渲染生成式界面。默认不监听，每次启动应用都需要显式开启。

## 专属文件

### 主进程

| 文件 | 用途 |
| --- | --- |
| `src/main/lan-remote/manager.ts` | 回环入口启停、外部 HTTPS 配对地址、配对与设备操作；实例化不监听 |
| `src/main/lan-remote/ipc.ts` | 可信桌面的固定控制入口与请求校验 |
| `src/main/lan-remote/server.ts` | 回环 HTTP 载体：真实连接来源、外部 Host／Origin、设备与载荷边界先于业务分派 |
| `src/main/lan-remote/static-assets.ts` | 只提供手机构建目录中的首页与 assets，真实路径复核阻止越界 |
| `src/main/lan-remote/event-stream.ts` | 单连接事件流：先观察增量再读取基准，独立背压与断流 |
| `src/main/lan-remote/session-service.ts` | 按设备与项目重新授权的能力白名单、会话目标固定与写请求去重 |
| `src/main/lan-remote/device-manager.ts` | 一次性配对码、凭证摘要、项目授权与撤销 |

### 契约与桥接

| 文件 | 用途 |
| --- | --- |
| `src/shared/lan-remote-api.ts` | 控制、配对、设备、远程会话请求与响应的共享契约及运行时校验 |
| `src/preload/lan-remote.ts` | 手机访问控制的固定通道桥接与响应校验 |

### 桌面界面

| 文件 | 用途 |
| --- | --- |
| `src/renderer/src/lan-remote/components/LanRemoteSettingsSection.vue` | 外部 HTTPS 地址与本地转发端口配置、启停、配对二维码、项目授权与设备撤销 |
| `src/renderer/src/lan-remote/services/lan-remote.ts` | 控制请求重建与状态事件订阅 |

### 手机网页

| 文件 | 用途 |
| --- | --- |
| `src/lan-mobile/index.html` | 手机页面文档与视口声明 |
| `src/lan-mobile/src/main.ts` | 手机应用挂载；不初始化桌面 Store |
| `src/lan-mobile/src/App.vue` | 配对、项目与会话导航、消息区与底部输入外壳 |
| `src/lan-mobile/src/client.ts` | 同源请求、响应校验、协议检查与写请求身份 |
| `src/lan-mobile/src/use-mobile-session.ts` | 会话选择、基准与增量、历史缓存、重连与结果未知保护 |
| `src/lan-mobile/src/components/MobileMessageList.vue` | 消息阅读、工具详情与历史原文展开 |
| `src/lan-mobile/src/components/MobileInteractionPanel.vue` | 选择、确认、文本与编辑四类问题的回应 |
| `src/lan-mobile/src/mobile.css` | 手机样式入口：复用基础令牌与共享组件样式，追加窄屏与安全区域规则 |

进程装配、安全判定与手机状态机已由源码读取；界面文件结合模板与接口调用映射，不将本表视作逐函数质量结论。

## 公共与跨模块引用

- [F-config](shared.md#f-configdesktop-配置混合)：`src/main/config/desktop-config-store.ts` 保存设备凭证摘要与项目授权，与项目、信任决定共用同一份配置与写入队列。
- [F-assembly](shared.md#f-assembly进程与页面组装混合)：`src/main/services.ts` 建立管理器，`src/main/app-lifecycle.ts` 注册控制通道、订阅状态并在退出链先收敛手机访问入口，`src/main/window-channel.ts` 提供状态广播。
- [F-runtime-state](shared.md#f-runtime-state综合-runtime-状态混合)：`src/shared/runtime/projection-reducer.ts` 的增量合并算法由桌面与手机共用，`src/renderer/src/sessions/stores/runtime-core.ts` 与手机状态机各自组合。
- [F-ui](shared.md#f-ui前端共享展示共享)：手机消息复用 `MarkdownContent.vue` 的安全 Markdown 渲染。
- [会话与聊天](sessions-chat.md)：复用会话列表、历史读取与后台打开链，以及运行实例状态查询与订阅。
- [项目与信任](projects-trust.md)：项目授权按已登记项目复核；项目移除时一并清除设备授权中的该项目。
- [应用外壳](app-shell.md)：设置页提供本模块的启停与设备管理入口。

## 关键调用链

1. 桌面开启入口：配置外部 HTTPS 来源与本地转发端口后显式开启，主进程只在回环地址监听 HTTP；关闭入口或应用退出时收敛连接，不自动恢复监听。配置契约见 `src/shared/lan-remote-api.ts` 的 `LanStartOptions`。
2. 配对：桌面按外部 HTTPS 来源生成一次性配对链接并限定可访问项目；手机扫码确认后保存设备授权，凭证只通过带 Secure、HttpOnly 属性的 Cookie 回到手机，落盘只有摘要。
3. 接入会话：手机请求项目与会话由主进程按设备授权复核；后台打开复用会话打开链，不改变桌面前台，也不占用桌面空白会话。
4. 同步：连接先建立事件观察再读取权威快照，之后按序号应用增量；增量失效或有缺口时重新取快照，不由手机端自行补齐。
5. 写操作：发送、停止与问题回应固定会话与绑定代际，按请求身份去重；结果未知时页面保留原请求等待用户显式重试或核对，不自动重发。

## 状态与边界

设备授权是访问控制真源：撤销立即关闭该设备的连接与事件流，重新配对会改变请求去重所依据的设备身份，旧写请求不会迁到新身份执行。移动端不能枚举未授权项目，也不能指定任意会话文件或主机路径。

手机页面是独立的页面入口，只经同源 HTTPS 接口工作，不加载 Electron 桥接，也不把桌面 Store 当作状态源。每条连接各自维护同步水位，慢连接只影响自身，通过背压与断流收敛，不阻塞桌面对同一会话的展示。会话本身仍由 SDK 与主进程持有；手机断开不中断正在运行的任务，重新连接后按权威快照重建。

手机侧必须使用浏览器信任的 HTTPS 来源，代理转发到本机回环 HTTP 入口。代理需提供独立的来源根地址，不使用路径前缀；转发时保留外部 Host 与 Origin、不改写 Cookie，并支持不缓存、不缓冲的 SSE 长连接。服务只按真实连接来源与配置的外部来源校验，不根据转发头授予设备身份。

外部代理由用户配置并保持运行，应用不自动安装或启动隧道，也不申请证书。HTTPS 在代理处终止，代理能够读取转发内容；本地入口就绪不表示外部地址已经可达。入口配置只保留在页面与服务内存中，不写入 Desktop 配置；设备凭证摘要与项目授权仍由 `DesktopConfigStore` 持久化。

可以连上的手机能驱动 Agent 在电脑上执行操作，项目授权因此按项目最小化授予，不能当作只读预览。