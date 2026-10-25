# 手机访问

模块 ID：`lan-remote`。返回 [总览](../项目结构文档.md)。

## 职责与入口

负责局域网入口的启停、本机专用 CA 与服务证书、一次性配对与设备授权、手机网页资源挂载，以及已授权项目与会话的受限远程接入。入口为设置页「手机访问」分节，手机侧入口是同一服务提供的网页。

执行仍在电脑上：本模块不另建会话运行时，也不隔离项目文件。手机页面不提供文件、终端、Git 与设置入口，也不渲染生成式界面。默认不监听，每次启动应用都需要显式开启。

## 专属文件

### 主进程

| 文件 | 用途 |
| --- | --- |
| `src/main/lan-remote/manager.ts` | 启停编排、配对与设备操作、网卡变化时的收敛；实例化不监听 |
| `src/main/lan-remote/ipc.ts` | 可信桌面的控制入口；CA 导出必须经过本机保存对话框 |
| `src/main/lan-remote/server.ts` | HTTPS 载体：来源网段、同源、设备与载荷边界先于业务分派 |
| `src/main/lan-remote/static-assets.ts` | 只提供手机构建目录中的首页与 assets，真实路径复核阻止越界 |
| `src/main/lan-remote/event-stream.ts` | 单连接事件流：先观察增量再读取基准，独立背压与断流 |
| `src/main/lan-remote/session-service.ts` | 按设备与项目重新授权的能力白名单、会话目标固定与写请求去重 |
| `src/main/lan-remote/device-manager.ts` | 一次性配对码、凭证摘要、项目授权与撤销 |
| `src/main/lan-remote/tls.ts` | 本机 CA 与服务证书签发；私钥经系统密钥库加密保存，导出只给公开根证书 |
| `src/main/lan-remote/network.ts` | 私有 IPv4 网卡枚举、绑定与来源网段判定 |

### 契约与桥接

| 文件 | 用途 |
| --- | --- |
| `src/shared/lan-remote-api.ts` | 控制、配对、设备、远程会话请求与响应的共享契约及运行时校验 |
| `src/preload/lan-remote.ts` | 局域网控制的固定通道桥接与响应校验 |

### 桌面界面

| 文件 | 用途 |
| --- | --- |
| `src/renderer/src/lan-remote/components/LanRemoteSettingsSection.vue` | 网卡选择、启停、CA 指纹与导出、配对二维码、项目授权与设备撤销 |
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
- [F-assembly](shared.md#f-assembly进程与页面组装混合)：`src/main/services.ts` 建立管理器，`src/main/app-lifecycle.ts` 注册控制通道、订阅状态并在退出链先收敛局域网入口，`src/main/window-channel.ts` 提供证书导出位置选择与状态广播。
- [F-runtime-state](shared.md#f-runtime-state综合-runtime-状态混合)：`src/shared/runtime/projection-reducer.ts` 的增量合并算法由桌面与手机共用，`src/renderer/src/sessions/stores/runtime-core.ts` 与手机状态机各自组合。
- [F-ui](shared.md#f-ui前端共享展示共享)：手机消息复用 `MarkdownContent.vue` 的安全 Markdown 渲染。
- [会话与聊天](sessions-chat.md)：复用会话列表、历史读取与后台打开链，以及运行实例状态查询与订阅。
- [项目与信任](projects-trust.md)：项目授权按已登记项目复核；项目移除时一并清除设备授权中的该项目。
- [应用外壳](app-shell.md)：设置页提供本模块的启停与设备管理入口。

## 关键调用链

1. 桌面开启入口：选择私有网卡地址后签发匹配该地址的服务证书并建立监听；未开启、网卡地址变化或应用退出时收敛连接，不自动重启监听。
2. 配对：桌面生成一次性配对码并限定可访问项目；手机提交后保存设备授权，凭证只以 Cookie 形式回到手机，落盘只有摘要。
3. 接入会话：手机请求项目与会话由主进程按设备授权复核；后台打开复用会话打开链，不改变桌面前台，也不占用桌面空白会话。
4. 同步：连接先建立事件观察再读取权威快照，之后按序号应用增量；增量失效或有缺口时重新取快照，不由手机端自行补齐。
5. 写操作：发送、停止与问题回应固定会话与绑定代际，按请求身份去重；结果未知时页面保留原请求等待用户显式重试或核对，不自动重发。

## 状态与边界

设备授权是访问控制真源：撤销立即关闭该设备的连接与事件流，重新配对会改变请求去重所依据的设备身份，旧写请求不会迁到新身份执行。移动端不能枚举未授权项目，也不能指定任意会话文件或主机路径。

手机页面是独立的页面入口，只经同源 HTTPS 接口工作，不加载 Electron 桥接，也不把桌面 Store 当作状态源。每条连接各自维护同步水位，慢连接只影响自身，通过背压与断流收敛，不阻塞桌面对同一会话的展示。会话本身仍由 SDK 与主进程持有；手机断开不中断正在运行的任务，重新连接后按权威快照重建。

局域网 HTTPS 使用本机专用 CA：私钥只留在电脑并经系统密钥库加密，手机需自行安装并信任公开根证书；本模块不修改系统证书信任，也不提供公网访问、中继或内网穿透。可以连上的手机能驱动 Agent 在电脑上执行操作，项目授权因此按项目最小化授予，不能当作只读预览。