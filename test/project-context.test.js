// dsh-project-context core logic tests: session-event fold + dual-state rendering
// + independent-message injection helpers (skill-catalog-style pre-step decision).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectModeOf, renderProjectText, projectContextMessage, projectHistoryVisibleText } from '../lib/index.js'

const CWD = 'C:/work/x'

function session(events, cwd = CWD) {
  return { header: { cwd }, events }
}

function pcMessage(id, text) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'project-context', form: 'context' } }
}

test('projectModeOf: no events -> undefined (default ON)', () => {
  assert.equal(projectModeOf(session([])), undefined)
})

test('projectModeOf: fold takes the last mode event', () => {
  const s = session([
    { type: 'project-context/mode', data: { enabled: false } },
    { type: 'project-context/mode', data: { enabled: true } },
  ])
  assert.equal(projectModeOf(s), true)
})

test('projectModeOf: ignores unrelated event types', () => {
  const s = session([
    { type: 'user/message', data: {} },
    { type: 'sandbox/mode', data: { mode: 'read-only' } },
  ])
  assert.equal(projectModeOf(s), undefined)
})

test('renderProjectText: session without cwd renders nothing', () => {
  assert.equal(renderProjectText({ header: {} }), '')
})

test('renderProjectText: enabled state renders the project convention', () => {
  const text = renderProjectText(session([]))
  assert.match(text, /<project_context>/)
  assert.match(text, /Working directory "C:\/work\/x" is now a project/)
  assert.doesNotMatch(text, /disabled for this session/)
})

test('renderProjectText: disabled state renders the downgrade notice', () => {
  const text = renderProjectText(session([{ type: 'project-context/mode', data: { enabled: false } }]))
  assert.match(text, /Project context: disabled for this session/)
  assert.match(text, /plain DSH workspace, not a project/)
  assert.doesNotMatch(text, /is now a project/)
})

test('renderProjectText: re-enabling restores the convention', () => {
  const s = session([
    { type: 'project-context/mode', data: { enabled: false } },
    { type: 'project-context/mode', data: { enabled: true } },
  ])
  const text = renderProjectText(s)
  assert.match(text, /is now a project/)
  assert.doesNotMatch(text, /disabled for this session/)
})

// --- 独立消息块注入：批量查找 + 历史可见文本（技能目录同款决策辅助） ----------

test('projectContextMessage: finds the sole project-context message in a batch', () => {
  const text = renderProjectText(session([]))
  const messages = [
    { id: 'a', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
    pcMessage('pc-1', text),
  ]
  const found = projectContextMessage(messages)
  assert.equal(found.message.id, 'pc-1')
  assert.equal(found.text, text)
})

test('projectContextMessage: undefined without a project-context message', () => {
  const messages = [
    { id: 'a', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
    { id: 'b', role: 'user', content: [{ type: 'text', text: '<system-reminder>sku</system-reminder>' }], source: { kind: 'skill-catalog', form: 'catalog' } },
  ]
  assert.equal(projectContextMessage(messages), undefined)
})

test('projectContextMessage: ignores malformed project-context messages (multi-block / no text)', () => {
  const text = renderProjectText(session([]))
  const messages = [
    { id: 'bad-1', role: 'user', content: [{ type: 'text', text }, { type: 'text', text }], source: { kind: 'project-context', form: 'context' } },
    { id: 'bad-2', role: 'user', content: [], source: { kind: 'project-context', form: 'context' } },
    pcMessage('ok', text),
  ]
  const found = projectContextMessage(messages)
  assert.equal(found.message.id, 'ok')
})

test('projectHistoryVisibleText: last visible project-context message wins', () => {
  const enabled = renderProjectText(session([]))
  const disabled = renderProjectText(session([{ type: 'project-context/mode', data: { enabled: false } }]))
  const s = {
    header: { cwd: CWD },
    surface: { nodes: [1, 2, 3] },
    events: [
      { seq: 1, type: 'user/message', data: { source: { kind: 'skill-catalog', form: 'catalog' } } },
      { seq: 2, type: 'user/message', data: pcMessage('pc-old', enabled) },
      { seq: 3, type: 'user/message', data: pcMessage('pc-new', disabled) },
    ],
  }
  assert.equal(projectHistoryVisibleText(s), disabled)
})

test('projectHistoryVisibleText: folded (not on surface) messages are not visible', () => {
  const text = renderProjectText(session([]))
  const s = {
    header: { cwd: CWD },
    surface: { nodes: [2] }, // seq 1 已被折叠
    events: [
      { seq: 1, type: 'user/message', data: pcMessage('pc-folded', text) },
      { seq: 2, type: 'user/message', data: { source: { kind: 'user' } } },
    ],
  }
  assert.equal(projectHistoryVisibleText(s), undefined)
})

test('projectHistoryVisibleText: undefined without surface', () => {
  const text = renderProjectText(session([]))
  const s = { header: { cwd: CWD }, events: [{ seq: 1, type: 'user/message', data: pcMessage('pc-1', text) }] }
  assert.equal(projectHistoryVisibleText(s), undefined)
})