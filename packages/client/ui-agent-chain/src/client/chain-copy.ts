/**
 * Presentation vocabulary for the review chain: filter selection, kind labels
 * and palettes, status dots, and the expansion rows one card can offer.
 */

import type { ChainCard, ChainKind, ChainStatus, RiskSeverity } from '@deepseek-ai/dsh-agent-activity'
import type { StateDotState, TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentChainKey } from './locales.ts'

/** Which cards the reader asked to see. */
export type ChainFilter = 'all' | 'changes' | 'risks'

/** Filter buttons in display order. */
export const CHAIN_FILTERS: readonly ChainFilter[] = ['all', 'changes', 'risks']

/** Dictionary key naming one filter. */
export const FILTER_KEYS: Readonly<Record<ChainFilter, AgentChainKey>> = {
  all: 'filter.all',
  changes: 'filter.changes',
  risks: 'filter.risks',
}

/** Dictionary key naming one card kind. */
export const KIND_KEYS: Readonly<Record<ChainKind, AgentChainKey>> = {
  intent: 'kind.intent',
  recon: 'kind.recon',
  change: 'kind.change',
  verify: 'kind.verify',
  interrupt: 'kind.interrupt',
  result: 'kind.result',
}

/** Tag palette of one card kind; failures and warnings stay on the status dot. */
export const KIND_TONES: Readonly<Record<ChainKind, TagTone>> = {
  intent: 'info',
  recon: 'quiet',
  change: 'neutral',
  verify: 'outline',
  interrupt: 'warning',
  result: 'outline',
}

/** Tag palette of one risk severity. */
export const SEVERITY_TONES: Readonly<Record<RiskSeverity, TagTone>> = {
  danger: 'danger',
  warn: 'warning',
  info: 'info',
}

/** Dictionary key naming one risk severity. */
export const SEVERITY_KEYS: Readonly<Record<RiskSeverity, AgentChainKey>> = {
  danger: 'severity.danger',
  warn: 'severity.warn',
  info: 'severity.info',
}

/** Dictionary key naming one change operation the projection records. */
const OP_KEYS: Readonly<Record<string, AgentChainKey>> = {
  create: 'op.create',
  update: 'op.update',
  delete: 'op.delete',
}

/** One labeled fact shown when a card is expanded. */
export interface ChainDetailRow {
  /** Localized field name. */
  readonly label: string
  /** Field value as recorded; never translated. */
  readonly value: string
}

/** Translate one review-chain key. */
export type ChainTranslate = (key: AgentChainKey) => string

/**
 * Map a card status onto the shared state dot.
 * @param status - card status from the projection.
 * @returns dot state; `ok` reads as done and `running` as an ongoing loader.
 */
export function statusDot(state: ChainStatus | undefined): StateDotState {
  switch (state) {
    case 'error':
      return 'error'
    case 'warning':
      return 'warning'
    case 'running':
      return 'ongoing'
    default:
      return 'done'
  }
}

/**
 * Keep the cards one filter admits.
 * @param cards - chain cards in display order.
 * @param filter - selected filter.
 * @returns matching cards; `all` keeps the input array.
 */
export function filterCards(cards: readonly ChainCard[], filter: ChainFilter): readonly ChainCard[] {
  switch (filter) {
    case 'changes':
      return cards.filter(card => card.kind === 'change')
    case 'risks':
      return cards.filter(card => card.status === 'error' || card.status === 'warning')
    default:
      return cards
  }
}

/**
 * Read one recorded fact as a string.
 * @param meta - card facts.
 * @param key - fact name.
 * @returns the value, or undefined when absent or not a string.
 */
function metaString(meta: ChainCard['meta'], key: string): string | undefined {
  const value = meta?.[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Read one recorded fact as a positive count.
 * @param meta - card facts.
 * @param key - fact name.
 * @returns the count as text, or undefined when absent, not a number, or not positive.
 */
function metaCount(meta: ChainCard['meta'], key: string): string | undefined {
  const value = meta?.[key]
  return typeof value === 'number' && value > 0 ? String(value) : undefined
}

/**
 * Build the labeled facts one expanded card shows.
 *
 * `path`, `command`, and `tool` repeat what the title already states for some
 * kinds, but a reader expanding a card is checking the record, not skimming it.
 * @param card - the card being expanded.
 * @param t - review-chain translator.
 * @returns rows in a stable field order; empty when the card records nothing.
 */
export function detailRows(card: ChainCard, t: ChainTranslate): readonly ChainDetailRow[] {
  const rows: ChainDetailRow[] = []
  const path = metaString(card.meta, 'path')
  if (path !== undefined) rows.push({ label: t('meta.path'), value: path })
  const command = metaString(card.meta, 'command')
  if (command !== undefined) rows.push({ label: t('meta.command'), value: command })
  const tool = metaString(card.meta, 'tool')
  if (tool !== undefined) rows.push({ label: t('meta.tool'), value: tool })
  const op = metaString(card.meta, 'op')
  if (op !== undefined) {
    const key = OP_KEYS[op]
    rows.push({ label: t('meta.op'), value: key === undefined ? op : t(key) })
  }
  const files = metaCount(card.meta, 'files')
  if (files !== undefined) rows.push({ label: t('meta.files'), value: files })
  const searches = metaCount(card.meta, 'searches')
  if (searches !== undefined) rows.push({ label: t('meta.searches'), value: searches })
  return rows
}

/**
 * Whether a card has anything to reveal.
 * @param card - the card in the list.
 * @param rows - its expansion facts.
 * @returns true when expansion would show text, facts, or evidence.
 */
export function isExpandable(card: ChainCard, rows: readonly ChainDetailRow[]): boolean {
  return card.detail !== undefined || rows.length > 0 || card.evidenceSeqs.length > 0
}
