// dsh-project-context (workspace purpose): CLIENT half.
//
// 两处 UI：
//   1. sidebar.panellist（list / root）→ 「临时会话」按钮。它在官方「新会话」按钮
//      下面那一排（panelList）里，点它就是"在临时工作区里开一个新会话"。
//      那一排每项本来只渲染一个图标、点击由外壳的 selectPanel 接管，所以 entry 里
//      铺了一层覆盖点击区的透明层并 stopPropagation，把点击改成开新会话。
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
    const { useEffect, useRef, useState } = React

    const NS = 'workspace-purpose'
    const STATE_PATH = '/__workspace-purpose/state'
    // 「新会话」下面那一排就是 sidebar.panellist（panelList），比底部按钮顺手得多。
    // 契约里那一排每项只渲染"图标 + 标签"，点击由外壳的 selectPanel 接管；这里铺一层
    // 覆盖点击区的透明层 + stopPropagation 把它劫持成"开新会话"。
    const PANEL_SLOT = 'sidebar.panellist'
    const PANEL_ID = 'workspace-purpose-new-conversation'
    // selectPanel 会校验 hasMainPanel(id)，不注册会抛错——注册一个渲染 null 的占位；
    // 劫持成功时它永远不会被渲染。
    const MAIN_SLOT = 'main'
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

    /**
     * panelList 那一排的标签。契约支持 `string | (() => string)`；传函数的话外壳每次
     * 投影都会重新求值，所以切换界面语言时标签跟着变，不需要重新注册。
     */
    function panelLabel() {
      return t().button
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

    // --- UI 1：侧边栏「新会话」下面那一排里的「临时会话」按钮 ----------------------
    /**
     * 在临时工作区里开一个新会话。
     * 当前已经是空白会话时直接跳过（否则连点会刷出一串空会话）。
     */
    function startTemporarySession({ ctx, state, sessions }) {
      const available = state.ready === true
        && typeof state.conversationWorkspaceId === 'string'
        && state.conversationWorkspaceId.length > 0
      if (!available) return
      const uiWorkspace = serviceOf(ctx, 'uiWorkspace')
      if (!uiWorkspace || typeof uiWorkspace.startSession !== 'function') {
        console.warn('dsh-project-context: uiWorkspace.startSession is unavailable; cannot start a temporary session')
        return
      }
      const current = sessions ? sessions.current : undefined
      const currentSummary = current !== undefined && sessions && sessions.byId ? sessions.byId[current] : undefined
      if (currentSummary && currentSummary.blank === true) return
      try {
        uiWorkspace.startSession(state.conversationWorkspaceId)
      } catch (error) {
        console.warn('dsh-project-context: failed to start a temporary session:', error)
      }
    }

    /**
     * panellist 的 entry：外壳只给 `{ size, active }`，并把渲染结果塞进一个固定尺寸的
     * 图标位，外面还套着官方自己的 button（onClick = selectPanel）。
     *
     * 所以这里只画图标，另在**捕获阶段**监听那个外层 button 的 click——点图标、点标签、
     * 点整行都算，抢在 React 的冒泡委托之前把事件停掉，改成开新会话。
     */
    function NewConversationEntry(props) {
      const ctx = props && props.ctx
      const state = useHostState()
      const sessions = useServiceSnapshot(ctx, 'sessions')
      const size = props && props.size ? props.size : 16
      const d = t()
      const ref = useRef(null)

      const available = state.ready === true
        && typeof state.conversationWorkspaceId === 'string'
        && state.conversationWorkspaceId.length > 0
      const title = available ? d.buttonTitle : d.buttonDisabledTitle

      useEffect(() => {
        const node = ref.current
        if (!node || typeof node.closest !== 'function') return undefined
        const row = node.closest('button')
        if (!row) return undefined
        const onClick = (event) => {
          event.stopPropagation()
          event.preventDefault()
          startTemporarySession({ ctx, state, sessions })
        }
        row.addEventListener('click', onClick, true)
        return () => row.removeEventListener('click', onClick, true)
      }, [ctx, state, sessions])

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
        ref,
        title,
        'data-workspace-purpose': 'new-conversation',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size,
          height: size,
        },
      }, glyph)
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

      // 「临时会话」按钮：放在官方「新会话」下面那一排（panelList）里。
      // label 传字符串即可（这一排的标签由外壳投影，宽模式下显示在图标右侧）。
      ctx.slots.inject(PANEL_SLOT, () => ctx.slots.register({
        name: PANEL_SLOT,
        id: PANEL_ID,
        order: 100,
        label: panelLabel,
      }, (props) => React.createElement(NewConversationEntry, { ...props, ctx })))

      // main 占位：selectPanel 会校验 hasMainPanel(id)，不注册会抛错。
      // 点击已被 entry 劫持，所以它正常情况下永远不会渲染。
      ctx.slots.inject(MAIN_SLOT, () => ctx.slots.register({
        name: MAIN_SLOT,
        key: PANEL_ID,
      }, () => null))

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
