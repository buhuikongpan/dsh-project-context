// dsh-project-context: CLIENT half.
//
// 在输入框右侧（conversation.input.right，list/session 级、低风险、id-keyed）
// 放一个"项目工作区上下文"开关按钮，逐会话独立控制：
//   - 会话不是工作区项目（无 cwd）→ 不渲染。
//   - 点击开关 → POST /__project-context/state
//     （host 把开关状态写入 ~/.dsh/storages/project-context.json 状态文件，不再写
//      会话日志事件——自定义事件类型不在 harness 已知白名单内）；默认开启。
//   - 关闭不是"移除注入"，而是**降级**：host 的独立注入消息块仍然存在，
//     渲染内容变为"已降级为普通工作区"状态提示（技能目录同款的替换式注入），
//     模型在下一轮步骤里会明确看到状态变化。
//
// Bundle 格式（client-modules protocol）：window.__ModuleLoader__.load({ id, factory })
// 注册经典脚本；无 JSX，纯 React.createElement；只用 --dsw-* 主题变量。
window.__ModuleLoader__.load({
  id: 'dsh-project-context',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React

    const SLOT = 'conversation.input.right'
    const ROW_ID = 'project-context-toggle'
    const HOST = '/__project-context/state'
    // 重启后首次打开会话时,会话可能尚未完成打开(host 的 live 会话列表尚未
    // 包含它),此时 /state 返回 {tracked:false},会让按钮被隐藏且不自动刷新。
    // 这里做有限次延时重试,等会话打开完成后再取一次真实状态。
    const MAX_RETRY = 3
    const RETRY_DELAY = [300, 800, 1600]

    // --- 文案（跟随浏览器语言；可不依赖 locale service） --------------------------
    const zh = {
      label: '项目',
      onTitle: '项目工作区上下文：已开启（点击关闭，本会话降级为普通工作区）',
      offTitle: '项目工作区上下文：已关闭（本会话已降级为普通工作区；点击恢复项目上下文）',
    }
    const en = {
      label: 'Project',
      onTitle: 'Project workspace context: ON (click to disable and downgrade this session to a plain workspace)',
      offTitle: 'Project workspace context: OFF — this session is a plain workspace (click to re-enable)',
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
      const sessionId = props.sessionId ?? (props.session && (props.session.sessionId ?? props.session.id))
      const [state, setState] = useState(null) // {tracked,cwd,enabled,disabled}
      const [busy, setBusy] = useState(false)
      const timerRef = useRef(null) // 延时重试定时器
      const aliveRef = useRef(true) // 卸载后忽略异步结果
      const refreshRef = useRef(() => {})

      const refresh = useCallback((attempt = 0) => {
        if (!sessionId) return
        const retry = () => {
          timerRef.current = setTimeout(() => refreshRef.current(attempt + 1), RETRY_DELAY[attempt] ?? 1600)
        }
        fetch(HOST + '?sessionId=' + encodeURIComponent(sessionId))
          .then((r) => r.json())
          .then((d) => {
            if (!aliveRef.current) return
            if (d && d.ok === true) {
              setState(d)
              // tracked:false 可能只是会话尚未 live（重启后首次打开时 host 的
              // live 会话列表还未包含它）——有限次延时重试，等会话打开完成再取一次真实状态；
              // 到上限仍为 false 说明该会话本就无 cwd（系统会话），保持隐藏即正确行为。
              if (d.tracked === false && attempt < MAX_RETRY) retry()
            }
          })
          .catch(() => { if (attempt < MAX_RETRY) retry() }) // 请求失败也有限重试
      }, [sessionId])

      useEffect(() => {
        refreshRef.current = refresh
        aliveRef.current = true
        refresh()
        return () => {
          aliveRef.current = false
          if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
        }
      }, [refresh])

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
