/**
 * 评审链视图：风险横幅、三个卡片筛选器，以及评审者无需打开转录即可浏览的
 * 可读卡片列表。展开后会显示折叠出该卡片的文件和原始 span。
 */

import { Fragment, useState } from 'react'
import type { ChainCard } from '@deepseek-ai/dsh-agent-activity'
import { IconChevronDownOutlineRegular, Pill, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChainSnapshot } from './chain-view.ts'
import type { ChainEvidenceSpan, ChainFilter, ChainTranslate } from './chain-copy.ts'
import {
  CHAIN_FILTERS, FILTER_KEYS, KIND_KEYS, KIND_TONES, SEVERITY_KEYS, SEVERITY_TONES,
  cardTitle, detailRows, evidenceSpans, filterCards, isExpandable, riskReason, statusDot,
} from './chain-copy.ts'
import css from './AgentChainView.module.css'

/** 由会话视图 slot 绑定的 props。 */
export interface AgentChainViewProps {
  /** 屏幕上 Session 的最新链快照。 */
  readonly useChain: <S>(selector: (snapshot: ChainSnapshot) => S) => S
  /** 翻译一个评审链键。 */
  readonly t: ChainTranslate
  /** 在 Sidebar 预览中打开一个工作区文件。 */
  readonly openFile: (path: string) => void
  /** 在认领该调用焦点的 View 中打开工具调用；没有认领者时为空。 */
  readonly inspectCall: ((callId: string) => void) | undefined
}

/** 一个文件名，点击后可在会话旁打开其内容。 */
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

/** 一个贡献 span；工具调用在运行期间保持其序号。 */
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

/** 一行卡片，拥有自己的展开状态。 */
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
  // 折叠的卡片保持低开销：只有展开的卡片才会执行 span 查找。
  const evidence = open ? evidenceSpans(card, spans) : []
  return (
    <li className={css.card} data-kind={card.kind} data-status={card.status}>
      <div className={css.head}>
        <StateDot state={statusDot(card.status)} />
        <Tag tone={KIND_TONES[card.kind]} className={css.kind}>{t(KIND_KEYS[card.kind])}</Tag>
        <span className={css.title}>{cardTitle(card, t)}</span>
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
 * 渲染评审执行链。
 * @param props - 绑定的快照 hook、翻译器、文件打开器和调用查看器。
 * @returns 链视图、筛选器和风险横幅，或空状态提示。
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
                <span className={css.riskReason}>{riskReason(flag, t)}</span>
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
