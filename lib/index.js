// dsh-project-context: HOST half.
//
// 把 DSH 的工作区文件夹变成项目工作区：
//   1. 每个有真实 cwd 的会话，都视为"被跟踪的工作区项目"（DSH 本身就是按会话
//      cwd 归组工作区），默认向该会话自动注入一段精简的"项目工作区约定"上下文
//      （先读代码建立心智模型 / 目录为空则新建项目，文件放本目录 / 精简读码方法论）。
//   2. 注入方式是**独立的消息块**，与技能目录（dsh-tool-skill 的
//      `agent/pre-step` + createUserMessage + 自定义 source.kind）同一套机制：
//      通过 `agent/pre-step` 钩子把渲染文本作为一条带 `project-context` 来源标记
//      的独立 user 消息追加/替换进本轮消息列表，**不参与系统提示词的拼接**
//      （不再注册 systemPrompt.context，与沙箱权限的 runtime-context 快照解耦）。
//   3. 注入是**状态渲染**而非"有/无"：有 cwd 的会话恒定拥有该消息块——
//      开启时渲染项目约定；关闭（降级）时渲染"降级为普通工作区"提示。模型每轮
//      都能看到当前状态（沙箱权限正是这样切换 read-only/workspace-write 的），
//      而不是"搬来一段提示词又悄悄搬走"。内容变化时替换会话里既有的
//      project-context 消息，内容不变时幂等不动（扫 session.events 历史判定，
//      与技能目录的 digest 去重同款）。
//   4. 每会话单独开关（默认开启）：开关状态以 session log 事件
//      `project-context/mode` 存储（fold 最近一次事件恢复，与 sandbox/mode 同款：
//      随会话 replay/导出/checkpoint 自动携带，无外部文件）。webServer 提供
//      GET/POST /__project-context/state 供浏览器侧开关按钮调用。
//   5. 旧版 ~/.dsh/storages/project-context.json 中的 disabled 状态在启动时
//      一次性迁移进各会话事件日志（幂等），随后原文件改名 .migrated 留存备份。
//
// ESM 模块格式（cordis bundle rule）：命名导出 name/apply；所有注册都挂在插件
// fiber 上（ctx.inject / 由 loader 自动回收）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const name = 'dsh-project-context'

// --- 状态：session log 事件（fold 即状态，默认开启） ----------------------------
// 每个会话可能携带若干条 `project-context/mode` 事件；生效值取最后一条：
//   { enabled: true  } → 项目模式（默认，无事件即此值）
//   { enabled: false } → 降级为普通工作区
// 这与 dsh-sandbox-policy 的 `sandbox/mode` 事件完全同型：log 即存储，
// 重放恢复，两会话互不可见，无外部状态文件。

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function stateFile() {
  return path.join(dshHome(), 'storages', 'project-context.json')
}

// 会话 id 可能出现两种拼写（原始 uuid / `session-` 前缀），统一去掉前缀作 key。
function norm(id) {
  return String(id || '').replace(/^session-/, '')
}

// 折叠会话事件：返回最近一条 project-context/mode 的 enabled，无事件时 undefined（=默认开启）。
export function projectModeOf(session) {
  const events = session && session.events
  if (!Array.isArray(events)) return undefined
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]
    if (e && e.type === 'project-context/mode') {
      return e.data && e.data.enabled === true
    }
  }
  return undefined
}

// 旧版文件迁移：~/.dsh/storages/project-context.json 里的 disabled 会话
// （无 project-context/mode 事件者）补写一条 enabled:false，然后改名备份。
// 幂等：已迁移过（存在 .migrated 或会话已有事件）则不重复写。
function migrateLegacyJson(ctx) {
  const file = stateFile()
  let legacy
  try {
    legacy = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return // 无旧文件或不可解析 → 无需迁移
  }
  const disabledMap =
    legacy && typeof legacy === 'object' && legacy.disabled && typeof legacy.disabled === 'object'
      ? legacy.disabled
      : {}
  const ids = Object.keys(disabledMap).filter((k) => disabledMap[k] === true)
  if (ids.length === 0) return
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.list !== 'function') return // 无 sessions 服务，保留文件待下次
  let migrated = 0
  for (const sid of ids) {
    const wanted = norm(sid)
    if (!wanted) continue
    let found = null
    try {
      for (const s of sessions.list()) {
        if (norm(s.id) === wanted) {
          found = s
          break
        }
      }
    } catch { /* service busy */ }
    if (!found || found.events && found.events.some((e) => e && e.type === 'project-context/mode')) continue
    try {
      found.append('project-context/mode', { enabled: false })
      migrated += 1
    } catch { /* 该会话不可写则跳过 */ }
  }
  if (migrated > 0) {
    try {
      fs.renameSync(file, file + '.migrated') // 保留备份；确认无问题后可手删
    } catch { /* 改名失败不阻塞 */ }
  }
}

