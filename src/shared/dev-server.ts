/**
 * 开发态渲染端服务的端口。
 *
 * dev server、主进程拼出的页面地址与开发期 CSP 三处都取自这一个值：主进程会把 electron-vite
 * 给出的渲染端地址与本值拼出的地址逐字符比对，任意一处不同都会让开发页面打不开。
 */
export const DEV_SERVER_PORT = 41730
