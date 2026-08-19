// dsh-project-context core logic tests: session-event fold + dual-state rendering.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectModeOf, renderProjectText } from '../lib/index.js'

const CWD = 'C:/work/x'

function session(events, cwd = CWD) {
  return { header: { cwd }, events }
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