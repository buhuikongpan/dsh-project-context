// dsh-project-context: HOST half.
//
// 把 DSH 的工作区文件夹变成项目工作区：
//   1. 每个有真实 cwd 的会话，都视为"被跟踪的工作区项目"（DSH 本身就是按会话
//      cwd 归组工作区），默认向该会话自动注入一段精简的"项目工作区约定"上下文
//      （先读代码建立心智模型 / 目录为空则新建项目，文件放本目录 / 精简读码方法论）。
//   2. 通过动态 runtime context（systemPrompt.context）注入，与沙箱权限
//      （dsh-sandbox-policy）同一套机制：text 按 context.agent.session 求值，
//      每次模型步骤重算；快照仅在内容变化时作为一条独立消息插入请求。
//   3. 注入是**状态渲染**而非"有/无"：有 cwd 的会话恒定拥有该 context 块——
//      开启时渲染项目约定；关闭（降级）时渲染"降级为普通工作区"提示。模型每轮
//      都能看到当前状态（沙箱权限正是这样切换 read-only/workspace-write 的），
//      而不是"搬来一段提示词又悄悄搬走"。
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
function projectModeOf(session) {
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

// --- 注入的文本：开启 = 项目约定；关闭 = 降级提示（状态渲染，永不隐身） ----------
// 与 dsh-sandbox-policy 的 renderPolicyContext 同构：块恒定存在，内容随
// 会话状态变化；模型在每轮快照里都能看到"当前是什么状态"，切换不是"移除"。

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
function renderProjectText(session) {
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

  // 自动注入：每个会话 agent 的动态 runtime context。text 在每次装配时按当前
  // 会话求值。有 cwd 的会话恒定渲染（开启=项目约定 / 关闭=降级提示）；
  // 无 cwd 的系统/后台会话不注入。
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'project:workspace',
      order: 120,
      text: (context) => {
        const session = context && context.agent ? context.agent.session : undefined
        if (!session) return ''
        return renderProjectText(session)
      },
    })
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
