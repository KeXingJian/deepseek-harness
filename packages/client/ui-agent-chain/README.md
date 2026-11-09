---
description: "Review-chain conversation view for the Web GUI: filters, per-card disclosure, and review risk flags over the six-card execution chain projection."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-chain

English | [中文](README.zh.md)

## Summary

The review-chain view turns one Session's agent activity into a short, readable execution chain inside the conversation view. It registers the `Chain` conversation view tab (`执行链` in Chinese), renders the six card kinds the `dsh-agent-activity` projection produces, filters them, expands one card's recorded facts and evidence, and shows the review risk flags above the list. The plugin runs in the browser only; the Node half is an empty `apply` that keeps the package a Loader row.

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

Mount the plugin beside `ui-conversation`, `ui-renderer`, and `ui-primitives`; it declares `slots`, `uiConversation`, and `locale`. The tab then appears next to Chat and Trajectory once a Session has activity to fold.

### Reading the chain

Each row shows a status dot, the card kind, one title line, and — when the projection merged repeated work — a repeat count. The card kinds are `intent`, `recon`, `change`, `verify`, `interrupt`, and `result`; the projection owns their titles and keeps failures on their own cards.

Three filters narrow the list: `All`, `Changes only`, and `Risks only`. `Risks only` keeps failed and warned cards, not the risk banner, which stays visible whenever the projection reports flags. A filter that matches nothing shows its own empty line rather than the waiting state.

### Expanding one card

The disclosure button reveals what the card recorded: the projection's detail text, its named facts (path, command, tool, operation, file count, search count), and the evidence sequence numbers a reviewer can open in the Session log. Cards without recorded facts, details, or evidence carry no disclosure button.

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin contributes four things in `apply`: the `agentChain` dictionary, one Conversation Definition, one Conversation view target, and one `conversation.view` slot entry.

- `chainDefinition` matches the seven durable event types the chain reads and folds them through `@deepseek-ai/dsh-agent-activity`. Every matched event is offered as a start candidate: the engine starts the Context from the earliest retained event of the loaded history window and applies the rest as updates, which also re-derives the chain when the window slides.
- `chainViewDefinition` publishes one snapshot per Session — `{ cards, flags }` — from the node the Definition builds. The node reuses the engine-owned Context key; a hand-written key fails the engine's identity check.
- `AgentChainView` renders the snapshot through the slot's `useChain` hook and its `t` seat. `chain-copy.ts` holds the filter, kind, and severity vocabulary plus the expansion rows, so the component keeps no copy and no service access.
- Styling is a CSS Module over `--dsw-*` tokens; the root bounds itself to `--dsh-chat-content-width` and never scrolls on its own, because the conversation scrollport owns scrolling.

<a id="further-exploration"></a>
## Further Exploration

- [Conversation view reference](../../../docs/subsystems/conversation.md) — Definitions, view targets, and the slot that hosts a view.
- [`dsh-agent-activity`](../../review/agent-activity/README.md) — the span fold, the six card kinds, and the risk rules this view renders.
- [`dsh-client-ui-primitives`](../ui-primitives/README.md) — `Pill`, `Tag`, and `StateDot`, the controls this view composes.

<a id="model-experience"></a>
## Model Experience

None, as the view renders the committed Session log and adds nothing to prompts, tool results, or model requests.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **Evidence is text, not navigation** — a card shows its sequence numbers; opening the corresponding file or event belongs to the review-linking work.
- **Titles are not localized** — card titles and flag reasons come from the `dsh-agent-activity` projection, which still writes them as Chinese literals; moving that copy into a dictionary belongs to the localization pass.
- **No folding of the chain itself** — every card renders; there is no "collapse all" or per-kind grouping yet.
- **The slot inject closure is uncovered** — the per-file coverage gate does not yet reach `apply`'s session-scoped `inject` callback, because the assembled whole-client spec boots without a Session; everything else in the package is at 100%.

### Dev Note

The tab registers into `conversation.view`, not a right-sidebar surface: the chain is a reading of one Session, and the view tab strip already carries the Session's other readings (Chat, Trajectory).
