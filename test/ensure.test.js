// 宿主端 ensure 集成测试：建目录 + registry 登记 + 状态落盘，
// 用隔离的 $DSH_HOME 与假 registry 驱动（不引 cordis / dsh-workspace，
// 所以这份测试不依赖 profile 的依赖树，重装即可跑）。
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wp-ensure-'))
const prevHome = process.env.DSH_HOME
process.env.DSH_HOME = tmpHome

const {
  conversationDir,
  ensureConversationWorkspace,
  conversationWorkspaceReady,
  resetEnsureStateForTest,
  lastEnsureError,
} = await import('../lib/index.js')
const { loadState, readState, stateFile } = await import('../lib/state.js')

after(() => {
  process.env.DSH_HOME = prevHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

function resetAll() {
  resetEnsureStateForTest()
  try {
    fs.rmSync(stateFile(), { force: true })
  } catch {
    /* 不存在即目标状态 */
  }
  fs.rmSync(conversationDir(), { recursive: true, force: true })
  loadState()
}

beforeEach(resetAll)

/** 把 `$DSH_HOME/workspace` 占成一个**文件**，让 mkdir -p 必然失败。 */
function blockWorkspaceParent() {
  fs.rmSync(path.join(tmpHome, 'workspace'), { recursive: true, force: true })
  fs.writeFileSync(path.join(tmpHome, 'workspace'), 'not a directory', 'utf8')
}

function unblockWorkspaceParent() {
  fs.rmSync(path.join(tmpHome, 'workspace'), { recursive: true, force: true })
}

function fakeRegistry(seed) {
  const calls = { resolve: 0, create: 0, created: [] }
  const existing = seed === undefined ? undefined : seed
  return {
    calls,
    async resolveByPath(dir) {
      calls.resolve += 1
      return existing
    },
    async create(dir, title) {
      calls.create += 1
      calls.created.push({ dir, title })
      return { id: 'ws-1' }
    },
  }
}

test('目录不存在 → 建目录 + create + 状态落盘', async () => {
  const registry = fakeRegistry()
  const id = await ensureConversationWorkspace(registry)
  assert.equal(id, 'ws-1')
  assert.equal(fs.existsSync(conversationDir()), true)
  assert.equal(fs.statSync(conversationDir()).isDirectory(), true)
  assert.equal(registry.calls.resolve, 1)
  assert.equal(registry.calls.create, 1)
  assert.deepEqual(registry.calls.created, [{ dir: conversationDir(), title: '临时会话' }])
  assert.equal(readState().conversationWorkspaceId, 'ws-1')
  assert.equal(conversationWorkspaceReady(), true)
})

test('目录只建目录、不预放任何文件（包括 .gitkeep）', async () => {
  await ensureConversationWorkspace(fakeRegistry())
  assert.deepEqual(fs.readdirSync(conversationDir()), [])
})

test('registry 已登记 → 复用，绝不重复 create（幂等）', async () => {
  const registry = fakeRegistry({ id: 'ws-existing' })
  const id = await ensureConversationWorkspace(registry)
  assert.equal(id, 'ws-existing')
  assert.equal(registry.calls.create, 0)
  assert.equal(readState().conversationWorkspaceId, 'ws-existing')
})

test('并发 ensure → 共享同一个 in-flight promise，create 只调一次', async () => {
  const registry = fakeRegistry()
  const [a, b, c] = await Promise.all([
    ensureConversationWorkspace(registry),
    ensureConversationWorkspace(registry),
    ensureConversationWorkspace(registry),
  ])
  assert.deepEqual([a, b, c], ['ws-1', 'ws-1', 'ws-1'])
  assert.equal(registry.calls.resolve, 1)
  assert.equal(registry.calls.create, 1)
})

test('再次 ensure（已完成后）→ 缓存 promise，不产生第二次 create', async () => {
  const registry = fakeRegistry()
  await ensureConversationWorkspace(registry)
  const again = await ensureConversationWorkspace(registry)
  assert.equal(again, 'ws-1')
  assert.equal(registry.calls.create, 1)
  assert.equal(registry.calls.resolve, 1)
})

test('mkdir 失败 → 不抛、返回 null、ready=false、有错误记录', async () => {
  blockWorkspaceParent()
  const registry = fakeRegistry()
  const id = await ensureConversationWorkspace(registry)
  assert.equal(id, null)
  assert.equal(conversationWorkspaceReady(), false)
  assert.notEqual(lastEnsureError(), null)
  assert.equal(registry.calls.create, 0)
  unblockWorkspaceParent()
})

test('登记返回的 workspace 没有 id → 视为失败，不写状态文件', async () => {
  const registry = {
    async resolveByPath() {
      return undefined
    },
    async create() {
      return {}
    },
  }
  const id = await ensureConversationWorkspace(registry)
  assert.equal(id, null)
  assert.equal(conversationWorkspaceReady(), false)
  assert.equal(fs.existsSync(stateFile()), false)
})

test('失败后可重试：修好条件再 ensure 能成功', async () => {
  blockWorkspaceParent()
  assert.equal(await ensureConversationWorkspace(fakeRegistry()), null)
  unblockWorkspaceParent()
  const registry = fakeRegistry()
  assert.equal(await ensureConversationWorkspace(registry), 'ws-1')
  assert.equal(conversationWorkspaceReady(), true)
  assert.equal(registry.calls.create, 1)
})

test('状态文件：写入内容就是极简两字段结构', async () => {
  await ensureConversationWorkspace(fakeRegistry())
  const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
  assert.deepEqual(Object.keys(raw).sort(), ['conversationWorkspaceId', 'version'])
  assert.equal(raw.version, 1)
})
