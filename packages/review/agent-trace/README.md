---
description: "Agent activity trace collection (ctx.agentTrace): incremental span counters persisted on a bounded storage domain, with sessionQuery backfill and no UI or model surface."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-trace

English | [中文](README.zh.md)

## Summary

This package is the collection layer behind the review execution chain: it folds a Session's committed events into activity spans, keeps whole-log counters incrementally, and persists a small bounded summary per Session on the `agent_trace` storage domain. `ctx.agentTrace` exposes `sessionSummary(sessionId)` and `sessionTrace(sessionId)` for a future full-trace view; the readable chain itself keeps folding events in the browser, so this package adds no UI, tool, prompt, or Session event. Collection is silent and fail-soft: a lost summary costs one recompute, never an interruption.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin beside the Session store and the storage stack. `sessionQuery` is optional: with it the service folds a cold or restored Session on demand; without it a cold read can only serve the stored summary.

### Configuration

Every field is a deployment choice, so the composition states it explicitly:

```yaml
- id: agent-trace
  name: '@deepseek-ai/dsh-agent-trace'
  config:
    flushEveryEvents: 200
    flushIntervalMs: 5000
    retentionDays: 30
    maxRecords: 500
```

| Field | Meaning |
|---|---|
| `flushEveryEvents` | Recorded events per Session that force a summary write between mandatory points |
| `flushIntervalMs` | Longest time a dirty summary may stay unwritten between mandatory points |
| `retentionDays` | Age after which a stored summary is pruned |
| `maxRecords` | Stored summaries kept; the oldest are pruned beyond this count |

### Reading values

`sessionSummary(sessionId)` answers from the live incremental fold for a live Session, otherwise from the stored record. `sessionTrace(sessionId)` returns the folded spans; for a Session that is not live it reads the complete log through `sessionQuery` and refreshes the stored summary as a side effect. Both return `undefined` when the Session is neither live nor readable.

```ts
const summary = await ctx.agentTrace.sessionSummary(sessionId)
const spans = await ctx.agentTrace.sessionTrace(sessionId)
```

The summary reports opening counts, current settlements (`running` counts spans still open), and settled wall time per span family, plus `traceVersion` and the last folded `asOfSeq`.

### Writes and retention

The service writes one complete record per Session at `turn/end`, at Session disposal, and on the configured event/interval throttles. Writes are fail-soft: a rejected write logs a warning, the in-memory fold stays authoritative, and the next write replaces the record. Retention runs when the domain opens and whenever a record for a new Session id appears; it removes expired records and then the oldest beyond `maxRecords`.

<a id="understand-the-implementation"></a>
## Understand the implementation

The service subscribes to `session/created` and `session/event` once. A Session created with no history seeds an empty fold and advances one event per commit; a restored Session, or one that entered before the plugin mounted, is folded from its complete log on first read and then advances incrementally. The fold itself is `@deepseek-ai/dsh-agent-activity`'s pure `applyActivityEvent`, so the host counters and the browser chain read the same activity facts. The record binds to the Session lifecycle's `createdAt`: a recreated id deletes its predecessor's record instead of serving those counters.

<details>
<summary>Implementation internals — click to expand</summary>

The summary lives in the fold state, not in a second projection: `openActivitySpan` and `settleActivitySpan` account a span exactly where the fold opens or closes it, and `summarizeSpans` computes the same counters from a complete span list. A property test pins incremental against from-scratch output over arbitrary event orders. Persistence goes through the domain's write chain, one record per Session key on the `sessions` table (`per-record` layout), so a flush rewrites one document. Reads never touch the medium: the domain's validated in-memory state answers them.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-agent-activity`](../agent-activity/README.md) — the span fold and the execution chain this collection layer feeds.
- [Review activity chain](../../../docs/subsystems/review-chain.md) — the summary and fold types this service persists and serves.
- [Storage subsystem](../../../docs/subsystems/storage.md) — the schema-validated domain form, routing, and write durability this package relies on.
- [Session query subsystem](../../../docs/subsystems/session-query.md) — the live-preferred complete-log read used for cold backfill.

<a id="model-experience"></a>
## Model Experience

None, as the service only reads committed Session events and writes host storage, adding no tool, prompt, developer message, or Session event, so nothing it records reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No consumer yet** — the full-trace view and its Remote controller are future work; the chain view keeps its own browser fold.
- **Only turn, step, and tool spans are folded** — `request`, `subagent`, `workflow`, and `compaction` span kinds exist in the type and are counted when produced, but the current folder emits none of them, so their counters stay zero.
- **A cold trace rereads the log** — bounded storage keeps the summary, not the spans, so `sessionTrace` on a cold Session folds its complete log each call.
- **A live summary can lag** — when a Session's log becomes unreadable after a gap, the service serves its last consistent fold and `asOfSeq` reports how far it reached.
- **Cold records are trusted by id and version** — a second writer creating the same id outside this process can be served its predecessor summary until a live creation invalidates the record.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The summary is stored on this package's own domain rather than as a session projection unit because the future full-trace view must read counts without opening a Session, and the retention bounds are collection policy rather than projection-cache policy. The cost is a second fold path next to the client chain's; the shared pure fold and the incremental-equals-full property test keep them aligned.

</details>
