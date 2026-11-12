---
description: "Review-oriented execution chain: folds agent activity spans into eight readable cards plus review risk flags."
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

Call `chainFromSpans(spans, userText?, diffs?)` with collection-layer spans ordered by sequence and get back `{ cards, flags }`.

```ts
import { chainFromSpans } from '@deepseek-ai/dsh-agent-activity'
import type { ActivitySpan } from '@deepseek-ai/dsh-agent-activity'

declare const spans: readonly ActivitySpan[]

const { cards, flags } = chainFromSpans(spans, '请修复排序的空数组问题')
```

### Folding a session log

`foldActivity(events)` turns a Session log into the spans the chain consumes. It reads turn, step, assistant, and tool events; a span whose closing event never arrived stays `running`, and tool arguments that are not JSON simply carry no attributes. When events arrive one at a time, `createActivityFolder()` applies them incrementally and exposes the same spans; `foldActivity()` is that folder over a whole log.

```ts
import { chainFromSpans, foldActivity } from '@deepseek-ai/dsh-agent-activity'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

declare const events: readonly SessionEvent[]

const { cards, flags } = chainFromSpans(foldActivity(events))
```

### Cards

| Kind | Source spans | Answers |
|---|---|---|
| `prompt` | `turn` carrying the human `user/message` as a `prompt` attribute | What was it asked to do |
| `thinking` | `step` carrying the reasoning of its `assistant/message` | What did it reason before acting |
| `intent` | `turn` carrying an `intent` attribute | What did it mean to do |
| `recon` | `read`/`grep`/`glob`/`list`/`lsp` tools, subagent hand-offs | Where did it look |
| `change` | `write`/`edit` tools and deletions | What did it change |
| `verify` | `bash`/`test`/`build`/`lint`/`run_code` tools, workflow phases | Did it prove the change |
| `interrupt` | approval and question tools | When did a human step in |
| `result` | synthesized from the chain | What was delivered |

A turn's `prompt` card cites the `user/message` that recorded it; synthetic user-role injections (plugin context, recalled history, goal continuations) are not human prompts and produce no card. A step that recorded reasoning produces one `thinking` card citing its `assistant/message`; that step's tool calls become its `children`, rendered as child cards under it, and the thinking card states their counts in `actions` so one row reads "thought this, then did that". A step without reasoning leaves its tool cards in the flat chain and produces no thinking card.

`chainFromSpans(spans, userText?, diffs?, { merge: false })` returns every event card separately in event-sequence order, including thinking cards and their actions as flat rows. The default projection merges adjacent recon cards, repeated edits to one file, and long successful-verification runs, while failed verification cards remain separate; merged cards sort by their first evidence event. Repeated edits merge only inside the stretch between two prompt cards, because a card that absorbed edits from after a later prompt would carry them back before that prompt and the reader would see no change between the two requests. The default merged chain is capped to keep long sessions readable.

A card title is a `ChainTitle` message descriptor — which message applies and the values it interpolates — and `meta` repeats the same facts in machine form for expansion and for the risk rules. Only `prompt`, `thinking`, and `intent` titles are recorded text. The consuming view maps each descriptor through its own locale dictionary, so the projection never writes product copy.

A `change` card can also carry a `note`: the recorded sentence that explains that edit, plus `noteFrom` stating how directly it addresses the file (`file` names the path, its basename, or a stem of three characters or more; `step` is the step first sentence setting the scene; `intent` is the turn goal when the step recorded no reasoning). Nothing is invented — an edit the recorded reasoning never mentions keeps no note, so a reviewer sees an unexplained change as unexplained. Merging two edits of one file keeps both notes when they differ.

A `change` card can also carry `diffs`: the before and after text the tool recorded for that file, one entry per applied hunk. The projection never computes a patch from them; it attaches what the caller supplies as `diffs`, keyed by tool-call id, and merging two edits of one file concatenates their hunks. That keeps span attributes small — the file text lives in the tool result the log already holds — while the view still renders a line diff.

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
- **Prompt quotes the first human message** — `prompt` is the turn's first human `user/message`, truncated in the title and bounded in `meta`; later human interjections in the same turn stay out of the chain.
- **Thinking is per step** — a `thinking` card carries the reasoning of one step; reasoning that arrives without an open step is dropped, and a step's actions are counted by the classification the action cards use, so an unknown tool counts as neither a file nor a search.
- **Out-of-scope matching is a heuristic** — it compares changed paths with paths the session read and with the task text (the caller's argument, or the prompts recorded in the chain), and reports the result as an inference rather than a fact.
- **One consumer so far** — `dsh-client-ui-agent-chain` renders these cards; the flags reach it as card status, and navigation from a card back to its evidence belongs to that view.
- **Deletion line counts are not inferred** — a deletion reports the file, not a removed-line total the session did not record.
- **Diffs come from the caller** — a chain folded from spans alone carries no diffs; a caller that holds the recorded tool results passes them as `chainFromSpans`'s third argument, so a tool that records no `diffs` in its result shows its facts without one.
- **The ceiling compresses look-around cards only** — a session that changed more than thirty distinct files still renders one card per file, because collapsing distinct files would hide exactly what a reviewer must read.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
