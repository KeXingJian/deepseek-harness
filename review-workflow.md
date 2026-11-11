# 评审双模块工作流程（agent-activity / agent-trace）

> 本文档用 Mermaid 梳理 `packages/review` 下两个包的数据流、状态机与落盘位置。
> 源码依据：`packages/review/agent-activity/src`、`packages/review/agent-trace/src`。

## 0. 一图看懂

一句话：**agent-activity 是纯函数投影库（事件→跨度→卡片/风险），agent-trace 是宿主侧采集服务（同一份跨度→计数→持久化）。**

```mermaid
flowchart TB
    subgraph LOG["Session 日志（唯一事实来源）"]
        E["turn/start · step/start · user/message · assistant/message<br/>tool/call · tool/result · step/end · turn/end"]
    end

    E -->|"每提交一个事件调用一次"| FOLD["applyActivityEvent<br/>增量折叠"]
    FOLD --> SPANS["ActivitySpan[]<br/>turn / step / tool"]

    SPANS --> CHAIN["chainFromSpans<br/>六步变换"]
    CHAIN --> CARDS["ChainCard[]<br/>prompt / thinking / intent / recon / change / verify / interrupt / result"]
    CHAIN --> FLAGS["RiskFlag[]<br/>7 条评审风险规则"]
    CARDS --> UI["ui-agent-chain<br/>浏览器会话视图"]
    FLAGS --> UI

    SPANS --> AGG["ActivitySummary<br/>按类别/状态的计数与耗时"]
    AGG --> DISK[("~/.dsh/storages/agent_trace/sessions/*.json")]

    classDef store fill:#eef,stroke:#88a
    class DISK store
```

关键点：`ui-agent-chain` 在**浏览器**里自己折叠，读的是 `agent-activity`；`agent-trace` 在**宿主**里折叠出计数并落盘，目前还没有读取方。

---

## 1. 阶段一：事件 → 跨度（fold）

`applyActivityEvent(state, event)` 是唯一的状态推进函数，`foldActivity(events)` 只是对整份日志循环调用它。

```mermaid
flowchart LR
    subgraph OPEN["开启一个跨度"]
        T1["turn/start"] --> S1["turn 跨度 running<br/>openTurns[turn]=下标"]
        T2["step/start"] --> S2["step 跨度 running<br/>openSteps[turn:step]=下标"]
        T3["tool/call"] --> S3["tool 跨度 running<br/>openCalls[callId]=下标"]
    end

    subgraph SETTLE["结算一个跨度"]
        T4["turn/end"] --> S4["endTime=事件时间<br/>error→error · aborted/blocked→cancelled · 其他→ok"]
        T5["step/end"] --> S5["endTime=事件时间<br/>固定 ok"]
        T6["tool/result"] --> S6["isError→error · 否则 ok<br/>有 error.code 时追加 errorCode 属性"]
    end

    subgraph ATTRIBUTE["附着属性"]
        T7["assistant/message"] --> S7["首个非空文本块 → turn 跨度的 intent<br/>已有 intent 则不再覆盖"]
        T9["user/message 且 source.kind=user<br/>（最近开启的回合）"] --> S10["首个人类提示词 → turn 跨度的 prompt<br/>同时记录该事件的 promptSeq"]
        T11["assistant/message 的 reasoning 块"] --> S12["累加到该回合当前步骤 → step 跨度的 thinking<br/>首次贡献的序号记为 thinkingSeq，截断到 2000 字符"]
        T8["tool/call 参数解析"] --> S8["抽取 path / file / command / pattern / op"]
        S8 --> S9["bash 且命令以 rm 开头<br/>→ op=delete, path=删除目标"]
    end
```

设计约束：

- **非破坏性更新**：函数永不修改入参，未改变的状態返回同一引用（上层可直接用引用比较短路重渲染）。
- **迟到事件不补**：`turn/end`、`step/end`、`tool/result` 找不到对应的开启记录时直接返回原状态，不凭空造跨度。
- **提示词挂在回合、思考挂在步骤**：`user/message` 不携带回合编号，因此记到最近开启的回合；合成注入（插件上下文、召回历史、目标续跑）不是人类提示词，不记录。思考记到 `assistant/message` 自带的 turn/step；步骤未开启时丢弃。同一事件同时推进回合的 `intent` 与步骤的 `thinking`。
- **只有三类跨度会产出**：`request`、`subagent`、`workflow`、`compaction` 在类型里存在，当前 folder 从不产出，计数恒为 0。
- **`seq` 是跨度身份**：每个跨度记录它开启时的会话事件序号，是后续"证据回溯"的锚点。