// --- 会话 cwd ---------------------------------------------------------------
function cwdOf(session) {
  const cwd = session && session.header ? session.header.cwd : undefined
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
}

// --- 独立消息块注入（参照 dsh-tool-skill 的技能目录机制） ----------------------
// 每个 agent 步骤装配时，`agent/pre-step` 钩子把本会话的项目上下文渲染成一条
// 带 `project-context` 来源标记的独立 user 消息，追加到本轮消息列表末尾（或替换
// 本轮批次内同来源的旧消息）。不参与 systemPrompt 的 sections/contexts 拼接——
// 模型看到的是技能目录同款的自包含消息块，而非合并进 runtime-context 快照的段落。
// 幂等策略与技能目录同构：扫 session.events 里可见的 project-context 消息，
// 内容未变则不动（不重发），变化则发布新消息替换。

// 取消息的纯文本内容：恰好一个 text 块时返回文本，否则 undefined。
function messageTextOf(message) {
  const blocks = message && message.content
  if (!Array.isArray(blocks) || blocks.length !== 1) return undefined
  const block = blocks[0]
  return block && block.type === 'text' ? block.text : undefined
}

// 在本轮消息批次里查找既有的 project-context 消息（外部 seed / resume 场景下
// 批次可能自带一条；正常流程每步最多追加一条，后续步骤由历史去重兜底）。
export function projectContextMessage(messages) {
  for (const message of messages) {
    if (!message || !message.source || message.source.kind !== 'project-context') continue
    const text = messageTextOf(message)
    if (text !== undefined) return { message, text }
  }
  return undefined
}

// 会话历史里最近一条可见的 project-context 消息文本。
// 可见性以 surface（会话投影的表面节点）判定，与 dsh-tool-skill 的
// catalogHistory 同款：被 compaction 折叠/移除的消息不视为已发布。
export function projectHistoryVisibleText(session) {
  if (!session || !Array.isArray(session.events) || !session.surface || !session.surface.nodes) return undefined
  const visible = new Set(session.surface.nodes)
  for (let i = session.events.length - 1; i >= 0; i -= 1) {
    const event = session.events[i]
    if (!event || event.type !== 'user/message') continue
    const data = event.data
    if (!data || !data.source || data.source.kind !== 'project-context') continue
    if (!visible.has(event.seq)) continue
    const text = messageTextOf(data)
    if (text !== undefined) return text
  }
  return undefined
}

function projectContextText(cwd) {
  return [
    '<project_context>',
    `Working directory "${cwd}" is now a project: all files belong here.`,
    'Build a mental model first, don\'t read everything: inspect structure/size, then entry/README, follow the call chain.',
    'Code is ground truth; docs are reference.',
    'Empty directory → new project, files live here.',
    'Report understanding and plan before changing.',
    'Not final fact — defer to actual files.',
    '</project_context>',
  ].join('\n')
}

function projectDisabledText(cwd) {
  return [
    '<project_context>',
    'Project context: disabled for this session.',
    `Working directory "${cwd}" is a plain DSH workspace, not a project.`,
    'The earlier project-context conventions no longer apply — treat this as a normal workspace.',
    'If you need project context again, ask the user to re-enable it.',
    '</project_context>',
  ].join('\n')
}

// 渲染本会话的 project context 块：无 cwd 的会话不注入（保持原判定）。
export function renderProjectText(session) {
  const cwd = cwdOf(session)
  if (!cwd) return ''
  return projectModeOf(session) === false ? projectDisabledText(cwd) : projectContextText(cwd)
}

// --- HTTP helpers -----------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (d) => {
      data += d
      if (data.length > 1e6) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

