/**
 * 采集层与展示层共用的、面向评审的活动类型。
 *
 * @module @deepseek-ai/dsh-agent-activity
 */

/** 采集层生成的一个折叠后的活动跨度。 */
export interface ActivitySpan {
  /** 该跨度首个贡献会话事件的序号。 */
  readonly seq: number
  /** 计时所属的跨度类别。 */
  readonly kind: 'turn' | 'step' | 'request' | 'tool' | 'subagent' | 'workflow' | 'compaction'
  /** 工具名、工作流阶段、子代理标签或回合标签。 */
  readonly name: string
  /** 跨度开启时的纪元毫秒数。 */
  readonly startTime: number
  /** 跨度关闭时的纪元毫秒数；跨度运行期间不存在。 */
  readonly endTime?: number | undefined
  /** 该跨度的结束状态。 */
  readonly status: 'running' | 'ok' | 'error' | 'cancelled' | 'interrupted'
  /**
   * 采集层附加到该跨度上的展示信息：模型给出的工具参数（目标文件统一记为
   * `path`）、文件变更工具上报或 bash 删除派生的 `op`、回合的单行 `intent` 及其事件序号
   * `intentSeq`、该回合的人类提示词 `prompt` 及其事件序号 `promptSeq`、步骤内助手的思考原文
   * `thinking` 及其事件序号 `thinkingSeq`，以及在检查视图中定位某次工具调用的
   * 已记录 `callId`。
   */
  readonly attributes?: Readonly<Record<string, string | number | boolean>> | undefined
}

/** 评审者可见的八种卡片类别。 */
export type ChainKind = 'prompt' | 'thinking' | 'intent' | 'recon' | 'change' | 'verify' | 'interrupt' | 'result'

/** 单张链路卡片的视觉状态。 */
export type ChainStatus = 'ok' | 'error' | 'running' | 'warning'

/** 一张变更卡片记录的文件操作。 */
export type ChangeOp = 'create' | 'update' | 'delete'

/**
 * 一张思考卡片所属步骤触发的行动计数。
 *
 * 展示层用读者语言把这些计数组合成一行摘要，因此投影只给出数字，不写句子。
 */
export interface ChainActions {
  /** 该步骤打开过的文件数。 */
  readonly files: number
  /** 该步骤执行的检索次数。 */
  readonly searches: number
  /** 该步骤造成的文件变更数。 */
  readonly changes: number
  /** 该步骤执行的校验次数。 */
  readonly verifications: number
}

/**
 * 一张改动卡片展示的差异块：记录时变更前后的原文。
 *
 * 投影只搬运记录的文本，不计算行级补丁；补丁由展示层从这两段文本派生。
 */
export interface ChainDiff {
  /** 该差异所属的文件路径。 */
  readonly path: string
  /** 变更前的原文（含上下文）；没有旧内容时为 null。 */
  readonly oldText: string | null
  /** 变更后的原文（含上下文）。 */
  readonly newText: string
}

/**
 * 一张卡片的标题：展示层渲染的消息，以及该消息插值所用的值。已记录的文本保持
 * 原样；其他每种变体只指明一条由读者所在语言字典提供的消息。
 */
export type ChainTitle =
  /** 用户原话，按记录截断后展示。 */
  | { readonly copy: 'prompt'; readonly text: string }
  /** 助手在该步骤的思考首句，按记录原样展示。 */
  | { readonly copy: 'thinking'; readonly text: string }
  /** 回合自身的意图语句，按记录原样展示。 */
  | { readonly copy: 'intent'; readonly text: string }
  /** 被合并为计数总计的探查类工作。 */
  | { readonly copy: 'recon'; readonly files: number; readonly searches: number }
  /** 为达到展示上限而被压缩的探查类工作。 */
  | { readonly copy: 'reconCollapsed' }
  /** 一次子代理交接。 */
  | { readonly copy: 'subagent'; readonly name: string }
  /** 一个正常结束的工作流阶段。 */
  | { readonly copy: 'workflowCompleted'; readonly name: string }
  /** 一个以错误结束的工作流阶段。 */
  | { readonly copy: 'workflowFailed'; readonly name: string }
  /** 一次将控制权交给人的工具调用。 */
  | { readonly copy: 'interrupt'; readonly seconds: number }
  /** 一次文件创建、修改或删除。 */
  | { readonly copy: 'change'; readonly op: ChangeOp; readonly path: string }
  /** 一条正常结束的命令。 */
  | { readonly copy: 'verifyPassed'; readonly command: string }
  /** 一条以错误结束的命令；若记录了失败码，则一并给出。 */
  | { readonly copy: 'verifyFailed'; readonly command: string; readonly errorCode?: string | undefined }
  /** 一段被折叠的连续成功校验。 */
  | { readonly copy: 'verifyRun'; readonly count: number }
  /** 变更文件与校验的收尾汇总。 */
  | { readonly copy: 'result'; readonly files: number; readonly verifications: number }

