/**
 * 从持久化的 Session 事件折叠出活动跨度。
 *
 * @module @deepseek-ai/dsh-agent-activity
 */

import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session/types'
import { emptyActivitySummary, openActivitySpan, settleActivitySpan } from './aggregate.ts'
import type { ActivitySpan, ActivitySummary } from './types.ts'

/** 跨度在构建过程中可接受的属性。 */
type MutableAttributes = Record<string, string | number | boolean>

/**
 * 一份折叠状态，可序列化为 JSON，以便投影为其做检查点。
 *
 * `open*` 记录把所有者标识映射到其运行中跨度的下标，因此一个事件只需更新一个
 * 跨度，无需扫描日志或跨度列表。
 */
export interface ActivityState {
  /** 按序号顺序排列的跨度。 */
  spans: ActivitySpan[]
  /** 运行中回合编号到跨度下标的映射。 */
  openTurns: Record<string, number>
  /** 运行中 `turn:step` 组合到跨度下标的映射。 */
  openSteps: Record<string, number>
  /** 运行中工具调用 id 到跨度下标的映射。 */
  openCalls: Record<string, number>
  /** 由相同的启动/关闭转换推进的全日志计数器。 */
  summary: ActivitySummary
}

/**
 * 工具参数中承载目标文件路径的键，按优先级排列。
 *
 * 文件系统工具（`read`、`write`、`edit`、`read_image`）用 `file_path`，检索类工具与
 * 其他工具用 `path` 或 `file`；统一记录为 `path`，投影层只认这一个键。
 */
const PATH_ARGUMENTS = ['path', 'file_path', 'file', 'target_file'] as const

/** 评审链路会读取的其他参数键。 */
const READ_ARGUMENTS = ['command', 'pattern', 'op'] as const

/** 文件变更工具在 `tool/result` 的私有 `meta` 中上报的操作类型。 */
const MUTATION_OPERATIONS: ReadonlySet<string> = new Set(['create', 'update', 'delete'])

/** 工具结果的私有 `meta` 负载，按事件类型取出以免复制其形状定义。 */
type ToolResultMeta = Extract<SessionEvent, { type: 'tool/result' }>['data']['meta']

/** shell 删除命令的目标；当命令未指明操作数时，返回命令本身。 */
function removalTarget(command: string): string | undefined {
  if (!/^rm(\s|$)/.test(command)) return undefined
  const operands = command.split(/\s+/).filter(token => token !== '' && !token.startsWith('-')).slice(1)
  return operands.at(-1) ?? command
}

/** 从解析后的参数对象中读取一个字符串字段。 */
function argumentString(source: object, key: string): string | undefined {
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

/** 从模型生成的工具参数中提取与评审相关的属性。 */
function attributesOf(argumentsJson: string): MutableAttributes {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    // 工具参数是模型输出；格式错误的 JSON 只是不携带任何已解析属性。
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const attributes: MutableAttributes = {}
  for (const key of PATH_ARGUMENTS) {
    const value = argumentString(parsed, key)
    if (value === undefined) continue
    attributes.path = value
    break
  }
  for (const key of READ_ARGUMENTS) {
    const value = argumentString(parsed, key)
    if (value !== undefined) attributes[key] = value
  }
  return attributes
}

/**
 * 读取文件变更工具在 `tool/result` 的 `meta` 中上报的操作类型。
 *
 * `meta` 的负载由生产工具拥有（当前是 `dsh-tool-fs` 的 `{ diffs, operation }`），
 * 此处只取评审需要的字段；形状不符时视为未上报，而不是推断。
 * @param meta - 工具结果事件的可选私有负载。
 * @returns 已上报的操作类型，未上报时为 undefined。
 */
function operationOf(meta: ToolResultMeta): 'create' | 'update' | 'delete' | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const operation = meta['operation']
  if (typeof operation !== 'string' || !MUTATION_OPERATIONS.has(operation)) return undefined
  return operation as 'create' | 'update' | 'delete'
}

/** 将回合结束原因映射为跨度状态。 */
function statusOf(reason: TurnEndReason): ActivitySpan['status'] {
  switch (reason.kind) {
    case 'error':
      return 'error'
    case 'aborted':
    case 'blocked':
      return 'cancelled'
    default:
      return 'ok'
  }
}

/** 助手消息的第一个非空文本块（如果存在）。 */
function intentOf(content: readonly { type: string; text?: string }[]): string | undefined {
  for (const block of content) {
    if (block.type !== 'text') continue
    const text = block.text?.trim()
    if (text !== undefined && text !== '') return text
  }
  return undefined
}

/** 替换一个跨度，并保留其余所有跨度引用。 */
function closed(state: ActivityState, index: number, previous: ActivitySpan, span: ActivitySpan): ActivityState {
  const spans = [...state.spans]
  spans[index] = span
  return { ...state, spans, summary: settleActivitySpan(state.summary, previous, span) }
}

/** 追加一个开启中的跨度，并将其计入一次。 */
function opened(state: ActivityState, span: ActivitySpan): ActivityState {
  return {
    ...state,
    spans: [...state.spans, span],
    summary: openActivitySpan(state.summary, span),
  }
}

/** 从记录中移除一个所有者键。 */
function released(record: Record<string, number>, key: string): Record<string, number> {
  const next: Record<string, number> = {}
  for (const [owner, index] of Object.entries(record)) {
    if (owner !== key) next[owner] = index
  }
  return next
}

/**
 * 创建一份空的折叠状态。
 * @returns 不含任何跨度、也没有开启中所有者的状态。
 */
