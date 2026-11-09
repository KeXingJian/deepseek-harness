/**
 * Review chain view: the risk banner, the three card filters, and the
 * readable card list a reviewer scans without opening the transcript.
 * Expansion reveals the files and raw spans a card was folded from.
 */

import { Fragment, useState } from 'react'
import type { ChainCard } from '@deepseek-ai/dsh-agent-activity'
import { IconChevronDownOutlineRegular, Pill, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChainSnapshot } from './chain-view.ts'
import type { ChainEvidenceSpan, ChainFilter } from './chain-copy.ts'
import {
  CHAIN_FILTERS, FILTER_KEYS, KIND_KEYS, KIND_TONES, SEVERITY_KEYS, SEVERITY_TONES,
  detailRows, evidenceSpans, filterCards, isExpandable, statusDot,
} from './chain-copy.ts'
import type { AgentChainKey } from './locales.ts'
import css from './AgentChainView.module.css'

/** Props bound by the conversation view slot. */
export interface AgentChainViewProps {
  /** Latest chain snapshot for the Session on screen. */
  readonly useChain: <S>(selector: (snapshot: ChainSnapshot) => S) => S
  /** Translate one review-chain key. */
  readonly t: (key: AgentChainKey) => string
  /** Open one workspace file in the Sidebar preview. */
  readonly openFile: (path: string) => void
  /** Open a tool call in the View that claims call focus; absent when none does. */
  readonly inspectCall: ((callId: string) => void) | undefined
}

/** One file name that opens its content beside the conversation. */
function FileButton({ path, openFile, t }: {
  path: string
  openFile: AgentChainViewProps['openFile']
  t: AgentChainViewProps['t']
}) {
  return (
    <button
      type="button"
      className={css.fileLink}
      aria-label={`${t('card.openFile')} ${path}`}
      onClick={() => { openFile(path) }}
    >
      {path}
    </button>
  )
}

/** One contributing span; a tool call keeps its sequence while it runs. */
function EvidenceRow({ span, inspectCall, t }: {
  span: ChainEvidenceSpan
  inspectCall: AgentChainViewProps['inspectCall']
  t: AgentChainViewProps['t']
}) {
  const seq = `#${String(span.seq)}`
  const content = (
    <>
      <StateDot state={span.dot} />
      <span className={css.evidenceSeq}>{seq}</span>
      <span className={css.evidenceName}>{span.name}</span>
    </>
  )
  const callId = span.callId
  if (callId === undefined || inspectCall === undefined) {
    return <li className={css.evidenceRow}>{content}</li>
  }
  return (
    <li className={css.evidenceRow}>
      <button
        type="button"
        className={css.evidenceButton}
        aria-label={`${t('card.openEvent')} ${seq}`}
        onClick={() => { inspectCall(callId) }}
      >
        {content}
      </button>
    </li>
  )
}

/** One card row with its own disclosure state. */
function ChainCardRow({ card, spans, open, onToggle, openFile, inspectCall, t }: {
  card: ChainCard
  spans: ChainSnapshot['spans']
  open: boolean
  onToggle: () => void
  openFile: AgentChainViewProps['openFile']
  inspectCall: AgentChainViewProps['inspectCall']
  t: AgentChainViewProps['t']
}) {
  const rows = detailRows(card, t)
  const expandable = isExpandable(card, rows)
  // Collapsed cards stay cheap: the span lookup runs only for a revealed card.
  const evidence = open ? evidenceSpans(card, spans) : []
  return (
    <li className={css.card} data-kind={card.kind} data-status={card.status}>
      <div className={css.head}>
        <StateDot state={statusDot(card.status)} />
        <Tag tone={KIND_TONES[card.kind]} className={css.kind}>{t(KIND_KEYS[card.kind])}</Tag>
        <span className={css.title}>{card.title}</span>
        {card.repeat !== undefined && <span className={css.repeat}>{`×${String(card.repeat)}`}</span>}
        {expandable && (
          <button
            type="button"
            className={css.toggle}
            aria-expanded={open}
            aria-label={t(open ? 'card.collapse' : 'card.expand')}
            onClick={onToggle}
          >
            <IconChevronDownOutlineRegular size={12} className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
          </button>
        )}
      </div>
      {open && expandable && (
        <div className={css.detail}>
          {card.detail !== undefined && <p className={css.detailText}>{card.detail}</p>}
          {rows.length > 0 && (
            <dl className={css.meta}>
              {rows.map(row => (
                <Fragment key={row.label}>
                  <dt className={css.metaLabel}>{row.label}</dt>
                  <dd className={css.metaValue}>
                    {row.file === undefined
                      ? row.value
                      : <FileButton path={row.file} openFile={openFile} t={t} />}
                  </dd>
                </Fragment>
              ))}
            </dl>
          )}
          {evidence.length > 0 && (
            <div className={css.evidence}>
              <span className={css.metaLabel}>{t('card.evidence')}</span>
              <ul className={css.evidenceList}>
                {evidence.map(span => (
                  <EvidenceRow key={span.seq} span={span} inspectCall={inspectCall} t={t} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * Render the review execution chain.
 * @param props - bound snapshot hook, translator, file opener, and call inspector.
 * @returns the chain view, filters, and risk banner, or the empty-state line.
 */
export function AgentChainView({ useChain, t, openFile, inspectCall }: AgentChainViewProps) {
  const chain = useChain(snapshot => snapshot)
  const [filter, setFilter] = useState<ChainFilter>('all')
  const [expanded, setExpanded] = useState<readonly string[]>([])
  if (chain.cards.length === 0) return <p className={css.empty}>{t('empty.waiting')}</p>
  const cards = filterCards(chain.cards, filter)
  const toggle = (id: string): void => {
    setExpanded(current => (current.includes(id)
      ? current.filter(entry => entry !== id)
      : [...current, id]))
  }
  return (
    <div className={css.root}>
      {chain.flags.length > 0 && (
        <section className={css.risks} aria-label={t('banner.risks')}>
          <div className={css.risksHead}>{t('banner.risks')}</div>
          <ul className={css.riskList}>
            {chain.flags.map(flag => (
              <li key={flag.code} className={css.riskItem}>
                <Tag tone={SEVERITY_TONES[flag.severity]}>{t(SEVERITY_KEYS[flag.severity])}</Tag>
                <span className={css.riskReason}>{flag.reason}</span>
                {flag.evidenceFiles.length > 0 && (
                  <span className={css.riskFiles}>
                    {flag.evidenceFiles.map(path => (
                      <FileButton key={path} path={path} openFile={openFile} t={t} />
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className={css.filters} role="group" aria-label={t('filter.aria')}>
        {CHAIN_FILTERS.map(value => (
          <Pill key={value} active={filter === value} aria-pressed={filter === value} onClick={() => { setFilter(value) }}>
            {t(FILTER_KEYS[value])}
          </Pill>
        ))}
      </div>
      {cards.length === 0
        ? <p className={css.empty}>{t('empty.filtered')}</p>
        : (
          <ol className={css.cards}>
            {cards.map(card => (
              <ChainCardRow
                key={card.id}
                card={card}
                spans={chain.spans}
                open={expanded.includes(card.id)}
                onToggle={() => { toggle(card.id) }}
                openFile={openFile}
                inspectCall={inspectCall}
                t={t}
              />
            ))}
          </ol>
        )}
    </div>
  )
}
