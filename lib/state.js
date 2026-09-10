// dsh-project-context (workspace purpose): path layer.
//
// 临时会话 = cwd 落在 `$DSH_HOME/workspace/default/` 之下的会话。于是用途判定
// 是一个**纯路径问题**：前缀匹配。不查 workspaceRegistry、不读状态文件、不留
// 任何映射——目录结构本身就是唯一的事实来源。
//
// 每个临时会话在自己的子目录里工作（cwd = 根目录/<会话 id>）。沙箱的可写边界
// 就是会话不可变的 cwd，所以隔离来自文件系统结构，而不是提示词对模型的约束。
//
// 刻意不做的事：
//   - 不读也不写旧状态文件（`workspace-purpose.json` 的 conversationWorkspaceId，
//     以及更早的 `project-context.json` 每会话开关）：语义已被"路径即用途"取代，
//     留作孤儿文件，不迁移、不回退。
//   - 不抛异常给启动流程：目录建不出来时由调用方降级（按钮禁用、端点报错）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Harness 数据根目录：`$DSH_HOME`，缺省 `~/.dsh`。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 临时会话的根目录：`$DSH_HOME/workspace/default`（所有临时会话的家）。 */
export function conversationRoot() {
  return path.join(dshHome(), 'workspace', 'default')
}

/**
 * 会话 id 归一化：DSH 的会话 id 有原始 uuid 与 `session-<uuid>` 两种拼写。
 * @param {unknown} id
 */
export function normSessionId(id) {
  return String(id ?? '').replace(/^session-/, '')
}

/**
 * 会话 id → 目录名：剥掉 `session-` 前缀，再去掉一切不适合做路径分量的字符。
 * @param {unknown} sessionId
 * @returns {string|null} 不可用时为 null
 */
export function sessionDirName(sessionId) {
  const safe = normSessionId(sessionId).replace(/[^A-Za-z0-9._-]/g, '')
  if (safe.length === 0) return null
  // `.` / `..` 是合法的字符组合，但会把 path.join 带出根目录——显式拒绝。
  if (safe === '.' || safe === '..') return null
  return safe
}

/**
 * 某个临时会话的工作目录（不保证已存在）。
 * @param {unknown} sessionId
 * @returns {string|null}
 */
export function conversationDirFor(sessionId) {
  const dirName = sessionDirName(sessionId)
  return dirName === null ? null : path.join(conversationRoot(), dirName)
}

/** 确保根目录存在（只建目录，不预放任何文件——连 `.gitkeep` 都不放）。 */
export function ensureConversationRoot() {
  const root = conversationRoot()
  fs.mkdirSync(root, { recursive: true })
  return root
}

/**
 * 确保某个临时会话的子目录存在。
 * @param {unknown} sessionId
 * @returns {string|null} 子目录路径；会话 id 不可用时为 null
 */
export function ensureConversationDir(sessionId) {
  const dir = conversationDirFor(sessionId)
  if (dir === null) return null
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 路径比较用的规范化：解析 `..`/尾分隔符 → 尽量取真实路径 → 统一分隔符与大小写。
 *
 * Windows 上同一目录可能以不同拼写出现（盘符大小写、8.3 短名、分隔符），
 * 所以比较前必须归一；取不到真实路径（目录还不存在）时退回 `path.resolve`。
 * @param {string} value
 */
export function normalizePathForCompare(value) {
  const raw = String(value ?? '')
  if (raw.length === 0) return ''
  let resolved
  try {
    resolved = fs.realpathSync.native(raw)
  } catch {
    resolved = path.resolve(raw)
  }
  return resolved.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * cwd 是否属于临时会话区：**等于**根目录，或位于它之下。
 *
 * 含"等于"是为了兼容子目录方案之前的旧临时会话（它们的 cwd 就是根目录本身），
 * 否则那些会话会突然被当成项目、吃上 `<project_context>`。
 * @param {unknown} cwd
 * @returns {boolean}
 */
export function isConversationCwd(cwd) {
  const value = normalizePathForCompare(typeof cwd === 'string' ? cwd : '')
  if (value.length === 0) return false
  const root = normalizePathForCompare(conversationRoot())
  if (root.length === 0) return false
  return value === root || value.startsWith(`${root}/`)
}
