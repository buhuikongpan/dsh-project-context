// dsh-project-context: HOST half.
//
// 把 DSH 的工作区文件夹变成项目工作区：
//   1. 每个有真实 cwd 的会话，都视为"被跟踪的工作区项目"（DSH 本身就是按会话
//      cwd 归组工作区），默认向该会话自动注入一段精简的"项目工作区约定"上下文
//      （先读代码建立心智模型 / 目录为空则新建项目，文件放本目录 / 精简读码方法论）。
//   2. 通过动态 runtime context（systemPrompt.context）注入 —— 和沙箱权限
//      （dsh-sandbox-policy）用的是同一套机制：text 按 context.agent.session
//      求值，每个会话/每次模型步骤都会重算，天然"每次打开新会话都自动注入"。
//   3. 每会话单独开关（默认开启）：webServer 提供 GET/POST /__project-context/state
//      供浏览器侧 `conversation.input.right` 的开关按钮调用；关闭的会话不再注入。
//
// ESM 模块格式（cordis bundle rule）：命名导出 name/apply；所有注册都挂在插件
// fiber 上（ctx.inject / 由 loader 自动回收）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const name = 'dsh-project-context'

// --- 状态持久化：~/.dsh/storages/project-context.json --------------------------
// 结构：{ "disabled": { "<normalized-sessionId>": true } }
// 默认 = 开启；只有被显式关闭的会话才会写进 disabled。

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

let overrides = {} // normalizedSessionId -> true（已关闭）

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    overrides = {}
    if (data && typeof data === 'object' && data.disabled && typeof data.disabled === 'object') {
      for (const [k, v] of Object.entries(data.disabled)) {
        if (v === true) overrides[k] = true
      }
    }
  } catch {
    overrides = {}
  }
}

function persistState() {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true })
    fs.writeFileSync(stateFile(), JSON.stringify({ disabled: overrides }, null, 2))
  } catch (e) {
    // 写盘失败不阻塞功能；状态仅在本进程内存生效
  }
}

function isDisabled(sessionId) {
  return overrides[norm(sessionId)] === true
}

function setDisabled(sessionId, disabled) {
  const key = norm(sessionId)
  if (!key) return
  if (disabled) overrides[key] = true
  else delete overrides[key]
  persistState()
}

// --- 会话 cwd ---------------------------------------------------------------
function cwdOf(session) {
  const cwd = session && session.header ? session.header.cwd : undefined
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
}

// --- 注入的项目工作区约定（精简读码方法论，避免污染） ----------------------------
function projectContextText(cwd) {
  return [
    `【项目工作区约定】本会话工作目录“${cwd}”是一个项目工作区：本项目所有文件都应放在此目录下。`,
    '开工前先读代码建立心智模型，不要一上来全量通读：',
    '1) 先探测再读内容：用 ls/find 看结构与规模、wc -l 量行数；先读 README/入口/数据格式；按需用 grep 沿调用链精准定位，不整包通读大项目。',
    '2) 文档会撒谎，代码不会：读到的事实与其矛盾时，以实际代码为准并回头核实。',
    '3) 若目录为空 → 这是待新建项目：直接在此目录创建，本项目所有文件放这里。',
    '动手前先向用户汇报你的理解与改动计划，确认后再改。不要把本约定当作最终事实，随时以实际文件为准。',
  ].join('\n')
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

// 查询某会话的开关状态：tracked（是否为有 cwd 的工作区项目）+ enabled/disabled。
function getSessionState(ctx, sessionId) {
  const wanted = norm(sessionId)
  let cwd = null
  const sessions = ctx.get('sessions')
  if (sessions && typeof sessions.list === 'function') {
    try {
      for (const s of sessions.list()) {
        if (norm(s.id) === wanted) {
          cwd = cwdOf(s)
          break
        }
      }
    } catch { /* service busy */ }
  }
  const tracked = !!wanted && !!cwd
  const disabled = isDisabled(wanted)
  return { tracked, cwd, enabled: tracked && !disabled, disabled }
}

// --- plugin ----------------------------------------------------------------
function apply(ctx) {
  loadState()

  // 自动注入：每个会话 agent 的动态 runtime context。text 在每次装配时按当前
  // 会话求值；非项目/被关闭的会话返回空串 → 该块不渲染。
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'project:workspace',
      order: 120,
      text: (context) => {
        const session = context && context.agent ? context.agent.session : undefined
        if (!session) return ''
        const cwd = cwdOf(session)
        if (!cwd) return ''
        if (isDisabled(session.id)) return ''
        return projectContextText(cwd)
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
          setDisabled(sessionId, !enabled)
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
