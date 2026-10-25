# 手机访问

模块 ID：`lan-remote`。返回 [总览](../项目结构文档.md)。

## 职责与入口

负责局域网手机访问入口的启停、扫码自动登记设备、手机网页资源挂载，以及已登记项目与会话的受限远程接入。入口为设置页「手机访问」分节；开启后自动识别局域网地址、分配端口并展示二维码，手机扫码即进入项目页面，无需配置代理、证书或逐项目授权。

执行仍在电脑上：本模块不另建会话运行时，也不隔离项目文件。手机页面不提供文件、终端、Git 与设置入口，也不渲染生成式界面。默认不监听，每次启动应用都需要显式开启。

## 专属文件

### 主进程

| 文件 | 用途 |
| --- | --- |
| `src/main/lan-remote/manager.ts` | 局域网地址识别、入口启停、扫码链接与设备操作；实例化不监听 |
| `src/main/lan-remote/ipc.ts` | 可信桌面的固定控制入口与请求校验 |
| `src/main/lan-remote/server.ts` | 局域网 HTTP 载体：自动端口、扫码登记、真实连接来源与同源校验先于业务分派 |
| `src/main/lan-remote/static-assets.ts` | 只提供手机构建目录中的首页与 assets，真实路径复核阻止越界 |
| `src/main/lan-remote/event-stream.ts` | 单连接事件流：先观察增量再读取基准，独立背压与断流 |
| `src/main/lan-remote/session-service.ts` | 设备身份与已登记项目校验、会话能力白名单、目标固定与写请求去重 |
| `src/main/lan-remote/device-manager.ts` | 内存中的一次性连接码、设备身份与凭证摘要、过期与撤销 |

### 契约与桥接

| 文件 | 用途 |
| --- | --- |
| `src/shared/lan-remote-api.ts` | 控制、配对、设备、远程会话请求与响应的共享契约及运行时校验 |
| `src/preload/lan-remote.ts` | 手机访问控制的固定通道桥接与响应校验 |

### 桌面界面

| 文件 | 用途 |
| --- | --- |
| `src/renderer/src/lan-remote/components/LanRemoteSettingsSection.vue` | 一键启停、自动展示与更新二维码、备用网络地址、设备撤销 |
| `src/renderer/src/lan-remote/services/lan-remote.ts` | 控制请求重建与状态事件订阅 |

### 手机网页

| 文件 | 用途 |
| --- | --- |
| `src/lan-mobile/index.html` | 手机页面文档与视口声明 |
| `src/lan-mobile/src/main.ts` | 手机应用挂载；不初始化桌面 Store |
| `src/lan-mobile/src/App.vue` | 自动连接状态、项目与会话导航、消息区与底部输入外壳 |
| `src/lan-mobile/src/client.ts` | 同源请求、响应校验、协议检查与写请求身份 |
| `src/lan-mobile/src/use-mobile-session.ts` | 扫码自动连接、会话选择、基准与增量、历史缓存、重连与结果未知保护 |
| `src/lan-mobile/src/components/MobileMessageList.vue` | 消息阅读、工具详情与历史原文展开 |
| `src/lan-mobile/src/components/MobileInteractionPanel.vue` | 选择、确认、文本与编辑四类问题的回应 |
| `src/lan-mobile/src/mobile.css` | 手机样式入口：复用基础令牌与共享组件样式，追加窄屏与安全区域规则 |

进程装配、安全判定与手机状态机已由源码读取；界面文件结合模板与接口调用映射，不将本表视作逐函数质量结论。

## 公共与跨模块引用

- [F-config](shared.md#f-configdesktop-配置混合)：`src/main/config/desktop-config-store.ts` 保存设备身份与凭证摘要，与项目、信任决定共用同一份配置与写入队列。
- [F-assembly](shared.md#f-assembly进程与页面组装混合)：`src/main/services.ts` 建立管理器，`src/main/app-lifecycle.ts` 注册控制通道、订阅状态并在退出链先收敛手机访问入口，`src/main/window-channel.ts` 提供状态广播。
- [F-runtime-state](shared.md#f-runtime-state综合-runtime-状态混合)：`src/shared/runtime/projection-reducer.ts` 的增量合并算法由桌面与手机共用，`src/renderer/src/sessions/stores/runtime-core.ts` 与手机状态机各自组合。
- [F-ui](shared.md#f-ui前端共享展示共享)：手机消息复用 `MarkdownContent.vue` 的安全 Markdown 渲染。
- [会话与聊天](sessions-chat.md)：复用会话列表、历史读取与后台打开链，以及运行实例状态查询与订阅。
- [项目与信任](projects-trust.md)：手机显示全部已登记项目，请求时重新复核项目是否仍存在；不维护设备级项目授权。
- [应用外壳](app-shell.md)：设置页提供本模块的启停与设备管理入口。

## 关键调用链

1. 桌面开启入口：用户显式开启后，主进程自动识别局域网地址并分配 HTTP 监听端口，设置页自动展示二维码；关闭入口或应用退出时收敛连接，不自动恢复监听。控制与状态契约见 `src/shared/lan-remote-api.ts`。
2. 扫码连接：手机优先复用浏览器已有设备身份，无有效身份时自动兑换链接中的一次性连接码，设备名称由服务端识别，无需填写或确认。凭证通过 HttpOnly Cookie 回到手机，配置中只保存设备身份与凭证摘要；二维码过期或被使用后由设置页自动更新。
3. 接入会话：手机显示全部已登记项目，请求项目与会话时复核设备身份及项目是否存在；后台打开复用会话打开链，不改变桌面前台，也不占用桌面空白会话。
4. 同步：连接先建立事件观察再读取权威快照，之后按序号应用增量；增量失效或有缺口时重新取快照，不由手机端自行补齐。
5. 写操作：发送、停止与问题回应固定会话与绑定代际，按请求身份去重；结果未知时页面保留原请求等待用户显式重试或核对，不自动重发。

## 状态与边界

设备身份是访问控制真源：撤销立即关闭该设备的连接与事件流，重新配对会改变请求去重所依据的设备身份，旧写请求不会迁到新身份执行。已连接设备可访问全部已登记项目，但不能指定任意会话文件或主机路径。

手机页面是独立的页面入口，只经同源局域网 HTTP 接口工作，不加载 Electron 桥接，也不把桌面 Store 当作状态源。每条连接各自维护同步水位，慢连接只影响自身，通过背压与断流收敛，不阻塞桌面对同一会话的展示。会话本身仍由 SDK 与主进程持有；手机断开不中断正在运行的任务，重新连接后按权威快照重建。

手机通过局域网 IPv4 地址直接访问电脑，地址识别优先使用实体网卡的私有地址，其他网卡地址作为备用；地址范围由 `src/shared/lan-remote-api.ts` 的 `isLanAddress` 定义。服务检查真实连接来源、访问地址与同源请求，不根据转发头授予设备身份。

手机与电脑需处于可互相访问的局域网，电脑与应用需保持运行；入口使用 HTTP，不提供传输加密或公网中继。连接地址、监听状态与一次性连接码只保留在内存中，不恢复监听；设备身份与凭证摘要由 `DesktopConfigStore` 持久化。

已连接手机能驱动 Agent 在电脑上的已登记项目中执行操作，不是只读预览；设备校验与会话能力白名单在后台执行，不增加扫码后的确认步骤。