// 路径层单测：根目录、会话目录、前缀判定、规范化。纯函数 + 隔离的 DSH_HOME。
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wp-state-'))
const prevHome = process.env.DSH_HOME
process.env.DSH_HOME = tmpHome

const {
  conversationDirFor,
  conversationRoot,
  dshHome,
  ensureConversationDir,
  ensureConversationRoot,
  isConversationCwd,
  normSessionId,
  normalizePathForCompare,
  sessionDirName,
} = await import('../lib/state.js')

after(() => {
  process.env.DSH_HOME = prevHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(conversationRoot(), { recursive: true, force: true })
})

test('dshHome / conversationRoot: 路径形状', () => {
  assert.equal(dshHome(), tmpHome)
  assert.equal(conversationRoot(), path.join(tmpHome, 'workspace', 'default'))
})

test('normSessionId: 两种拼写归一到裸 uuid', () => {
  assert.equal(normSessionId('session-abc'), 'abc')
  assert.equal(normSessionId('abc'), 'abc')
  assert.equal(normSessionId(undefined), '')
  assert.equal(normSessionId(null), '')
})

test('sessionDirName: 剥离路径不安全字符；不可用时为 null', () => {
  assert.equal(sessionDirName('session-8f0a-4c1b'), '8f0a-4c1b')
  assert.equal(sessionDirName('a/b\\c:d*e'), 'abcde')
  assert.equal(sessionDirName(''), null)
  assert.equal(sessionDirName('///'), null)
  assert.equal(sessionDirName(undefined), null)
})

test('sessionDirName: 拒绝 . 与 ..（否则 path.join 会跳出根目录）', () => {
  assert.equal(sessionDirName('.'), null)
  assert.equal(sessionDirName('..'), null)
  assert.equal(conversationDirFor('..'), null)
  // 斜杠被剥掉之后剩下的只是普通目录名，不再是父目录引用
  assert.equal(sessionDirName('../..'), '....')
  assert.equal(path.dirname(path.join(conversationRoot(), sessionDirName('../..'))), conversationRoot())
})

test('conversationDirFor: 会话目录落在根目录之下', () => {
  assert.equal(conversationDirFor('session-x'), path.join(conversationRoot(), 'x'))
  assert.equal(conversationDirFor(''), null)
})

test('ensureConversationRoot: 只建目录，不预放任何文件', () => {
  const root = ensureConversationRoot()
  assert.equal(root, conversationRoot())
  assert.ok(fs.statSync(root).isDirectory())
  assert.deepEqual(fs.readdirSync(root), [])
})

test('ensureConversationDir: 建出会话子目录并返回它', () => {
  const dir = ensureConversationDir('session-abc')
  assert.equal(dir, conversationDirFor('session-abc'))
  assert.ok(fs.statSync(dir).isDirectory())
  assert.equal(ensureConversationDir('session-abc'), dir)
})

test('ensureConversationDir: 会话 id 不可用时返回 null', () => {
  assert.equal(ensureConversationDir(''), null)
})

test('isConversationCwd: 根目录本身算（兼容子目录方案之前的旧会话）', () => {
  assert.equal(isConversationCwd(conversationRoot()), true)
})

test('isConversationCwd: 根目录之下算', () => {
  assert.equal(isConversationCwd(path.join(conversationRoot(), 'abc')), true)
  assert.equal(isConversationCwd(path.join(conversationRoot(), 'a', 'b')), true)
})

test('isConversationCwd: 相似前缀不算（default-other 不是 default 的子目录）', () => {
  assert.equal(isConversationCwd(`${conversationRoot()}-other`), false)
  assert.equal(isConversationCwd(path.join(tmpHome, 'workspace', 'default2', 'x')), false)
})

test('isConversationCwd: 根目录之外不算', () => {
  assert.equal(isConversationCwd(path.join(tmpHome, 'workspace')), false)
  assert.equal(isConversationCwd(tmpHome), false)
  assert.equal(isConversationCwd('C:/somewhere/else'), false)
})

test('isConversationCwd: 空值 / 非字符串不算', () => {
  assert.equal(isConversationCwd(''), false)
  assert.equal(isConversationCwd(null), false)
  assert.equal(isConversationCwd(undefined), false)
  assert.equal(isConversationCwd(42), false)
})

test('isConversationCwd: 尾分隔符与大小写不影响判定', () => {
  assert.equal(isConversationCwd(`${conversationRoot()}${path.sep}`), true)
  assert.equal(isConversationCwd(path.join(conversationRoot(), 'AbC').toUpperCase()), true)
})

test('normalizePathForCompare: 统一分隔符、去尾斜杠、小写', () => {
  const value = normalizePathForCompare(`${tmpHome}${path.sep}`)
  assert.ok(!value.includes('\\'))
  assert.ok(!value.endsWith('/'))
  assert.equal(value, value.toLowerCase())
  assert.equal(normalizePathForCompare(''), '')
})
