/**
 * The review-chain plugin's Node half: the browser carries the projection, so
 * the Host entry activates without registering anything.
 */
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('node half', () => {
  it('activates without side effects', () => {
    expect(() => { apply() }).not.toThrow()
  })
})
