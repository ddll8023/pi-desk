# 便携打包输出目录被外部进程锁定

### 打包在 electron-builder 阶段失败，release/ 下留下 .tmp 残留

现象：`npm run package:win`（或 `package:portable`）失败，但前置的 `npm run build` 三步全部成功。`release/<platform>-unpacked.tmp` 残留，其中只有 Electron 解压出的文件：`resources/default_app.asar` 与 `version` 未清理、`LICENSE.electron.txt` 未改名、`resources/app/` 不存在、`electron.exe` 未改名为 `pi-desk.exe`——说明失败发生在解压之后、清理与复制应用文件之前。

根因：electron-builder 解压 Electron 到 `<输出目录>.tmp`（`app-builder-lib/out/util/electronGet.js` 的 `extractArchive()`）后执行 `fs.rm(dir)` + `fs.rename(tmpDir, dir)`。Windows 上只要该目录内有任一文件被其他进程以不含 FILE_SHARE_DELETE 的方式持有，目录改名即失败。本机持有者是 Orca.exe：它承载 pi 会话并监视 `H:\code\pi-desk` 工作区，会打开新出现的 .asar 且长期不释放；`.gitignore` 里的 `release/` 挡不住它。

识别特征：被锁文件可 Read、可 ReadWrite、可改长度（据此排除内存映射），但 Delete 与改名失败；用 Windows 重启管理器 API 可点名持有进程。同目录其他文件报无持有者、只有该文件报出进程，即可判定为文件级锁定而非目录级。

排除：360 主动防御与信任名单、Windows Defender 实时防护、内存映射、electron-builder 依赖缺失（当前版本已不依赖 app-builder-bin 与 @electron/rcedit）、Electron 缓存与磁盘空间、应用进程占用——都不是原因，不要往这些方向排查。

处置：打包前把 `release/` 加入 Orca 忽略列表，或退出 Orca／移除 pi-desk 工作区；否则每次打包都会失败。锁释放后再删除残留的 `.tmp` 目录。Orca 为何只持有该文件无法从外部确定，不据此推断其他行为。
