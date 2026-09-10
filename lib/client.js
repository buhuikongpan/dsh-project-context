// dsh-project-context (workspace purpose): CLIENT half.
//
// 两处 UI，都只做"呈现"，不提供任何会话级开关（用途是工作区的属性）：
//   1. sidebar.footer.action（list / root）→ 「临时会话」按钮：点击在固定临时
//      工作区里开一个新会话。owner props 只给 `{wide}`，startSession 必须自己从
//      `ctx.uiWorkspace` 取（官方 SidebarRoot 的注入面）。
//   2. conversation.session.header.actions（list / session）→ 「临时会话」徽标：
//      当前会话属于临时工作区时渲染一个不可点的 Pill。
//
// 判定口径：反查 `workspaces` 快照里 `sessionIds.includes(sessionId)`，再比那个
// workspaceId 是否等于 host 给的 conversationWorkspaceId —— 纯 uuid 比较，
// 不碰 Windows 路径大小写/短名的坑。
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
        buttonTitle: '在临时会话工作区里开一个新会话（不适用项目约定）',
        buttonDisabledTitle: '临时会话工作区不可用（宿主未能创建或登记该目录）',
        badge: '临时会话',
        badgeTitle: '本会话在临时会话工作区里：项目指令与项目约定不适用',
      },
      en: {
        button: 'Temporary',
        buttonTitle: 'Start a new session in the temporary conversation workspace (project conventions do not apply)',
        buttonDisabledTitle: 'Temporary conversation workspace unavailable (the host could not create or register it)',
        badge: 'Temporary',
        badgeTitle: 'This session runs in the temporary conversation workspace: project instructions and conventions do not apply',
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
    // conversationWorkspaceId: undefined = 未取到；null = 宿主明确说"还没有"。
    const hostState = { conversationWorkspaceId: undefined, ready: false }
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
          hostState.conversationWorkspaceId = typeof data.conversationWorkspaceId === 'string'
            ? data.conversationWorkspaceId
            : null
          hostState.ready = data.ready === true
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

    /** 某会话是否属于固定临时工作区（纯 uuid 反查）。 */
    function isConversationSession(snapshot, sessionId, conversationWorkspaceId) {
      if (!snapshot || !sessionId || !conversationWorkspaceId) return false
      const items = snapshot.items
      if (!Array.isArray(items)) return false
      const wanted = String(sessionId).replace(/^session-/, '')
      for (const workspace of items) {
        if (!workspace || workspace.workspaceId !== conversationWorkspaceId) continue
        const ids = workspace.sessionIds
        if (!Array.isArray(ids)) return false
        return ids.some((id) => String(id).replace(/^session-/, '') === wanted)
      }
      return false
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

      const available = state.ready === true
        && typeof state.conversationWorkspaceId === 'string'
        && state.conversationWorkspaceId.length > 0

      const start = useCallback(() => {
        if (!available) return
        const uiWorkspace = serviceOf(ctx, 'uiWorkspace')
        if (!uiWorkspace || typeof uiWorkspace.startSession !== 'function') {
          console.warn('dsh-project-context: uiWorkspace.startSession is unavailable; cannot start a temporary session')
          return
        }
        // 当前已经是空白会话 → 再开一个只会刷出一串空会话，什么都不做。
        const current = sessions ? sessions.current : undefined
        const currentSummary = current !== undefined && sessions && sessions.byId ? sessions.byId[current] : undefined
        if (currentSummary && currentSummary.blank === true) return
        try {
          uiWorkspace.startSession(state.conversationWorkspaceId)
        } catch (error) {
          console.warn('dsh-project-context: failed to start a temporary session:', error)
        }
      }, [available, ctx, sessions, state.conversationWorkspaceId])

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
      const workspaces = useServiceSnapshot(ctx, 'workspaces')
      const d = t()
      const sessionId = props.sessionId
        ?? (props.session && (props.session.sessionId ?? props.session.id))
      if (!isConversationSession(workspaces, sessionId, state.conversationWorkspaceId)) return null

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
      if (typeof ctx.effect === 'function' && typeof ctx.locale?.register === 'function') {
        ctx.effect(() => ctx.locale.register(NS, dict), 'workspace-purpose: dictionaries')
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
      inject: ['slots', 'sessions', 'workspaces', 'uiWorkspace'],
    }
  },
})
