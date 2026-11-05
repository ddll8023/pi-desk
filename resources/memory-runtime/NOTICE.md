# 受管记忆运行环境

本目录只维护固定发布清单与来源说明，不存用户记忆。二进制缓存位于工作区 runtime/memory/，选中平台的发行资源位于 out/sdk-host/memory-runtime/。

## 来源

- CPython 3.12.16：Astral python-build-standalone 的 20261026 发布，采用各平台 install_only_stripped 归档。
- 发布地址：https://github.com/astral-sh/python-build-standalone/releases/tag/20261026
- CPython 来源：https://www.python.org/ ；发行包还包含其标准库、平台运行库及其他组件。
- IANA 数据：Python Software Foundation 的 tzdata 2026.6 源归档。
- 数据地址：https://pypi.org/project/tzdata/2026.6/

归档 URL 与发布方 SHA-256 固定在 manifest.json，不追踪 latest。准备脚本仅下载、检查完整性和解压，不执行下载的 Python，不使用 pip 或系统安装器。

## 许可随包保留

CPython 的许可及其附带组件的许可，以官方归档实际携带的全文为准；CPython 自身采用 Python Software Foundation License。tzdata 的包声明为 Apache-2.0，其数据和相关许可说明同样保留原文。

准备与暂存保留两个归档的完整目录，不移除其中的 LICENSE、licenses、COPYING 或其他出处文件。本说明不替代上游许可，也不把全部附带组件声明为同一种许可。

## 平台与数据边界

Windows、macOS 各提供 x64 与 arm64 资源，应用只暂存当前构建主机的目标。macOS 应用仍由对应主机打包及签名，不在 Windows 上产出 macOS 应用。

运行期确认固定布局、平台和资源存在；下载归档的 SHA-256 是来源完整性记录，不拿签名前的二进制字节哈希误判 macOS 签名后的文件。运行环境不可用时明确报告，不回退系统 Python 或项目虚拟环境。

用户数据始终是用户级全局库 ~/.agents/memory-store/，不在本目录或程序资源中创建，不随源码或运行时分发。