---

## 2. 阶段二：跨度 → 卡片（chainFromSpans）

```mermaid
flowchart LR
    A["1. baseCards<br/>逐跨度出卡"] --> B["2. mergeRecon<br/>相邻探查合并计数"]
    B --> C["3. mergeChanges<br/>同文件变更合并 repeat++"]
    C --> D["4. foldVerifies<br/>连续 ≥3 次成功校验折叠"]
    D --> E["5. dedupeIntents<br/>相似度 ≥0.8 去重"]
    E --> F["6. resultCard<br/>追加收尾卡片"]
    F --> G["7. capCards<br/>超 30 张时优先压探查"]
    G --> H["8. reviewFlags<br/>计算风险标记"]
    H --> I["9. 被标记的 change 卡片<br/>状态改为 warning"]
```

### 2.1 分类规则（第 1 步）

```mermaid
flowchart TD
    S["一个 ActivitySpan"] --> K{"跨度类别"}
    K -->|turn| P{"有 prompt 属性?"}
    P -->|是| PC["prompt 卡片<br/>依据 promptSeq"]
    P -->|否| I{"有 intent 属性?"}
    PC --> I
    I -->|是| IC["intent 卡片"]
    I -->|否| DROP["不出卡"]
    K -->|step| TH{"有 thinking 属性?"}
    TH -->|是| TC["thinking 卡片<br/>依据 thinkingSeq<br/>actions=同步骤工具计数<br/>children=同步骤工具卡片"]
    TH -->|否| DROP
    K -->|subagent| SB["recon 卡片<br/>标题区分成功/失败"]
    K -->|workflow| WF["verify 卡片<br/>阶段完成/失败"]
    K -->|tool| TI{"工具属于哪一类"}

    TI -->|"approval / ask_user"| IN["interrupt 卡片<br/>状态 warning"]
    TI -->|"op=delete 或 delete 工具"| DEL["change 卡片 op=delete<br/>状态 error"]
    TI -->|"bash / exec / test / build / lint / run_code"| EX["verify 卡片<br/>通过/失败，带 command"]
    TI -->|"write / edit / apply_patch 等"| WR["change 卡片 op=create/update"]
    TI -->|"read / grep / glob / web_* 等"| RC["recon 卡片<br/>带 files / searches 计数"]
    K -->|"request / compaction"| DROP
```

> 顺序很重要：删除要先于执行类判断，否则 `bash rm` 会被误读成一次校验。

### 2.2 合并语义（第 2–7 步）

| 步骤 | 规则 | 为什么 |
|---|---|---|
| `mergeRecon` | 只合并**相邻**且都来自工具的探查卡片；子代理交接不参与 | 一次连续翻文件是"看了一圈"，分散在两头则是两个阶段 |
| `mergeChanges` | 同一路径的变更卡片合并为一张，`repeat` 累加，位置保留首次编辑处 | 评审者关心"这个文件被改了"，不是被改了几次 |
| `foldVerifies` | 连续成功的校验 ≥3 次折成一张 `verifyRun`；**失败校验永远独立保留** | 失败是评审信号，折叠会掩盖它 |
| `dedupeIntents` | 与上一个 intent 相似度 ≥0.8 时合并，除非中间隔了中断或失败校验 | 模型反复复述同一个计划不是新计划 |
| `resultCard` | 汇总变更文件数、校验次数；有改动但无成功校验时状态为 error | 给整条链一个结论 |
| `capCards` | 超过 30 张时，反复合并最前面的两张探查卡片 | 只压探查，因为压掉不同文件的变更会藏住必须看的东西 |

> 合并按层进行：顶层卡片合成一层，每张思考卡片的 `children` 再各自合成一层。思考卡片不参与任何合并，并且会把相邻勘察卡隔开：每个步骤的行动子卡各自成层，这正是"思考 + 行动"要表达的配对关系；同一文件在两个步骤里各改一次就是两张子卡，因为卡片属于促成它的那段思考。

### 2.3 卡片契约

