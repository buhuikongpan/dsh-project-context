// dsh-project-context (workspace purpose): state layer.
//
// 状态文件是插件唯一的持久化：`$DSH_HOME/storages/workspace-purpose.json`，
// 结构极简 —— `{ "version": 1, "conversationWorkspaceId": "<uuid>|null" }`。
//
// 刻意不做的事：
//   - 不读也不写旧版的 `project-context.json`（那是"每会话开关"时代的产物，
//     语义已被废弃；留作孤儿文件，不迁移、不回退）。
//   - 不加 `purposes` 映射：用途只有"是不是那一个固定临时工作区"两种，
//     多一条映射只会在将来变成陈旧 uuid 的来源。
//   - 不抛异常：文件缺失/损坏/结构不符一律退化为缺省态，插件照常启动。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Harness 数据根目录：`$DSH_HOME`，缺省 `~/.dsh`。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 本插件状态文件的绝对路径。 */
export function stateFile() {
  return path.join(dshHome(), 'storages', 'workspace-purpose.json')
}

/** 固定临时会话工作区目录：`$DSH_HOME/workspace/default`。 */
export function conversationDir() {
  return path.join(dshHome(), 'workspace', 'default')
}

/** 缺省状态（也用于任何读取失败的退化）。 */
export function defaultState() {
  return { version: 1, conversationWorkspaceId: null }
}

/** 只接受非空字符串 id；其余（数字、对象、空串）一律视作"未记录"。 */
function normalizeId(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * 读取状态文件。文件缺失、JSON 损坏、结构不符时返回缺省态，绝不抛。
 * @returns {{version: number, conversationWorkspaceId: string|null}}
 */
export function readState() {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
  } catch {
    return defaultState()
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return defaultState()
  return { version: 1, conversationWorkspaceId: normalizeId(raw.conversationWorkspaceId) }
}

/**
 * 原子写入状态文件（同目录 tmp + rename）。
 * 目录不存在时先建；写失败会清掉 tmp 并把错误抛给调用方（由启动包装记录）。
 * @param {{version?: number, conversationWorkspaceId: string|null}} next
 */
export function writeState(next) {
  const file = stateFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const payload = {
    version: 1,
    conversationWorkspaceId: normalizeId(next && next.conversationWorkspaceId),
  }
  const tmp = `${file}.tmp`
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* tmp 清理失败不掩盖原始错误 */
    }
    throw error
  }
  return payload
}

/** 模块级状态缓存：避免每个 agent 步骤都读一次磁盘。 */
const state = defaultState()

/** 缓存对应的磁盘 mtime（null = 文件缺失；用来发现外部改动/删除）。 */
let cachedMtimeMs = null

/** 当前状态文件的 mtime（毫秒）；不存在或读不到时返回 null。 */
function stateMtimeMs() {
  try {
    return fs.statSync(stateFile()).mtimeMs
  } catch {
    return null
  }
}

/** 缓存是否与磁盘一致。 */
function stateCacheFresh() {
  return cachedMtimeMs !== null && cachedMtimeMs === stateMtimeMs()
}

/** 重新从磁盘装载缓存（损坏/缺失 → 缺省态）。 */
export function loadState() {
  const next = readState()
  state.version = next.version
  state.conversationWorkspaceId = next.conversationWorkspaceId
  cachedMtimeMs = stateMtimeMs()
  return state
}

/** 当前缓存的临时工作区 id（未记录时为 null）。 */
export function conversationWorkspaceId() {
  return state.conversationWorkspaceId
}

/**
 * 记录临时工作区 id（写盘成功后缓存才生效；写失败返回 false 且缓存不变）。
 *
 * 缓存已与磁盘一致且值相同 → 直接成功（省掉每个启动周期的重复写）。
 * 缓存与磁盘不一致（文件被外部删除/改动）→ 重新读一次再决定，避免
 * "缓存说已经是它了"这种假成功。
 * @param {string|null} id
 * @returns {boolean} 是否成功落盘（或磁盘上已经是该值）
 */
export function rememberConversationWorkspaceId(id) {
  const wanted = normalizeId(id)
  if (wanted === state.conversationWorkspaceId && stateCacheFresh()) return true
  const previous = state.conversationWorkspaceId
  if (!stateCacheFresh()) {
    const onDisk = readState()
    state.version = onDisk.version
    state.conversationWorkspaceId = onDisk.conversationWorkspaceId
  }
  if (wanted === state.conversationWorkspaceId && stateCacheFresh()) return true
  state.conversationWorkspaceId = wanted
  try {
    writeState({ conversationWorkspaceId: wanted })
    cachedMtimeMs = stateMtimeMs()
    return true
  } catch {
    // 落盘失败：回到写入之前的缓存值（而不是回退到那次"磁盘重读"的结果——
    // 文件不可读时它会是 null，会让调用方看到凭空丢失的 id）。
    state.conversationWorkspaceId = previous
    return false
  }
}

/**
 * 会话 id 归一化：DSH 的会话 id 有原始 uuid 与 `session-<uuid>` 两种拼写。
 * @param {unknown} id
 */
export function normSessionId(id) {
  return String(id ?? '').replace(/^session-/, '')
}

/**
 * 路径比较用的规范化：解析 `..`/尾分隔符 → 尽量取真实路径 → 统一分隔符与大小写。
 *
 * Windows 上同一目录可能以不同拼写出现（盘符大小写、8.3 短名、分隔符），
 * 所以比较前必须归一；取不到真实路径时退回 `path.resolve`。
 * 注意：这只是**兜底**判定，主判走 workspace 的 sessionId 归属（纯 uuid 比较）。
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
