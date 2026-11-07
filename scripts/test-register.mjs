/**
 * 测试进程入口：注册 TypeScript 扩展名解析钩子。
 * 只用 Node 内置的 `module.register`，不引入额外依赖；构建与运行时不加载该入口。
 */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./test-ts-resolve.mjs', pathToFileURL(import.meta.filename))