- **标题是消息描述符，不是文案**：`prompt` 是用户原话、`thinking` 是模型思考首句、`intent` 是模型原话（都截断到 60 字符），其余只描述"用哪条文案 + 插值什么值"，具体语言由 UI 查自己的字典 → 投影层永不产生产品文案。
- **`evidenceSeqs`**：每张卡片记录它由哪些会话事件序号构成，评审者可以点开回原始事件；`prompt` 卡片依据写下它的那条 `user/message`，`thinking` 卡片依据它展示思考的那条 `assistant/message`。
- **`actions`**：思考卡片用 `ChainActions`（files / searches / changes / verifications 计数）描述同一步骤触发的行动，供 UI 组合成一行摘要。
- **`children`**：同一步骤的工具调用成为该思考卡片的子卡，按事件顺序排列并以缩进子卡渲染；没有记录思考的步骤，工具卡片留在顶层平铺。结果卡与风险规则统计的是展开后的全部卡片，因此子卡里的改动同样计入文件数与风险标记。
- **`diffs`**：改动卡片可携带 `ChainDiff`（path / oldText / newText，记录时变更前后的原文），由 `chainFromSpans(spans, userText?, diffs?)` 的第三项按工具调用标识传入——跨度只记录调用标识，不记录它改过的文件文本。投影只挂载、不计算补丁；同一文件的多次改动合并时差异块按顺序拼接，行级补丁由 UI 的 `DiffBlock` 派生。
- **`meta`**：同一事实的机器可读副本，供展开视图与风险规则使用；用户提示词全文放在 `prompt` 卡片的 `meta.prompt`，步骤的思考原文放在 `thinking` 卡片的 `meta.thinking`。
- **提示词、思考与意图都不参与合并**：`prompt` 卡片按回合出现一次，`thinking` 卡片按步骤出现一次，`dedupeIntents` 只合并相似意图——每句人类要求和每步思考都是独立事实。

---

## 3. 阶段三：风险标记（reviewFlags）

```mermaid
flowchart TD
    IN["输入：spans + cards + 用户任务文本"] --> R1{"有测试文件被改?"}
    R1 -->|是| F1["touches-tests · warn"]
    IN --> R2{"有 CI / 构建配置被改?"}
    R2 -->|是| F2["touches-ci · warn"]
    IN --> R3{"有删除操作?"}
    R3 -->|是| F3["deletes · danger"]
    IN --> R4{"改了没读过、<br/>任务文本也没提到的文件?"}
    R4 -->|是| F4["out-of-scope · info"]
    IN --> R5{"有改动但没有成功校验?"}
    R5 -->|是| F5["unverified · danger"]
    IN --> R6{"同一命令失败 ≥2 次<br/>且仍在改?"}
    R6 -->|是| F6["gave-up · warn"]
    IN --> R7{"intent 卡片 ≥5 张?"}
    R7 -->|是| F7["plan-churn · info"]
    F1 --> OUT["按 danger → warn → info 排序"]
    F2 --> OUT
    F3 --> OUT
    F4 --> OUT
    F5 --> OUT
    F6 --> OUT
    F7 --> OUT
```

最后一步只把**被标记的 `change` 卡片**（不含 `unverified`）状态改成 `warning`，底层跨度不变——标记是视图层信息，不改写事实。

---

## 4. agent-trace：采集服务生命周期

```mermaid
stateDiagram-v2
    [*] --> 初始化: Service.init
    初始化 --> 空闲: 打开 agent_trace 域 + 首次 prune
    空闲 --> 跟踪中: session/created 且 seq 为 0
    跟踪中 --> 脏: 连续事件推进折叠
    脏 --> 脏: 继续累积 pending
    脏 --> 跟踪中: flush 写盘 清零 pending
    跟踪中 --> 已退役: session/disposed
    脏 --> 已退役: session/disposed 前先写最后一次
    已退役 --> [*]: 丢弃内存折叠

    跟踪中 --> 跟踪中: 冷读缺失/落后时<br/>重建折叠并写盘
```

### 4.1 写触发条件

```mermaid
flowchart LR
    EV["每个连续事件"] --> M["markDirty"]
    M --> Q{"立即写?"}
    Q -->|"事件是 turn/end"| W["write：整条记录替换"]
    Q -->|"pending ≥ flushEveryEvents"| W
    Q -->|"都不是"| T["挂一个 flushIntervalMs 定时器<br/>（unref，不阻止进程退出）"]
    T -->|"到期"| W
    W --> Q2["table.put → 域的写链<br/>原子替换一个文件"]
    Q2 -->|"失败"| LOG["记 warning，内存折叠仍权威<br/>下次写入覆盖（fail-soft）"]

    D["session/disposed"] --> FF["flushAll：刷全部脏摘要<br/>并排空 inflight"]
    X["Service 销毁"] --> FF2["flushAll 后 close 域"]
```

### 4.2 读路径

