// dsh-project-context (workspace purpose): CLIENT half.
//
// 四处 UI：
//   1. sidebar.panellist（list / root）→「临时会话」面板入口（图标 + 标签）。
//      它的 list id 直接寻址 main 插槽里同 key 的面板。
//   2. main（keyed / root）→ 临时会话面板：新建入口 + 当前所有临时会话的列表，
//      点一行就打开那个会话。这是"临时会话"在侧边栏的正式归宿——官方的工作区树
//      里它们仍落在 ungrouped（那是官方渲染端的分组，插件改不了）。
//   3. sidebar.footer.action（list / root）→「临时会话」快捷按钮：一键新建。
//   4. conversation.session.header.actions（list / session）→「临时会话」徽标。
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
    // main 用 key 寻址、panellist 用 id 寻址，两者必须是同一个值。
    // 官方只占了 'conversation'，这里用自有的 id。
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
        panelHint: '每个临时会话有自己的目录，产出文件互不干扰。',
        panelNew: '新建临时会话',
        panelEmpty: '还没有临时会话',
        justNow: '刚刚',
        minutesAgo: '分钟前',
        hoursAgo: '小时前',
        daysAgo: '天前',
      },
      en: {
        button: 'Temporary',
        buttonTitle: 'Start a temporary session: its own directory, project conventions do not apply',
        buttonDisabledTitle: 'Temporary session directory unavailable (the host could not create it)',
        badge: 'Temporary',
        badgeTitle: 'This session runs in its own temporary directory: project instructions and conventions do not apply',
        panel: 'Temporary',
        panelTitle: 'Temporary sessions',
        panelHint: 'Each temporary session has its own directory, so their files never mix.',
        panelNew: 'New temporary session',
        panelEmpty: 'No temporary sessions yet',
        justNow: 'just now',
        minutesAgo: 'min ago',
        hoursAgo: 'h ago',
        daysAgo: 'd ago',
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

    /** 打开某个会话并切回对话视图（面板是"全局面板"，打开会话要退出它）。 */
    function openSession(ctx, sessionId) {
      const sessions = serviceOf(ctx, 'sessions')
      if (sessions && typeof sessions.open === 'function') sessions.open(sessionId)
      const layout = serviceOf(ctx, 'layout')
      if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(null)
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

    const panelStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      height: '100%',
      minHeight: 0,
      padding: '18px 20px',
      overflowY: 'auto',
      color: 'var(--dsw-alias-label-primary, inherit)',
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

    const rowStyle = {
      ...buttonReset,
      flexDirection: 'column',
      alignItems: 'stretch',
      gap: 2,
      width: '100%',
      padding: '8px 10px',
      borderRadius: 8,
    }

    const rowTitleStyle = {
      fontSize: 13,
      lineHeight: '19px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }

    const rowMetaStyle = {
      fontSize: 11,
      lineHeight: '16px',
      color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }

    // --- UI 1：侧边栏的面板入口（图标） ------------------------------------------
    function PanelGlyph(props) {
      const size = props && props.size ? props.size : 16
      const Icon = primitive('IconNewChatOutline16')
      if (Icon) return React.createElement(Icon, { size })
      return React.createElement('span', {
        style: {
          display: 'inline-block',
          width: size,
          height: size,
          borderRadius: 4,
          border: '1.5px solid currentColor',
        },
      })
    }

    // --- UI 2：main 面板 --------------------------------------------------------

    function ConversationRow(props) {
      const session = props.session
      const ctx = props.ctx
      const [hover, setHover] = useState(false)
      const sessionId = session.id ?? session.sessionId
      const meta = [relativeTime(session.updatedAt), session.cwd]
        .filter((value) => typeof value === 'string' && value.length > 0)
        .join(' · ')
      return React.createElement('button', {
        type: 'button',
        title: session.cwd,
        'data-workspace-purpose': 'panel-row',
        style: {
          ...rowStyle,
          background: hover ? 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))' : 'transparent',
        },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onClick: () => openSession(ctx, sessionId),
      }, [
        React.createElement('span', { key: 'title', style: rowTitleStyle }, titleOf(session)),
        React.createElement('span', { key: 'meta', style: rowMetaStyle }, meta),
      ])
    }

    function ConversationPanel(props) {
      const ctx = props && props.ctx
      const state = useHostState()
      const sessions = useServiceSnapshot(ctx, 'sessions')
      const workspaces = useServiceSnapshot(ctx, 'workspaces')
      const d = t()
      const rows = temporarySessions(sessions, state.root, workspaces ? workspaces.archivedSessionIds : undefined)
      const available = state.ready === true && typeof state.root === 'string'

      const children = [
        React.createElement('div', { key: 'header', style: panelHeaderStyle }, [
          React.createElement('span', { key: 'title', style: panelTitleStyle }, d.panelTitle),
          React.createElement('button', {
            key: 'new',
            type: 'button',
            disabled: !available,
            title: available ? d.panelNew : d.buttonDisabledTitle,
            'data-workspace-purpose': 'panel-new',
            style: { ...primaryButtonStyle, ...(available ? null : { opacity: 0.45, cursor: 'default' }) },
            onClick: () => startTemporarySession({ ctx, snapshot: sessions }),
          }, d.panelNew),
        ]),
        React.createElement('div', { key: 'hint', style: panelHintStyle }, d.panelHint),
      ]

      if (rows.length === 0) {
        children.push(React.createElement('div', { key: 'empty', style: panelHintStyle }, d.panelEmpty))
      } else {
        children.push(React.createElement('div', {
          key: 'rows',
          style: { display: 'flex', flexDirection: 'column', gap: 2, minHeight: 0 },
        }, rows.map((session) => React.createElement(ConversationRow, {
          key: String(session.id ?? session.sessionId),
          session,
          ctx,
        }))))
      }

      return React.createElement('div', {
        style: panelStyle,
        'data-workspace-purpose': 'panel',
      }, children)
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

      // 侧边栏面板入口 + 它寻址的 main 面板（list id 必须等于 main key）。
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
      }, (props) => React.createElement(ConversationPanel, { ...props, ctx })))

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

      // 预热：面板、按钮与徽标都依赖它，早一次比晚一次好。
      ensureHostState()
    }

    return {
      apply,
      inject: ['slots', 'sessions', 'workspaces'],
    }
  },
})
