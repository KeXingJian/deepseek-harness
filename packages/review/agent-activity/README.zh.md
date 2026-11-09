---
description: "面向评审的执行链：把 agent 活动 span 折叠成六类可读卡片，并给出评审风险标记。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-activity

[English](README.md) | 中文

## 概述

`dsh-agent-activity` 把折叠后的 agent 活动 span 变成一条评审员可以直接读的短链，而不必回放整个会话：它打算做什么、看了哪些地方、改了什么、验证了什么、人何处介入。它同时给出评审员通常靠人工盯的风险标记——改测试、改 CI 或构建配置、删除文件、范围外改动、未验证改动、反复失败、方案抖动。

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

按序号顺序传入采集层 span，调用 `chainFromSpans(spans, userText?)`，得到 `{ cards, flags }`。

```ts
import { chainFromSpans } from '@deepseek-ai/dsh-agent-activity'

const { cards, flags } = chainFromSpans(spans, '请修复排序的空数组问题')
```

### 折叠会话日志

`foldActivity(events)` 把 Session 日志折叠成链所需要的 span。它读取 turn、step、assistant 与 tool 事件；缺少结束事件的 span 保持 `running`，不是 JSON 的工具参数则不带任何属性。事件逐条到达时，用 `createActivityFolder()` 增量应用并读取同样的 span；`foldActivity()` 就是它对整份日志的一次运行。

```ts
import { chainFromSpans, foldActivity } from '@deepseek-ai/dsh-agent-activity'

const { cards, flags } = chainFromSpans(foldActivity(events))
```

### 卡片

| 类型 | 来源 span | 回答的问题 |
|---|---|---|
| `intent` | 带 `intent` 属性的 `turn` | 它打算做什么 |
| `recon` | `read`/`grep`/`glob`/`list`/`lsp` 工具、子代理交接 | 它看了哪里 |
| `change` | `write`/`edit` 工具与删除操作 | 它改了什么 |
| `verify` | `bash`/`test`/`build`/`lint`/`run_code` 工具、工作流阶段 | 它验证过吗 |
| `interrupt` | 审批与提问工具 | 人何时介入 |
| `result` | 由整条链汇总 | 交付了什么 |

合并规则保留评审语义：相邻的勘察卡合成一张计数摘要，同一文件的重复修改合成一张并带 `repeat` 次数，失败验证永不合并，连续成功验证折叠为一张。整条链有上限，长会话仍能一屏读完。

### 风险标记

| 标识 | 级别 | 规则 |
|---|---|---|
| `touches-tests` | warn | 改动的路径是测试文件 |
| `touches-ci` | warn | 改动的路径是 CI 或构建配置 |
| `deletes` | danger | 会话删除了文件 |
| `out-of-scope` | info | 原地修改了会话从未读过、任务也未点名的文件 |
| `unverified` | danger | 有改动但没有任何通过的验证 |
| `gave-up` | warn | 同一验证反复失败后仍在继续修改 |
| `plan-churn` | info | 出现五个及以上不同意图 |

每个标记都带上命中的文件；展示层给出原因与证据，而不是一个没有依据的警告。

<a id="understand-the-implementation"></a>
## 理解实现

本包是两段式纯投影，没有 I/O，也不依赖 Cordis：先由 span 得到卡片，再由卡片与 span 得到标记。卡片按序号顺序生成，按固定次序合并（勘察、同文件改动、验证、意图、上限），最后追加结果卡。标记最后计算，因此被标记的改动可以显示为 `warning`，而底下的 span 不变。

`evidenceSeqs` 是"可质疑"的保证：读者若不信某张卡，就打开它依据的事件序号。

<a id="further-exploration"></a>
## 延伸阅读

- [Session 事件](../../core/session/README.zh.md) —— 采集层折叠成 span 的持久事实。
- [Session 子系统](../../../docs/subsystems/session.zh.md) —— span 所依据的事件词汇。
- [Trajectory 视图](../../client/ui-trajectory/README.zh.md) —— 逐条记录台账；本链刻意做它的摘要而非复刻。

<a id="model-experience"></a>
## 模型体验

无。本包只投影面向评审的链数据，不注册任何模型可见内容。

#### KV Cache effect

无；本包既不组装也不发送模型请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **不提供服务也不做持久化** —— 本包只投影调用方给出的 Session 事件或 span；持久化、实时投递与渲染属于消费插件。
- **只读持久事件** —— 审批、子代理交接、工作流阶段属于实时 Cordis 事件而非 Session 记录，因此从日志折叠出的链不包含它们。
- **意图是模型原话** —— `intent` 卡取该轮第一个非空 assistant 文本块，不是本包生成的摘要。
- **范围外匹配是启发式** —— 它把改动路径与会话读过的路径、调用方给出的任务文本比对，并按"推断"呈现结果。
- **目前只有一个消费方** —— `dsh-client-ui-agent-chain` 渲染这些卡片与标记；从卡片跳回依据属于该视图的工作。
- **不推断删除行数** —— 删除只报告文件，不报告会话并未记录的行数。
- **上限只压缩勘察卡** —— 会话若改了三十个以上不同文件，仍会一文件一卡；把不同文件合并起来，恰好会藏掉评审员必须看的东西。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文 —— 点击展开</summary>

无。

</details>
