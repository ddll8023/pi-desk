# Electron 二进制需要单独安装

### 重装依赖后 `node_modules/electron/dist` 不会就位，dev 与 build 直接起不来

现象：`npm ci`（或 `npm install`）报成功，紧接着 `npm run dev` / `npm run build` 起不来，提示 Electron 二进制缺失或「Electron failed to install correctly，请删除 node_modules/electron 重装」——按该提示重装结果一样；`node_modules/electron/` 下只有 JS 文件，没有 `dist/` 与 `path.txt`。

根因：本项目锁文件里的 electron 条目没有 `hasInstallScript`，该发布不带 install 脚本，依赖安装流程不会下载与解包 Electron 二进制；它与 allow-scripts 拦截不是同一回事（被拦截的依赖会出现在 npm 的安装脚本告警里，electron 不在其中）。

处置：执行开发启动脚本（`scripts/start-dev.*`）前置检查里提示的那条命令：`node node_modules/electron/install.js`（直接跑 `npm run dev` 不会看到这段提示）。它复用 electron 包自带的 `@electron/get`，命中缓存时无需联网，冷缓存才需要下载（可用 `ELECTRON_MIRROR` 换源；`scripts/package-portable.mjs` 里的镜像变量只作用于打包步骤）。已就位时脚本立即退出，重复执行无害。
