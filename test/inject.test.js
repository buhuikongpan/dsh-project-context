// index.js 单测：用途判定 + 文本渲染 + 历史幂等 + 会话目录准备 + 沙箱钉定。
// 纯函数与假对象，不碰 cordis、不碰真实 ~/.dsh（node --test 每个文件独立进程）。
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wp-index-'))
const prevHome = process.env.DSH_HOME
process.env.DSH_HOME = tmpHome

const {
  SOURCE_KIND,
  conversationRootReady,
  cwdOf,
  historyPurposeText,
  isConversationSession,
  lastRootError,
  prepareConversationSession,
  projectText,
  purposeMessageIn,
  purposeOf,
  purposeTextFor,
} = await import('../lib/index.js')
const { conversationRoot } = await import('../lib/state.js')

after(() => {
  process.env.DSH_HOME = prevHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(conversationRoot(), { recursive: true, force: true })
})

const CONV_ROOT = conversationRoot()
const CONV_DIR = path.join(CONV_ROOT, 'abc')
const PROJECT_DIR = path.join(tmpHome, 'some-project')

function session({ id = 's-1', cwd = PROJECT_DIR, events, surface } = {}) {
  return {
    id,
    header: cwd === null ? {} : { cwd },
    events,
    surface,
  }
}

/** 会话里一条本插件的 user 消息事件（可见性由 surface.nodes 决定）。 */
function purposeEvent(seq, text) {
  return { type: 'user/message', seq, data: { content: [{ type: 'text', text }], source: { kind: SOURCE_KIND } } }
}

// --- 文本 -------------------------------------------------------------------

test('projectText: 标签与目录都出现在文本里', () => {
  const text = projectText('C:/work/x')
  assert.ok(text.startsWith('<project_context>'))
  assert.ok(text.endsWith('</project_context>'))
  assert.ok(text.includes('"C:/work/x"'))
})

// --- 用途判定 ---------------------------------------------------------------

test('cwdOf: 只接受非空字符串', () => {
  assert.equal(cwdOf({ header: { cwd: 'C:/a' } }), 'C:/a')
  assert.equal(cwdOf({ header: {} }), null)
  assert.equal(cwdOf({ header: { cwd: '' } }), null)
  assert.equal(cwdOf({ header: { cwd: 42 } }), null)
  assert.equal(cwdOf(null), null)
})

test('purposeOf: 无 cwd 的会话返回 null（不参与）', () => {
  assert.equal(purposeOf(session({ cwd: null })), null)
})

test('purposeOf: 根目录本身与根目录之下都算 conversation（旧会话兼容）', () => {
  assert.equal(purposeOf(session({ cwd: CONV_ROOT })), 'conversation')
  assert.equal(purposeOf(session({ cwd: CONV_DIR })), 'conversation')
})

test('purposeOf: 别处一律 project', () => {
  assert.equal(purposeOf(session({ cwd: PROJECT_DIR })), 'project')
  assert.equal(purposeOf(session({ cwd: `${CONV_ROOT}-other` })), 'project')
})

test('isConversationSession: 与 purposeOf 同口径', () => {
  assert.equal(isConversationSession(session({ cwd: CONV_DIR })), true)
  assert.equal(isConversationSession(session({ cwd: CONV_ROOT })), true)
  assert.equal(isConversationSession(session({ cwd: PROJECT_DIR })), false)
  assert.equal(isConversationSession(session({ cwd: null })), false)
})

// --- 注入文本 ---------------------------------------------------------------

test('purposeTextFor: 临时会话不注入任何东西', () => {
  assert.equal(purposeTextFor(session({ cwd: CONV_DIR })), '')
  assert.equal(purposeTextFor(session({ cwd: CONV_ROOT })), '')
})

test('purposeTextFor: 项目会话注入项目约定', () => {
  assert.equal(purposeTextFor(session({ cwd: PROJECT_DIR })), projectText(PROJECT_DIR))
})

test('purposeTextFor: 无 cwd 的系统会话不注入', () => {
  assert.equal(purposeTextFor(session({ cwd: null })), '')
  assert.equal(purposeTextFor(null), '')
})

// --- 历史幂等（`<project_context>` 仍然需要） ---------------------------------

test('historyPurposeText: 只认 surface 里可见的那一条', () => {
  const text = projectText('C:/a')
  const hidden = session({
    cwd: 'C:/a',
    events: [purposeEvent(1, 'old text'), purposeEvent(2, text)],
    surface: { nodes: [2] },
  })
  assert.equal(historyPurposeText(hidden), text)

  const notVisible = session({
    cwd: 'C:/a',
    events: [purposeEvent(1, text)],
    surface: { nodes: [99] },
  })
  assert.equal(historyPurposeText(notVisible), undefined)
})

test('historyPurposeText: 取最近一条可见的（倒序扫描）', () => {
  const visible = session({
    cwd: 'C:/a',
    events: [purposeEvent(1, 'first'), purposeEvent(2, 'second')],
    surface: { nodes: [1, 2] },
  })
  assert.equal(historyPurposeText(visible), 'second')
})

test('historyPurposeText: 没有 surface 时返回 undefined（宁可多发一次）', () => {
  assert.equal(historyPurposeText(session({ cwd: 'C:/a', events: [purposeEvent(1, 'x')] })), undefined)
  assert.equal(historyPurposeText(session({ cwd: 'C:/a' })), undefined)
})

test('historyPurposeText: 忽略其它来源的消息', () => {
  const other = session({
    cwd: 'C:/a',
    events: [{ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'project-context' } } }],
    surface: { nodes: [1] },
  })
  assert.equal(historyPurposeText(other), undefined)
})

test('purposeMessageIn: 在本轮消息批次里找到同来源消息', () => {
  const message = { id: 'm1', content: [{ type: 'text', text: 'hello' }], source: { kind: SOURCE_KIND } }
  const found = purposeMessageIn([{ id: 'm0', content: [], source: { kind: 'other' } }, message])
  assert.equal(found.message, message)
  assert.equal(found.text, 'hello')
  assert.equal(purposeMessageIn([]), undefined)
})

test('purposeMessageIn: 多块内容的消息不算（只认同样式的单 text 块）', () => {
  const weird = { id: 'm1', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], source: { kind: SOURCE_KIND } }
  assert.equal(purposeMessageIn([weird]), undefined)
})

// --- 会话目录准备 -----------------------------------------------------------

test('prepareConversationSession: 建好目录并给出会话 id', () => {
  const prepared = prepareConversationSession()
  assert.ok(prepared)
  assert.match(prepared.sessionId, /^session-[0-9a-f-]{36}$/)
  assert.ok(fs.statSync(prepared.cwd).isDirectory())
  assert.equal(path.dirname(prepared.cwd), CONV_ROOT)
})

test('prepareConversationSession: 每次都是不同的目录', () => {
  const a = prepareConversationSession()
  const b = prepareConversationSession()
  assert.notEqual(a.cwd, b.cwd)
  assert.ok(fs.statSync(a.cwd).isDirectory())
  assert.ok(fs.statSync(b.cwd).isDirectory())
})

test('prepareConversationSession 之后根目录仍报告可用', () => {
  prepareConversationSession()
  assert.equal(conversationRootReady(), true)
  assert.equal(lastRootError(), null)
})
