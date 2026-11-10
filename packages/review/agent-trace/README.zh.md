---
description: "Agent 活动轨迹采集（ctx.agentTrace）：增量 span 计数落在有界的存储域上，按需用 sessionQuery 回填，不提供界面与模型面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-trace

[English](README.md) | 中文

## 概述

本包是评审执行链背后的采集层：把会话已提交的事件折叠成活动 span，增量维护全日志计数，并把一份有界的摘要按会话持久化到 `agent_trace` 存储域。<br>`ctx.agentTrace` 提供 `sessionSummary(sessionId)` 与 `sessionTrace(sessionId)` 给将来的全量视图使用；可读的执行链仍然在浏览器侧自行折叠事件，因此本包不新增界面、工具、提示词或会话事件。<br>采集默认静默且失败软着陆：丢一次摘要只会多算一次，不会打断会话。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把插件与会话存储、存储栈一起挂载。`sessionQuery` 是可选的：有它就能按需折叠冷会话或恢复的会话；没有它时冷读只能返回已存的摘要。

### 配置

每个字段都是部署选择，所以组合处必须显式写出：

```yaml
- id: agent-trace
  name: '@deepseek-ai/dsh-agent-trace'
  config:
    flushEveryEvents: 200
    flushIntervalMs: 5000
    retentionDays: 30
    maxRecords: 500
```

| 字段 | 含义 |
|---|---|
| `flushEveryEvents` | 两个强制写点之间，每个会话累计多少个事件后强制写一次摘要 |
| `flushIntervalMs` | 两个强制写点之间，脏摘要最长可等待多久不落盘 |
| `retentionDays` | 存储摘要的保留天数，超期在下次清理时删除 |
| `maxRecords` | 最多保留多少条摘要，超出后删除最旧的 |

### 读取数据

对活动会话，`sessionSummary(sessionId)` 直接读实时增量折叠；否则读已存记录。<br>`sessionTrace(sessionId)` 返回折叠后的 span；对非活动会话，它通过 `sessionQuery` 读取完整日志，并顺带刷新已存摘要。<br>当会话既不活动也不可读时，两者都返回 `undefined`。

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentTraceSummary } from '@deepseek-ai/dsh-agent-trace'

declare const ctx: Context
declare const sessionId: SessionId

const summary: AgentTraceSummary | undefined = await ctx.agentTrace.sessionSummary(sessionId)
const spans = await ctx.agentTrace.sessionTrace(sessionId)
```

摘要给出按 span 类型统计的开启数量、当前结算状态（`running` 表示仍未关闭的 span）、按类型累计的已结算耗时，以及 `traceVersion` 与最后折叠到的 `asOfSeq`。

### 写入与保留

服务在 `turn/end`、会话销毁，以及配置的事件数／时间间隔触发点各写一条完整记录。<br>写入失败软着陆：失败只记一条告警，内存中的折叠仍是权威，下一次写入会覆盖记录。<br>保留策略在存储域打开时执行，并在出现新会话 id 的记录时再执行一次：先删过期记录，再删超出 `maxRecords` 的最旧记录。

<a id="understand-the-implementation"></a>
## 理解实现

服务只订阅一次 `session/created` 与 `session/event`。<br>无历史的会话在创建时得到一个空的折叠，之后每提交一个事件前进一步；恢复的会话，或在插件挂载前就已存在的会话，在第一次读取时从完整日志折叠，之后同样增量推进。<br>折叠本身是 `@deepseek-ai/dsh-agent-activity` 的纯函数 `applyActivityEvent`，因此宿主计数与浏览器执行链看到的是同一份活动事实。<br>记录绑定到会话生命周期的 `createdAt`：同 id 重建的会话会删除前任记录，而不是继续给出旧计数。

<details>
<summary>实现内幕 —— 点击展开</summary>

摘要保存在折叠状态里，而不是第二个投影：`openActivitySpan` 与 `settleActivitySpan` 就在折叠开启或关闭 span 的位置记账，`summarizeSpans` 则从完整 span 列表算出同一组计数。<br>属性测试用任意事件序列钉住“增量结果 == 从头计算”。<br>持久化走存储域的写链，每个会话键对应 `sessions` 表的一条记录（`per-record` 布局），一次刷新只重写一个文档。<br>读取不碰介质：由存储域校验过的内存状态直接回答。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [`dsh-agent-activity`](../agent-activity/README.zh.md) —— 本采集层喂给执行链的 span 折叠与卡片投影。
- [评审活动链](../../../docs/subsystems/review-chain.zh.md) —— 本服务持久化并提供读取的摘要与折叠类型。
- [存储子系统](../../../docs/subsystems/storage.zh.md) —— 本包依赖的 schema 校验域、路由与写入持久性。
- [会话查询子系统](../../../docs/subsystems/session-query.zh.md) —— 冷回填所用的“优先实时”的完整日志读取。

<a id="model-experience"></a>
## 模型体验

无。本包只读取已提交的会话事件并写入宿主存储，不新增工具、提示词、开发者消息或会话事件，因此它记录的任何内容都不会进入模型请求。

#### KV Cache effect

无；本包既不组装也不发送模型请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **暂无消费方** —— 全量视图及其 Remote 控制器属于后续工作；执行链视图仍使用自己的浏览器侧折叠。
- **只折叠 turn、step、tool 三类 span** —— 类型里已有 `request`、`subagent`、`workflow`、`compaction`，一旦产出就会被计数，但当前折叠器不产出这些 span，因此它们的计数保持为零。
- **冷会话的轨迹会重读日志** —— 有界存储只保留摘要，不保留 span，所以对冷会话调用 `sessionTrace` 每次都会折叠完整日志。
- **活动摘要可能滞后** —— 会话日志在出现缺口后变得不可读时，服务返回最后一次一致的折叠，`asOfSeq` 会说明它折叠到哪。
- **冷记录按 id 与版本信任** —— 若本进程之外的第二个写入方重建了同一 id，在活动创建事件让记录失效之前，可能读到前任摘要。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

摘要存在本包自己的存储域，而不是做成会话投影单元：将来的全量视图需要在不开会话的情况下读计数，而保留上限属于采集策略，不属于投影缓存策略。<br>代价是浏览器执行链旁边多了一条折叠路径；共享的纯折叠与“增量等于全量”的属性测试保证两者一致。

</details>
