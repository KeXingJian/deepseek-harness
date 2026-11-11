/**
 * 执行链的滚动渐进渲染：先渲染一页卡片，滚到底部再追加下一页。
 */

import { useCallback, useEffect, useState } from 'react'

/** 每次追加渲染的卡片数。 */
export const CARD_PAGE = 40

/** 已渲染数量与追加入口。 */
export interface StreamCount {
  /** 当前渲染的卡片数；不超过链上的卡片总数。 */
  readonly count: number
  /** 追加一页。 */
  readonly more: () => void
  /** 确保第 `index` 张卡片已经渲染，供定位条跳到尚未渲染的位置。 */
  readonly showThrough: (index: number) => void
}

/** 一页的渲染窗口：记住它属于哪份列表，以及它渲染到第几张。 */
interface StreamState {
  /** 这份窗口所属列表的代号；与当前列表不同即视为旧窗口。 */
  readonly key: string
  /** 已渲染的卡片数。 */
  readonly count: number
}

/**
 * 按页追加卡片的渲染数量。
 *
 * `resetKey` 变化（换筛选器、切换勘察可见性）时回到第一页：读者不会落在
 * 另一份列表的中段。
 * @param total - 当前列表的卡片总数。
 * @param resetKey - 标识当前列表的键；变化即重置分页。
 * @returns 已渲染数量、追加回调，以及按位置展开的回调。
 */
export function useRenderedCount(total: number, resetKey: string): StreamCount {
  const [state, setState] = useState<StreamState>({ key: resetKey, count: CARD_PAGE })
  // 列表换了就回到第一页：在渲染期归位，而不是用 effect 把状态同步回来。
  if (state.key !== resetKey) setState({ key: resetKey, count: CARD_PAGE })
  const current = state.key === resetKey ? state.count : CARD_PAGE
  const more = useCallback(() => {
    setState(entry => ({ ...entry, count: entry.count + CARD_PAGE }))
  }, [])
  const showThrough = useCallback((index: number) => {
    setState(entry => (entry.count > index ? entry : { ...entry, count: index + 1 }))
  }, [])
  return { count: Math.min(current, total), more, showThrough }
}

/**
 * 把列表末尾的追加控件交给观察者：它进入视口即追加一页。
 *
 * 每次追加后重建观察者，让仍停在视口内的控件继续追加；浏览器不支持
 * IntersectionObserver 时读者仍可点击该控件。
 * @param more - 追加一页的回调。
 * @param page - 已渲染数量的代号；变化即重建观察者。
 * @returns 挂在追加控件上的 ref。
 */
export function useSentinelAppend(more: () => void, page: number): (node: HTMLElement | null) => void {
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (sentinel === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) more()
    }, { root: sentinel.closest('[data-conversation-scroll]') })
    observer.observe(sentinel)
    return () => { observer.disconnect() }
  }, [sentinel, more, page])
  return setSentinel
}
