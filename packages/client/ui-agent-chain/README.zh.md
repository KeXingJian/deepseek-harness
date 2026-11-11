---
description: "Web GUI 的评审执行链视图：在八类卡片投影之上提供筛选、逐卡展开和评审风险标记。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-chain

[English](README.md) | 中文

## 概述

评审执行链视图把单个会话的 agent 活动压缩成一条可读的执行链，放在会话视图里。<br>它注册 `执行链`（英文 `Chain`）视图标签，渲染 `dsh-agent-activity` 投影产出的八类卡片，支持筛选、展开单卡记录的事实与依据，并在列表上方展示评审风险标记。<br>卡片记录的路径可在右侧栏预览中打开文件，依据行可在“轨迹”中打开对应工具调用。<br>插件只在浏览器运行；Node 侧是一个空的 `apply`，只为让这个包成为一条 Loader 行。

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

每行包含状态点、带字形与类型名的类别标签、一行标题；投影合并了重复工作时还会带上重复次数。<br>卡片类型有 `prompt`、`thinking`、`intent`、`recon`、`change`、`verify`、`interrupt`、`result`，八类一眼就能分开：类别标签各用自身墨色与底色，提示词是带左侧竖线的填充块，改动卡片带描边，交接行是琥珀底色，收尾的结果行上方有一条分隔线。<br>思考卡片多一行该步骤的行动计数摘要，按读者语言组合，并拥有该步骤的行动子卡：子卡缩进挂在它下面，各自带展开按钮，一行读完"想了什么、做了什么"而不用离开这个步骤。<br>投影把每个标题作为消息描述符提供，失败卡片始终单独成卡；措辞由本包字典拥有，并由 `chain-copy.ts` 解析。

三个筛选器收窄列表：`全部`、`仅看改动`、`只看风险`。<br>`只看风险` 只保留失败与告警卡片，不影响风险条——只要投影报告了标记，风险条就一直可见。<br>挂在思考卡片下的命中子卡会提升到顶层单独成行，筛选不会因为父卡片而漏掉某次改动或某个风险。<br>筛选结果为空时显示专门的空态，而不是“还没有记录到活动”。

### 展开单张卡片

展开按钮揭示卡片记录的内容：具名事实（用户提示词原文、步骤的思考、路径、命令、工具、操作、文件数、检索数），以及每条来源 span 的一行——会话日志序号、span 名称与结算状态。<br>工具记录了变更原文的改动卡片，会在这些之前显示行级差异——该文件的变更前后行，按行数上限折叠并带自己的展开控件——评审员读到的就是这次编辑本身。<br>没有事实、差异或依据的卡片不提供展开按钮；快照里已不存在的依据序号会被跳过。

### 打开卡片指向的对象

路径按会话工作区根显示为相对路径，记录时的路径留在悬停标题里。<br>路径事实与风险标记里的文件都是按钮：点击在右侧栏预览中打开该文件，地址按同一个根解析，评审者可以在执行链旁直接读文件。<br>来自工具调用的依据行会通过会话的检查目标在“轨迹”中打开该调用；轮次与步骤 span 保留序号，但没有可检查的调用。

<a id="understand-the-implementation"></a>
## 理解实现

插件在 `apply` 里贡献四样东西：`agentChain` 字典、一个 Conversation Definition、一个 Conversation 视图 target，以及一个 `conversation.view` 槽位条目。

- `chainDefinition` 匹配执行链读取的八种持久事件，并通过 `@deepseek-ai/dsh-agent-activity` 折叠它们。<br>它同时把每条 `tool/result` 的 `diffs` 负载按调用标识记录下来——span 只保留调用标识、不保留文件文本——构建节点时再把这份记录作为 `chainFromSpans` 的第三项传入。<br>额外不落任何东西：文本本来就在日志已有的工具结果里。<br>每个匹配事件都作为 start 候选：引擎用已加载历史窗口里最早的事件初始化 Context，其余按 update 应用，窗口滑动时也会重新推导执行链。<br>它构建的节点同时携带折叠结果与来源 span，因此展开时可以按序号读取单条 span。
- `chainViewDefinition` 按会话发布一份快照 —— `{ cards, flags, spans }` —— 来自 Definition 构建的节点。<br>该节点复用引擎生成的 Context key；自己手写的 key 过不了引擎的身份校验。
- `AgentChainView` 通过槽位的 `useChain` hook 与 `t` 座位渲染快照。<br>它通过框架的 `useSessions` 座位读取会话工作区根，把每个要显示的路径相对它缩短，而 `openFile` 仍然收到记录时的路径。<br>`chain-copy.ts` 持有筛选、类型字形、严重级的词汇，通过字典解析卡片标题与风险原因，并推导展开行与依据行，因此组件里既没有文案副本，也不访问服务。<br>视图从会话视图的 owner share 收到 `inspectCall`，并用 span 记录的调用标识调用它。
- 槽位的 `inject` 面在点击时从 `sessions.list` 读取会话工作区根，把卡片路径解析为会话作用域的文件地址并通过 `sidebarRight.openResource` 打开；读取文件内容由预览自己负责。
- 样式是一个基于 `--dsw-*` 令牌的 CSS Module；根节点宽度限制在 `--dsh-chat-content-width`，自身不滚动，滚动由会话滚动容器负责。

<a id="further-exploration"></a>
## 进一步探索

- [会话视图参考](../../../docs/subsystems/conversation.zh.md) —— Definition、视图 target 与承载视图的槽位。
- [评审活动链](../../../docs/subsystems/review-chain.zh.md) —— 本视图渲染的 span 与卡片类型，以及其字典解析的消息。
- [`dsh-agent-activity`](../../review/agent-activity/README.zh.md) —— 本视图渲染的 span 折叠、八类卡片与风险规则。
- [`dsh-client-ui-primitives`](../ui-primitives/README.zh.md) —— 本视图组合的 `Pill`、`Tag`、`StateDot`，以及类别标签使用的产品图标。

<a id="model-experience"></a>
## 模型体验

无，因为该视图只渲染已提交的会话日志，不向提示词、工具结果或模型请求添加任何内容。

#### KV Cache effect

无。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **计数没有单复数形式** —— 字典消息接收数字后只渲染一个模板，因此英文执行链会显示 "1 searches" 而不是单数形式。
- **执行链自身还不能折叠** —— 所有卡片都会渲染；尚无“全部收起”或按类型分组。
- **轮次与步骤依据不能跳转** —— 只有工具调用 span 带有“轨迹”可聚焦的调用标识，因此轮次与步骤依据行只是标签。
- **差异只覆盖记录下来的文本** —— 工具结果里没有 `diffs` 的改动（shell 删除、只上报操作类型的工具）只显示路径与操作，不显示差异；视图不会去读文件倒推。
- **子卡属于它所在的步骤** —— 同一文件在两个步骤里各改一次，就是两张卡片、分属两张思考卡，因为卡片属于促成它的那段思考。

<a id="dev-note"></a>
### 开发备注

标签注册进 `conversation.view`，而不是右侧栏：执行链是对单个会话的一种阅读，而视图标签栏已经承载了该会话的其他阅读方式（对话、轨迹）。<br>文件链接随后落在右侧栏，因为它的预览已经能解析会话作用域的文件地址；执行链本身从不读取文件。
