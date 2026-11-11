/**
 * 评审链视图：风险横幅、三个卡片筛选器、勘察卡显隐开关、右侧定位条，
 * 以及评审者无需打开转录即可浏览的可读卡片列表。列表随滚动按页追加渲染。
 * 思考卡片带着它触发的行动子卡，展开后会显示折叠出该卡片的文件和原始 span。
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChainCard } from '@deepseek-ai/dsh-agent-activity'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import {
  DiffBlock, IconChevronDownOutlineRegular, IconChevronLeftOutlineRegular, IconWarningTriangleOutlineRegular,
  Pill, StateDot, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { relativizeToCwd } from '@deepseek-ai/dsh-util-workspace-path'
import type { ChainSnapshot } from './chain-view.ts'
import type { ChainEvidenceSpan, ChainFilter, ChainPathLabel, ChainTranslate } from './chain-copy.ts'
import {
  CHAIN_FILTERS, FILTER_KEYS, KIND_GLYPHS, KIND_KEYS, SEVERITY_KEYS, SEVERITY_TONES,
  actionSummary, cardDiffs, cardTitle, detailRows, diffLabels, evidenceSpans, filterCards, hideReconCards,
  isExpandable, riskReason, statusDot,
} from './chain-copy.ts'
import { locatorBars, scrollToCard, useActiveBar } from './locator.ts'
import type { ChainLocatorBar } from './locator.ts'
import { useRenderedCount, useSentinelAppend } from './stream.ts'
import css from './AgentChainView.module.css'

/** 展开的改动卡片先显示的行数；其余行由卡片自身的折叠控件展开。 */
const DIFF_MAX_LINES = 12

/** 由会话视图 slot 绑定的 props。 */
export interface AgentChainViewProps {
  /** 屏幕上 Session 的身份；卡片路径相对它的工作区根目录展示。 */
  readonly sessionId: SessionId
  /** 框架提供的会话列表读口，用来取得该 Session 的工作区根目录。 */
  readonly useSessions: SnapshotSelectorHook<SessionListState>
  /** 屏幕上 Session 的最新链快照。 */
  readonly useChain: <S>(selector: (snapshot: ChainSnapshot) => S) => S
  /** 翻译一个评审链键。 */
  readonly t: ChainTranslate
  /** 在 Sidebar 预览中打开一个工作区文件。 */
  readonly openFile: (path: string) => void
  /** 在认领该调用焦点的 View 中打开工具调用；没有认领者时为空。 */
  readonly inspectCall: ((callId: string) => void) | undefined
}

/**
 * 一个文件，点击后可在会话旁打开其内容。
 * @param props.path - 记录时的工作区路径，打开文件用它。
 * @param props.label - 相对项目根的展示文本。
 * @param props.openFile - 在 Sidebar 预览中打开文件。
 * @param props.t - 评审链翻译器。
 * @returns 显示相对路径的文件按钮。
 */