// 按 sessionId 在 sessions 服务里定位会话对象（list 里 id 可能带/不带 session- 前缀）。
function findSession(ctx, sessionId) {
  const wanted = norm(sessionId)
  if (!wanted) return null
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.list !== 'function') return null
  try {
    for (const s of sessions.list()) {
      if (norm(s.id) === wanted) return s
    }
  } catch { /* service busy */ }
  return null
}

// 查询某会话的开关状态：tracked（是否为有 cwd 的工作区项目）+ enabled（事件 fold）。
function getSessionState(ctx, sessionId) {
  const session = findSession(ctx, sessionId)
  const cwd = session ? cwdOf(session) : null
  const tracked = !!session && !!cwd
  const disabled = tracked && projectModeOf(session) === false
  return { tracked, cwd, enabled: tracked && !disabled, disabled }
}

// --- plugin ----------------------------------------------------------------
function apply(ctx) {
  // 迁移旧版 json：等到 sessions 服务就绪后再执行（bundle 加载早期
  // ctx.get('sessions') 还拿不到服务，HTTP 层能查到会话时一定已就绪）。
  ctx.inject(['sessions'], () => migrateLegacyJson(ctx))

  // 独立消息块注入：每个 agent 步骤装配时，把项目上下文作为带 `project-context`
  // 来源标记的独立 user 消息发布（技能目录同款机制，不参与系统提示词拼接）。
  // 有 cwd 的会话恒定拥有该消息块（开启=项目约定 / 关闭=降级提示）；
  // 无 cwd 的系统/后台会话不注入。内容未变时幂等不动，变化时替换旧消息。
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal?.throwIfAborted?.()
    const session = agent && agent.session ? agent.session : undefined
    const text = renderProjectText(session)
    if (!text) return decision // 无 cwd：不注入也不管理
    // 历史里已有相同内容的可见消息 → 幂等；若本轮批次又自带同来源消息（外部
    // seed 场景）则移除该重复项，保持"始终恰好一条"。
    if (projectHistoryVisibleText(session) === text) {
      const existing = projectContextMessage(decision.messages)
      return existing === undefined
        ? decision
        : { kind: 'enter', messages: decision.messages.filter((m) => m.id !== existing.message.id) }
    }
    // 内容变化 → 发布新消息；本轮批次内已有旧消息则原位替换，否则追加到末尾。
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'project-context', form: 'context' },
    })
    const existing = projectContextMessage(decision.messages)
    return {
      kind: 'enter',
      messages: existing === undefined
        ? [...decision.messages, message]
        : decision.messages.map((m) => (m.id === existing.message.id ? message : m)),
    }
  })

  // client↔host RPC：浏览器开关按钮读写本会话的状态。
  function registerHttp(host, targetCtx) {
    targetCtx.effect(() => host.register({
      kind: 'exact',
      path: '/__project-context/state',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          const url = new URL(req.url || '/', 'http://local')
          const sessionId = String(url.searchParams.get('sessionId') || '').trim()
          sendJson(res, 200, { ok: true, ...getSessionState(ctx, sessionId) })
          return
        }
        if (req.method === 'POST') {
          let args = {}
          try {
            args = JSON.parse((await readBody(req)) || '{}')
          } catch {
            sendJson(res, 400, { ok: false, error: 'bad json body' })
            return
          }
          const sessionId = String(args.sessionId || '').trim()
          if (!sessionId) {
            sendJson(res, 400, { ok: false, error: 'sessionId required' })
            return
          }
          const enabled = args.enabled === true
          const session = findSession(ctx, sessionId)
          if (!session) {
            sendJson(res, 404, { ok: false, error: 'session not found' })
            return
          }
          // 写路径：追加一条会话事件（log 即状态）。下次模型步骤快照内容变化 →
          // 模型立即看到"降级为普通工作区"（或恢复项目约定）。
          try {
            session.append('project-context/mode', { enabled })
          } catch {
            sendJson(res, 500, { ok: false, error: 'failed to record mode event' })
            return
          }
          sendJson(res, 200, { ok: true, ...getSessionState(ctx, sessionId) })
          return
        }
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
      },
    }))
  }

  const ws = ctx.get('webServer')
  if (ws !== undefined) {
    registerHttp(ws, ctx)
  } else {
    // 终端/无 web 面的 profile 不挂 HTTP 端点，不影响上下文注入。
    ctx.inject(['webServer'], (sub) => registerHttp(sub.webServer, sub))
  }
}

export { name, apply }
