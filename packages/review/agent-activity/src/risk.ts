/**
 * Review risk rules over a projected chain.
 *
 * @module @deepseek-ai/dsh-agent-activity
 */

import type { ActivitySpan, ChainCard, RiskFlag } from './types.ts'

/** Tools whose calls only look around. */
const READ_TOOLS = new Set(['read', 'grep', 'glob', 'list', 'lsp', 'fs_search', 'web_search', 'web_fetch'])

/** Tools that execute a command. */
const EXEC_TOOLS = new Set(['bash', 'exec', 'test', 'build', 'lint', 'run_code'])

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/
const CI_PATH = /^\.github\/|(^|\/)(ci|\.ci)\/|(^|\/)(tsconfig|\.eslintrc|eslint\.config|lint)\b/

const SEVERITY_ORDER = { danger: 0, warn: 1, info: 2 } as const

/** Read one attribute as a string, or undefined. */
function attrString(span: ActivitySpan, key: string): string | undefined {
  const value = span.attributes?.[key]
  return typeof value === 'string' ? value : undefined
}

/** Command text of one execution span. */
function verifyCommand(span: ActivitySpan): string {
  return attrString(span, 'command') ?? span.name
}

/** File path a span changed. */
function changePath(span: ActivitySpan): string {
  return attrString(span, 'path') ?? attrString(span, 'file') ?? span.name
}

/** Whether one span records a deletion. */
function isDeletion(span: ActivitySpan): boolean {
  return attrString(span, 'op') === 'delete' || span.name === 'delete'
}

/** Compare a changed path with paths the session already saw, including directory reads. */
function sawEarlier(paths: readonly string[], path: string): boolean {
  return paths.some(known => known === path
    || known.endsWith(`/${path}`)
    || path.endsWith(`/${known}`)
    || path.startsWith(`${known}/`))
}

/**
 * Compute review risk flags over a chain.
 * @param spans - the spans the chain was projected from.
 * @param cards - the projected cards, including the result card.
 * @param userText - the user's task text, used only by the out-of-scope heuristic.
 * @returns flags ordered by severity.
 */
export function reviewFlags(
  spans: readonly ActivitySpan[],
  cards: readonly ChainCard[],
  userText: string,
): RiskFlag[] {
  const changes = cards.filter(card => card.kind === 'change')
  const files = changes.map(card => String(card.meta?.path ?? ''))
  const flags: RiskFlag[] = []

  const tests = files.filter(path => TEST_PATH.test(path))
  if (tests.length > 0) {
    flags.push({ code: 'touches-tests', severity: 'warn', reason: { copy: 'touchesTests' }, evidenceFiles: tests })
  }

  const ci = files.filter(path => CI_PATH.test(path))
  if (ci.length > 0) {
    flags.push({ code: 'touches-ci', severity: 'warn', reason: { copy: 'touchesCi' }, evidenceFiles: ci })
  }

  const deleted = spans.filter(span => span.kind === 'tool' && isDeletion(span)).map(span => changePath(span))
  if (deleted.length > 0) {
    flags.push({
      code: 'deletes',
      severity: 'danger',
      reason: { copy: 'deletes', count: deleted.length },
      evidenceFiles: deleted,
    })
  }

  const seen = spans
    .filter(span => span.kind === 'tool' && READ_TOOLS.has(span.name))
    .map(span => attrString(span, 'path'))
    .filter((path): path is string => path !== undefined)
  const suspected = changes
    .filter(card => String(card.meta?.op ?? 'update') === 'update')
    .map(card => String(card.meta?.path ?? ''))
    .filter(path => path !== '' && !sawEarlier(seen, path) && !userText.includes(path))
  if (suspected.length > 0) {
    flags.push({
      code: 'out-of-scope',
      severity: 'info',
      reason: { copy: 'outOfScope' },
      evidenceFiles: suspected,
    })
  }

  const verified = cards.some(card => card.kind === 'verify' && card.status === 'ok')
  if (changes.length > 0 && !verified) {
    flags.push({
      code: 'unverified',
      severity: 'danger',
      reason: { copy: 'unverified' },
      evidenceFiles: files.filter(path => path !== ''),
    })
  }

  const failures = new Map<string, number>()
  for (const span of spans) {
    if (span.kind !== 'tool' || !EXEC_TOOLS.has(span.name) || span.status !== 'error') continue
    const command = verifyCommand(span)
    failures.set(command, (failures.get(command) ?? 0) + 1)
  }
  if ([...failures.values()].some(count => count >= 2) && changes.length > 0) {
    flags.push({
      code: 'gave-up',
      severity: 'warn',
      reason: { copy: 'gaveUp' },
      evidenceFiles: [...failures.keys()],
    })
  }

  const intents = cards.filter(card => card.kind === 'intent').length
  if (intents >= 5) {
    flags.push({
      code: 'plan-churn',
      severity: 'info',
      reason: { copy: 'planChurn', count: intents },
      evidenceFiles: [],
    })
  }

  return flags.sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity])
}
