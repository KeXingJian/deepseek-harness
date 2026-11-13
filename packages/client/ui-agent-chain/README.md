---
description: "Review-chain conversation view for the Web GUI: filters, per-card disclosure, and a change locator over the eight-card execution chain projection."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-chain

English | [中文](README.zh.md)

## Summary

The review-chain view turns one Session's agent activity into a short, readable execution chain inside the conversation view. It registers the `Chain` conversation view tab (`执行链` in Chinese), renders the eight card kinds the `dsh-agent-activity` projection produces, filters them, expands one card's recorded facts and evidence, and guides the reader between prompts and changes with a locator rail on the right. A recorded path opens the file in the Sidebar preview, and an evidence row opens its tool call in Trajectory. The plugin runs in the browser only; the Node half is an empty `apply` that keeps the package a Loader row.

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

The chain opens as a chronological timeline with each event shown separately. The `Show merged events` toggle switches to the projection's merged view, which combines adjacent recon cards, repeated edits to one file, long successful-verification runs, and near-duplicate intents. The merged timeline sorts cards by the event sequence of their first evidence; repeated edits retain their first event position within the stretch between two prompts, so the rail still shows a change between two consecutive requests. The result summary remains last in both modes. The toolbar keeps both controls together on the left: the merge toggle and `Hide recon`.

`Hide recon` removes recon cards, including recon child cards under a thinking card, while preserving the parent's other children. Its label states what it will do next (`Hide recon` / `Show recon`), so the pressed state is never the only signal.

### Navigating and streaming a long chain

A chain of any length renders one page at a time. The first page holds the first 40 top-level cards, and the list grows by another page as the reader reaches the end: a sentinel below the cards appends automatically once it enters the scrollport, and the same control stays a button so a browser without `IntersectionObserver`, or a keyboard reader, can page it by hand. Changing either toolbar control returns to the first page instead of leaving the reader mid-way through a different list.

A locator rail on the right of the card column guides the cards a reviewer actually reads: one bar per prompt card and per change card, tinted by the card's scope accent. Hover or keyboard focus shows the card title and recorded change explanation in a preview. A thinking card earns a bar only when the step folded out a change, so the rail never points at reasoning that changed nothing. The bars are twice the size of the transcript's turn-rail marks, and the rail pins itself to the middle of the band the reader actually sees — the scrollport height minus the composer seat, both published by the conversation shell — and stays there while the cards scroll, once the list end comes into view, and as an appended page grows the list, because the rail hangs off a zero-height sticky point instead of a sticky box that would stop at its containing block's bottom edge; the rail scrolls inside its own frame when the guided cards are taller than that band. An `IntersectionObserver` over those rows marks the earliest guided card in card-list order that intersects the upper reading band, so the rail follows the reader while scrolling, and choosing a bar scrolls that card to the top of the scrollport — first rendering the rest of the chain up to it when the card sits past the current page. A chain with fewer than two guided cards needs no rail and takes the full width. Below 560px of view width the rail is dropped in favour of card width; the cards remain reachable by scrolling.

### Expanding one card

