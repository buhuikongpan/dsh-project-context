// dsh-project-context (workspace purpose): CLIENT half.
//
// 两处 UI，都只做"呈现"：
//   1. sidebar.footer.action（list / root）→「临时会话」按钮：点击让宿主建一个新
//      子目录，然后拿这个 cwd 创建一个会话（`sessions.create({cwd})`）。
//      临时会话不属于任何工作区，因此落在侧边栏的"未分组"桶里——每个会话有自己的
//      目录与沙箱边界，互不干扰。
//   2. conversation.session.header.actions（list / session）→「临时会话」徽标：
//      当前会话的 cwd 在临时根目录之下时渲染一个不可点的 Pill。
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
      },
      en: {
        button: 'Temporary',
        buttonTitle: 'Start a temporary session: its own directory, project conventions do not apply',
        buttonDisabledTitle: 'Temporary session directory unavailable (the host could not create it)',
        badge: 'Temporary',
        badgeTitle: 'This session runs in its own temporary directory: project instructions and conventions do not apply',
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

    // --- UI 1：侧边栏底部「临时会话」按钮 ----------------------------------------
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
        const service = serviceOf(ctx, 'sessions')
        if (!service || typeof service.create !== 'function') {
          console.warn('dsh-project-context: sessions.create is unavailable; cannot start a temporary session')
          return
        }
        // 当前已经是空白会话 → 再开一个只会刷出一串空会话，什么都不做。
        const current = sessions ? sessions.current : undefined
        const currentSummary = summaryOf(sessions, current)
        if (currentSummary && currentSummary.blank === true) return

        fetch(NEW_CONVERSATION_PATH, { method: 'POST', headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : undefined))
          .then((data) => {
            if (!data || data.ok !== true || typeof data.cwd !== 'string') {
              throw new Error(data && data.error ? String(data.error) : 'bad new-conversation response')
            }
            const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined
            return service.create(sessionId === undefined ? { cwd: data.cwd } : { sessionId, cwd: data.cwd })
          })
          .then((result) => {
            if (!result || result.ok !== true) throw new Error('session creation failed')
            const sessionId = result.value && result.value.sessionId
            if (typeof sessionId === 'string' && typeof service.open === 'function') service.open(sessionId)
          })
          .catch((error) => {
            console.warn('dsh-project-context: failed to start a temporary session:', error)
          })
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

    // --- UI 2：会话头「临时会话」徽标 --------------------------------------------
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

      // 预热：按钮与徽标都依赖它，早一次比晚一次好。
      ensureHostState()
    }

    return {
      apply,
      inject: ['slots', 'sessions'],
    }
  },
})
