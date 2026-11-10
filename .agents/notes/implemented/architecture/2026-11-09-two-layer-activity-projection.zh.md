# Agent Note: Project review activity twice — spans for collection, messages for presentation

Status: implemented

[English](2026-11-09-two-layer-activity-projection.md) | 中文

## 问题

阅读一段 Session 的评审者要的是一条简短的执行链，而不是回放：代理想做什么、看过哪里、改了什么、验证了什么、人类在哪一步介入。同一批已记录的活动还要回答执行链根本不展示的问题——跑了多少次工具调用、各 span 家族各耗多久、这段会话的整体开销——而且要在浏览器关闭、进程结束之后依然能回答。

一个投影无法同时满足两者。如果推导执行链的投影顺便把句子也写好了，每个消费方都会继承那个包的语言：任何语言的 Web 视图、录制快照、将来的导出。仓库"客户端 UI 文案归类型化语言字典所有"的规则使这种泄漏成为缺陷而非捷径，而这条规则在根本不是 UI 的包里最尖锐。反过来，如果唯一消费方自己折叠事件，全量计数视图就要再付一次折叠成本，无头调用方也拿不到计数。

## 决定

评审活动分两层投影，方向严格单向，每一层拥有一种产出。

| 层 | 包 | 输入 | 输出 | 拥有 |
|---|---|---|---|---|
| 采集 | `@deepseek-ai/dsh-agent-activity` | 已提交的 `SessionEvent`（或调用方提供的 span 列表） | `ActivitySpan[]` 及增量维护的 `ActivitySummary` | 计时、结算状态、评审相关的记录事实 |
| 呈现 | `@deepseek-ai/dsh-agent-activity` | `ActivitySpan[]` 与用户任务文本 | `ChainCard[]`、`RiskFlag[]` | 卡片顺序、合并规则、风险规则 |

两层都是对已记录事实的纯函数：没有 I/O、没有 Cordis 服务、没有存储、没有时钟。执行链从不持久化——它由 span 重算，成本是一次线性遍历。

呈现层中面向读者的文字是消息描述符而不是字符串。`ChainTitle` 与 `RiskReason` 指明是哪条消息，并携带它要插值的值；消费视图通过自己的语言字典解析。唯一例外是 `intent` 卡片，它的标题就是模型自己写的那句话，原样保留。`ChainCard.meta` 以机器可读形式携带同一批记录事实——目标路径、命令、工具名、操作、合并后的计数——使展开的卡片与风险规则都不必解析标题。

采集结果由 `@deepseek-ai/dsh-agent-trace` 通过 `ctx.agentTrace` 单独持久化。存储记录 = 摘要 + 计算时的日志位置（`asOfSeq`）与折叠语义（`traceVersion`），按会话 id 及其 `createdAt` 生命周期标签作键。span 本身不存储：冷会话的 `sessionTrace` 读取会通过 `ctx.sessionQuery` 重放会话日志，并在返回时顺带刷新已存的摘要。

## 考虑过的替代方案

**存下渲染好的卡片列表。** 存好的执行链能让历史视图跳过折叠。它失败的原因在于执行链是语言相关的：存下来的执行链冻结了写下它的人所用的语言，之后切换语言也无法修复。改存 span 则既能重建执行链也能得到任何计数，代价是每次读取多一次廉价的折叠。

**由呈现层直接产出英文句子。** 这是换了个措辞的同一种泄漏：数据包依然拥有产品文案，非英语读者、翻译后的导出或录制快照都会带上视图无法替换的文字。消息描述符把每条消息的身份留在投影里，把措辞留在字典里。

**让每个消费方自行折叠 Session 事件。** Web 视图已经在浏览器里折叠，看起来够用。它对采集层存在的两个调用方都不成立：需要重算同一次折叠的全量计数视图，以及完全没有浏览器半边的无头 Host 消费方。

**持久化 span 本身。** 存 span 能让冷会话在不重放日志的情况下同时回答 `sessionSummary` 与 `sessionTrace`。代价是存储量随会话长度无界增长，且随每次工具调用膨胀；而摘要是每个会话一条定长记录，有界保留对（`retentionDays`、`maxRecords`）只对摘要成立。

## 影响

执行链与计数共用一次折叠，因此改变 span 结算的规则会同时改变两者；属性测试用同一批 span 对比增量计数与从头汇总，使两者不可能漂移。`ACTIVITY_TRACE_VERSION` 是失效杠杆：带其他版本的已存摘要会被重算而不是直接返回。

由于两层都不接触 Session store，投影可以从任何地方调用——测试、将来的导出器、CLI。代价是想要执行链的调用方必须自己再跑一次采集层，而想要持久化形式的调用方必须挂载存储栈。

由于投影产出消息而非句子，Web 视图现在是面向读者的执行链文案（包括风险原因）的唯一所有者。仓库的字典一致性门禁因此无需特例就能覆盖该特性：新增一个消息变体会让视图的字典缺项变成编译错误。

## 验证

- `tests/aggregate.properties.spec.ts` 在生成的事件序列上钉住"增量计数等于从头汇总"。
- `tests/chain.golden.spec.ts` 端到端钉住三个录制用例：卡片顺序、状态、依据序号与风险发现。
- `packages/client/ui-agent-chain/tests/chain-copy.client.spec.ts` 通过随包发布的字典逐一执行每个标题与原因变体；`scripts/locale-dictionary-parity.spec.ts` 拒绝丢失键或占位符的字典。
- `packages/review/agent-trace/tests/loader-composition.spec.ts` 通过真实 Loader 启动随包发布的 storage 与 trace 行，并读回已持久化的摘要。