A change card with a recorded turn intent shows that intent above its title and diff. The chain text uses a 1.5× font scale. Recon cards are hidden when the view opens; the toolbar can show them. The disclosure button reveals what the card recorded: its named facts (the human prompt text, the step's thinking, path, the change note, command, tool, operation, file count, search count) and one row per contributing span with its session-log sequence, span name, and settlement. A change note carries its own field name, so a reader can tell a sentence that names this file (`Why this change`) from the step's plan (`Step context`) or the turn's goal (`Turn intent`). A change card whose tool recorded the changed text shows a line diff first — the file's before and after lines, capped, with the card's own expand control — so the reviewer reads the edit instead of a description of it. Cards without recorded facts, diffs, or evidence carry no disclosure button, and a cited sequence the snapshot no longer holds is skipped.

### Opening what a card names

Paths display relative to the Session's workspace root, and the recorded path stays available on hover. A path fact and a risk flag's files are buttons: each opens that file in the Sidebar preview, addressed under the same root, so the reviewer reads the file beside the chain. An evidence row that came from a tool call opens that call in Trajectory through the conversation's inspection target; a turn or step span keeps its sequence but has no call to inspect.

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin contributes four things in `apply`: the `agentChain` dictionary, one Conversation Definition, one Conversation view target, and one `conversation.view` slot entry.

- `chainDefinition` matches the eight durable event types the chain reads and folds them through `@deepseek-ai/dsh-agent-activity`. It also records the `diffs` payload of each `tool/result` under its call id, because a span keeps the call identity but not the file text; the view node passes that record to `chainFromSpans` as its third argument. Nothing extra is stored: the text stays in the tool result the log already holds. Every matched event is offered as a start candidate: the engine starts the Context from the earliest retained event of the loaded history window and applies the rest as updates, which also re-derives the chain when the window slides. The built node carries the folded chain and the spans it was folded from, so expansion can read one span by sequence.
- `chainViewDefinition` publishes one snapshot per Session — `{ cards, flags, spans }` — from the node the Definition builds. The node reuses the engine-owned Context key; a hand-written key fails the engine's identity check.
- `AgentChainView` renders the snapshot through the slot's `useChain` hook and its `t` seat. It reads the Session's workspace root through the framework's `useSessions` seat and shortens every displayed path against it, while `openFile` still receives the recorded path. `chain-copy.ts` holds the filter and kind-glyph vocabulary, resolves a card title through the dictionary, derives the expansion and evidence rows, and drops recon cards when the reader hides them, so the component keeps no copy and no service access. `locator.ts` maps the prompt and change cards to rail bars, observes those rows, and scrolls a chosen card into place; `stream.ts` owns the rendered page size and the sentinel that appends the next one. The view receives `inspectCall` from the conversation view owner share and calls it with a span's recorded call identity.
- The slot's `inject` face resolves a card's path against the Session's workspace root — read from `sessions.list` at click time — and opens it through `sidebarRight.openResource` as a Session-scoped file address; the file preview owns reading the content.
- Styling is a CSS Module over `--dsw-*` tokens; the root bounds itself to `--dsh-chat-content-width`, declares an inline-size container so the rail/list breakpoint follows the view column rather than the window, and never scrolls on its own, because the conversation scrollport owns scrolling.

<a id="further-exploration"></a>
## Further Exploration

- [Conversation view reference](../../../docs/subsystems/conversation.md) — Definitions, view targets, and the slot that hosts a view.
- [Review activity chain](../../../docs/subsystems/review-chain.md) — the span and card types this view renders and the messages its dictionary resolves.
- [`dsh-agent-activity`](../../review/agent-activity/README.md) — the span fold, the eight card kinds, and the risk rules behind the `Risks only` filter.
- [`dsh-client-ui-primitives`](../ui-primitives/README.md) — `Pill`, `StateDot`, and the product icons the kind chips use.

<a id="model-experience"></a>
## Model Experience

None, as the view renders the committed Session log and adds nothing to prompts, tool results, or model requests.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **Unselected Conversation views unmount** — selecting another view discards the chain component's local filters, disclosures, and scroll position; retaining inactive views requires a change to the shared `ui-conversation` renderer.
- **Counts interpolate without plural forms** — a dictionary message receives the number and renders one template, so an English chain reads "1 searches" rather than a singular form.
- **No folding of the chain itself** — every matching card renders, one page at a time; there is no "collapse all" or per-kind grouping yet.
- **Risk flags reach the reader only as card status** — the projection still computes them and marks the affected cards, but the view lists none of them, so the reader never sees a flag's own reason or its evidence files.
- **Turn and step evidence does not navigate** — only a tool-call span carries the call identity Trajectory can focus, so a turn or step row stays a label.
- **Creates lack a recorded full-content diff** — create tools currently provide neither prior text nor the applied new text, so the card shows only the path and operation; the view never reads the file to reconstruct one.
- **Diffs only cover recorded text** — a change whose tool result carries no `diffs` (a shell deletion, a tool that reports only the operation) shows its path and operation without a diff; the view never reads the file to reconstruct one.
- **Child cards belong to their step** — a change on the same file in two steps stays two cards under two thinking cards, because the card belongs to the reasoning that caused it.

### Dev Note

The tab registers into `conversation.view`, not a right-sidebar surface: the chain is a reading of one Session, and the view tab strip already carries the Session's other readings (Chat, Trajectory). File links then use the right Sidebar for content, because its preview already resolves a Session-scoped file address; the chain itself never reads a file.
