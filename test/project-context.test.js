// dsh-project-context core logic tests: session-event fold + file-store state
// + dual-state rendering + independent-message injection helpers (skill-catalog-
// style pre-step decision). v0.4.0: mode state moved to a state file.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  projectModeOf, resolveMode, renderProjectText, projectContextMessage, projectHistoryVisibleText,
  readModesFile, writeModesFile, loadModes,
} from '../lib/index.js'

const CWD = 'C:/work/x'

function session(events, cwd = CWD) {
  return { header: { cwd }, events }
}

function pcMessage(id, text) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'project-context', form: 'context' } }
}

// --- 文件存储测试隔离：临时 DSH_HOME（node --test 串行执行） ------------------

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pc-test-'))
const prevHome = process.env.DSH_HOME
process.env.DSH_HOME = tmpHome
after(() => {
  process.env.DSH_HOME = prevHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

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

// --- v0.4.0 文件存储：读写 + 优先级 ------------------------------------------

test('writeModesFile/readModesFile: round-trip', () => {
  writeModesFile({ a: true, 'session-b': false })
  assert.deepEqual(readModesFile(), { a: true, 'session-b': false })
})

test('readModesFile: missing file -> null', () => {
  fs.rmSync(path.join(tmpHome, 'storages', 'project-context.json'), { force: true })
  assert.equal(readModesFile(), null)
})

test('readModesFile: corrupt json -> null', () => {
  const file = path.join(tmpHome, 'storages', 'project-context.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{oops', 'utf8')
  assert.equal(readModesFile(), null)
})

test('readModesFile: filters non-boolean entries', () => {
  writeModesFile({ a: true, b: 'yes', c: false, d: 1 })
  assert.deepEqual(readModesFile(), { a: true, c: false })
})

test('resolveMode: file wins over session events', () => {
  writeModesFile({ abc: false })
  loadModes()
  const s = { id: 'abc', header: { cwd: CWD }, events: [{ type: 'project-context/mode', data: { enabled: true } }] }
  assert.equal(resolveMode(s), false)
})

test('resolveMode: session events fall back when absent from file', () => {
  writeModesFile({ keep: true })
  loadModes()
  const s = { id: 'xyz', header: { cwd: CWD }, events: [{ type: 'project-context/mode', data: { enabled: false } }] }
  assert.equal(resolveMode(s), false)
  const s2 = { id: 'xyz2', header: { cwd: CWD }, events: [] }
  assert.equal(resolveMode(s2), undefined)
})

test('resolveMode: loadModes normalizes the session- prefix', () => {
  writeModesFile({ 'session-zz': false })
  loadModes()
  const s = { id: 'zz', header: { cwd: CWD }, events: [] }
  assert.equal(resolveMode(s), false)
})

test('renderProjectText: explicit fileMode param wins over events', () => {
  const on = session([{ type: 'project-context/mode', data: { enabled: true } }])
  const off = session([{ type: 'project-context/mode', data: { enabled: false } }])
  assert.match(renderProjectText(off, true), /is now a project/)
  assert.match(renderProjectText(on, false), /disabled for this session/)
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