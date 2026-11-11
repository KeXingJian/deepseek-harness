/**
 * 执行链右侧的定位条：把顶层卡片映射成横杠，滚动时标记当前读到的位置，
 * 点击横杠跳回那张卡片。
 */

import { useEffect, useState } from 'react'
import type { ChainCard, ChainKind } from '@deepseek-ai/dsh-agent-activity'
import { cardTitle } from './chain-copy.ts'
import type { ChainPathLabel, ChainTranslate } from './chain-copy.ts'

/** 定位条上的一根横杠。 */
export interface ChainLocatorBar {
  /** 该横杠对应的卡片标识。 */
  readonly id: string
  /** 卡片类别，用于给横杠上色。 */
  readonly kind: ChainKind
  /** 卡片的本地化标题，用于无障碍名称与悬停提示。 */
  readonly title: string
}

/**
 * 把顶层卡片映射成定位条横杠，保持展示顺序。
 * @param cards - 筛选后的顶层卡片。
 * @param t - 评审链翻译器。
 * @param label - 把卡片里的文件路径改写为展示文本。
 * @returns 每张卡片一根横杠。
 */
export function locatorBars(
  cards: readonly ChainCard[],
  t: ChainTranslate,
  label: ChainPathLabel,
): readonly ChainLocatorBar[] {
  return cards.map(card => ({ id: card.id, kind: card.kind, title: cardTitle(card, t, label) }))
}

/**
 * 按系统的减弱动效偏好选择滚动方式。
 * @returns 系统要求减弱动效时为 `auto`，否则为 `smooth`。
 */
export function jumpBehavior(): ScrollBehavior {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth'
}

/**
 * 把定位条指向的卡片滚动到滚动容器上沿。
 * @param list - 承载顶层卡片的列表元素。
 * @param id - 目标卡片标识；它还没渲染时什么也不做。
 */
export function scrollToCard(list: HTMLElement, id: string): void {
  for (const row of list.querySelectorAll<HTMLElement>(':scope > [data-card-id]')) {
    if (row.dataset.cardId !== id) continue
    row.scrollIntoView({ block: 'start', behavior: jumpBehavior() })
    return
  }
}

/** 一次观察结果：它看过的行集合代号，以及阅读带最上方那根横杠的下标。 */
interface ActiveBarObservation {
  /** 观察时的行集合代号；与当前代号不同的读数作废。 */
  readonly key: string
  /** 已渲染卡片中的下标；没有卡片落在阅读带内时为空。 */
  readonly index: number | undefined
}

/**
 * 观察顶层卡片与滚动容器上部阅读带的交叠，返回当前读到的横杠下标。
 *
 * 观察根取最近的会话滚动容器，横杠因此跟随真正的滚动位置；行集合变化
 * （筛选、渐进渲染追加）时重建观察者，读数不会留在旧行上。
 * @param list - 承载顶层卡片的列表元素；挂载前为 null。
 * @param rowsKey - 当前已渲染卡片序列的代号，用于在行集合变化时重建观察者。
 * @returns 落在阅读带最上方的横杠下标；没有卡片落在带内时为 undefined。
 */
export function useActiveBar(list: HTMLElement | null, rowsKey: string): number | undefined {
  const [seen, setSeen] = useState<ActiveBarObservation | null>(null)
  useEffect(() => {
    if (list === null || typeof IntersectionObserver === 'undefined') return
    const rows = [...list.querySelectorAll(':scope > [data-card-id]')]
    const onScreen = new Set<Element>()
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) onScreen.add(entry.target)
        else onScreen.delete(entry.target)
      }
      const found = rows.findIndex(row => onScreen.has(row))
      setSeen({ key: rowsKey, index: found === -1 ? undefined : found })
    }, { root: list.closest('[data-conversation-scroll]'), rootMargin: '0px 0px -70% 0px' })
    for (const row of rows) observer.observe(row)
    return () => { observer.disconnect() }
  }, [list, rowsKey])
  return seen !== null && seen.key === rowsKey ? seen.index : undefined
}
