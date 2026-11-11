# Agent Note: Project review activity twice — spans for collection, messages for presentation

Status: implemented

English | [中文](2026-11-09-two-layer-activity-projection.zh.md)

## Problem

A reviewer reading a Session wants a short chain, not a replay: what the agent meant to do, where it looked, what it changed, what it verified, and where a human stepped in. The same recorded activity also has to answer questions no chain shows — how many tool calls ran, how long each span family took, what a Session costed — and it has to answer them for a Session whose browser is closed and whose process is gone.

One projection cannot serve both. If the projection that derives the chain also writes the sentences, every consumer inherits that package's language: a Web view in any locale, a recorded fixture, a future export. The repository rule that client UI copy belongs to typed locale dictionaries makes that leakage a defect rather than a shortcut, and the rule applies most sharply in a package that is not the UI at all. Conversely, if the only consumer folds events itself, a whole-log counter view pays for the fold again and a headless caller cannot get counters without a browser.

## Decision

Review activity is projected in two layers with a strict direction, and each layer owns one kind of output.

| Layer | Package | Input | Output | Owns |
|---|---|---|---|---|
| Collection | `@deepseek-ai/dsh-agent-activity` | committed `SessionEvent`s (or a caller's span list) | `ActivitySpan[]` plus an incrementally maintained `ActivitySummary` | timing, settlement state, review-relevant recorded facts |
| Presentation | `@deepseek-ai/dsh-agent-activity` | `ActivitySpan[]` and the user's task text | `ChainCard[]`, `RiskFlag[]` | card order, merge rules, risk rules |

Both layers are pure functions over recorded facts: no I/O, no Cordis service, no storage, no clock. The chain is never persisted — it is recomputed from spans, which cost one linear pass.

Reader-facing text in the presentation layer is a message descriptor, not a string. `ChainTitle` and `RiskReason` name the message and carry the values it interpolates; the consuming view resolves them through its own locale dictionary. The exceptions are the `prompt`, `thinking`, and `intent` cards, whose titles are the human's and the model's own sentences and stay verbatim. `ChainCard.meta` carries the same recorded facts in machine form — target path, command, tool name, operation, merged counts, the recorded prompt and thinking text — and `ChainCard.actions` carries a thinking card's step action counts, so the expanded card and the risk rules never parse a title.

Collection is persisted separately by `@deepseek-ai/dsh-agent-trace` behind `ctx.agentTrace`. The stored record is the summary plus the log position (`asOfSeq`) and the fold semantics (`traceVersion`) it was computed under, keyed by Session id and its `createdAt` lifecycle label. Spans themselves are not stored: a cold `sessionTrace` read replays the Session log through `ctx.sessionQuery` and refreshes the stored summary on the way out.

## Alternatives considered

**Store the rendered card list.** A stored chain would let a history view skip folding. It loses because the chain is locale-relative: a stored chain freezes the language of whoever wrote it, and a later locale switch cannot repair it. Storing spans instead keeps both the chain and any counter derivable, at the cost of one cheap fold per read.

**Emit English sentences from the presentation layer.** This is the leak with different words: the data package would still own product copy, and a non-English reader, a translated export, or a recorded fixture would carry text the view cannot replace. Message descriptors keep the identity of each message in the projection and the wording in the dictionary.

**Fold Session events in every consumer.** The Web view already folds in the browser, so this looks sufficient. It fails for the two callers the collection layer exists for: a whole-log counter view that would recompute the same fold, and a headless Host consumer with no browser half at all.

**Persist the spans themselves.** Persisting spans would let a cold Session answer both `sessionSummary` and `sessionTrace` without replaying its log. The storage cost is unbounded in Session length and grows with every tool call, while the summary is a fixed-size record per Session; the bounded retention pair (`retentionDays`, `maxRecords`) only makes sense for the summary.

## Consequences

The chain and the counters share one fold, so a rule that changes span settlement changes both at once; a property test pins the incremental counters against a from-scratch summary over the same spans so the two can never drift. `ACTIVITY_TRACE_VERSION` is the invalidation lever: a stored summary stamped with another version is recomputed rather than served.

The projection stays callable from anywhere — tests, a future exporter, a CLI — because neither layer touches the Session store. The cost is that a caller wanting a chain must also apply the collection layer itself, and a caller wanting the persisted form must mount the storage stack.

Because the projection emits messages rather than sentences, the Web view is now the sole owner of reader-facing chain copy, including risk reasons. The repository's dictionary-parity gate therefore covers this feature without special cases, and adding a message variant is a compile error in the view until its dictionary entry exists.

## Verification

- `tests/aggregate.properties.spec.ts` pins "incremental counters equal a from-scratch summary" over generated event sequences.
- `tests/chain.golden.spec.ts` pins three recorded cases end to end: card order, statuses, evidence sequences, and risk findings.
- `packages/client/ui-agent-chain/tests/chain-copy.client.spec.ts` exercises every title and reason variant through the shipped dictionaries; `scripts/locale-dictionary-parity.spec.ts` rejects a dictionary that loses a key or a placeholder.
- `packages/review/agent-trace/tests/loader-composition.spec.ts` boots the shipped storage and trace rows through the real Loader and reads the persisted summary back.
