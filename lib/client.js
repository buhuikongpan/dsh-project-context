// dsh-project-context (workspace purpose): CLIENT half.
//
// 四处 UI：
//   1. sidebar.panellist（list / root）→「临时会话」图标：点它展开侧边栏浮层。
//      entry 里铺一层覆盖图标区的透明点击层并 stopPropagation，拦住外层按钮的
//      `selectPanel`，所以中间区域不受影响。
//   2. shell.overlay（list / root）→ 浮层本体。这是官方**为浮层预留的 additive
//      座位**（契约原文："a fresh id is added beside the shipped entries instead
//      of replacing them"），层本身点击穿透，所以它不遮蔽、不替换官方的工作区树
//      ——官方树与它的全部功能继续由官方维护，插件只实现"临时会话"这一份列表。
//   3. main（keyed / root）→ 占位。`layout.selectPanel(id)` 会校验 hasMainPanel，
//      不注册会抛错；点到它时只给一句提示，不再重复渲染一份列表。
//   4. sidebar.footer.action（list / root）→ 快捷新建按钮；
//      conversation.session.header.actions（list / session）→「临时会话」徽标。
//
// 判定口径：会话 cwd 与宿主给的 root 做前缀比较（分隔符统一 + 大小写归一），
// 不碰 Windows 短名（cwd 是宿主自己生成的路径，字符串前缀足够）。
//
// Bundle 格式（client-modules protocol）：window.__ModuleLoader__.load({id, factory})
// 注册经典脚本；无 JSX，纯 React.createElement；只用 --dsw-* 主题变量。
window.__ModuleLoader__.load({
  id: 'dsh-project-context',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useState } = React

    const NS = 'workspace-purpose'
    const STATE_PATH = '/__workspace-purpose/state'
    const NEW_CONVERSATION_PATH = '/__workspace-purpose/new-conversation'
    const FOOTER_SLOT = 'sidebar.footer.action'
    const FOOTER_ID = 'workspace-purpose-new-conversation'
    const HEADER_SLOT = 'conversation.session.header.actions'
    const HEADER_ID = 'workspace-purpose-badge'
    const PANEL_SLOT = 'sidebar.panellist'
    const MAIN_SLOT = 'main'
    const OVERLAY_SLOT = 'shell.overlay'
    // main 用 key 寻址，panellist 与 shell.overlay 用 id 寻址，共用同一个值。
    // 官方在 main 只占了 'conversation'，在 shell.overlay 的既有条目也都是别的
    // id ——所以这两处都是"新增一座位"，不是"替换官方"。
    const PANEL_ID = 'workspace-purpose-conversations'

    // 重启后页面可能先于 host 就绪：有限次退避重试（沿用既有做法）。
    const MAX_RETRY = 3
    const RETRY_DELAY = [300, 800, 1600]

    // --- 文案（跟随浏览器语言；不依赖未验证的壳内 locale API） --------------------
    const dict = {
      zh: {
        button: '临时会话',
        buttonTitle: '开一个临时会话：它有自己的目录，项目约定不适用',
        buttonDisabledTitle: '临时会话目录不可用（宿主未能创建）',
        badge: '临时会话',
        badgeTitle: '本会话在自己的临时目录里：项目指令与项目约定不适用',
        panel: '临时会话',
        panelTitle: '临时会话',
        panelNew: '新建临时会话',
        panelEmpty: '还没有临时会话',
        justNow: '刚刚',
        minutesAgo: '分钟前',
        hoursAgo: '小时前',
        daysAgo: '天前',
        overlayClose: '收起',
        overlaySearch: '搜索临时会话…',
        overlayNoMatch: '没有匹配的临时会话',
        groupToday: '今天',
        groupYesterday: '昨天',
        groupEarlier: '更早',
        actionRename: '重命名',
        actionArchive: '归档',
        actionCancel: '取消',
        countSuffix: ' 个会话',
        mainPlaceholder: '临时会话已从侧边栏展开。',
        mainPlaceholderHint: '点侧边栏的「临时会话」图标可再次展开或收起。',
      },
      en: {
        button: 'Temporary',
        buttonTitle: 'Start a temporary session: its own directory, project conventions do not apply',
        buttonDisabledTitle: 'Temporary session directory unavailable (the host could not create it)',
        badge: 'Temporary',
        badgeTitle: 'This session runs in its own temporary directory: project instructions and conventions do not apply',
        panel: 'Temporary',
        panelTitle: 'Temporary sessions',
        panelNew: 'New temporary session',
        panelEmpty: 'No temporary sessions yet',
        justNow: 'just now',
        minutesAgo: 'min ago',
        hoursAgo: 'h ago',
        daysAgo: 'd ago',
        overlayClose: 'Close',
        overlaySearch: 'Search temporary sessions…',
        overlayNoMatch: 'No matching temporary sessions',
        groupToday: 'Today',
        groupYesterday: 'Yesterday',
        groupEarlier: 'Earlier',
        actionRename: 'Rename',
        actionArchive: 'Archive',
        actionCancel: 'Cancel',
        countSuffix: ' sessions',
        mainPlaceholder: 'Temporary sessions are open in the sidebar.',
        mainPlaceholderHint: 'Click the "Temporary" icon in the sidebar to toggle them.',
      },
    }

    function primaryLang() {
      if (typeof navigator === 'undefined') return 'en'
      const tags = [].concat(navigator.languages || [], [navigator.language])
      for (const tag of tags) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh') return 'zh'
        if (primary === 'en') return 'en'
      }
      return 'en'
    }

    const t = () => dict[primaryLang()]

    /** 面板入口的标签：注册时传 thunk（契约支持 `string | (() => string)`），
     *  宿主每次投影都重新求值，所以切换语言后标签跟着变，不需要重新注册。 */
    function panelLabel() {
      return t().panel
    }

    // --- 壳内 primitives（单例；渲染期惰性取，取不到就降级为原生元素） ------------
    let primitivesResolved = false
    let primitives = null

    function primitivesOf() {
      if (!primitivesResolved) {
        primitivesResolved = true
        try {
          primitives = require('@deepseek-ai/dsh-client-ui-primitives') || null
        } catch {
          primitives = null
        }
      }
      return primitives
    }

    function primitive(name) {
      const lib = primitivesOf()
      return lib && lib[name] ? lib[name] : undefined
    }

    // --- 宿主状态：只拉一次（外加有限退避重试） ----------------------------------
    // root 是临时会话的根目录；undefined = 未取到。
    const hostState = { root: undefined, ready: false }
    let fetchPromise = null
    const listeners = new Set()

    function notify() {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          /* 单个订阅者出错不影响其它 */
        }
      }
    }

    function waitThenRetry(attempt) {
      const delay = RETRY_DELAY[attempt] ?? RETRY_DELAY[RETRY_DELAY.length - 1]
      return new Promise((resolve) => {
        if (typeof window === 'undefined' || typeof window.setTimeout !== 'function') {
          resolve(undefined)
          return
        }
        window.setTimeout(() => resolve(fetchHostState(attempt + 1)), delay)
      })
    }

    function fetchHostState(attempt = 0) {
      return fetch(STATE_PATH, { headers: { accept: 'application/json' } })
        .then((response) => (response.ok ? response.json() : undefined))
        .then((data) => {
          if (!data || data.ok !== true) throw new Error('bad state response')
          hostState.root = typeof data.root === 'string' && data.root.length > 0 ? data.root : undefined
          hostState.ready = data.ready === true && hostState.root !== undefined
          notify()
          // 目录还没建好（host 首次 ensure 失败/仍在进行）→ 退避重试。
          if (hostState.ready !== true && attempt < MAX_RETRY) return waitThenRetry(attempt)
          return undefined
        })
        .catch(() => {
          if (attempt < MAX_RETRY) return waitThenRetry(attempt)
          return undefined
        })
    }

    function ensureHostState() {
      if (fetchPromise === null) fetchPromise = fetchHostState(0)
      return fetchPromise
    }

    function useHostState() {
      const [, bump] = useState(0)
      useEffect(() => {
        const listener = () => bump((value) => value + 1)
        listeners.add(listener)
        ensureHostState()
        return () => {
          listeners.delete(listener)
        }
      }, [])
      return hostState
    }

    // --- 浮层开关（模块级 store；panellist 入口与 shell.overlay 两处共享它） -----
    const overlayState = { open: false }
    const overlayListeners = new Set()

    function setOverlayOpen(next) {
      const value = next === true
      if (overlayState.open === value) return
      overlayState.open = value
      for (const listener of [...overlayListeners]) {
        try {
          listener()
        } catch {
          /* 单个订阅者出错不影响其它 */
        }
      }
    }

    function useOverlayOpen() {
      const [, bump] = useState(0)
      useEffect(() => {
        const listener = () => bump((value) => value + 1)
        overlayListeners.add(listener)
        return () => {
          overlayListeners.delete(listener)
        }
      }, [])
      return overlayState.open
    }

    // --- 路径比较（客户端没有 fs，只做分隔符与大小写归一） ------------------------
    function normalizeForCompare(value) {
      return String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    }

    /** cwd 是否等于 root 或位于 root 之下。 */
    function isUnderRoot(cwd, root) {
      const value = normalizeForCompare(cwd)
      const base = normalizeForCompare(root)
      if (value.length === 0 || base.length === 0) return false
      return value === base || value.startsWith(`${base}/`)
    }

    // --- 服务访问（services 随 inject 就绪，只能在渲染期读） ----------------------
    function serviceOf(ctx, name) {
      if (!ctx || typeof ctx.get !== 'function') return undefined
      try {
        return ctx.get(name)
      } catch {
        return undefined
      }
    }

    function useServiceSnapshot(ctx, name) {
      const [snapshot, setSnapshot] = useState(undefined)
      useEffect(() => {
        const service = serviceOf(ctx, name)
        if (!service || !service.list || typeof service.list.getSnapshot !== 'function') return undefined
        setSnapshot(service.list.getSnapshot())
        if (typeof service.list.subscribe !== 'function') return undefined
        return service.list.subscribe((next) => setSnapshot(next))
      }, [])
      return snapshot
    }

    /** 从会话列表快照里取某个会话的 summary（容忍 id 的两种拼写）。 */
    function summaryOf(snapshot, sessionId) {
      if (!snapshot || sessionId === undefined || sessionId === null) return undefined
      const byId = snapshot.byId
      if (!byId || typeof byId !== 'object') return undefined
      const wanted = String(sessionId)
      const bare = wanted.replace(/^session-/, '')
      const direct = byId[wanted] ?? byId[bare] ?? byId[`session-${bare}`]
      if (direct) return direct
      for (const key of Object.keys(byId)) {
        const entry = byId[key]
        if (!entry || typeof entry !== 'object') continue
        const id = entry.id ?? entry.sessionId
        if (id !== undefined && String(id).replace(/^session-/, '') === bare) return entry
      }
      return undefined
    }

    /** 某会话是否是一个临时会话（cwd 落在临时根目录之下）。 */
    function isConversationSession(snapshot, sessionId, root) {
      if (!root) return false
      const summary = summaryOf(snapshot, sessionId)
      if (!summary || typeof summary.cwd !== 'string') return false
      return isUnderRoot(summary.cwd, root)
    }

    /**
     * 快照里所有临时会话，按最近活动倒序。
     * 过滤口径与侧边栏一致：跳过 subagent 子会话、归档会话与空白占位会话。
     * 归档集合是 registry-global 的，来自 workspaces 服务而**不是** sessions 快照。
     */
    function temporarySessions(snapshot, root, archivedSessionIds) {
      if (!snapshot || !root) return []
      const byId = snapshot.byId
      if (!byId || typeof byId !== 'object') return []
      const archived = new Set(Array.isArray(archivedSessionIds) ? archivedSessionIds : [])
      const rows = []
      for (const key of Object.keys(byId)) {
        const summary = byId[key]
        if (!summary || typeof summary !== 'object') continue
        if (summary.origin === 'subagent') continue
        if (summary.blank === true) continue
        if (typeof summary.cwd !== 'string') continue
        const id = summary.id ?? summary.sessionId
        if (id === undefined) continue
        if (archived.has(id)) continue
        if (!isUnderRoot(summary.cwd, root)) continue
        rows.push(summary)
      }
      rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      return rows
    }

    /** 会话行的显示标题（退化到 id 前 8 位）。 */
    function titleOf(summary) {
      const raw = summary.displayTitle ?? summary.title
      if (typeof raw === 'string' && raw.trim().length > 0) return raw
      const id = summary.id ?? summary.sessionId
      return String(id ?? '').replace(/^session-/, '').slice(0, 8)
    }

    /** 相对时间（面板里够用即可，不引壳内的格式化工具）。 */
    function relativeTime(updatedAt) {
      const d = t()
      if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return ''
      const diff = Date.now() - updatedAt
      if (diff < 60_000) return d.justNow
      const minutes = Math.floor(diff / 60_000)
      if (minutes < 60) return `${minutes} ${d.minutesAgo}`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours} ${d.hoursAgo}`
      return `${Math.floor(hours / 24)} ${d.daysAgo}`
    }

    // --- 动作：新建 / 打开 -------------------------------------------------------

    /** 打开某个会话：收起浮层、切回对话视图。 */
    function openSession(ctx, sessionId) {
      setOverlayOpen(false)
      const sessions = serviceOf(ctx, 'sessions')
      if (sessions && typeof sessions.open === 'function') sessions.open(sessionId)
      const layout = serviceOf(ctx, 'layout')
      if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(null)
    }

    /** 重命名会话（走官方 Session.rename，与官方树是同一份数据）。 */
    async function renameSession(ctx, sessionId, title) {
      const sessions = serviceOf(ctx, 'sessions')
      const binding = sessions && typeof sessions.binding === 'function' ? sessions.binding(sessionId) : undefined
      const session = binding ? binding.session : undefined
      if (!session || typeof session.rename !== 'function') throw new Error(`unknown session "${sessionId}"`)
      const result = await session.rename(title)
      if (!result || result.ok !== true) {
        throw new Error(result && result.error ? String(result.error.message ?? result.error) : 'rename failed')
      }
    }

    /** 归档会话（registry-global 归档集，归档后两处列表一起消失）。 */
    async function archiveSession(ctx, sessionId) {
      const uiWorkspace = serviceOf(ctx, 'uiWorkspace')
      if (!uiWorkspace || typeof uiWorkspace.archiveSession !== 'function') {
        throw new Error('uiWorkspace.archiveSession is unavailable')
      }
      await uiWorkspace.archiveSession(sessionId)
    }

    /** 时间分组：今天 / 昨天 / 更早（替代官方的"按工作区"分组）。 */
    function groupByDay(rows) {
      const d = t()
      const startOfToday = new Date()
      startOfToday.setHours(0, 0, 0, 0)
      const todayStart = startOfToday.getTime()
      const yesterdayStart = todayStart - 86_400_000
      const buckets = [
        { key: 'today', label: d.groupToday, rows: [] },
        { key: 'yesterday', label: d.groupYesterday, rows: [] },
        { key: 'earlier', label: d.groupEarlier, rows: [] },
      ]
      for (const row of rows) {
        const at = typeof row.updatedAt === 'number' ? row.updatedAt : 0
        if (at >= todayStart) buckets[0].rows.push(row)
        else if (at >= yesterdayStart) buckets[1].rows.push(row)
        else buckets[2].rows.push(row)
      }
      return buckets.filter((bucket) => bucket.rows.length > 0)
    }

    /**
     * 全文搜索，但只保留临时会话。
     *
     * `sessions.search` 是 host 侧内容搜索，返回 `{ ok, value: { items, hasMore } }`；
     * items 只保证有 id/title，所以用 cwd 前缀把非临时会话剔掉。结果按会话 summary
     * 返回，好让调用方复用同一套行渲染。
     */
    async function searchTemporarySessions(ctx, query, root, signal) {
      const sessions = serviceOf(ctx, 'sessions')
      if (!sessions || typeof sessions.search !== 'function') return []
      const result = await sessions.search(query, signal)
      if (!result || result.ok !== true) throw new Error('search failed')
      const items = result.value && Array.isArray(result.value.items) ? result.value.items : []
      const snapshot = sessions.list && typeof sessions.list.getSnapshot === 'function'
        ? sessions.list.getSnapshot()
        : undefined
      const rows = []
      for (const item of items) {
        const id = item && (item.id ?? item.sessionId)
        if (id === undefined) continue
        const summary = summaryOf(snapshot, id)
        if (!summary || typeof summary.cwd !== 'string') continue
        if (!isUnderRoot(summary.cwd, root)) continue
        rows.push(summary)
      }
      return rows
    }

    /**
     * 让宿主建一个新子目录，并以它为 cwd 创建会话，然后打开它。
     * 当前已是空白会话时直接跳过（否则会刷出一串空会话）。
     */
    function startTemporarySession({ ctx, snapshot }) {
      const sessions = serviceOf(ctx, 'sessions')
      if (!sessions || typeof sessions.create !== 'function') {
        console.warn('dsh-project-context: sessions.create is unavailable; cannot start a temporary session')
        return
      }
      const current = snapshot ? snapshot.current : undefined
      const currentSummary = summaryOf(snapshot, current)
      if (currentSummary && currentSummary.blank === true) return

      fetch(NEW_CONVERSATION_PATH, { method: 'POST', headers: { accept: 'application/json' } })
        .then((response) => (response.ok ? response.json() : undefined))
        .then((data) => {
          if (!data || data.ok !== true || typeof data.cwd !== 'string') {
            throw new Error(data && data.error ? String(data.error) : 'bad new-conversation response')
          }
          const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined
          return sessions.create(sessionId === undefined ? { cwd: data.cwd } : { sessionId, cwd: data.cwd })
        })
        .then((result) => {
          if (!result || result.ok !== true) throw new Error('session creation failed')
          const sessionId = result.value && result.value.sessionId
          if (typeof sessionId !== 'string') return
          if (typeof sessions.open === 'function') sessions.open(sessionId)
          const layout = serviceOf(ctx, 'layout')
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(null)
        })
        .catch((error) => {
          console.warn('dsh-project-context: failed to start a temporary session:', error)
        })
    }

    // --- 共用样式 ---------------------------------------------------------------

    const buttonReset = {
      display: 'inline-flex',
      alignItems: 'center',
      border: '1px solid transparent',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      fontFamily: 'inherit',
      textAlign: 'left',
    }

    const panelHeaderStyle = {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: 12,
      flex: 'none',
    }

    const panelTitleStyle = {
      fontSize: 15,
      lineHeight: '22px',
      fontWeight: 600,
    }

    const panelHintStyle = {
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
      flex: 'none',
    }

    const primaryButtonStyle = {
      ...buttonReset,
      justifyContent: 'center',
      gap: 6,
      height: 30,
      padding: '0 12px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
      background: 'var(--dsw-alias-bg-layer-2, transparent)',
      fontSize: 12,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-primary, inherit)',
      flex: 'none',
    }

    // --- UI 1：侧边栏入口（图标 + 点击劫持） -------------------------------------
    /**
     * panellist 的 entry 只能渲染一个图标（外层被 panelGlyph 包着），而且它外面是
     * 官方的一个 button，onClick 会 `selectPanel(id)`。所以这里铺一层覆盖图标区的
     * 透明层并 stopPropagation：点图标 = 展开/收起浮层，中间区域不受影响。
     */
    function PanelGlyph(props) {
      const size = props && props.size ? props.size : 16
      const open = useOverlayOpen()
      const Icon = primitive('IconNewChatOutline16')
      const glyph = Icon
        ? React.createElement(Icon, { size })
        : React.createElement('span', {
          style: {
            display: 'inline-block',
            width: size,
            height: size,
            borderRadius: 4,
            border: '1.5px solid currentColor',
          },
        })
      return React.createElement('span', {
        'data-workspace-purpose': 'panel-entry',
        'data-open': open ? 'true' : 'false',
        style: {
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size,
          height: size,
          color: open ? 'var(--dsw-alias-label-primary, inherit)' : undefined,
        },
      }, [
        glyph,
        React.createElement('span', {
          key: 'hit',
          'aria-hidden': 'true',
          onClick: (event) => {
            event.stopPropagation()
            event.preventDefault()
            setOverlayOpen(!overlayState.open)
          },
          style: { position: 'absolute', inset: -4, cursor: 'pointer' },
        }),
      ])
    }

    // --- UI 2：shell.overlay 浮层 -------------------------------------------------
    /**
     * 会话行：状态点 + 标题 + 相对时间；hover 显示重命名/归档，右键弹同样的菜单，
     * 双击标题就地改名。点行本身打开会话并收起浮层。
     */
    function SessionRow(props) {
      const session = props.session
      const ctx = props.ctx
      const [hover, setHover] = useState(false)
      const [menu, setMenu] = useState(null)
      const [draft, setDraft] = useState(null)
      const d = t()
      const sessionId = session.id ?? session.sessionId

      useEffect(() => {
        if (menu === null) return undefined
        const close = () => setMenu(null)
        document.addEventListener('click', close)
        return () => document.removeEventListener('click', close)
      }, [menu])

      const commitRename = () => {
        const next = draft === null ? '' : draft.trim()
        setDraft(null)
        if (next.length === 0 || next === titleOf(session)) return
        renameSession(ctx, sessionId, next).catch((error) => {
          console.warn('dsh-project-context: rename failed:', error)
        })
      }

      const archive = () => {
        setMenu(null)
        archiveSession(ctx, sessionId).catch((error) => {
          console.warn('dsh-project-context: archive failed:', error)
        })
      }

      const iconAction = (key, label, glyph, onClick) => React.createElement('span', {
        key,
        role: 'button',
        tabIndex: 0,
        title: label,
        onClick: (event) => { event.stopPropagation(); onClick() },
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          borderRadius: 4,
          cursor: 'pointer',
          color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
          fontSize: 12,
          lineHeight: '18px',
        },
      }, glyph)

      const menuItem = (key, label, onClick) => React.createElement('span', {
        key,
        role: 'button',
        style: { padding: '5px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' },
        onClick: (event) => { event.stopPropagation(); onClick() },
      }, label)

      return React.createElement('div', {
        'data-workspace-purpose': 'session-row',
        style: { position: 'relative' },
      }, [
        React.createElement('div', {
          key: 'row',
          role: 'button',
          tabIndex: 0,
          title: session.cwd,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            height: 32,
            padding: '0 8px',
            borderRadius: 8,
            cursor: 'pointer',
            background: hover ? 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))' : 'transparent',
            color: 'var(--dsw-alias-label-primary, inherit)',
          },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onContextMenu: (event) => {
            event.preventDefault()
            event.stopPropagation()
            setMenu({ x: event.clientX, y: event.clientY })
          },
          onClick: () => openSession(ctx, sessionId),
        }, [
          React.createElement('span', {
            key: 'dot',
            style: {
              flex: 'none',
              width: 6,
              height: 6,
              borderRadius: 999,
              background: session.running === true
                ? 'var(--dsw-alias-state-business-primary, #4a8cff)'
                : 'var(--dsw-alias-border-l4, rgba(128,128,128,.4))',
            },
          }),
          draft === null
            ? React.createElement('span', {
              key: 'title',
              onDoubleClick: (event) => { event.stopPropagation(); setDraft(titleOf(session)) },
              style: {
                flex: 1,
                minWidth: 0,
                fontSize: 13,
                lineHeight: '19px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            }, titleOf(session))
            : React.createElement('input', {
              key: 'input',
              autoFocus: true,
              value: draft,
              onClick: (event) => event.stopPropagation(),
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') { event.preventDefault(); commitRename() }
                else if (event.key === 'Escape') { event.preventDefault(); setDraft(null) }
              },
              onBlur: commitRename,
              style: {
                flex: 1,
                minWidth: 0,
                fontSize: 13,
                lineHeight: '19px',
                color: 'inherit',
                background: 'var(--dsw-alias-button-elevated-fill, transparent)',
                border: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.4))',
                borderRadius: 4,
                outline: 'none',
                padding: '0 4px',
              },
            }),
          hover && draft === null
            ? React.createElement('span', {
              key: 'actions',
              style: { flex: 'none', display: 'inline-flex', gap: 2 },
            }, [
              iconAction('rename', d.actionRename, '✎', () => setDraft(titleOf(session))),
              iconAction('archive', d.actionArchive, '▣', archive),
            ])
            : React.createElement('span', {
              key: 'time',
              style: {
                flex: 'none',
                fontSize: 11,
                lineHeight: '16px',
                color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
              },
            }, relativeTime(session.updatedAt)),
        ]),
        menu === null ? null : React.createElement('div', {
          key: 'menu',
          onClick: (event) => event.stopPropagation(),
          style: {
            position: 'fixed',
            left: menu.x,
            top: menu.y,
            zIndex: 60,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 116,
            padding: 4,
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
            background: 'var(--dsw-alias-bg-layer-2, #2a2a2e)',
            boxShadow: '0 8px 24px rgba(0,0,0,.3)',
          },
        }, [
          menuItem('rename', d.actionRename, () => { setMenu(null); setDraft(titleOf(session)) }),
          menuItem('archive', d.actionArchive, archive),
        ]),
      ])
    }

    /**
     * 浮层本体。挂在官方**为浮层预留**的 `shell.overlay` 上（那一层本身点击穿透，
     * 这里自己 opt in 指针事件），所以它只覆盖、不替换官方的任何东西。
     */
    function ConversationOverlay(props) {
      const ctx = props && props.ctx
      const open = useOverlayOpen()
      const state = useHostState()
      const sessions = useServiceSnapshot(ctx, 'sessions')
      const workspaces = useServiceSnapshot(ctx, 'workspaces')
      const [query, setQuery] = useState('')
      const [searchRows, setSearchRows] = useState(null)
      const [searching, setSearching] = useState(false)
      const d = t()
      const root = state.root
      const archived = workspaces ? workspaces.archivedSessionIds : undefined
      const all = temporarySessions(sessions, root, archived)
      const rows = searchRows === null ? all : searchRows
      const available = state.ready === true && typeof root === 'string'

      // Esc 收起
      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => { if (event.key === 'Escape') setOverlayOpen(false) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      // 搜索：debounce + abort；空查询回到按时间排的最近列表
      useEffect(() => {
        if (!open) return undefined
        const text = query.trim()
        if (text.length === 0) {
          setSearchRows(null)
          setSearching(false)
          return undefined
        }
        const controller = new AbortController()
        setSearching(true)
        const timer = window.setTimeout(() => {
          searchTemporarySessions(ctx, text, root, controller.signal)
            .then((found) => {
              if (controller.signal.aborted) return
              setSearchRows(found)
              setSearching(false)
            })
            .catch(() => {
              if (controller.signal.aborted) return
              setSearchRows([])
              setSearching(false)
            })
        }, 250)
        return () => {
          window.clearTimeout(timer)
          controller.abort()
        }
      }, [open, query, root])

      if (!open) return null

      const body = []
      if (rows.length === 0) {
        const emptyText = searching
          ? '…'
          : (query.trim().length > 0 ? d.overlayNoMatch : d.panelEmpty)
        body.push(React.createElement('div', { key: 'empty', style: panelHintStyle }, emptyText))
      } else {
        for (const group of groupByDay(rows)) {
          body.push(React.createElement('div', {
            key: `g-${group.key}`,
            style: { display: 'flex', flexDirection: 'column', gap: 2 },
          }, [
            React.createElement('div', {
              key: 'label',
              style: { ...panelHintStyle, padding: '6px 8px 2px', fontWeight: 600 },
            }, group.label),
            ...group.rows.map((session) => React.createElement(SessionRow, {
              key: String(session.id ?? session.sessionId),
              session,
              ctx,
            })),
          ]))
        }
      }

      return React.createElement('div', {
        'data-workspace-purpose': 'overlay',
        onClick: () => setOverlayOpen(false),
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 30,
          display: 'flex',
          alignItems: 'stretch',
          justifyContent: 'flex-start',
          background: 'rgba(0,0,0,.35)',
        },
      }, [
        React.createElement('div', {
          key: 'panel',
          onClick: (event) => event.stopPropagation(),
          style: {
            width: 320,
            maxWidth: '85vw',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: '12px 12px 10px',
            background: 'var(--dsw-alias-bg-base, #1e1e21)',
            borderRight: '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,.25))',
            boxShadow: '0 0 32px rgba(0,0,0,.35)',
            color: 'var(--dsw-alias-label-primary, inherit)',
          },
        }, [
          React.createElement('div', { key: 'header', style: panelHeaderStyle }, [
            React.createElement('span', { key: 'title', style: panelTitleStyle }, d.panelTitle),
            React.createElement('span', {
              key: 'count',
              style: { ...panelHintStyle, marginLeft: 8 },
            }, `${all.length}${d.countSuffix}`),
            React.createElement('span', {
              key: 'close',
              role: 'button',
              tabIndex: 0,
              title: d.overlayClose,
              'data-workspace-purpose': 'overlay-close',
              onClick: () => setOverlayOpen(false),
              style: {
                ...buttonReset,
                justifyContent: 'center',
                marginLeft: 'auto',
                width: 24,
                height: 24,
                borderRadius: 6,
                color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
                fontSize: 14,
              },
            }, '✕'),
          ]),
          React.createElement('input', {
            key: 'search',
            value: query,
            placeholder: d.overlaySearch,
            'data-workspace-purpose': 'overlay-search',
            onChange: (event) => setQuery(event.target.value),
            style: {
              flex: 'none',
              height: 28,
              padding: '0 8px',
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
              background: 'var(--dsw-alias-bg-layer-2, transparent)',
              color: 'inherit',
              fontSize: 12,
              outline: 'none',
            },
          }),
          React.createElement('div', {
            key: 'body',
            style: {
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            },
          }, body),
          React.createElement('button', {
            key: 'new',
            type: 'button',
            disabled: !available,
            title: available ? d.panelNew : d.buttonDisabledTitle,
            'data-workspace-purpose': 'overlay-new',
            onClick: () => startTemporarySession({ ctx, snapshot: sessions }),
            style: { ...primaryButtonStyle, ...(available ? null : { opacity: 0.45, cursor: 'default' }) },
          }, d.panelNew),
        ]),
      ])
    }

    /**
     * main 占位：`layout.selectPanel(id)` 会校验 hasMainPanel，不注册会抛错。
     * 真正的内容在浮层里，所以这里只给一句提示和一个返回入口。
     */
    function MainPlaceholder(props) {
      const d = t()
      const back = () => {
        const layout = serviceOf(props && props.ctx, 'layout')
        if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(null)
      }
      return React.createElement('div', {
        'data-workspace-purpose': 'main-placeholder',
        style: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          height: '100%',
          padding: 24,
          textAlign: 'center',
          color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
        },
      }, [
        React.createElement('span', {
          key: 'line',
          style: { fontSize: 14, color: 'var(--dsw-alias-label-primary, inherit)' },
        }, d.mainPlaceholder),
        React.createElement('span', { key: 'hint', style: { fontSize: 12 } }, d.mainPlaceholderHint),
        React.createElement('span', {
          key: 'back',
          role: 'button',
          style: {
            marginTop: 4,
            fontSize: 12,
            cursor: 'pointer',
            color: 'var(--dsw-alias-state-business-primary, #4a8cff)',
          },
          onClick: back,
        }, d.overlayClose),
      ])
    }

    // --- UI 3：侧边栏底部「临时会话」快捷按钮 ------------------------------------
    const footerButtonStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      height: 28,
      minWidth: 28,
      padding: '0 8px',
      border: '1px solid transparent',
      borderRadius: 8,
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, #6b6b70)',
      fontSize: 12,
      lineHeight: '20px',
      cursor: 'pointer',
      userSelect: 'none',
      flex: 'none',
    }

    function NewConversationButton(props) {
      const wide = props && props.wide === true
      const ctx = props && props.ctx
      const state = useHostState()
      const sessions = useServiceSnapshot(ctx, 'sessions')
      const d = t()

      const available = state.ready === true && typeof state.root === 'string'

      const start = useCallback(() => {
        if (!available) return
        startTemporarySession({ ctx, snapshot: sessions })
      }, [available, ctx, sessions])

      const Icon = primitive('IconNewChatOutline16')
      const title = available ? d.buttonTitle : d.buttonDisabledTitle

      const button = React.createElement('button', {
        type: 'button',
        title,
        'aria-label': d.button,
        disabled: !available,
        style: {
          ...footerButtonStyle,
          ...(available ? null : { opacity: 0.45, cursor: 'default' }),
        },
        onClick: start,
        'data-workspace-purpose': 'new-conversation',
      }, [
        Icon ? React.createElement(Icon, { key: 'icon', size: wide ? 16 : 18 }) : null,
        wide ? React.createElement('span', { key: 'label' }, d.button) : null,
      ])

      const Tooltip = primitive('Tooltip')
      if (!Tooltip) return button
      return React.createElement(Tooltip, { label: title, delayMs: 500, disabled: wide }, button)
    }

    // --- UI 4：会话头「临时会话」徽标 --------------------------------------------
    const badgeStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      height: 20,
      padding: '0 8px',
      borderRadius: 999,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
      background: 'var(--dsw-alias-bg-layer-2, transparent)',
      color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
      fontSize: 11,
      lineHeight: '18px',
      whiteSpace: 'nowrap',
      userSelect: 'none',
    }

    function PurposeBadge(props) {
      const ctx = props && props.ctx
      const state = useHostState()
      const sessions = useServiceSnapshot(ctx, 'sessions')
      const d = t()
      const sessionId = props.sessionId
        ?? (props.session && (props.session.sessionId ?? props.session.id))
      if (!isConversationSession(sessions, sessionId, state.root)) return null

      const Pill = primitive('Pill')
      if (Pill) {
        return React.createElement(Pill, {
          title: d.badgeTitle,
          style: badgeStyle,
          'data-workspace-purpose': 'badge',
        }, d.badge)
      }
      return React.createElement('span', {
        title: d.badgeTitle,
        style: badgeStyle,
        'data-workspace-purpose': 'badge',
      }, d.badge)
    }

    function apply(ctx) {
      // locale 是可选服务，只能走可选注入：
      //   - 写进下面的 inject 列表 → 宿主没有 locale 服务时，整个插件永远不会 apply，
      //     按钮与徽标一起消失；
      //   - 直接读 ctx.locale → cordis 的 ctx 代理对未注入的服务属性直接抛
      //     `cannot get property "locale" without inject`，`typeof` / `?.` 都挡不住。
      // 服务在场就注册字典，不在场就跳过（文案本来就跟随浏览器语言）。
      if (typeof ctx.inject === 'function') {
        ctx.inject(['locale'], (scope) => {
          if (typeof scope.effect !== 'function' || typeof scope.locale?.register !== 'function') return
          scope.effect(() => scope.locale.register(NS, dict), 'workspace-purpose: dictionaries')
        })
      }

      // 侧边栏入口（点它开浮层）+ main 占位（panellist 的 id 必须等于 main key）。
      // label 传函数：契约写明 thunk 每次投影重新求值，语言切换无需重注册。
      ctx.slots.inject(PANEL_SLOT, () => ctx.slots.register({
        name: PANEL_SLOT,
        id: PANEL_ID,
        order: 100,
        label: panelLabel,
      }, (props) => React.createElement(PanelGlyph, props)))

      ctx.slots.inject(MAIN_SLOT, () => ctx.slots.register({
        name: MAIN_SLOT,
        key: PANEL_ID,
      }, (props) => React.createElement(MainPlaceholder, { ...props, ctx })))

      // 浮层本体：官方为浮层预留的 additive 座位——新 id 是"新增一座位"，
      // 既有的条目（若有）原样保留，官方 UI 不受影响。
      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: PANEL_ID,
        order: 100,
      }, (props) => React.createElement(ConversationOverlay, { ...props, ctx })))

      ctx.slots.inject(FOOTER_SLOT, () => ctx.slots.register({
        name: FOOTER_SLOT,
        id: FOOTER_ID,
        order: 100,
      }, (props) => React.createElement(NewConversationButton, { ...props, ctx })))

      ctx.slots.inject(HEADER_SLOT, () => ctx.slots.register({
        name: HEADER_SLOT,
        id: HEADER_ID,
        order: 100,
      }, (props) => React.createElement(PurposeBadge, { ...props, ctx })))

      // 预热：浮层、按钮与徽标都依赖它，早一次比晚一次好。
      ensureHostState()
    }

    return {
      apply,
      inject: ['slots', 'sessions', 'workspaces', 'layout'],
    }
  },
})
