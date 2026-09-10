// 注入逻辑单测：用途判定 + 文本渲染 + 历史幂等（纯函数，不碰磁盘、不碰 cordis）。
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wp-inject-'))
const prevHome = process.env.DSH_HOME
process.env.DSH_HOME = tmpHome

const {
  SOURCE_KIND,
  conversationText,
  cwdOf,
  historyPurposeText,
  isConversationSession,
  projectText,
  purposeMessageIn,
  purposeOf,
  renderPurposeText,
} = await import('../lib/index.js')
const { conversationDir, loadState, rememberConversationWorkspaceId, writeState } = await import('../lib/state.js')

after(() => {
  process.env.DSH_HOME = prevHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

const CONV_DIR = conversationDir()

function session({ id = 's-1', cwd = CONV_DIR, events, surface } = {}) {
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

beforeEach(() => {
  try {
    fs.rmSync(path.join(tmpHome, 'storages', 'workspace-purpose.json'), { force: true })
  } catch {
    /* 不存在即目标状态 */
  }
  loadState()
})

test('projectText / conversationText: 标签与目录都出现在文本里', () => {
  assert.ok(projectText('C:/work/x').startsWith('<project_context>'))
  assert.ok(projectText('C:/work/x').endsWith('</project_context>'))
  assert.ok(projectText('C:/work/x').includes('"C:/work/x"'))
  assert.ok(conversationText('C:/tmp/y').startsWith('<workspace_purpose>'))
  assert.ok(conversationText('C:/tmp/y').endsWith('</workspace_purpose>'))
  assert.ok(conversationText('C:/tmp/y').includes('"C:/tmp/y"'))
  assert.ok(conversationText('C:/tmp/y').includes('not a project'))
})

test('renderPurposeText: 无 cwd → 空串（不注入）', () => {
  assert.equal(renderPurposeText('project', null), '')
  assert.equal(renderPurposeText('conversation', ''), '')
  assert.equal(renderPurposeText('project', undefined), '')
})

test('renderPurposeText: 有 cwd → 按用途给对应块', () => {
  assert.equal(renderPurposeText('project', 'C:/a'), projectText('C:/a'))
  assert.equal(renderPurposeText('conversation', 'C:/a'), conversationText('C:/a'))
})

test('cwdOf: 只接受非空字符串', () => {
  assert.equal(cwdOf({ header: { cwd: 'C:/a' } }), 'C:/a')
  assert.equal(cwdOf({ header: {} }), null)
  assert.equal(cwdOf({ header: { cwd: '' } }), null)
  assert.equal(cwdOf({ header: { cwd: 42 } }), null)
  assert.equal(cwdOf(null), null)
})

test('purposeOf: 无 cwd 的会话返回 null（不参与）', () => {
  assert.equal(purposeOf(session({ cwd: null }), undefined), null)
})

test('isConversationSession: registry.sessionIds 命中（含 session- 前缀混写）', () => {
  rememberConversationWorkspaceId('ws-conv')
  const registry = { get: (id) => (id === 'ws-conv' ? { sessionIds: ['session-abc'] } : undefined) }
  assert.equal(isConversationSession(session({ id: 'abc', cwd: 'C:/elsewhere' }), registry), true)
  assert.equal(isConversationSession(session({ id: 'zzz', cwd: 'C:/elsewhere' }), registry), false)
})

test('isConversationSession: registry 的 membership 为空数组时退回 cwd 比对', () => {
  rememberConversationWorkspaceId('ws-conv')
  const registry = { get: () => ({ sessionIds: [] }) }
  assert.equal(isConversationSession(session({ cwd: CONV_DIR }), registry), true)
  assert.equal(isConversationSession(session({ cwd: path.join(tmpHome, 'other') }), registry), false)
})

test('isConversationSession: registry 抛错 / 缺失时退回 cwd 比对', () => {
  rememberConversationWorkspaceId('ws-conv')
  const throwing = { get: () => { throw new Error('registry busy') } }
  assert.equal(isConversationSession(session({ cwd: CONV_DIR }), throwing), true)
  assert.equal(isConversationSession(session({ cwd: CONV_DIR }), undefined), true)
})

test('isConversationSession: 没有记录 id 时只有 cwd 命中也算（首启动竞态）', () => {
  const registry = { get: () => undefined }
  assert.equal(isConversationSession(session({ cwd: CONV_DIR }), registry), true)
  assert.equal(isConversationSession(session({ cwd: path.join(tmpHome, 'x') }), registry), false)
})

test('purposeOf: 项目与会话两种用途', () => {
  rememberConversationWorkspaceId('ws-conv')
  const registry = { get: (id) => (id === 'ws-conv' ? { sessionIds: ['s-conv'] } : undefined) }
  assert.equal(purposeOf(session({ id: 's-conv' }), registry), 'conversation')
  assert.equal(purposeOf(session({ id: 's-proj', cwd: 'C:/work/proj' }), registry), 'project')
})

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
  const noSurface = session({ cwd: 'C:/a', events: [purposeEvent(1, 'x')] })
  assert.equal(historyPurposeText(noSurface), undefined)
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

test('状态文件损坏时判定仍可用（purpose 不依赖状态文件也能靠 cwd 兜底）', () => {
  writeState({ conversationWorkspaceId: 'ws-x' })
  fs.writeFileSync(path.join(tmpHome, 'storages', 'workspace-purpose.json'), 'broken', 'utf8')
  loadState()
  assert.equal(isConversationSession(session({ cwd: CONV_DIR }), undefined), true)
})
