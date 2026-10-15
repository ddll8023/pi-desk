/** 出包构建内嵌的默认端口；开发脚本用 PI_DESK_DEV_SERVER_PORT 覆盖后与出包版本区分开。 */
const DEFAULT_DEV_SERVER_PORT = 41730

/**
 * 由环境变量取值算出开发态渲染端服务的端口。
 *
 * 取值由调用方传入（不在这里读 `process.env`）：本模块与它所在的目录同时被沙箱页面的类型检查覆盖，
 * 因此保持无 Node 能力。dev server、主进程拼出的页面地址与开发期 CSP 三处都必须用同一个值：
 * 主进程会把 electron-vite 给出的渲染端地址与本值拼出的地址逐字符比对，任意一处不同都会让开发页面打不开。
 * 环境变量未设置时用默认端口，出包构建与 electron-vite preview 都走默认值。
 */
export function devServerPortFromEnv(raw: string | undefined): number {
  return Number(raw ?? DEFAULT_DEV_SERVER_PORT)
}