export function initActivityState(): ActivityState {
  return { spans: [], openTurns: {}, openSteps: {}, openCalls: {}, summary: emptyActivitySummary() }
}

/**
 * 将一个已提交的 Session 事件应用到折叠状态。
 * @param state - 当前状态；永不被修改。
 * @param event - 按日志顺序排列的事件。
 * @returns 下一个状态；若该事件没有改变任何内容，则返回同一个引用。
 */
export function applyActivityEvent(state: ActivityState, event: SessionEvent): ActivityState {
  switch (event.type) {
    case 'turn/start': {
      const span: ActivitySpan = {
        seq: event.seq,
        kind: 'turn',
        name: `turn:${String(event.data.turn)}`,
        startTime: event.time,
        status: 'running',
      }
      const next = opened(state, span)
      return { ...next, openTurns: { ...next.openTurns, [String(event.data.turn)]: state.spans.length } }
    }
    case 'turn/end': {
      const key = String(event.data.turn)
      const index = state.openTurns[key]
      const span = index === undefined ? undefined : state.spans[index]
      if (index === undefined || span === undefined) return state
      return {
        ...closed(state, index, span, { ...span, endTime: event.time, status: statusOf(event.data.reason) }),
        openTurns: released(state.openTurns, key),
      }
    }
    case 'step/start': {
      const key = `${String(event.data.turn)}:${String(event.data.step)}`
      const span: ActivitySpan = {
        seq: event.seq,
        kind: 'step',
        name: `step:${key}`,
        startTime: event.time,
        status: 'running',
      }
      const next = opened(state, span)
      return { ...next, openSteps: { ...next.openSteps, [key]: state.spans.length } }
    }
    case 'step/end': {
      const key = `${String(event.data.turn)}:${String(event.data.step)}`
      const index = state.openSteps[key]
      const span = index === undefined ? undefined : state.spans[index]
      if (index === undefined || span === undefined) return state
      return {
        ...closed(state, index, span, { ...span, endTime: event.time, status: 'ok' }),
        openSteps: released(state.openSteps, key),
      }
    }
    case 'assistant/message': {
      const index = state.openTurns[String(event.data.turn)]
      const span = index === undefined ? undefined : state.spans[index]
      if (index === undefined || span === undefined || span.attributes?.intent !== undefined) return state
      const intent = intentOf(event.data.message.content)
      if (intent === undefined) return state
      return closed(state, index, span, { ...span, attributes: { ...span.attributes, intent } })
    }
    case 'tool/call': {
      const attributes = attributesOf(event.data.arguments)
      const command = attributes.command
      if (event.data.name === 'bash' && typeof command === 'string') {
        const target = removalTarget(command)
        if (target !== undefined) {
          attributes.op = 'delete'
          attributes.path = target
        }
      }
      // 调用标识并非模型生成的参数：记录它是为了让仅有跨度的投影仍能在检查视图
      // 中定位这次调用。
      attributes.callId = String(event.data.callId)
      const span: ActivitySpan = {
        seq: event.seq,
        kind: 'tool',
        name: event.data.name,
        startTime: event.time,
        status: 'running',
        attributes,
      }
      const next = opened(state, span)
      return { ...next, openCalls: { ...next.openCalls, [String(event.data.callId)]: state.spans.length } }
    }
    case 'tool/result': {
      const key = String(event.data.message.toolCallId)
      const index = state.openCalls[key]
      const span = index === undefined ? undefined : state.spans[index]
      if (index === undefined || span === undefined) return state
      const errorCode = event.data.error === undefined ? undefined : event.data.error.code
      const operation = operationOf(event.data.meta)
      const attributes = errorCode === undefined && operation === undefined
        ? span.attributes
        : {
          ...span.attributes,
          ...(errorCode === undefined ? {} : { errorCode }),
          ...(operation === undefined ? {} : { op: operation }),
        }
      return {
        ...closed(state, index, span, {
          ...span,
          endTime: event.time,
          status: event.data.message.isError === true ? 'error' : 'ok',
          attributes,
        }),
        openCalls: released(state.openCalls, key),
      }
    }
    default:
      return state
  }
}

/**
 * 对单个 Session 的事件做增量折叠的折叠器。
 *
 * 能看到事件到达的载体为每个 Session 保留一个折叠器，而不是重新折叠整份日志，
 * 因此实时视图的代价是每个事件一次调用。
 */
export interface ActivityFolder {
  /**
   * 应用一个已提交的 Session 事件。
   * @param event - 按日志顺序排列的事件。
   */
  apply(event: SessionEvent): void
  /**
   * 读取目前记录的跨度，按序号顺序排列。
   * @returns 当前的跨度；调用方不得修改它们。
   */
  snapshot(): ActivitySpan[]
}

/**
 * 创建一个增量折叠器。
 * @returns 按日志顺序接收已提交事件的折叠器。
 */
export function createActivityFolder(): ActivityFolder {
  let state = initActivityState()
  return {
    apply: (event) => {
      state = applyActivityEvent(state, event)
    },
    snapshot: () => [...state.spans],
  }
}

/**
 * 将持久化的 Session 事件折叠成供评审链路使用的活动跨度。
 * @param events - 按序号升序排列的会话日志。
 * @returns 按序号顺序排列的跨度；关闭事件始终未到达的跨度保持运行中状态。
 */
export function foldActivity(events: readonly SessionEvent[]): ActivitySpan[] {
  const folder = createActivityFolder()
  for (const event of events) folder.apply(event)
  return folder.snapshot()
}
