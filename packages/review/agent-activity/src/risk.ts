/**
 * 针对已投影链路的评审风险规则。
 *
 * @module @deepseek-ai/dsh-agent-activity
 */

import type { ActivitySpan, ChainCard, RiskFlag } from './types.ts'

/** 其调用仅做探查的工具。 */
const READ_TOOLS = new Set(['read', 'grep', 'glob', 'list', 'lsp', 'fs_search', 'web_search', 'web_fetch'])

/** 会执行命令的工具。 */
const EXEC_TOOLS = new Set(['bash', 'exec', 'test', 'build', 'lint', 'run_code'])

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/
const CI_PATH = /^\.github\/|(^|\/)(ci|\.ci)\/|(^|\/)(tsconfig|\.eslintrc|eslint\.config|lint)\b/

const SEVERITY_ORDER = { danger: 0, warn: 1, info: 2 } as const

/** 将一个属性读作字符串；不存在时返回 undefined。 */
function attrString(span: ActivitySpan, key: string): string | undefined {
  const value = span.attributes?.[key]
  return typeof value === 'string' ? value : undefined
}

/** 单次执行跨度的命令文本。 */
function verifyCommand(span: ActivitySpan): string {
  return attrString(span, 'command') ?? span.name
}

/** 该跨度变更的文件路径。 */
function changePath(span: ActivitySpan): string {
  return attrString(span, 'path') ?? attrString(span, 'file') ?? span.name
}

/** 该跨度是否记录了一次删除。 */
function isDeletion(span: ActivitySpan): boolean {
  return attrString(span, 'op') === 'delete' || span.name === 'delete'
}

/** 将变更路径与会话此前已见过的路径（含目录读取）进行比较。 */
function sawEarlier(paths: readonly string[], path: string): boolean {
  return paths.some(known => known === path
    || known.endsWith(`/${path}`)
    || path.endsWith(`/${known}`)
    || path.startsWith(`${known}/`))
}

/**
 * 在一条链路上计算评审风险标记。
 * @param spans - 链路投影所依据的跨度。
 * @param cards - 投影出的卡片，包含结果卡片。
 * @param userText - 用户的任务文本，仅用于范围外启发式判断。
 * @returns 按严重程度排序的标记。
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
