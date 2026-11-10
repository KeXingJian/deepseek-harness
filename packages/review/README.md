---
description: "The review group: projections that turn recorded agent activity into what a human code reviewer needs to decide."
kind: "package-group"
---

# packages/review

English | [中文](README.zh.md)

## Summary

The `review` group answers a reviewer's question rather than a debugger's: not "what happened, in every detail" but "what did it change, why, and is that trustworthy". Its packages project recorded session facts into a form a human reads before approving a diff. They do not collect data, own a session log, or render UI; collection and presentation belong to the consuming plugins.

Choosing this group means the subject is human judgment of agent work. Anything the model sees, or anything that persists, stays with the owning capability elsewhere.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`agent-activity/`](agent-activity/README.md) | Projects folded activity spans into a six-card execution chain plus review risk flags | — (library) |
| [`agent-trace/`](agent-trace/README.md) | Collects whole-log activity counters incrementally and persists a bounded summary for future review views | `ctx.agentTrace` |

<a id="related-documentation"></a>
## Related documentation

- The [review activity chain](../../docs/subsystems/review-chain.md) records this group's span, card, risk, and persisted-summary types.
- The [Session subsystem](../../docs/subsystems/session.md) owns the durable events a collection layer folds before this group sees them.
- [`ui-trajectory`](../client/ui-trajectory/README.md) presents the per-record ledger; this group deliberately summarizes rather than lists.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
