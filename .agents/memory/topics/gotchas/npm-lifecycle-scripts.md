# npm 生命周期脚本

### postinstall 可能被 allow-scripts 拦截，必需步骤不能挂在生命周期脚本上

现象：以为 `npm install` 会执行依赖的 postinstall，实际步骤被静默跳过、没有任何提示。

根因：开发机的 npm 若启用 allow-scripts 允许列表，依赖的 postinstall 会被拦截（在启用该设置的机器上 esbuild 两个版本实测被拦）；平台预编译二进制仍在位，因此编译类依赖照样可用。该设置随主机而异，不能假定每台机器都会执行依赖的 postinstall。

处置：需要显式执行的准备步骤一律放独立脚本与 `npm run` 入口（如 `npm run pi:prepare`），不写成 postinstall 或依赖安装的副作用。

排除：不需要为此补本地编译链（无需本地编译的预编译产物已就位）。
