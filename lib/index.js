// dsh-project-context (workspace purpose): HOST half.
//
// 用途分层落地成两件事，都围着"目录结构"转：
//   1. 判定：会话的 cwd 落在临时会话根目录之下 → conversation，否则 → project。
//      纯路径前缀匹配（`state.js`），不查注册表、不读状态文件。
//   2. 隔离：每个临时会话在自己的子目录里工作（cwd = 根目录/<会话 id>），产出
//      文件各写各的。插件**不动会话权限**——临时会话常被用来清盘、整理文件，
//      钉死沙箱会让这些事做不了；告诉模型它在哪个目录就够了。
//   3. 注入：`agent/pre-step` 只给**非临时**会话注入一条独立的
//      `<project_context>` user 消息（技能目录同款机制，不参与系统提示词拼接）。
//      临时会话不注入任何东西。
//
// 刻意不做的事：
//   - 不写任何自定义会话事件：仓库外插件自造事件类型会让重启后的会话恢复抛
//     SessionFormatUnsupportedError。
//   - 不改会话的沙箱模式 / 审批策略：那是用户的权限配置，插件不覆盖。
//   - 不改 workspaceRecord（官方 schema 是 z.core.$strip，未知键会被剥掉）。
//   - 不读旧版状态文件，不做任何迁移。
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  conversationRoot,
  ensureConversationDir,
  ensureConversationRoot,
  isConversationCwd,
} from './state.js'

const name = 'dsh-project-context'

// --- 会话事件读取（真实 Session 用 snapshotEvents()，测试里的假 session 用 events） ---

/**
 * 取会话事件数组。
 * @param {unknown} session
 * @returns {Array<Record<string, unknown>>|undefined}
 */
