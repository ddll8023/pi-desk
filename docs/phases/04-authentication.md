# 第四阶段：Authentication

[开发总览](../development.md) · [上一阶段：Pi 深度能力](03-pi-capabilities.md) · [下一阶段：Desktop 产品能力](05-desktop-features.md)

## 目标与边界

提供 Provider、认证状态、API Key 和官方 OAuth 的 Desktop 入口，继续复用 Pi 的认证实现与数据管理。

认证不阻塞第一阶段。此处不假定当前 RPC 已有 login / logout，也不提前决定必须增加 Auth Helper。

## 依赖

- 已有稳定 Runtime、模型选择与错误呈现。
- 实施时重新核实实际固定 Pi 版本的官方认证能力，沿用官方凭据归属，避免 Desktop 创建平行认证库。
- 凭据不进入 Vue bundle、可公开环境变量、命令行参数或常规日志；UI 输入通过明确的受限操作传递。

## 任务拆分

### P4-01 认证能力确认

**目标**：依据实际版本确定认证接入边界。

**范围**：核实官方 Provider / Auth API、RPC 能力、凭据存储、API Key 与 OAuth 的生命周期。优先正式能力；若 RPC 不足，再设计复用官方 SDK 的 standalone Auth Helper，保持 Agent 主 Runtime 仍为 Pi RPC sidecar。

**依赖**：当前项目实际 Pi 版本。Helper 是条件方案，不能先实现再寻找理由。

### P4-02 Provider 与认证状态

**目标**：展示可用 Provider 与可行动的认证状态。

**范围**：官方 Provider 信息、已配置 / 未配置 / 失效等状态、错误提示和模型可用性变化；只暴露必要状态，不把凭据解析结果直接返回到页面。

**依赖**：P4-01 确定的数据来源；复用第二阶段模型入口。

### P4-03 API Key

**目标**：通过 GUI 配置或移除 API Key，并保持 Pi 与 Desktop 行为一致。

**范围**：密钥输入、受限传递、官方存储与移除、状态同步、已有配置冲突提示。展示成功以真实存储结果为依据，不建立第二套密钥文件，不默认回显已有密钥。

**依赖**：P4-01、P4-02。

### P4-04 OAuth 与 Login / Logout

**目标**：复用 Pi 官方 OAuth 流程提供登录、取消和退出。

**范围**：启动官方登录流程、浏览器与回调衔接、授权进度、取消与失败、Logout 和 Runtime 状态刷新。需要 Helper 时处理其 standalone 打包、受限通信、生命周期与秘密输出，不能重新实现 OpenAI、Anthropic 或 GitHub OAuth。

认证子流程使用的官方回调机制不等于把 Agent RPC 暴露到网络；两者安全边界分别说明。

**依赖**：P4-01、P4-02；复用官方认证入口，不要求 OAuth 与 API Key 共用不合适的抽象。

## 推进顺序

```text
P4-01 → P4-02 → P4-03 → P4-04
```

先确认能力，再实现入口。API Key 与 OAuth 只在实际公开行为相同的部分复用。

## 不做项

- 自研 OAuth、账户系统、云端凭据同步或平行认证库。
- 改用 SDK 嵌入作为 Agent 主方案。
- 提前加入所有 Provider 的专属配置页面。
- 通过日志、版本探测或通用 RPC 返回暴露密钥。

## 待决策事项

- 实施版本的 RPC 是否足够，是否确需 Auth Helper。
- Helper 的正式 API、打包方式、通信边界与存储所有者。
- 登录 / 退出后活动 Agent 操作如何处理，以及模型和凭据状态何时刷新。
- Windows/macOS 的浏览器回调、取消与窗口关闭行为。
