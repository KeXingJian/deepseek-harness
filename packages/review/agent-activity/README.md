---
description: "Review-oriented execution chain: folds agent activity spans into six readable cards plus review risk flags."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-activity

English | [中文](README.zh.md)

## Summary

`dsh-agent-activity` turns folded agent activity spans into a short, ordered chain a reviewer reads instead of replaying the session: what the agent meant to do, what it looked at, what it changed, what it verified, and where a human stepped in. It also flags the changes reviewers police by hand — modified tests, CI or build configuration, deletions, out-of-scope edits, unverified changes, repeated failures, and plan churn.

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

Call `chainFromSpans(spans, userText?)` with collection-layer spans ordered by sequence and get back `{ cards, flags }`.

```ts
import { chainFromSpans } from '@deepseek-ai/dsh-agent-activity'

const { cards, flags } = chainFromSpans(spans, '请修复排序的空数组问题')
```

### Folding a session log

`foldActivity(events)` turns a Session log into the spans the chain consumes. It reads turn, step, assistant, and tool events; a span whose closing event never arrived stays `running`, and tool arguments that are not JSON simply carry no attributes. When events arrive one at a time, `createActivityFolder()` applies them incrementally and exposes the same spans; `foldActivity()` is that folder over a whole log.

```ts
import { chainFromSpans, foldActivity } from '@deepseek-ai/dsh-agent-activity'

const { cards, flags } = chainFromSpans(foldActivity(events))
```

### Cards

| Kind | Source spans | Answers |
|---|---|---|
| `intent` | `turn` carrying an `intent` attribute | What did it mean to do |
| `recon` | `read`/`grep`/`glob`/`list`/`lsp` tools, subagent hand-offs | Where did it look |
| `change` | `write`/`edit` tools and deletions | What did it change |
| `verify` | `bash`/`test`/`build`/`lint`/`run_code` tools, workflow phases | Did it prove the change |
| `interrupt` | approval and question tools | When did a human step in |
| `result` | synthesized from the chain | What was delivered |

Cards merge while preserving review meaning: adjacent look-around cards become one counted summary, repeated edits to one file become one card with a `repeat` count, failed verifications stay standalone, and long success runs collapse. The chain is capped so a long session still fits one screen.

A card title is a `ChainTitle` message descriptor — which message applies and the values it interpolates — and `meta` repeats the same facts in machine form for expansion and for the risk rules. Only an `intent` title is recorded text. The consuming view maps each descriptor through its own locale dictionary, so the projection never writes product copy.

### Risk flags

| Code | Severity | Rule |
|---|---|---|
| `touches-tests` | warn | A changed path is a test file |
| `touches-ci` | warn | A changed path is CI or build configuration |
| `deletes` | danger | The session deleted a file |
| `out-of-scope` | info | An in-place edit of a file the session never read or the task never named |
| `unverified` | danger | Changes exist with no passing verification |
| `gave-up` | warn | The same verification failed repeatedly and edits continued |
| `plan-churn` | info | Five or more distinct intents |

Every flag carries a `RiskReason` message descriptor and the files it matched; the presentation layer localizes the reason and shows the evidence instead of a bare warning.

<a id="understand-the-implementation"></a>
## Understand the implementation

The package is a two-step projection with no I/O and no Cordis dependencies: spans become cards, then cards and spans become flags. Cards are derived in sequence order, merged in a fixed order (look-around, per-file changes, verifications, intents, ceiling), and closed with the result card. Flags run last so a flagged change can render as `warning` without changing the underlying spans.

`evidenceSeqs` is the contract that keeps the chain checkable: a reader who distrusts a card opens the sequence numbers it was built from.

<a id="further-exploration"></a>
## Further Exploration

- [Review activity chain](../../../docs/subsystems/review-chain.md) — the span, card, and risk types with their contracts.
- [Session events](../../core/session/README.md) — the durable facts a collection layer folds into spans.
- [Session subsystem](../../../docs/subsystems/session.md) — the event vocabulary the spans are derived from.
- [Trajectory view](../../client/ui-trajectory/README.md) — the per-record ledger this chain deliberately summarizes instead of listing.

<a id="model-experience"></a>
## Model Experience

None, as this package projects review-facing chain data and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No service and no storage** — the package projects Session events or spans supplied by a caller; persistence, live delivery, and rendering belong to consuming plugins.
- **Durable events only** — approvals, subagent hand-offs, and workflow phases are live Cordis events rather than Session records, so a chain folded from a log does not contain them.
- **Intent quotes the model** — an `intent` card is the turn's first non-empty assistant text block, not a summary written by this package.
- **Out-of-scope matching is a heuristic** — it compares changed paths with paths the session read and with the caller-supplied task text, and reports the result as an inference rather than a fact.
- **One consumer so far** — `dsh-client-ui-agent-chain` renders these cards and flags; navigation from a card back to its evidence belongs to that view.
- **Deletion line counts are not inferred** — a deletion reports the file, not a removed-line total the session did not record.
- **The ceiling compresses look-around cards only** — a session that changed more than thirty distinct files still renders one card per file, because collapsing distinct files would hide exactly what a reviewer must read.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
