// dsh-project-context (workspace purpose): HOST half.
//
// 工作区用途分层：
//   1. 每个本地工作区有一个用途，由**它是不是那个固定临时工作区**唯一决定
//      （`$DSH_HOME/workspace/default`）—— 不存映射、不给会话级开关，因为用途是
//      工作区的属性，不是会话偶然的属性。
//   2. 首次运行确保临时目录存在并在 workspaceRegistry 登记（幂等、失败不阻塞启动）。
//   3. `agent/pre-step` 按用途注入一条独立 user 消息块（技能目录同款机制）：
//      项目工作区 → <project_context> 约定；临时工作区 → <workspace_purpose> 状态。
//      内容不变不重发，变化时原位替换。
//   4. 只读 HTTP 端点把 `conversationWorkspaceId` 交给浏览器半边（按钮与徽标用）。
//      purpose 完全由目录决定，客户端没有任何需要写回的状态。
//
// 刻意不做的事：
//   - 不写自定义会话事件（harness 已知事件类型白名单不含仓库外插件事件，
//     写日志会让重启后的会话恢复抛 SessionFormatUnsupportedError）。
//   - 不改 workspaceRecord（官方 schema 是 z.core.$strip，未知键会被剥掉）。
//   - 不读旧版 project-context 状态文件，不做任何迁移。
import fs from 'node:fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  conversationDir,
  conversationWorkspaceId,
  loadState,
  normSessionId,
  normalizePathForCompare,
  rememberConversationWorkspaceId,
} from './state.js'

const name = 'dsh-project-context'

/** 临时工作区在侧边栏里的标题（中/英文界面各一套；store 的是创建时那一套）。 */
const CONVERSATION_TITLE = '临时会话'

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

// --- 用途渲染 ---------------------------------------------------------------

/**
 * 项目工作区的约定块。只写模型无法自行推断、且必须知道的事实。
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

/**
 * 按用途渲染注入文本。无 cwd 的会话（系统/后台）不注入。
 *
 * **临时会话不注入任何提示词**：它落在自己的工作区目录里，这件事由目录本身表达，
 * 不需要再写一段文字去"告诉"模型（何况那段文字是 user 消息，会被 compaction 折掉）。
 * @param {'project'|'conversation'} purpose
 * @param {string|null|undefined} cwd
 * @returns {string} 空串表示不注入
 */
export function renderPurposeText(purpose, cwd) {
  const dir = typeof cwd === 'string' && cwd.length > 0 ? cwd : null
  if (!dir) return ''
  return purpose === 'conversation' ? '' : projectText(dir)
}

/** 会话工作目录（无 cwd 的系统会话返回 null）。 */
export function cwdOf(session) {
  const cwd = session && typeof session === 'object'
    ? /** @type {{header?: {cwd?: unknown}}} */ (session).header?.cwd
    : undefined
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
}

// --- 用途判定 ---------------------------------------------------------------

/**
 * 该会话是否属于那个固定临时工作区。
 *
 * 主判走 workspace 的 sessionId 归属（纯 uuid 比较，不碰路径）；registry 尚未
 * 就绪、或会话刚落盘还没进 membership 时，退回 cwd 与临时目录的规范化比对。
 * @param {unknown} session
 * @param {unknown} registry
 * @returns {boolean}
 */
export function isConversationSession(session, registry) {
  if (!session || typeof session !== 'object') return false
  const sid = normSessionId(/** @type {{id?: unknown}} */ (session).id)
  const id = normSessionId(conversationWorkspaceId())
  if (id && sid && registry && typeof registry === 'object') {
    const reg = /** @type {{get?: (workspaceId: string) => unknown}} */ (registry)
    if (typeof reg.get === 'function') {
      try {
        const workspace = /** @type {{sessionIds?: unknown}}|undefined */ (reg.get(id))
        if (workspace && Array.isArray(workspace.sessionIds) && workspace.sessionIds.length > 0) {
          return workspace.sessionIds.some((value) => normSessionId(value) === sid)
        }
      } catch {
        /* registry 忙碌 → 走 cwd 兜底 */
      }
    }
  }
  // cwd 兜底：等于临时目录，或位于它之下。
  // 含"之下"是为了兼容"每会话一个子目录"那一版（0.6–0.8）建出来的会话——它们的
  // cwd 是根目录的子目录，换回共享目录后不该突然被当成项目、吃上 <project_context>。
  const cwd = cwdOf(session)
  if (!cwd) return false
  const value = normalizePathForCompare(cwd)
  const root = normalizePathForCompare(conversationDir())
  if (value.length === 0 || root.length === 0) return false
  return value === root || value.startsWith(`${root}/`)
}

/**
 * 该会话的用途（无 cwd 的会话返回 null，表示"不参与"）。
 * @param {unknown} session
 * @param {unknown} registry
 * @returns {'project'|'conversation'|null}
 */
export function purposeOf(session, registry) {
  if (!cwdOf(session)) return null
  return isConversationSession(session, registry) ? 'conversation' : 'project'
}

