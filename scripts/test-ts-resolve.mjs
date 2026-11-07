/**
 * 测试用模块解析钩子：把无扩展名的相对导入解析到 `.ts`。
 *
 * 仓库沿用打包器风格的无扩展名相对导入（由 Vite 与 tsconfig 的 `moduleResolution: bundler` 解析），
 * 而 Node 的 ESM 加载器要求显式扩展名；测试直接跑源码时因此报 `ERR_MODULE_NOT_FOUND`。
 * 这里只在测试进程内补齐扩展名，不改变源码导入写法，也不影响构建产物。
 */
const CANDIDATES = ['.ts', '.tsx', '/index.ts']

/** 已带扩展名或是包名/裸标识符时交给默认解析。 */
function needsExtension(specifier) {
  return specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/i.test(specifier)
}

export async function resolve(specifier, context, nextResolve) {
  if (!needsExtension(specifier)) return nextResolve(specifier, context)
  for (const suffix of CANDIDATES) {
    try {
      return await nextResolve(`${specifier}${suffix}`, context)
    } catch {
      // 该后缀不存在，继续尝试下一个。
    }
  }
  return nextResolve(specifier, context)
}
