// 状态层单测：状态文件读写的损坏容错 + 路径规范化 + 会话 id 归一化。
// 用临时 DSH_HOME 隔离，绝不触碰真实 ~/.dsh（node --test 每个文件独立进程）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wp-state-'))
const prevHome = process.env.DSH_HOME
process.env.DSH_HOME = tmpHome

const {
  conversationDir,
  conversationWorkspaceId,
  defaultState,
  loadState,
  normSessionId,
  normalizePathForCompare,
  readState,
  rememberConversationWorkspaceId,
  stateFile,
  writeState,
} = await import('../lib/state.js')

after(() => {
  process.env.DSH_HOME = prevHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

function resetFile() {
  try {
    fs.rmSync(stateFile(), { force: true })
  } catch {
    /* 不存在即目标状态 */
  }
}

test('conversationDir: 落在 $DSH_HOME/workspace/default', () => {
  assert.equal(conversationDir(), path.join(tmpHome, 'workspace', 'default'))
})

test('readState: 文件缺失 → 缺省态，不抛', () => {
  resetFile()
  assert.deepEqual(readState(), defaultState())
})

test('readState: JSON 损坏 → 缺省态，不抛', () => {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true })
  fs.writeFileSync(stateFile(), '{ this is not json', 'utf8')
  assert.deepEqual(readState(), defaultState())
})

test('readState: 结构不符（数组 / 非对象）→ 缺省态', () => {
  fs.writeFileSync(stateFile(), '[1,2,3]', 'utf8')
  assert.deepEqual(readState(), defaultState())
  fs.writeFileSync(stateFile(), '"nope"', 'utf8')
  assert.deepEqual(readState(), defaultState())
})

test('readState: id 非字符串（数字/对象/空串）→ 归一为 null', () => {
  fs.writeFileSync(stateFile(), JSON.stringify({ version: 1, conversationWorkspaceId: 42 }), 'utf8')
  assert.equal(readState().conversationWorkspaceId, null)
  fs.writeFileSync(stateFile(), JSON.stringify({ conversationWorkspaceId: {} }), 'utf8')
  assert.equal(readState().conversationWorkspaceId, null)
  fs.writeFileSync(stateFile(), JSON.stringify({ conversationWorkspaceId: '' }), 'utf8')
  assert.equal(readState().conversationWorkspaceId, null)
})

test('writeState → readState 往返一致，且不残留 .tmp', () => {
  resetFile()
  writeState({ conversationWorkspaceId: 'ws-1' })
  assert.equal(readState().conversationWorkspaceId, 'ws-1')
  assert.equal(fs.existsSync(`${stateFile()}.tmp`), false)
  // 覆盖写不残留、结果取最后一次
  writeState({ conversationWorkspaceId: 'ws-2' })
  assert.equal(readState().conversationWorkspaceId, 'ws-2')
  assert.equal(fs.existsSync(`${stateFile()}.tmp`), false)
})

test('writeState: 空 id 归一为 null（写 null 而非 undefined）', () => {
  writeState({ conversationWorkspaceId: null })
  const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.conversationWorkspaceId, null)
  assert.ok(Object.prototype.hasOwnProperty.call(raw, 'conversationWorkspaceId'))
})

test('loadState + rememberConversationWorkspaceId: 缓存与磁盘同步', () => {
  resetFile()
  writeState({ conversationWorkspaceId: 'ws-disk' })
  loadState()
  assert.equal(conversationWorkspaceId(), 'ws-disk')

  assert.equal(rememberConversationWorkspaceId('ws-new'), true)
  assert.equal(conversationWorkspaceId(), 'ws-new')
  assert.equal(readState().conversationWorkspaceId, 'ws-new')
})

test('rememberConversationWorkspaceId: 落盘失败时缓存回滚且返回 false', () => {
  loadState()
  const before = conversationWorkspaceId()
  // 把 storages 位置占成文件，让 mkdirSync 必然失败。
  const storages = path.join(tmpHome, 'storages')
  fs.rmSync(storages, { recursive: true, force: true })
  fs.writeFileSync(storages, 'not a directory', 'utf8')
  try {
    assert.equal(rememberConversationWorkspaceId('ws-cannot-write'), false)
    assert.equal(conversationWorkspaceId(), before)
  } finally {
    fs.rmSync(storages, { force: true })
  }
})

test('normSessionId: 去掉 session- 前缀，其它拼写保持原样', () => {
  assert.equal(normSessionId('session-abc'), 'abc')
  assert.equal(normSessionId('abc'), 'abc')
  assert.equal(normSessionId(undefined), '')
  assert.equal(normSessionId(null), '')
})

test('normalizePathForCompare: 真实存在的目录忽略 尾分隔符 / 大小写 / 反斜杠差异', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wp-path-'))
  try {
    const canonical = normalizePathForCompare(dir)
    assert.notEqual(canonical, '')
    assert.equal(normalizePathForCompare(`${dir}${path.sep}`), canonical)
    assert.equal(normalizePathForCompare(dir.toUpperCase()), canonical)
    assert.equal(normalizePathForCompare(dir.replace(/\\/g, '/')), canonical)
    assert.equal(canonical.includes('\\'), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('normalizePathForCompare: 不存在的路径退回 resolve（不抛）', () => {
  const missing = path.join(tmpHome, 'no', 'such', 'dir')
  assert.equal(normalizePathForCompare(missing), normalizePathForCompare(missing))
  assert.equal(normalizePathForCompare(''), '')
})
