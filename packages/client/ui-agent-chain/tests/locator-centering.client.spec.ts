/**
 * Review-chain locator rail: the rail keeps its centre on the band the reader
 * sees while the cards scroll, reach the list end, and grow by a page.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/AgentChainView.module.css', import.meta.url)),
  'utf8',
)

/** The declaration block of one rule, from its selector to its closing brace. */
function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start, `${selector} rule`).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start) + 1)
}

describe('Locator rail centering', () => {
  it('anchors the rail on a zero-height sticky point at the band centre', () => {
    // A sticky element never passes its containing block's bottom edge, so a
    // tall rail pinned to the band centre slid off it as the list end came into
    // view and while an appended page grew the block. The zero-height anchor
    // makes the rail absolute around a point that has no bottom edge to hit.
    expect(rule('.locatorTrack')).toMatch(/position:\s*sticky/)
    expect(rule('.locatorTrack')).toMatch(/top:\s*calc\(var\(--chain-band\) \/ 2\)/)
    expect(rule('.locatorTrack')).toMatch(/height:\s*0/)
    const rail = rule('.locator')
    expect(rail).toMatch(/position:\s*absolute/)
    expect(rail).toMatch(/transform:\s*translateY\(-50%\)/)
    expect(rail).not.toMatch(/position:\s*sticky/)
  })

  it('gives the anchor room to reach the centre when the chain is short', () => {
    // Card rows alone can be shorter than half the band, which is the farthest
    // the anchor's own row can place it; the grid area carries that height.
    expect(rule('.stream[data-locator]')).toMatch(/min-height:\s*max\(0px, calc\(var\(--chain-band\) \/ 2\)\)/)
  })

  it('derives the band from the published scrollport and composer heights', () => {
    const root = rule('.root')
    expect(root).toMatch(
      /--chain-band:\s*calc\(\s*var\(--dsh-conversation-viewport-height, 100dvh\) - var\(--dsh-composer-height, 152px\)\s*\)/,
    )
    expect(root).toMatch(/--chain-gap:\s*8px/)
  })
})
