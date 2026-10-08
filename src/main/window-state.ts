/**
 * 唯一业务窗口的尺寸、位置与最大化状态的读取、校正与保存。
 *
 * 创建窗口前读取存储值：位置必须与某显示器工作区有足够交集，否则丢弃位置交给窗口居中；
 * 尺寸按窗口下限与目标显示器工作区收敛，避免恢复到放不下的尺寸。保存使用 getNormalBounds，
 * 不把最大化尺寸写成常态尺寸；窗口变更经防抖写入，退出前强制落盘。不通过 IPC 暴露给页面。
 */
import { screen } from 'electron'
import type { BrowserWindow, Display, Rectangle } from 'electron'
import { DEFAULT_WINDOW_STATE } from './desktop-config-store'
import type { DesktopConfigStore, WindowState as StoredWindowState } from './desktop-config-store'

/** 窗口尺寸下限；创建窗口时同样使用，避免恢复出比最小尺寸更小的窗口。 */
export const MIN_WINDOW_WIDTH = 720
export const MIN_WINDOW_HEIGHT = 600
/** 恢复位置时必须落在显示器工作区内的最小可见范围。 */
const MIN_VISIBLE_WIDTH = 100
const MIN_VISIBLE_HEIGHT = 40
/** 窗口变更的保存防抖；退出前会强制落盘。 */
const SAVE_DEBOUNCE_MS = 500

/** 已按显示器校正、可直接用于创建窗口的状态；位置为 null 表示由窗口居中。 */
export interface ResolvedWindowState {
  readonly width: number
  readonly height: number
  readonly x: number | null
  readonly y: number | null
  readonly maximized: boolean
}

export interface WindowStateOptions {
  /** 配置文件的唯一读写者；窗口状态与项目、界面偏好共用同一份文件。 */
  readonly store: DesktopConfigStore
}

interface DisplayMatch {
  readonly display: Display
  /** 交集是否达到最小可见范围；不足时按不可见处理。 */
  readonly visible: boolean
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function intersectionArea(rect: Rectangle, area: Rectangle): number {
  const width = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x)
  const height = Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y)
  return width > 0 && height > 0 ? width * height : 0
}

/** 取交集面积最大的显示器；没有任何显示器时返回 null。 */
function matchDisplay(rect: Rectangle, displays: readonly Display[]): DisplayMatch | null {
  let best: Display | null = null
  let bestArea = 0
  for (const display of displays) {
    const area = intersectionArea(rect, display.workArea)
    if (area > bestArea) {
      bestArea = area
      best = display
    }
  }
  if (best === null) return null
  return { display: best, visible: bestArea >= MIN_VISIBLE_WIDTH * MIN_VISIBLE_HEIGHT }
}

export class WindowState {
  private timer: ReturnType<typeof setTimeout> | null = null
  /** 最近一次真实窗口状态；为空表示本次运行还没有可保存的变更。 */
  private latest: ResolvedWindowState | null = null

  constructor(private readonly options: WindowStateOptions) {}

  /** 创建窗口前读取；配置读取失败时按默认值处理，不阻断应用启动。 */
  async read(): Promise<ResolvedWindowState> {
    let stored: StoredWindowState = DEFAULT_WINDOW_STATE
    try {
      stored = await this.options.store.readWindowState()
    } catch {
      // 配置不可读时已由存储层给出降级提示，这里只需退回默认窗口。
    }
    return this.resolve(stored)
  }

  /** 窗口尺寸、位置或最大化状态变化后调用；防抖写入。 */
  notifyChanged(window: BrowserWindow): void {
    this.capture(window)
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, SAVE_DEBOUNCE_MS)
  }

  /** 窗口关闭前记录最后一次状态；销毁后无法再读取 bounds。 */
  captureBeforeClose(window: BrowserWindow): void {
    this.capture(window)
  }

  /** 立即落盘；失败只影响窗口状态，不回滚已恢复的窗口，也不阻断退出。 */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const snapshot = this.latest
    if (snapshot === null) return
    try {
      await this.options.store.saveWindowState(snapshot)
    } catch {
      // 窗口状态不是关键数据：保存失败不提示、不重试。
    }
  }

  /** 释放防抖定时器；窗口销毁后调用。 */
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private capture(window: BrowserWindow): void {
    try {
      if (window.isDestroyed()) return
      // getNormalBounds 在最大化状态下返回还原后的尺寸，避免把最大化尺寸写成常态尺寸。
      const bounds = window.getNormalBounds()
      this.latest = {
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        maximized: window.isMaximized()
      }
    } catch {
      // 窗口在读取过程中销毁：保留上一次成功记录，不写入半份状态。
    }
  }

  private resolve(stored: StoredWindowState): ResolvedWindowState {
    const storedRect: Rectangle | null = stored.x !== null && stored.y !== null
      ? { x: stored.x, y: stored.y, width: stored.width, height: stored.height }
      : null
    const match = storedRect === null ? null : matchDisplay(storedRect, screen.getAllDisplays())
    const targetArea = (match?.display ?? screen.getPrimaryDisplay()).workArea

    const width = clamp(stored.width, MIN_WINDOW_WIDTH, Math.max(MIN_WINDOW_WIDTH, targetArea.width))
    const height = clamp(stored.height, MIN_WINDOW_HEIGHT, Math.max(MIN_WINDOW_HEIGHT, targetArea.height))

    if (storedRect === null || match === null || !match.visible) {
      // 没有存储位置，或位置已不可见：只保留尺寸与最大化状态，位置交给窗口居中。
      return { width, height, x: null, y: null, maximized: stored.maximized }
    }

    // 位置仍可见时也收敛到工作区内，保证标题栏与至少一小部分窗口可达。
    const x = clamp(
      storedRect.x,
      targetArea.x - width + MIN_VISIBLE_WIDTH,
      targetArea.x + targetArea.width - MIN_VISIBLE_WIDTH
    )
    const y = clamp(
      storedRect.y,
      targetArea.y,
      targetArea.y + targetArea.height - MIN_VISIBLE_HEIGHT
    )
    return { width, height, x, y, maximized: stored.maximized }
  }
}