/** 执行链中一个可读的步骤。 */
export interface ChainCard {
  /** 由类别与首个贡献序号推导出的稳定标识符。 */
  readonly id: string
  /** 展示类别。 */
  readonly kind: ChainKind
  /** 未展开时显示的单行摘要，由展示层负责本地化。 */
  readonly title: ChainTitle
  /** 卡片开启时的纪元毫秒数。 */
  readonly startedAt: number
  /** 由底层跨度与风险标记推导出的视觉状态。 */
  readonly status: ChainStatus
  /** 评审者可打开以核对这张卡片的序号。 */
  readonly evidenceSeqs: readonly number[]
  /** 合并后的出现次数，用于同一目标上的重复工作。 */
  readonly repeat?: number | undefined
  /** 思考卡片所在步骤触发的行动计数，供展示层组合成一行摘要。 */
  readonly actions?: ChainActions | undefined
  /**
   * 思考卡片所在步骤触发的行动卡片，按事件顺序排列。
   *
   * 行动是这段思考的直接结果，因此随思考卡片一起展示；只有思考卡片拥有子卡，
   * 其余卡片的行动在链上平铺。
   */
  readonly children?: readonly ChainCard[] | undefined
  /** 改动卡片记录的差异块，供展示层渲染该次改动；没有记录时不存在。 */
  readonly diffs?: readonly ChainDiff[] | undefined
  /** 展示层无需解析标题即可读取的机器可读信息。 */
  readonly meta?: Readonly<Record<string, string | number>> | undefined
}

/** 评审风险标记的严重程度。 */
export type RiskSeverity = 'danger' | 'warn' | 'info'

/** 单条规则的发现：由展示层本地化的消息，以及相应计数。 */
export type RiskReason =
  | { readonly copy: 'touchesTests' }
  | { readonly copy: 'touchesCi' }
  | { readonly copy: 'deletes'; readonly count: number }
  | { readonly copy: 'outOfScope' }
  | { readonly copy: 'unverified' }
  | { readonly copy: 'gaveUp' }
  | { readonly copy: 'planChurn'; readonly count: number }

/** 附加到链路上的一项评审风险。 */
export interface RiskFlag {
  /** 稳定的规则名。 */
  readonly code: string
  /** 该标记对可靠评审的阻断程度。 */
  readonly severity: RiskSeverity
  /** 面向评审者的原因，由展示层负责本地化。 */
  readonly reason: RiskReason
  /** 该规则匹配到的文件。 */
  readonly evidenceFiles: readonly string[]
}

/** 交给展示层的投影结果。 */
export interface ChainResult {
  /** 按展示顺序排列的卡片，以结果卡片结尾。 */
  readonly cards: readonly ChainCard[]
  /** 按严重程度排序的风险标记。 */
  readonly flags: readonly RiskFlag[]
}

/** 由跨度推导出的全日志计数器，由折叠过程增量维护。 */
export interface ActivitySummary {
  /** 按跨度类别统计的开启次数。 */
  readonly spansByKind: Readonly<Record<ActivitySpan['kind'], number>>
  /** 当前的结束状态计数；`running` 统计仍处于打开状态的跨度。 */
  readonly spansByStatus: Readonly<Record<ActivitySpan['status'], number>>
  /** 按类别统计的已结束跨度实际耗时之和，单位为毫秒。 */
  readonly durationByKind: Readonly<Record<ActivitySpan['kind'], number>>
}
