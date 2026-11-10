/**
 * Presentation vocabulary for the review chain: filter selection, kind labels
 * and palettes, status dots, and the expansion rows one card can offer.
 */

import type {
  ActivitySpan, ChangeOp, ChainCard, ChainKind, ChainStatus, ChainTitle, RiskFlag, RiskReason, RiskSeverity,
} from '@deepseek-ai/dsh-agent-activity'
import type { StateDotState, TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { assertNever } from '@deepseek-ai/dsh-util-values'
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
  /** Workspace path the value names, when the file preview can open it. */
  readonly file?: string | undefined
}

/** One contributing span shown under an expanded card. */
export interface ChainEvidenceSpan {
  /** Session-log position a reader cross-checks in the transcript. */
  readonly seq: number
  /** Raw span name, never translated. */
  readonly name: string
  /** Dot state for the span's settlement. */
  readonly dot: StateDotState
  /** Tool-call identity when this span is a call; absent for turn and step spans. */
  readonly callId?: string | undefined
}

/** Translate one review-chain key, interpolating the placeholders the message declares. */
export type ChainTranslate = (key: AgentChainKey, params?: Record<string, unknown>) => string

/** Dictionary key naming one file operation's card title. */
const CHANGE_TITLE_KEYS: Readonly<Record<ChangeOp, AgentChainKey>> = {
  create: 'title.changeCreate',
  update: 'title.changeUpdate',
  delete: 'title.changeDelete',
}

/**
 * Compose the counted title of one look-around card.
 * @param files - files the merged card opened.
 * @param searches - searches the merged card ran.
 * @param t - review-chain translator.
 * @returns the title naming whichever totals are positive.
 */
function reconText(files: number, searches: number, t: ChainTranslate): string {
  if (files > 0 && searches > 0) return t('title.recon', { files, searches })
  if (files > 0) return t('title.reconFiles', { files })
  if (searches > 0) return t('title.reconSearches', { searches })
  return t('title.reconNone')
}

/**
 * Compose one card's title in the reader's language.
 * @param card - the card to render.
 * @param t - review-chain translator.
 * @returns the title text; an intent card returns the model's own words verbatim.
 */
export function cardTitle(card: ChainCard, t: ChainTranslate): string {
  return titleText(card.title, t)
}

/** Compose the title of one message descriptor. */
function titleText(title: ChainTitle, t: ChainTranslate): string {
  switch (title.copy) {
    case 'intent':
      return title.text
    case 'recon':
      return reconText(title.files, title.searches, t)
    case 'reconCollapsed':
      return t('title.reconCollapsed')
    case 'subagent':
      return t('title.subagent', { name: title.name })
    case 'workflowCompleted':
      return t('title.workflowCompleted', { name: title.name })
    case 'workflowFailed':
      return t('title.workflowFailed', { name: title.name })
    case 'interrupt':
      return t('title.interrupt', { seconds: title.seconds })
    case 'change':
      return t(CHANGE_TITLE_KEYS[title.op], { path: title.path })
    case 'verifyPassed':
      return t('title.verifyPassed', { command: title.command })
    case 'verifyFailed':
      return title.errorCode === undefined
        ? t('title.verifyFailed', { command: title.command })
        : t('title.verifyFailedCode', { command: title.command, code: title.errorCode })
    case 'verifyRun':
      return t('title.verifyRun', { count: title.count })
    case 'result':
      return t('title.result', { files: title.files, verifications: title.verifications })
  }
  /* v8 ignore next -- closed-union backstop; every title variant is handled above. */
  return assertNever(title, 'chain title')
}

/**
 * Compose one risk flag's reason in the reader's language.
 * @param flag - the flag to render.
 * @param t - review-chain translator.
 * @returns the reason text.
 */
export function riskReason(flag: RiskFlag, t: ChainTranslate): string {
  return reasonText(flag.reason, t)
}

/** Compose the reason of one rule finding. */
function reasonText(reason: RiskReason, t: ChainTranslate): string {
  switch (reason.copy) {
    case 'touchesTests':
      return t('risk.touchesTests')
    case 'touchesCi':
      return t('risk.touchesCi')
    case 'deletes':
      return t('risk.deletes', { count: reason.count })
    case 'outOfScope':
      return t('risk.outOfScope')
    case 'unverified':
      return t('risk.unverified')
    case 'gaveUp':
      return t('risk.gaveUp')
    case 'planChurn':
      return t('risk.planChurn', { count: reason.count })
  }
  /* v8 ignore next -- closed-union backstop; every rule finding is handled above. */
  return assertNever(reason, 'risk reason')
}

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
 * Map a span settlement onto the shared state dot.
 * @param status - settlement recorded on the span.
 * @returns dot state; a span stopped before it settled reads as a warning.
 */
export function spanDot(status: ActivitySpan['status']): StateDotState {
  switch (status) {
    case 'running':
      return 'ongoing'
    case 'ok':
      return 'done'
    case 'error':
      return 'error'
    default:
      return 'warning'
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
  if (path !== undefined) rows.push({ label: t('meta.path'), value: path, file: path })
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
 * Read the spans one card cites, in the order its evidence lists them.
 * @param card - the expanded card.
 * @param spans - every span the chain snapshot published.
 * @returns one row per cited sequence the snapshot still holds.
 */
export function evidenceSpans(card: ChainCard, spans: readonly ActivitySpan[]): readonly ChainEvidenceSpan[] {
  const bySeq = new Map(spans.map(span => [span.seq, span]))
  return card.evidenceSeqs.flatMap((seq) => {
    const span = bySeq.get(seq)
    if (span === undefined) return []
    const callId = span.attributes?.callId
    return [{
      seq,
      name: span.name,
      dot: spanDot(span.status),
      callId: typeof callId === 'string' ? callId : undefined,
    }]
  })
}

/**
 * Whether a card has anything to reveal.
 * @param card - the card in the list.
 * @param rows - its expansion facts.
 * @returns true when expansion would show facts or evidence.
 */
export function isExpandable(card: ChainCard, rows: readonly ChainDetailRow[]): boolean {
  return rows.length > 0 || card.evidenceSeqs.length > 0
}