function FileButton({ path, label, openFile, t }: {
  path: string
  label: string
  openFile: AgentChainViewProps['openFile']
  t: AgentChainViewProps['t']
}) {
  return (
    <button
      type="button"
      className={css.fileLink}
      aria-label={`${t('card.openFile')} ${label}`}
      title={label === path ? undefined : path}
      onClick={() => { openFile(path) }}
    >
      {label}
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

/** 一行卡片，拥有自己的展开状态；思考卡片的行动子卡在此递归渲染。 */
function ChainCardRow({ card, spans, expanded, onToggle, openFile, inspectCall, label, t }: {
  card: ChainCard
  spans: ChainSnapshot['spans']
  expanded: readonly string[]
  onToggle: (id: string) => void
  openFile: AgentChainViewProps['openFile']
  inspectCall: AgentChainViewProps['inspectCall']
  label: ChainPathLabel
  t: AgentChainViewProps['t']
}) {
  const rows = detailRows(card, t, label)
  const diffs = cardDiffs(card, label)
  const expandable = isExpandable(card, rows)
  const open = expanded.includes(card.id)
  const labels = useMemo(() => diffLabels(t), [t])
  // 折叠的卡片保持低开销：只有展开的卡片才会执行 span 查找。
  const evidence = open ? evidenceSpans(card, spans) : []
  const Glyph = KIND_GLYPHS[card.kind]
  return (
    <li className={css.card} data-kind={card.kind} data-status={card.status} data-card-id={card.id}>
      <div className={css.head}>
        <StateDot state={statusDot(card.status)} />
        <span className={css.kind}>
          <Glyph size={12} />
          {t(KIND_KEYS[card.kind])}
        </span>
        <span className={css.title}>{cardTitle(card, t, label)}</span>
        {card.repeat !== undefined && <span className={css.repeat}>{`×${String(card.repeat)}`}</span>}
        {expandable && (
          <button
            type="button"
            className={css.toggle}
            aria-expanded={open}
            aria-label={t(open ? 'card.collapse' : 'card.expand')}
            onClick={() => { onToggle(card.id) }}
          >
            <IconChevronDownOutlineRegular size={12} className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
          </button>
        )}
      </div>
      {card.actions !== undefined && (
        <div className={css.actions}>{actionSummary(card.actions, t)}</div>
      )}
      {open && expandable && (
        <div className={css.detail}>
          {diffs.length > 0 && (
            <DiffBlock diffs={diffs} labels={labels} maxLines={DIFF_MAX_LINES} className={css.diffBody} />
          )}
          {rows.length > 0 && (
            <dl className={css.meta}>
              {rows.map(row => (
                <Fragment key={row.label}>
                  <dt className={css.metaLabel}>{row.label}</dt>
                  <dd className={css.metaValue}>
                    {row.file === undefined
                      ? row.value
                      : <FileButton path={row.file} label={label(row.file)} openFile={openFile} t={t} />}
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
      {card.children !== undefined && (
        <ol className={css.children}>
          {card.children.map(child => (
            <ChainCardRow
              key={child.id}
              card={child}
              spans={spans}
              expanded={expanded}
              onToggle={onToggle}
              openFile={openFile}
              inspectCall={inspectCall}
              label={label}
              t={t}
            />
          ))}
        </ol>
      )}
    </li>
  )
}

/** 右侧定位条：每张顶层卡片一根横杠，标出当前读到的位置。 */
function ChainLocator({ bars, active, onJump, t }: {
  bars: readonly ChainLocatorBar[]
  active: number | undefined
  onJump: (index: number, id: string) => void
  t: AgentChainViewProps['t']
}) {
  const rail = useRef<HTMLElement | null>(null)
  // 当前横杠滚出定位条时把它带回来，读者始终看得见自己读到哪里。
  useEffect(() => {
    rail.current?.querySelector<HTMLElement>('[data-active]')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <nav ref={rail} className={css.locator} aria-label={t('locator.aria')}>
      {bars.map((bar, index) => (
        <button
          key={bar.id}
          type="button"
          className={css.locatorBar}
          data-kind={bar.kind}
          data-active={index === active ? '' : undefined}
          aria-current={index === active ? 'location' : undefined}
          aria-label={`${t('locator.jump')} ${bar.title}`}
          title={bar.title}
          onClick={() => { onJump(index, bar.id) }}
        />
      ))}
    </nav>
  )
}

/**
 * 渲染评审执行链。
 * @param props - 绑定的快照 hook、翻译器、文件打开器和调用查看器。
 * @returns 左侧风险栏及其可折叠入口、筛选器与勘察显隐按钮、右侧定位条和卡片列表，
 *   或空状态提示。
 */
export function AgentChainView({ sessionId, useSessions, useChain, t, openFile, inspectCall }: AgentChainViewProps) {
  const chain = useChain(snapshot => snapshot)
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  const label = useMemo<ChainPathLabel>(() => path => relativizeToCwd(path, cwd), [cwd])
  const [filter, setFilter] = useState<ChainFilter>('all')
  const [expanded, setExpanded] = useState<readonly string[]>([])
  const [risksOpen, setRisksOpen] = useState(true)
  const [reconHidden, setReconHidden] = useState(false)
  const [list, setList] = useState<HTMLOListElement | null>(null)
  const [jumpTo, setJumpTo] = useState<string | null>(null)
  const cards = useMemo(() => filterCards(hideReconCards(chain.cards, reconHidden), filter), [chain.cards, reconHidden, filter])
  const { count: shown, more, showThrough } = useRenderedCount(cards.length, `${filter}:${String(reconHidden)}`)
  // 代号取自已渲染卡片的标识：换筛选器、换会话或追加一页都会换掉它，观察者随之重建。
  const rowsKey = useMemo(() => cards.slice(0, shown).map(card => card.id).join('|'), [cards, shown])
  const active = useActiveBar(list, rowsKey)
  const sentinel = useSentinelAppend(more, shown)
  const bars = useMemo(() => locatorBars(cards, t, label), [cards, t, label])
  const jump = useCallback((index: number, id: string) => {
    // 目标还没渲染时先把它渲染出来，提交后的 Effect 负责滚动。
    showThrough(index)
    setJumpTo(id)
  }, [showThrough])
  useEffect(() => {
    if (jumpTo !== null && list !== null) {
      scrollToCard(list, jumpTo)
      setJumpTo(null)
    }
  }, [jumpTo, list, shown])
  const toggle = (id: string): void => {
    setExpanded(current => (current.includes(id)
      ? current.filter(entry => entry !== id)
      : [...current, id]))
  }
  if (chain.cards.length === 0) return <p className={css.empty}>{t('empty.waiting')}</p>
  const flags = chain.flags
  return (
    <div className={css.root}>
      <div className={css.board} data-risks={flags.length === 0 ? 'none' : risksOpen ? 'open' : 'closed'}>
        {flags.length > 0 && (!risksOpen
          ? (
            <button
              type="button"
              className={css.risksHandle}
              aria-label={t('banner.show')}
              aria-expanded={false}
              title={t('banner.show')}
              onClick={() => { setRisksOpen(true) }}
            >
              <IconWarningTriangleOutlineRegular size={12} />
              <span className={css.risksHandleCount}>{String(flags.length)}</span>
            </button>
          )
          : (
            <aside className={css.risks} aria-label={t('banner.risks')}>
              <div className={css.risksHead}>
                <IconWarningTriangleOutlineRegular size={12} className={css.risksGlyph} />
                <span className={css.risksTitle}>{t('banner.risks')}</span>
                <span className={css.riskCount}>{String(flags.length)}</span>
                <button
                  type="button"
                  className={css.risksToggle}
                  aria-label={t('banner.hide')}
                  aria-expanded
                  onClick={() => { setRisksOpen(false) }}
                >
                  <IconChevronLeftOutlineRegular size={12} />
                </button>
              </div>
              <ul className={css.riskList}>
                {flags.map(flag => (
                  <li key={flag.code} className={css.riskItem} data-severity={flag.severity}>
                    <Tag tone={SEVERITY_TONES[flag.severity]}>{t(SEVERITY_KEYS[flag.severity])}</Tag>
                    <span className={css.riskReason}>{riskReason(flag, t)}</span>
                    {flag.evidenceFiles.length > 0 && (
                      <span className={css.riskFiles}>
                        {flag.evidenceFiles.map(path => (
                          <FileButton key={path} path={path} label={label(path)} openFile={openFile} t={t} />
                        ))}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </aside>
          ))}
        <div className={css.main}>
          <div className={css.toolbar}>
            <div className={css.filters} role="group" aria-label={t('filter.aria')}>
              {CHAIN_FILTERS.map(value => (
                <Pill key={value} active={filter === value} aria-pressed={filter === value} onClick={() => { setFilter(value) }}>
                  {t(FILTER_KEYS[value])}
                </Pill>
              ))}
            </div>
            <button
              type="button"
              className={css.reconToggle}
              aria-pressed={reconHidden}
              title={t(reconHidden ? 'recon.show' : 'recon.hide')}
              onClick={() => { setReconHidden(hidden => !hidden) }}
            >
              {t(reconHidden ? 'recon.show' : 'recon.hide')}
            </button>
          </div>
          {cards.length === 0
            ? <p className={css.empty}>{t('empty.filtered')}</p>
            : (
              <div className={css.stream} data-locator={bars.length > 1 ? '' : undefined}>
                <div className={css.column}>
                  <ol className={css.cards} ref={setList}>
                    {cards.slice(0, shown).map(card => (
                      <ChainCardRow
                        key={card.id}
                        card={card}
                        spans={chain.spans}
                        expanded={expanded}
                        onToggle={toggle}
                        openFile={openFile}
                        inspectCall={inspectCall}
                        label={label}
                        t={t}
                      />
                    ))}
                  </ol>
                  {shown < cards.length && (
                    <div ref={sentinel} className={css.sentinel}>
                      <button type="button" className={css.moreButton} onClick={more}>
                        {t('stream.more', { shown, total: cards.length })}
                      </button>
                    </div>
                  )}
                </div>
                {bars.length > 1 && (
                  <div className={css.locatorTrack}>
                    <ChainLocator bars={bars} active={active} onJump={jump} t={t} />
                  </div>
                )}
              </div>
            )}
        </div>
      </div>
    </div>
  )
}
