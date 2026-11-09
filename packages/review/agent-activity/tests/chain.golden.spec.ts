import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { chainFromSpans } from '../src/index.ts'
import type { ActivitySpan, ChainCard, RiskFlag } from '../src/index.ts'

/** One recorded review case: spans in, cards and flags out. */
interface GoldenCase {
  readonly name: string
  readonly spans: readonly ActivitySpan[]
  readonly expected: {
    readonly cards: ReadonlyArray<{
      readonly id: string
      readonly kind: string
      readonly title: string
      readonly status: string
      readonly evidenceSeqs: readonly number[]
      readonly repeat?: number
    }>
    readonly flags: readonly RiskFlag[]
  }
}

const GOLDEN_FILES = ['01-bugfix', '02-test-first-feature', '03-risky-shortcut'] as const

/** Load one recorded case from the fixture directory. */
function load(name: string): GoldenCase {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as GoldenCase
}

/** Keep only the fields a golden case states. */
function observe(card: ChainCard): Record<string, unknown> {
  return {
    id: card.id,
    kind: card.kind,
    title: card.title,
    status: card.status,
    evidenceSeqs: [...card.evidenceSeqs],
    ...(card.repeat === undefined ? {} : { repeat: card.repeat }),
  }
}

describe('execution chain goldens', () => {
  for (const name of GOLDEN_FILES) {
    it(`projects ${name}`, () => {
      const golden = load(name)
      const result = chainFromSpans(golden.spans)
      expect(result.cards.map(observe)).toEqual(golden.expected.cards)
      expect(result.flags).toEqual(golden.expected.flags)
    })
  }
})
