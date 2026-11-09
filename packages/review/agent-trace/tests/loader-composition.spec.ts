/**
 * REAL-composition proof: the shipped YAML shape (Session store, the storage
 * stack, and `agent-trace`) boots through the vendored Loader, the service
 * class keeps its default export, and one logged turn produces a stored
 * summary the service serves without a query service.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import * as AgentTracePlugin from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot one Loader composition from YAML lines over the in-process module table. */
async function loadYaml(lines: (base: string) => readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-agent-trace-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines(root), ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-agent-trace', AgentTracePlugin],
  ])
  // The in-process module table replaces the Node loader hook this spec does
  // not need; defineProperty keeps the partial face out of the public type.
  Object.defineProperty(context.loader, 'internal', {
    configurable: true,
    writable: true,
    value: {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    },
  })
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('real Loader composition', () => {
  it('loads the shipped storage + agent-trace YAML shape and stores a summary', async () => {
    const loaded = await loadYaml(base => [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-storage'",
      "- name: '@deepseek-ai/dsh-storage-json'",
      '  config:',
      `    root: ${JSON.stringify(join(base, 'storages'))}`,
      "- name: '@deepseek-ai/dsh-storage-domain'",
      '  config:',
      '    backend: json',
      "- name: '@deepseek-ai/dsh-agent-trace'",
      '  config:',
      '    flushEveryEvents: 200',
      '    flushIntervalMs: 5000',
      '    retentionDays: 30',
      '    maxRecords: 100',
    ])

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const id = SessionId('composed')
    const session = loaded.sessions.create(id)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'bash', arguments: '{}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: ToolCallId('call-1'), content: [], isError: false }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await vi.waitFor(async () => {
      const summary = await loaded.agentTrace.sessionSummary(id)
      expect(summary).toMatchObject({ traceVersion: 1, asOfSeq: 5 })
      expect(summary?.summary.spansByKind).toMatchObject({ turn: 1, step: 1, tool: 1 })
    })
    await vi.waitFor(async () => {
      const document = JSON.parse(await readFile(join(root ?? '', 'storages', 'agent_trace', 'sessions', 'composed.json'), 'utf8')) as {
        record: { asOfSeq: number }
      }
      expect(document.record.asOfSeq).toBe(5)
    })
  })

  it('keeps the service class as the module default export', () => {
    // A function plugin beside a default export loses its namespace; a Service
    // package ships the class as the default plugin value and nothing named
    // `apply`.
    expect(typeof AgentTracePlugin.default).toBe('function')
    expect('apply' in AgentTracePlugin).toBe(false)
  })
})