```mermaid
sequenceDiagram
    participant C as 调用方
    participant T as AgentTrace
    participant S as sessions
    participant Q as sessionQuery
    participant D as 存储域

    C->>T: sessionSummary / sessionTrace
    T->>S: get(sessionId)
    alt Session 活跃
        T->>T: ensureLive：内存折叠是否落后
        opt 落后或缺失
            T->>Q: readSession 读完整日志
            Q-->>T: 事件快照
            T->>T: 从头折叠，替换跟踪态
            T->>D: 写回一份摘要
        end
        T-->>C: 实时摘要 / 跨度
    else 不活跃但已存记录
        T->>D: 读记录
        T->>T: 校验 traceVersion 与 createdAt
        T-->>C: 存下来的摘要
    else 不活跃且无记录
        T->>Q: readSession 冷读
        alt 可读
            T->>D: 顺带写回摘要
            T-->>C: 折叠结果
        else 不可读
            T-->>C: undefined
        end
    end
```

### 4.3 两道版本护栏

| 字段 | 绑定对象 | 不符时的处理 |
|---|---|---|
| `traceVersion` | 折叠语义版本 `ACTIVITY_TRACE_VERSION` | 记录视为不存在，重新计算 |
| `createdAt` | Session 生命周期的创建时间 | 判定为"同一 id 的前世"，删除旧记录而不是对外服务 |

---

## 5. 落盘位置与文件结构

```mermaid
flowchart LR
    H["DSH_HOME<br/>默认 ~/.dsh"] --> ST["storages/"]
    ST --> DM["agent_trace/"]
    DM --> TB["sessions/"]
    TB --> F1["0f7fec81-....json"]
    TB --> F2["15ba1561-....json"]
    TB --> F3["… 每个 Session 一个文件"]
```

```
~/.dsh/storages/agent_trace/sessions/<sessionId>.json
```

```json
{
  "version": 1,
  "record": {
    "traceVersion": 1,
    "createdAt": 1794294733745,
    "asOfSeq": 199,
    "updatedAt": 1794294800000,
    "summary": {
      "spansByKind": { "turn": 3, "step": 12, "tool": 28, "request": 0, "subagent": 0, "workflow": 0, "compaction": 0 },
      "spansByStatus": { "running": 0, "ok": 40, "error": 1, "cancelled": 0, "interrupted": 0 },
      "durationByKind": { "turn": 183000, "step": 90000, "tool": 42000, "request": 0, "subagent": 0, "workflow": 0, "compaction": 0 }
    }
  }
}
```

- `per-record` 布局：一次 flush 只原子重写**一个**文件，不重写整表。
- 目录**惰性创建**：`open()` 不碰磁盘，首次写入才 `mkdir`。
- 保留策略：`retentionDays`（默认 30 天）与 `maxRecords`（默认 500 条）在域打开时、以及出现新 Session id 时清理。

---

## 6. 端到端：一次任务从产生到展示

```mermaid
sequenceDiagram
    participant M as 模型
    participant S as Session
    participant H as 宿主
    participant T as AgentTrace
    participant B as 浏览器 ui-agent-chain

    M->>S: turn/start → step/start → tool/call …
    S->>H: 提交每个事件 session/event
    H->>T: record(session, event)
    T->>T: applyActivityEvent 推进折叠 + markDirty

    S->>H: turn/end
    H->>T: record（mandatory）
    T->>T: write → 域写链 → 原子替换 JSON

    Note over B: 浏览器端独立折叠同一份事件
    B->>B: applyActivityEvent → chainFromSpans
    B-->>B: 卡片 + 风险标记渲染
```

---

## 7. 现状与边界

| 事实 | 影响 |
|---|---|
| 卡片链在浏览器折叠 | 宿主侧的 `agent-trace` 计数暂时"存而不用" |
| `agent-trace` 无消费者 | 完整 trace 视图尚未实现，`sessionSummary` / `sessionTrace` 无人调用 |
| 只折叠 turn / step / tool | `request`、`subagent`、`workflow`、`compaction` 计数恒为 0 |
| 提示词挂在回合、思考挂在步骤 | 不新增跨度类别，计数与摘要格式不变；冷读日志同样能折出它们 |
| 从日志折出来的链不含审批、子代理交接、工作流阶段 | 这些是活 Cordis 事件，不是 Session 记录 |
| 冷 trace 每次重读日志 | 存储只留摘要，不留跨度 |
| `out-of-scope` 是启发式 | 与"读过的路径"和任务文本（调用方传入，或链中记录的提示词）比对，属于推断而非事实 |
