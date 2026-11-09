/**
 * Review chain view: the risk banner, the three card filters, and the
 * readable card list a reviewer scans without opening the transcript.
 */

import { Fragment, useState } from 'react'
import type { ChainCard } from '@deepseek-ai/dsh-agent-activity'
import { IconChevronDownOutlineRegular, Pill, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChainSnapshot } from './chain-view.ts'
import type { ChainFilter } from './chain-copy.ts'
import {
  CHAIN_FILTERS, FILTER_KEYS, KIND_KEYS, KIND_TONES, SEVERITY_KEYS, SEVERITY_TONES,
  detailRows, filterCards, isExpandable, statusDot,
} from './chain-copy.ts'
import type { AgentChainKey } from './locales.ts'
import css from './AgentChainView.module.css'

/** Props bound by the conversation view slot. */
export interface AgentChainViewProps {
  /** Latest chain snapshot for the Session on screen. */
  readonly useChain: <S>(selector: (snapshot: ChainSnapshot) => S) => S
  /** Translate one review-chain key. */
  readonly t: (key: AgentChainKey) => string
}

/** One card row with its own disclosure state. */
function ChainCardRow({ card, open, onToggle, t }: {
  card: ChainCard
  open: boolean
  onToggle: () => void
  t: AgentChainViewProps['t']
}) {
  const rows = detailRows(card, t)
  const expandable = isExpandable(card, rows)
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
                  <dd className={css.metaValue}>{row.value}</dd>
                </Fragment>
              ))}
            </dl>
          )}
          {card.evidenceSeqs.length > 0 && (
            <p className={css.evidence}>
              <span className={css.metaLabel}>{t('card.evidence')}</span>
              <span>{card.evidenceSeqs.map(seq => `#${String(seq)}`).join(' · ')}</span>
            </p>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * Render the review execution chain.
 * @param props - bound snapshot hook and translator.
 * @returns the chain view, filters, and risk banner, or the empty-state line.
 */
export function AgentChainView({ useChain, t }: AgentChainViewProps) {
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
                {flag.evidenceFiles.length > 0 && <span className={css.riskFiles}>{flag.evidenceFiles.join(' · ')}</span>}
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
                open={expanded.includes(card.id)}
                onToggle={() => { toggle(card.id) }}
                t={t}
              />
            ))}
          </ol>
        )}
    </div>
  )
}
