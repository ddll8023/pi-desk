# 渲染端桥接调用

### 跨 contextBridge 的载荷必须由服务层重建为普通对象

约定：`src/renderer/src/services/` 的每个桥接调用只传原始值或当场构造的普通对象；要传响应式数据时在该层显式重建（现有例子：`toPlainTrustStatus`），不把 `ref` 或 store 里的对象直接传过去。

适用：新增或修改任何渲染端桥接方法，以及把 store 数据作为参数的调用。

原因：contextBridge 不能结构化克隆 Vue 的响应式代理，调用会在渲染层直接抛出 “An object could not be cloned.”，主进程收不到请求，界面只看到通用失败文案；`addProject` 曾因此长期不可用。

### 桥接失败的展示必须保留原始异常文本

约定：桥接异常的展示结果带原始 message——项目等模块拼进文案，认证模块放 `AuthError.detail` 由界面折叠展示；新增 IPC 通道用 `src/main/index.ts` 的 `handle()` 包装，使处理器抛错时主进程留有 `[ipc] …` 日志。不许只回固定文案。

适用：新增桥接方法及其错误分支。

原因：Electron 只把拒绝传给调用方，主进程默认不留任何记录；换掉原始文本就同时抹掉了唯一能定位原因的线索（排查 `addProject` 时先被固定文案挡了一轮）。