// --- 确保临时工作区（幂等、失败不阻塞） ---------------------------------------

let ensurePromise = null
let ensureError = null

/** 临时工作区当前是否可用（目录已建且已在 registry 登记）。 */
export function conversationWorkspaceReady() {
  return conversationWorkspaceId() !== null && ensureError === null
}

/** 最近一次 ensure 的失败原因（无失败时为 null）。 */
export function lastEnsureError() {
  return ensureError
}

/**
 * 确保临时工作区存在：建目录（只建目录，不预放任何文件）→ registry 登记 → 记 id。
 *
 * - 幂等：`resolveByPath` 命中即复用，绝不对已登记目录重复 `create`。
 * - 并发安全：成功的 in-flight promise 会被复用。
 * - 失败不抛也不缓存：记录错误、标记不可用，并立刻解禁以便下次调用重试。
 *
 * 注意：解禁必须发生在 **promise 真正结算时**（不是 async 函数体里那行）——
 * `catch` 返回的 promise 要再过一个微任务才落定，若在函数体里清空缓存，
 * 调用方 `await` 返回后看到的仍是被缓存下来的那个失败结果，重试会永久失效。
 * @param {{resolveByPath: (dir: string) => Promise<unknown>, create: (dir: string, title?: string) => Promise<unknown>}} registry
 * @returns {Promise<string|null>} 临时工作区 id，失败为 null
 */
export function ensureConversationWorkspace(registry) {
  if (ensurePromise !== null) return ensurePromise

  const attempt = (async () => {
    const dir = conversationDir()
    fs.mkdirSync(dir, { recursive: true })
    const existing = await registry.resolveByPath(dir)
    const workspace = existing !== undefined && existing !== null
      ? existing
      : await registry.create(dir, CONVERSATION_TITLE)
    const id = workspace && typeof workspace === 'object'
      ? /** @type {{id?: unknown}} */ (workspace).id
      : undefined
    if (id === undefined || id === null) throw new Error('workspace registry returned no id')
    if (!rememberConversationWorkspaceId(String(id))) {
      throw new Error('failed to persist conversation workspace id')
    }
    return String(id)
  })()

  const tracked = attempt
    .then((id) => {
      ensureError = null
      return id
    })
    .catch((error) => {
      ensureError = error
      return null
    })
    .then((id) => {
      if (id === null) ensurePromise = null // 失败解禁：下一次调用可以重试
      return id
    })

  ensurePromise = tracked
  return tracked
}

/** 仅测试使用：重置 ensure 的模块级状态。 */
export function resetEnsureStateForTest() {
  ensurePromise = null
  ensureError = null
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

/** 只读状态端点：GET → {ok, conversationWorkspaceId, path, ready}。 */
export const STATE_PATH = '/__workspace-purpose/state'

function registerHttp(host, targetCtx) {
  targetCtx.effect(() => host.register({
    kind: 'exact',
    path: STATE_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      sendJson(res, 200, {
        ok: true,
        conversationWorkspaceId: conversationWorkspaceId(),
        path: conversationDir(),
        ready: conversationWorkspaceReady(),
        ...(ensureError === null ? {} : { error: String(ensureError && ensureError.message ? ensureError.message : ensureError) }),
      })
    },
  }))
}

// --- plugin ----------------------------------------------------------------

function warn(ctx, message, error) {
  const logger = ctx && typeof ctx === 'object'
    ? /** @type {{logger?: {warn?: (msg: string) => void}}} */ (ctx).logger
    : undefined
  const suffix = error === undefined ? '' : `: ${error && error.message ? error.message : String(error)}`
  const text = `${name}: ${message}${suffix}`
  if (logger && typeof logger.warn === 'function') logger.warn(text)
  else console.warn(text)
}

function apply(ctx) {
  loadState()

  // 确保临时工作区存在（幂等；失败只降级，不影响插件加载）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['workspaceRegistry'], (sub) => {
      const registry = sub.workspaceRegistry
      ensureConversationWorkspace(registry).then((id) => {
        if (id === null) warn(ctx, `temporary conversation workspace unavailable at ${conversationDir()}`, ensureError)
      })
    })
  }

  // 按用途注入独立消息块：内容不变不重发，变化时原位替换，无 cwd 不注入。
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal?.throwIfAborted?.()
    const session = agent && agent.session ? agent.session : undefined
    const purpose = purposeOf(session, ctx.get('workspaceRegistry'))
    if (purpose === null) return decision
    const text = renderPurposeText(purpose, cwdOf(session))
    const existing = purposeMessageIn(decision.messages)
    if (historyPurposeText(session) === text) {
      // 历史里已是当前内容：只需清掉本轮批次可能自带的重复项。
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

  // 只读端点：把固定临时工作区 id 交给浏览器半边。
  const host = ctx.get('webServer')
  if (host !== undefined) registerHttp(host, ctx)
  else if (typeof ctx.inject === 'function') ctx.inject(['webServer'], (sub) => registerHttp(sub.webServer, sub))
}

export { name, apply }
export { conversationDir } from './state.js'
