// dsh-project-context: CLIENT half.
//
// 在输入框右侧（conversation.input.right，list/session 级、低风险、id-keyed）
// 放一个"项目工作区上下文"开关按钮，逐会话独立控制：
//   - 会话不是工作区项目（无 cwd）→ 不渲染。
//   - 点击开关 → POST /__project-context/state 持久化；默认开启。
//   关闭后该会话不再被注入项目上下文（host 的 systemPrompt.context 读取同一状态）。
//
// Bundle 格式（client-modules protocol）：window.__ModuleLoader__.load({ id, factory })
// 注册经典脚本；无 JSX，纯 React.createElement；只用 --dsw-* 主题变量。
window.__ModuleLoader__.load({
  id: 'dsh-project-context',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useState } = React

    const SLOT = 'conversation.input.right'
    const ROW_ID = 'project-context-toggle'
    const HOST = '/__project-context/state'

    // --- 文案（跟随浏览器语言；可不依赖 locale service） --------------------------
    const zh = {
      label: '项目',
      onTitle: '项目工作区上下文：已开启（点击关闭本会话的自动注入）',
      offTitle: '项目工作区上下文：已关闭（点击开启本会话的自动注入）',
    }
    const en = {
      label: 'Project',
      onTitle: 'Project workspace context: ON (click to disable auto-inject for this session)',
      offTitle: 'Project workspace context: OFF (click to enable auto-inject for this session)',
    }
    function isEn() {
      if (typeof navigator === 'undefined') return false
      for (const tag of (navigator.languages || []).concat([navigator.language])) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh') return false
        if (primary === 'en') return true
      }
      return false
    }
    const DICT = () => (isEn() ? en : zh)

    // --- 样式（只用主题变量，轻量内联） --------------------------------------------
    const wrapStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      height: 28,
      padding: '0 8px',
      borderRadius: 8,
      cursor: 'pointer',
      userSelect: 'none',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
      background: 'var(--dsw-alias-bg-layer-2, transparent)',
      color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
      fontSize: 12,
      lineHeight: '20px',
      flex: 'none',
    }
    const onStyle = {
      color: 'var(--dsw-alias-state-business-primary, #3b82f6)',
      borderColor: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #3b82f6) 45%, transparent)',
    }

    function ProjectToggle(props) {
      const sessionId = props.sessionId || (props.session && props.session.id)
      const [state, setState] = useState(null) // {tracked,cwd,enabled,disabled}
      const [busy, setBusy] = useState(false)

      const refresh = useCallback(() => {
        if (!sessionId) return
        fetch(HOST + '?sessionId=' + encodeURIComponent(sessionId))
          .then((r) => r.json())
          .then((d) => { if (d && d.ok === true) setState(d) })
          .catch(() => { /* 拉取失败则隐藏 */ })
      }, [sessionId])

      useEffect(() => { refresh() }, [refresh])

      const toggle = useCallback(() => {
        if (!sessionId || busy || !state) return
        setBusy(true)
        const target = !state.enabled
        fetch(HOST, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, enabled: target }),
        })
          .then((r) => r.json())
          .then((d) => { if (d && d.ok === true) setState(d) })
          .catch(() => { /* 忽略，保持旧状态 */ })
          .finally(() => setBusy(false))
      }, [sessionId, busy, state])

      // 非工作区项目会话（无 cwd）→ 不渲染开关。
      if (!state || !state.tracked || !sessionId) return null

      const enabled = state.enabled === true
      const d = DICT()
      return React.createElement('button', {
        type: 'button',
        title: enabled ? d.onTitle : d.offTitle,
        'aria-pressed': enabled,
        'data-on': enabled ? 'true' : 'false',
        disabled: busy,
        style: { ...wrapStyle, ...(enabled ? onStyle : {}), ...(busy ? { opacity: 0.6, cursor: 'default' } : {}) },
        onClick: toggle,
      },
        React.createElement('span', {
          style: {
            fontSize: 10,
            lineHeight: '16px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          },
        },
          React.createElement('span', { 'aria-hidden': true }, enabled ? '●' : '○'),
          d.label))
    }

    function apply(ctx) {
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: ROW_ID,
        order: 200,
      }, ProjectToggle))
    }

    return { apply, inject: ['slots'] }
  },
})
