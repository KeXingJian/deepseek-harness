---
description: "Review-chain conversation view for the Web GUI: filters, per-card disclosure, and review risk flags over the six-card execution chain projection."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-chain

English | [中文](README.zh.md)

## Summary

The review-chain view turns one Session's agent activity into a short, readable execution chain inside the conversation view. It registers the `Chain` conversation view tab (`执行链` in Chinese), renders the six card kinds the `dsh-agent-activity` projection produces, filters them, expands one card's recorded facts and evidence, and shows the review risk flags above the list. A recorded path opens the file in the Sidebar preview, and an evidence row opens its tool call in Trajectory. The plugin runs in the browser only; the Node half is an empty `apply` that keeps the package a Loader row.

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

Each row shows a status dot, the card kind, one title line, and — when the projection merged repeated work — a repeat count. The card kinds are `intent`, `recon`, `change`, `verify`, `interrupt`, and `result`. The projection supplies each title as a message descriptor and keeps failures on their own cards; this package's dictionary owns the wording, and `chain-copy.ts` resolves it.

Three filters narrow the list: `All`, `Changes only`, and `Risks only`. `Risks only` keeps failed and warned cards, not the risk banner, which stays visible whenever the projection reports flags. A filter that matches nothing shows its own empty line rather than the waiting state.

### Expanding one card

The disclosure button reveals what the card recorded: its named facts (path, command, tool, operation, file count, search count) and one row per contributing span with its session-log sequence, span name, and settlement. Cards without recorded facts or evidence carry no disclosure button, and a cited sequence the snapshot no longer holds is skipped.

### Opening what a card names

A path fact and a risk flag's files are buttons: each opens that file in the Sidebar preview, addressed under the Session's workspace root, so the reviewer reads the file beside the chain. An evidence row that came from a tool call opens that call in Trajectory through the conversation's inspection target; a turn or step span keeps its sequence but has no call to inspect.

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin contributes four things in `apply`: the `agentChain` dictionary, one Conversation Definition, one Conversation view target, and one `conversation.view` slot entry.

- `chainDefinition` matches the seven durable event types the chain reads and folds them through `@deepseek-ai/dsh-agent-activity`. Every matched event is offered as a start candidate: the engine starts the Context from the earliest retained event of the loaded history window and applies the rest as updates, which also re-derives the chain when the window slides. The built node carries the folded chain and the spans it was folded from, so expansion can read one span by sequence.
- `chainViewDefinition` publishes one snapshot per Session — `{ cards, flags, spans }` — from the node the Definition builds. The node reuses the engine-owned Context key; a hand-written key fails the engine's identity check.
- `AgentChainView` renders the snapshot through the slot's `useChain` hook and its `t` seat. `chain-copy.ts` holds the filter, kind, and severity vocabulary, resolves a card title and a risk reason through the dictionary, and derives the expansion and evidence rows, so the component keeps no copy and no service access. The view receives `inspectCall` from the conversation view owner share and calls it with a span's recorded call identity.
- The slot's `inject` face resolves a card's path against the Session's workspace root — read from `sessions.list` at click time — and opens it through `sidebarRight.openResource` as a Session-scoped file address; the file preview owns reading the content.
- Styling is a CSS Module over `--dsw-*` tokens; the root bounds itself to `--dsh-chat-content-width` and never scrolls on its own, because the conversation scrollport owns scrolling.

<a id="further-exploration"></a>
## Further Exploration

- [Conversation view reference](../../../docs/subsystems/conversation.md) — Definitions, view targets, and the slot that hosts a view.
- [Review activity chain](../../../docs/subsystems/review-chain.md) — the span and card types this view renders and the messages its dictionary resolves.
- [`dsh-agent-activity`](../../review/agent-activity/README.md) — the span fold, the six card kinds, and the risk rules this view renders.
- [`dsh-client-ui-primitives`](../ui-primitives/README.md) — `Pill`, `Tag`, and `StateDot`, the controls this view composes.

<a id="model-experience"></a>
## Model Experience

None, as the view renders the committed Session log and adds nothing to prompts, tool results, or model requests.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **Counts interpolate without plural forms** — a dictionary message receives the number and renders one template, so an English chain reads "1 searches" rather than a singular form.
- **No folding of the chain itself** — every card renders; there is no "collapse all" or per-kind grouping yet.
- **Turn and step evidence does not navigate** — only a tool-call span carries the call identity Trajectory can focus, so a turn or step row stays a label.

### Dev Note

The tab registers into `conversation.view`, not a right-sidebar surface: the chain is a reading of one Session, and the view tab strip already carries the Session's other readings (Chat, Trajectory). File links then use the right Sidebar for content, because its preview already resolves a Session-scoped file address; the chain itself never reads a file.
