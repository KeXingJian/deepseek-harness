---
description: "Web GUI 的评审执行链视图：在六类卡片投影之上提供筛选、逐卡展开和评审风险标记。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-chain

[English](README.md) | 中文

## 概述

评审执行链视图把单个会话的 agent 活动压缩成一条可读的执行链，放在会话视图里。<br>它注册 `执行链`（英文 `Chain`）视图标签，渲染 `dsh-agent-activity` 投影产出的六类卡片，支持筛选、展开单卡记录的事实与依据，并在列表上方展示评审风险标记。<br>插件只在浏览器运行；Node 侧是一个空的 `apply`，只为让这个包成为一条 Loader 行。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把插件与 `ui-conversation`、`ui-renderer`、`ui-primitives` 一起挂载；它声明依赖 `slots`、`uiConversation`、`locale`。<br>会话一旦有可折叠的活动，标签就会出现在“对话”和“轨迹”旁边。

### 阅读执行链

每行包含状态点、卡片类型、一行标题；投影合并了重复工作时还会带上重复次数。<br>卡片类型有 `intent`、`recon`、`change`、`verify`、`interrupt`、`result`；标题由投影决定，失败卡片始终单独成卡。

三个筛选器收窄列表：`全部`、`仅看改动`、`只看风险`。<br>`只看风险` 只保留失败与告警卡片，不影响风险条——只要投影报告了标记，风险条就一直可见。<br>筛选结果为空时显示专门的空态，而不是“还没有记录到活动”。

### 展开单张卡片

展开按钮揭示卡片记录的内容：投影的详情文本、具名事实（路径、命令、工具、操作、文件数、检索数），以及评审者可以回到会话日志核对的依据序号。<br>没有详情、事实或依据的卡片不提供展开按钮。

<a id="understand-the-implementation"></a>
## 理解实现

插件在 `apply` 里贡献四样东西：`agentChain` 字典、一个 Conversation Definition、一个 Conversation 视图 target，以及一个 `conversation.view` 槽位条目。

- `chainDefinition` 匹配执行链读取的七种持久事件，并通过 `@deepseek-ai/dsh-agent-activity` 折叠它们。<br>每个匹配事件都作为 start 候选：引擎用已加载历史窗口里最早的事件初始化 Context，其余按 update 应用，窗口滑动时也会重新推导执行链。
- `chainViewDefinition` 按会话发布一份快照 —— `{ cards, flags }` —— 来自 Definition 构建的节点。<br>该节点复用引擎生成的 Context key；自己手写的 key 过不了引擎的身份校验。
- `AgentChainView` 通过槽位的 `useChain` hook 与 `t` 座位渲染快照。<br>`chain-copy.ts` 持有筛选、类型、严重级的词汇与展开行，因此组件里既没有文案副本，也不访问服务。
- 样式是一个基于 `--dsw-*` 令牌的 CSS Module；根节点宽度限制在 `--dsh-chat-content-width`，自身不滚动，滚动由会话滚动容器负责。

<a id="further-exploration"></a>
## 进一步探索

- [会话视图参考](../../../docs/subsystems/conversation.zh.md) —— Definition、视图 target 与承载视图的槽位。
- [`dsh-agent-activity`](../../review/agent-activity/README.zh.md) —— 本视图渲染的 span 折叠、六类卡片与风险规则。
- [`dsh-client-ui-primitives`](../ui-primitives/README.zh.md) —— 本视图组合的 `Pill`、`Tag`、`StateDot`。

<a id="model-experience"></a>
## 模型体验

无，因为该视图只渲染已提交的会话日志，不向提示词、工具结果或模型请求添加任何内容。

#### KV Cache effect

无。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **依据只是文本，还不能跳转** —— 卡片展示依据序号；打开对应文件或事件属于评审联动的工作。
- **标题未本地化** —— 卡片标题与风险原因是 `dsh-agent-activity` 投影产出的中文常量；把它们搬进字典属于本地化收尾。
- **执行链自身还不能折叠** —— 所有卡片都会渲染；尚无“全部收起”或按类型分组。
- **槽位 inject 闭包未覆盖** —— 逐文件覆盖率门禁还触达不到 `apply` 里按会话绑定的 `inject` 回调，因为整客户端 spec 启动时没有会话；包内其余文件均为 100%。

<a id="dev-note"></a>
### 开发备注

标签注册进 `conversation.view`，而不是右侧栏：执行链是对单个会话的一种阅读，而视图标签栏已经承载了该会话的其他阅读方式（对话、轨迹）。
