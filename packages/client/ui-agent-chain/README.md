---
description: "Review-chain conversation view for the Web GUI: filters, per-card disclosure, and review risk flags over the eight-card execution chain projection."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-chain

English | [中文](README.zh.md)

## Summary

The review-chain view turns one Session's agent activity into a short, readable execution chain inside the conversation view. It registers the `Chain` conversation view tab (`执行链` in Chinese), renders the eight card kinds the `dsh-agent-activity` projection produces, filters them, expands one card's recorded facts and evidence, and shows the review risk flags in a left rail beside the list. A recorded path opens the file in the Sidebar preview, and an evidence row opens its tool call in Trajectory. The plugin runs in the browser only; the Node half is an empty `apply` that keeps the package a Loader row.

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

Each row shows a status dot, a kind chip with that kind's glyph and name, one title line, and — when the projection merged repeated work — a repeat count. The card kinds are `prompt`, `thinking`, `intent`, `recon`, `change`, `verify`, `interrupt`, and `result`. Scope, not individual kind, drives the color: a row's left rail, tint, and chip ink come from one accent — blue for the human prompt, violet for reasoning (`thinking`, `intent`), neutral grey for `recon`, amber for what a reviewer reads or must answer (`change`, `interrupt`), green for `verify`, and the primary ink for the closing `result`. Failures override the scope accent with the error color, and the status dot plus title color still carry health. A thinking card reads quieter than an intent card through a dashed rail and a colorless chip. A thinking card also adds a second line with its step's action counts, composed in the reader's language, and owns that step's action cards as children: they render indented under it, each with its own disclosure, so one row reads "thought this, then did that" without leaving the step. The projection supplies each title as a message descriptor and keeps failures on their own cards; this package's dictionary owns the wording, and `chain-copy.ts` resolves it.

The review risk flags occupy a rail on the left of the list, sticky within the view so they stay readable while the card list scrolls. The rail heading carries the flag count and a collapse control; collapsed, it shrinks to a 24px handle that shows the count and reopens the rail on click or Enter. Below 800px of view width the rail moves above the list and the handle becomes a horizontal bar. Collapsing the rail is independent of the card filters. Three filters narrow the list: `All`, `Changes only`, and `Risks only`. `Risks only` keeps failed and warned cards, not the risk rail, which stays visible whenever the projection reports flags. A matching card nested under a thinking card is promoted to the top level, so a filter never loses a change or a risk behind its parent. A filter that matches nothing shows its own empty line rather than the waiting state.

### Expanding one card

The disclosure button reveals what the card recorded: its named facts (the human prompt text, the step's thinking, path, command, tool, operation, file count, search count) and one row per contributing span with its session-log sequence, span name, and settlement. A change card whose tool recorded the changed text shows a line diff first — the file's before and after lines, capped, with the card's own expand control — so the reviewer reads the edit instead of a description of it. Cards without recorded facts, diffs, or evidence carry no disclosure button, and a cited sequence the snapshot no longer holds is skipped.

### Opening what a card names

Paths display relative to the Session's workspace root, and the recorded path stays available on hover. A path fact and a risk flag's files are buttons: each opens that file in the Sidebar preview, addressed under the same root, so the reviewer reads the file beside the chain. An evidence row that came from a tool call opens that call in Trajectory through the conversation's inspection target; a turn or step span keeps its sequence but has no call to inspect.

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin contributes four things in `apply`: the `agentChain` dictionary, one Conversation Definition, one Conversation view target, and one `conversation.view` slot entry.

- `chainDefinition` matches the eight durable event types the chain reads and folds them through `@deepseek-ai/dsh-agent-activity`. It also records the `diffs` payload of each `tool/result` under its call id, because a span keeps the call identity but not the file text; the view node passes that record to `chainFromSpans` as its third argument. Nothing extra is stored: the text stays in the tool result the log already holds. Every matched event is offered as a start candidate: the engine starts the Context from the earliest retained event of the loaded history window and applies the rest as updates, which also re-derives the chain when the window slides. The built node carries the folded chain and the spans it was folded from, so expansion can read one span by sequence.
- `chainViewDefinition` publishes one snapshot per Session — `{ cards, flags, spans }` — from the node the Definition builds. The node reuses the engine-owned Context key; a hand-written key fails the engine's identity check.
- `AgentChainView` renders the snapshot through the slot's `useChain` hook and its `t` seat. It reads the Session's workspace root through the framework's `useSessions` seat and shortens every displayed path against it, while `openFile` still receives the recorded path. `chain-copy.ts` holds the filter, kind-glyph, and severity vocabulary, resolves a card title and a risk reason through the dictionary, and derives the expansion and evidence rows, so the component keeps no copy and no service access. The view receives `inspectCall` from the conversation view owner share and calls it with a span's recorded call identity.
- The slot's `inject` face resolves a card's path against the Session's workspace root — read from `sessions.list` at click time — and opens it through `sidebarRight.openResource` as a Session-scoped file address; the file preview owns reading the content.
- Styling is a CSS Module over `--dsw-*` tokens; the root bounds itself to `--dsh-chat-content-width`, declares an inline-size container so the rail/list breakpoint follows the view column rather than the window, and never scrolls on its own, because the conversation scrollport owns scrolling.

<a id="further-exploration"></a>
## Further Exploration

- [Conversation view reference](../../../docs/subsystems/conversation.md) — Definitions, view targets, and the slot that hosts a view.
- [Review activity chain](../../../docs/subsystems/review-chain.md) — the span and card types this view renders and the messages its dictionary resolves.
- [`dsh-agent-activity`](../../review/agent-activity/README.md) — the span fold, the eight card kinds, and the risk rules this view renders.
- [`dsh-client-ui-primitives`](../ui-primitives/README.md) — `Pill`, `Tag`, `StateDot`, and the product icons the kind chips use.

<a id="model-experience"></a>
## Model Experience

None, as the view renders the committed Session log and adds nothing to prompts, tool results, or model requests.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **Counts interpolate without plural forms** — a dictionary message receives the number and renders one template, so an English chain reads "1 searches" rather than a singular form.
- **No folding of the chain itself** — every card renders; there is no "collapse all" or per-kind grouping yet.
- **Turn and step evidence does not navigate** — only a tool-call span carries the call identity Trajectory can focus, so a turn or step row stays a label.
- **Diffs only cover recorded text** — a change whose tool result carries no `diffs` (a shell deletion, a tool that reports only the operation) shows its path and operation without a diff; the view never reads the file to reconstruct one.
- **Child cards belong to their step** — a change on the same file in two steps stays two cards under two thinking cards, because the card belongs to the reasoning that caused it.

### Dev Note

The tab registers into `conversation.view`, not a right-sidebar surface: the chain is a reading of one Session, and the view tab strip already carries the Session's other readings (Chat, Trajectory). File links then use the right Sidebar for content, because its preview already resolves a Session-scoped file address; the chain itself never reads a file.
