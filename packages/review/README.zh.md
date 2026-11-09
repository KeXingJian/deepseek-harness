---
description: "review 组：把已记录的 agent 活动投影成人工代码评审做决定所需要的信息。"
kind: "package-group"
---

# packages/review

[English](README.md) | 中文

## 概述

`review` 组回答的是评审员的问题，而不是调试员的问题：不是"完整经过是什么"，而是"它改了什么、为什么改、值不值得信"。本组的包把已记录的会话事实投影成人在合入 diff 之前会读的形式。它们不采集数据、不拥有会话日志、不负责渲染；采集与呈现属于消费它们的插件。

选择本组，意味着主题是人对 agent 工作成果的判断。任何模型可见的内容、任何需要持久化的内容，都留在别处对应的能力里。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx key |
|---|---|---|
| [`agent-activity/`](agent-activity/README.zh.md) | 把折叠后的活动 span 投影成六类卡片执行链与评审风险标记 | —（库） |

<a id="related-documentation"></a>
## 相关文档

- [Session 子系统](../../docs/subsystems/session.zh.md) 拥有采集层折叠之前的持久事件。
- [`ui-trajectory`](../client/ui-trajectory/README.zh.md) 呈现逐条记录台账；本组刻意做摘要而非罗列。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>面向维护者的工作上下文 —— 点击展开</summary>

无。

</details>
