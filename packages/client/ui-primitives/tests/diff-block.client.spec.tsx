// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { DEFAULT_DIFF_MAX_LINES, DiffBlock as LocalizedDiffBlock, type DiffHunk } from '../src/index.ts'
import { diffBlockLabels } from './labels.client.ts'
import { diffTotals } from '../src/DiffBlock.tsx'

function DiffBlock(props: Omit<ComponentProps<typeof LocalizedDiffBlock>, 'labels'>) {
  return <LocalizedDiffBlock {...props} labels={diffBlockLabels} />
}

afterEach(cleanup)

beforeEach(() => {
  vi.useRealTimers()
})

function insertCells(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('.diff-code-insert')]
}

function deleteCells(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('.diff-code-delete')]
}

function added(count: number): string {
  return Array.from({ length: count }, (_v, i) => `line ${i + 1}`).join('\n')
}

describe('DiffBlock structure', () => {
  it('renders a create as a path header and an added block (no removed side)', () => {
    const diffs: DiffHunk[] = [{ path: 'notes/new.txt', oldText: null, newText: 'hello\nworld' }]
    const { container } = render(<DiffBlock diffs={diffs} />)
    expect(screen.getByText('notes/new.txt')).toBeTruthy()
    expect(deleteCells(container)).toHaveLength(0)
    expect(insertCells(container).map(cell => cell.textContent)).toEqual(['hello', 'world'])
  })

  it('aligns a replaced line across the old and new columns', () => {
    const diffs: DiffHunk[] = [{ path: 'a.ts', oldText: 'old', newText: 'new' }]
    const { container } = render(<DiffBlock diffs={diffs} />)
    expect(deleteCells(container)).toHaveLength(1)
    expect(insertCells(container)).toHaveLength(1)
    expect(container.querySelector('[data-change-key]')).toBeNull()
  })

  it('opens a same-file second hunk with a gap instead of repeating the path', () => {
    const diffs: DiffHunk[] = [
      { path: 'a.ts', oldText: 'x', newText: 'y' },
      { path: 'a.ts', oldText: 'p', newText: 'q' },
    ]
    const { container } = render(<DiffBlock diffs={diffs} />)
    expect(container.querySelectorAll('[class*="_path_"]')).toHaveLength(1)
    expect(container.querySelectorAll('[class*="_gap_"]')).toHaveLength(1)
  })

  it('opens a new file with its own path header', () => {
    const diffs: DiffHunk[] = [
      { path: 'a.ts', oldText: 'x', newText: 'y' },
      { path: 'b.ts', oldText: 'p', newText: 'q' },
    ]
    const { container } = render(<DiffBlock diffs={diffs} />)
    expect(container.querySelectorAll('[class*="_path_"]')).toHaveLength(2)
    expect(container.querySelectorAll('[class*="_gap_"]')).toHaveLength(0)
  })

  it('renders nothing for empty diffs', () => {
    const { container } = render(<DiffBlock diffs={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('treats a trailing newline as a terminator, not an extra blank line', () => {
    const { container } = render(<DiffBlock diffs={[{ path: 'n.txt', oldText: null, newText: 'hello\n' }]} />)
    expect(insertCells(container).map(cell => cell.textContent)).toEqual(['hello'])
  })

  it('renders a full deletion as removed-only with no phantom added line', () => {
    const { container } = render(<DiffBlock diffs={[{ path: 'gone.ts', oldText: 'a\nb', newText: '' }]} />)
    expect(insertCells(container)).toHaveLength(0)
    expect(deleteCells(container).map(cell => cell.textContent)).toEqual(['a', 'b'])
  })

  it('keeps a genuine interior blank line', () => {
    const { container } = render(<DiffBlock diffs={[{ path: 'a.ts', oldText: null, newText: 'x\n\ny' }]} />)
    expect(insertCells(container)).toHaveLength(3)
  })
})

describe('DiffBlock highlighting', () => {
  it('colors syntax with refractor token spans for a known language', () => {
    const diffs: DiffHunk[] = [{ path: 'a.ts', oldText: 'const x = 1', newText: 'const x = 2' }]
    const { container } = render(<DiffBlock diffs={diffs} />)
    expect(container.querySelectorAll('.token.keyword').length).toBe(2)
  })

  it('marks word-level edits with diff-code-edit spans on both sides', () => {
    const diffs: DiffHunk[] = [{ path: 'a.ts', oldText: 'const x = 1', newText: 'const x = 2' }]
    const { container } = render(<DiffBlock diffs={diffs} />)
    expect(container.querySelectorAll('.diff-code-edit')).toHaveLength(2)
  })

  it('falls back to plain text for an unregistered language without throwing', () => {
    const diffs: DiffHunk[] = [{ path: 'a.zzz', oldText: 'before', newText: 'after' }]
    const { container } = render(<DiffBlock diffs={diffs} />)
    expect(deleteCells(container)).toHaveLength(1)
    expect(insertCells(container)).toHaveLength(1)
    expect(container.querySelector('.token')).toBeNull()
  })
})

describe('DiffBlock totals and copy', () => {
  it.each([128, 129])('renders and counts %i replacements with bounded comparison', async (count) => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const oldLines = ['shared context', ...Array.from({ length: count }, (_, i) => `old ${i}`)]
    const newLines = ['shared context', ...Array.from({ length: count }, (_, i) => `new ${i}`)]
    const diffs = [{ path: 'large.txt', oldText: oldLines.join('\n'), newText: newLines.join('\n') }]
    const total = count === 128 ? count : count + 1
    render(<DiffBlock diffs={diffs} maxLines={1000} />)
    expect(diffTotals(diffs)).toEqual({ added: total, removed: total })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制' })) })
    expect(writeText).toHaveBeenCalledWith(count === 128
      ? ['large.txt', '  shared context', ...oldLines.slice(1).map(line => `- ${line}`), ...newLines.slice(1).map(line => `+ ${line}`)].join('\n')
      : ['large.txt', ...oldLines.map(line => `- ${line}`), ...newLines.map(line => `+ ${line}`)].join('\n'))
  })

  it('counts a sparse edit in a ten-thousand-line fragment and collapses it', () => {
    const before = Array.from({ length: 10000 }, (_, i) => `line ${i}`)
    const after = [...before]
    after[5000] = 'changed'
    const diffs = [{ path: 'sparse.txt', oldText: before.join('\n'), newText: after.join('\n') }]
    const { container } = render(<DiffBlock diffs={diffs} />)
    expect(diffTotals(diffs)).toEqual({ added: 1, removed: 1 })
    // The default cap folds the middle: far fewer than 10000 rows render.
    expect(container.querySelectorAll('.diff-line').length).toBeLessThan(100)
  })

  it('copies shared context once and counts only a changed line', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const diffs = [{ path: 'settings.ts', oldText: 'start\nmode = 1\nend', newText: 'start\nmode = 2\nend' }]
    render(<DiffBlock diffs={diffs} />)
    expect(screen.getAllByText('start')).toHaveLength(1)
    expect(screen.getAllByText('end')).toHaveLength(1)
    expect(diffTotals(diffs)).toEqual({ added: 1, removed: 1 })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制' })) })
    expect(writeText).toHaveBeenCalledWith('settings.ts\n  start\n- mode = 1\n+ mode = 2\n  end')
  })

  it.each([
    ['a\nx\na\ny\na', 'a\nx\na\nz\na', 1, 1],
    ['a\nb', 'a\nx\nb', 1, 0],
    ['a\nx\nb', 'a\nb', 0, 1],
    ['same\n', 'same', 0, 0],
    ['same', 'same', 0, 0],
    ['', '', 0, 0],
    ['a\n\nb', 'a\nb', 0, 1],
  ])('counts ordered changes in %j → %j', (oldText, newText, addedCount, removedCount) => {
    const diffs = [{ path: 'a.txt', oldText, newText }]
    const { container } = render(<DiffBlock diffs={diffs} />)
    expect(diffTotals(diffs)).toEqual({ added: addedCount, removed: removedCount })
    expect(insertCells(container)).toHaveLength(addedCount)
    expect(deleteCells(container)).toHaveLength(removedCount)
  })
})

describe('DiffBlock height cap', () => {
  it('shows head and tail with an expand control past the cap, then all lines expanded', () => {
    const diffs: DiffHunk[] = [{ path: 'a.ts', oldText: null, newText: added(DEFAULT_DIFF_MAX_LINES + 4) }]
    const { container } = render(<DiffBlock diffs={diffs} />)
    const toggle = screen.getByRole('button', { name: /展开其余/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(insertCells(container)).toHaveLength(DEFAULT_DIFF_MAX_LINES)
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: '收起差异' }).getAttribute('aria-expanded')).toBe('true')
    expect(insertCells(container)).toHaveLength(DEFAULT_DIFF_MAX_LINES + 4)
  })

  it('shows no expand control at or under the cap', () => {
    const diffs: DiffHunk[] = [{ path: 'a.ts', oldText: null, newText: added(4) }]
    render(<DiffBlock diffs={diffs} maxLines={16} />)
    expect(screen.queryByRole('button', { name: /展开其余|收起差异/ })).toBeNull()
  })
})

describe('DiffBlock copy', () => {
  it('copies the prefixed diff text and flips the label on success', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const diffs: DiffHunk[] = [
      { path: 'a.ts', oldText: 'old', newText: 'new' },
      { path: 'a.ts', oldText: 'p', newText: 'q' },
    ]
    render(<DiffBlock diffs={diffs} />)
    const copy = screen.getByRole('button', { name: '复制' })
    await act(async () => { fireEvent.click(copy) })
    expect(writeText).toHaveBeenCalledWith('a.ts\n- old\n+ new\n⋯\n- p\n+ q')
    expect(screen.getByRole('button', { name: '复制成功' })).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('keeps the label on a refused clipboard write', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    render(<DiffBlock diffs={[{ path: 'a.ts', oldText: null, newText: 'x' }]} />)
    const copy = screen.getByRole('button', { name: '复制' })
    await act(async () => { fireEvent.click(copy) })
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('ignores a second click while the copied label is showing', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<DiffBlock diffs={[{ path: 'a.ts', oldText: null, newText: 'x' }]} />)
    const copy = screen.getByRole('button', { name: '复制' })
    await act(async () => { fireEvent.click(copy) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制成功' })) })
    expect(writeText).toHaveBeenCalledTimes(1)
  })
})