export function sessionEvents(session) {
  if (!session || typeof session !== 'object') return undefined
  const candidate = /** @type {{events?: unknown, snapshotEvents?: unknown}} */ (session)
  if (Array.isArray(candidate.events)) return candidate.events
  if (typeof candidate.snapshotEvents === 'function') {
    try {
      const events = /** @type {() => unknown} */ (candidate.snapshotEvents)()
      return Array.isArray(events) ? events : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * 消息块的纯文本：恰好一个 text 块时返回文本，否则 undefined。
 * @param {unknown} message
 */
export function messageTextOf(message) {
  const blocks = message && typeof message === 'object'
    ? /** @type {{content?: unknown}} */ (message).content
    : undefined
  if (!Array.isArray(blocks) || blocks.length !== 1) return undefined
  const block = /** @type {{type?: string, text?: string}} */ (blocks[0])
  return block && block.type === 'text' && typeof block.text === 'string' ? block.text : undefined
}

/** 本插件的消息来源标记。 */
export const SOURCE_KIND = 'workspace-purpose'

/**
 * 会话历史里最近一条**可见**的本插件消息文本。
 *
 * 可见性以 `session.surface.nodes` 判定（与 dsh-tool-skill 的技能目录同款）：
 * 被 compaction 折叠掉的消息不算"已发布"。取不到 surface 时返回 undefined ——
 * 宁可多发一次，也不要因为看不见就断定没发过。
 * @param {unknown} session
 * @returns {string|undefined}
 */
export function historyPurposeText(session) {
  const events = sessionEvents(session)
  if (!Array.isArray(events)) return undefined
  const nodes = session && typeof session === 'object'
    ? /** @type {{surface?: {nodes?: unknown}}} */ (session).surface?.nodes
    : undefined
  if (!Array.isArray(nodes)) return undefined
  const visible = new Set(nodes)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = /** @type {{type?: string, seq?: unknown, data?: unknown}} */ (events[i])
    if (!event || event.type !== 'user/message') continue
    const data = /** @type {{source?: {kind?: string}, content?: unknown}} */ (event.data)
    if (!data || !data.source || data.source.kind !== SOURCE_KIND) continue
    if (!visible.has(event.seq)) continue
    const text = messageTextOf(data)
    if (text !== undefined) return text
  }
  return undefined
}

/**
 * 本轮消息批次里既有的本插件消息（外部 seed / 恢复场景可能自带一条）。
 * @param {ReadonlyArray<unknown>} messages
 * @returns {{message: any, text: string}|undefined}
 */
export function purposeMessageIn(messages) {
  if (!Array.isArray(messages)) return undefined
  for (const message of messages) {
    const source = message && typeof message === 'object'
      ? /** @type {{source?: {kind?: string}}} */ (message).source
      : undefined
    if (!source || source.kind !== SOURCE_KIND) continue
    const text = messageTextOf(message)
    if (text !== undefined) return { message, text }
  }
  return undefined
}

// --- 用途判定与渲染 ---------------------------------------------------------

/**
 * 项目工作区的约定块。只写模型无法自行推断、且必须知道的事实。
 *
 * 临时会话不再有自己的块：隔离由沙箱和独立目录承担，写一段文字去"告诉模型
 * 这是临时目录"是多余的（而且会被 compaction 折掉）。
 * @param {string} cwd
 */
export function projectText(cwd) {
  return [
    '<project_context>',
    `Working directory "${cwd}" is a project workspace: files for this work belong here.`,
    'Build a mental model before changing: inspect structure and entry points, follow the call chain.',
    'Code is ground truth; docs are reference.',
    'An empty directory is a new project — files still live here.',
    'Report your understanding and plan before making changes.',
    '</project_context>',
  ].join('\n')
}

/** 会话工作目录（无 cwd 的系统会话返回 null）。 */
export function cwdOf(session) {
  const cwd = session && typeof session === 'object'
    ? /** @type {{header?: {cwd?: unknown}}} */ (session).header?.cwd
    : undefined
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
}

/** 该会话是否是一个临时会话（cwd 在临时根目录之下）。 */
export function isConversationSession(session) {
  return isConversationCwd(cwdOf(session))
}

/**
 * 该会话的用途（无 cwd 的会话返回 null，表示"不参与"）。
 * @param {unknown} session
 * @returns {'project'|'conversation'|null}
 */
export function purposeOf(session) {
  const cwd = cwdOf(session)
  if (!cwd) return null
  return isConversationCwd(cwd) ? 'conversation' : 'project'
}

/**
 * 该会话需要注入的文本。空串表示不注入：
 *   - 无 cwd 的会话（系统/后台）；
 *   - 临时会话（独立沙箱，没有需要告知的处境）。
 * @param {unknown} session
 * @returns {string}
 */
export function purposeTextFor(session) {
  const cwd = cwdOf(session)
  if (!cwd) return ''
  return isConversationCwd(cwd) ? '' : projectText(cwd)
}

// --- 临时会话根目录（幂等、失败不阻塞） ----------------------------------------

let rootError = null

/** 临时会话根目录当前是否可用。 */
export function conversationRootReady() {
  return rootError === null
}

/** 最近一次建根目录的失败原因（无失败时为 null）。 */
export function lastRootError() {
  return rootError
}

/**
 * 确保根目录存在。失败只记录、不抛、不阻塞插件加载；下一次调用会重试。
 * @returns {string|null} 根目录路径，失败为 null
 */
export function ensureRoot() {
  try {
    const root = ensureConversationRoot()
    rootError = null
    return root
  } catch (error) {
    rootError = error
    return null
  }
}

/** 仅测试使用：清掉根目录错误状态。 */
export function resetRootStateForTest() {
  rootError = null
}

/**
 * 为一个新的临时会话准备目录。
 *
 * 会话 id 由本插件生成（客户端带着它去创建会话），于是"目录 ↔ 会话"一一对应，
 * 清理时能直接对上。目录必须先存在：会话一旦创建，cwd 就不可变，之后再也补不上。
 * @returns {{sessionId: string, cwd: string}|null} 失败为 null（原因见 lastRootError）
 */
export function prepareConversationSession() {
  const sessionId = `session-${randomUUID()}`
  try {
    const cwd = ensureConversationDir(sessionId)
    if (cwd === null) throw new Error(`session id "${sessionId}" is not usable as a directory name`)
    rootError = null
    return { sessionId, cwd }
  } catch (error) {
    rootError = error
    return null
  }
}

// --- HTTP ------------------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** 只读状态端点：GET → {ok, root, ready}。 */
export const STATE_PATH = '/__workspace-purpose/state'

/** 新建临时会话端点：POST → {ok, sessionId, cwd}（目录已建好）。 */
export const NEW_CONVERSATION_PATH = '/__workspace-purpose/new-conversation'

function errorText(error) {
  return String(error && error.message ? error.message : error)
}

function registerHttp(host, targetCtx) {
  targetCtx.effect(() => host.register({
    kind: 'exact',
    path: STATE_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      ensureRoot()
      sendJson(res, 200, {
        ok: true,
        root: conversationRoot(),
        ready: conversationRootReady(),
        ...(rootError === null ? {} : { error: errorText(rootError) }),
      })
    },
  }))

  targetCtx.effect(() => host.register({
    kind: 'exact',
    path: NEW_CONVERSATION_PATH,
    handler: (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const prepared = prepareConversationSession()
      if (prepared === null) {
        sendJson(res, 500, { ok: false, error: errorText(rootError) })
        return
      }
      sendJson(res, 200, { ok: true, sessionId: prepared.sessionId, cwd: prepared.cwd })
    },
  }))
}

// --- plugin ----------------------------------------------------------------

function warn(ctx, message, error) {
  const logger = ctx && typeof ctx === 'object'
    ? /** @type {{logger?: {warn?: (msg: string) => void}}} */ (ctx).logger
    : undefined
  const suffix = error === undefined ? '' : `: ${errorText(error)}`
  const text = `${name}: ${message}${suffix}`
  if (logger && typeof logger.warn === 'function') logger.warn(text)
  else console.warn(text)
}

function apply(ctx) {
  // 根目录：启动时建一次（失败只降级，不影响插件加载；端点与按钮会重试）。
  if (ensureRoot() === null) {
    warn(ctx, `temporary conversation root unavailable at ${conversationRoot()}`, rootError)
  }

  // 只给非临时会话注入项目约定：内容不变不重发，变化时原位替换，无 cwd 不注入。
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal?.throwIfAborted?.()
    const session = agent && agent.session ? agent.session : undefined
    const text = purposeTextFor(session)
    const existing = purposeMessageIn(decision.messages)
    if (text === '') {
      // 不注入（临时会话 / 无 cwd）：只需清掉本轮批次可能自带的重复项。
      return existing === undefined
        ? decision
        : { kind: 'enter', messages: decision.messages.filter((m) => m.id !== existing.message.id) }
    }
    if (historyPurposeText(session) === text) {
      return existing === undefined
        ? decision
        : { kind: 'enter', messages: decision.messages.filter((m) => m.id !== existing.message.id) }
    }
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: SOURCE_KIND, form: 'context' },
    })
    return {
      kind: 'enter',
      messages: existing === undefined
        ? [...decision.messages, message]
        : decision.messages.map((m) => (m.id === existing.message.id ? message : m)),
    }
  })

  // 只读/新建端点：把根目录交给浏览器半边，并由宿主建好新会话的目录。
  const host = ctx.get('webServer')
  if (host !== undefined) registerHttp(host, ctx)
  else if (typeof ctx.inject === 'function') ctx.inject(['webServer'], (sub) => registerHttp(sub.webServer, sub))
}

export { name, apply }
export { conversationDirFor, conversationRoot } from './state.js'
