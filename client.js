/**
 * dsh-douyin-life —— 浏览器半端（「设置」里的一页：刷抖音）
 * ============================================================================
 * ⭐ client bundle 不是 ESM，是自注册脚本（跟 dsh-bili-scroll 同一套约定）：
 *
 *     window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ({ inject, apply }) })
 *
 * ⭐ 进「设置」= 往 settings.section 槽位注册一项；label 就是左侧导航那一行。
 * ⭐ 面板形状照使用者 2026-10-23 给的截图：顶部一排状态徽章 + 「现在跑一轮」，
 *    下面四个 tab（日常 / 偏好 / 互动 / 高级），每个 tab 顶上都有「保存」。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-douyin-life',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/douyin-duty'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const MEM_CSS = `
  .dym-root{display:flex;flex-direction:column;gap:10px}
  .dym-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .dym-title{font-size:15px;font-weight:600;letter-spacing:.2px}
  .dym-badge{font-size:11px;opacity:.6;border:1px solid rgba(128,128,128,.35);border-radius:999px;padding:1px 8px}
  .dym-chips{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
  .dym-chip{font-size:11.5px;opacity:.85;border:1px solid rgba(128,128,128,.3);border-radius:999px;padding:2px 9px}
  .dym-chip b{font-weight:600}
  .dym-tabs{display:flex;gap:6px;flex-wrap:wrap}
  .dym-tab{font-size:12.5px;padding:5px 12px;border-radius:999px;border:1px solid rgba(128,128,128,.3);background:transparent;color:inherit;cursor:pointer}
  .dym-tab.on{background:var(--dsh-accent,#4b6bfb);border-color:transparent;color:#fff}
  .dym-card{border:1px solid rgba(128,128,128,.22);border-radius:12px;padding:10px 12px;font-size:12.5px;line-height:1.6;white-space:pre-wrap;margin-bottom:8px}
  .dym-kv{display:flex;gap:8px;margin-bottom:3px}
  .dym-k{opacity:.6;min-width:88px}
  .dym-graph{border:1px solid rgba(128,128,128,.22);border-radius:12px;overflow:hidden;position:relative;background:rgba(128,128,128,.04)}
  .dym-graph svg{display:block;cursor:grab;touch-action:none}
  .dym-graph svg.dragging{cursor:grabbing}
  .dym-gctrl{position:absolute;right:8px;bottom:8px;display:flex;gap:6px}
  .dym-gbtn{width:28px;height:28px;border-radius:8px;border:1px solid rgba(128,128,128,.35);background:var(--dsh-bg,#1b1d22);color:inherit;font-size:14px;line-height:1;cursor:pointer}
  .dym-tip{position:absolute;left:10px;bottom:10px;font-size:11.5px;opacity:.7}
`

    const CSS = `
[data-dy-page]{display:flex;flex-direction:column;gap:14px;padding:2px 2px 10px;max-width:660px;}
[data-dy-top]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-dy-grow]{flex:1;min-width:0;}
[data-dy-badges]{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
[data-dy-badge]{font-size:11px;line-height:16px;padding:3px 8px;border-radius:6px;white-space:nowrap;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.24));
  color:var(--dsw-alias-label-secondary,inherit);background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));}
[data-dy-badge][data-good]{color:#22c55e;border-color:rgba(34,197,94,.35);}
[data-dy-badge][data-warn]{color:#f59e0b;border-color:rgba(245,158,11,.35);}
[data-dy-tabs]{display:flex;gap:4px;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));}
[data-dy-tab]{flex:1;min-width:0;cursor:pointer;font:inherit;font-size:13px;padding:7px 10px;border:0;border-radius:8px;
  background:transparent;color:var(--dsw-alias-label-secondary,inherit);}
[data-dy-tab]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));}
[data-dy-tab][aria-selected=true]{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,inherit);
  font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12);}
[data-dy-sec]{display:flex;flex-direction:column;gap:8px;}
[data-dy-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-dy-label]{font-size:13px;}
[data-dy-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-dy-sw][data-on]{background:#3b82f6;}
[data-dy-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-dy-sw][data-on] i{left:19px;}
[data-dy-sw][disabled]{opacity:.45;cursor:default;}
[data-dy-sub]{margin-left:14px;padding-left:12px;border-left:2px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.1));
  display:flex;flex-direction:column;gap:10px;}
[data-dy-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-dy-input]:focus{outline:none;border-color:#3b82f6;}
[data-dy-num]{width:88px;text-align:center;}
[data-dy-area]{min-height:64px;resize:vertical;}
[data-dy-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));color:inherit;}
[data-dy-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-dy-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-dy-btn][disabled]{opacity:.5;cursor:default;}
[data-dy-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-msg][data-warn]{color:#f59e0b;}
[data-dy-msg][data-good]{color:#22c55e;}
[data-dy-qr]{display:flex;gap:14px;align-items:flex-start;}
[data-dy-qr] img{width:150px;height:150px;border-radius:8px;background:#fff;padding:6px;}
[data-dy-pre]{margin:6px 0 0;padding:8px 9px;border-radius:8px;max-height:190px;overflow:auto;font-size:11px;
  line-height:15px;white-space:pre-wrap;word-break:break-all;
  background:var(--dsw-alias-bg-layer-4,rgba(0,0,0,.25));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-dy-day]{display:flex;flex-direction:column;gap:6px;margin-top:14px;}
[data-dy-dayhead]{font-size:12px;font-weight:700;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,inherit);padding:2px 2px 0;border-bottom:1px dashed var(--dsw-alias-bg-layer-3,rgba(127,127,127,.3));}
[data-dy-nocover]{display:flex;align-items:center;justify-content:center;aspect-ratio:16/9;font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));}
[data-dy-list]{margin:8px 0 0;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;}
[data-dy-item]{display:flex;flex-direction:column;gap:3px;padding:9px 11px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.22));
  color:var(--dsw-alias-label-primary,inherit);}
[data-dy-item-t]{font-size:12px;line-height:16px;font-weight:600;}
[data-dy-item-n]{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,inherit);}
[data-dy-chip]{cursor:pointer;white-space:nowrap;font:inherit;font-size:12px;padding:3px 10px;border-radius:999px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.22));background:transparent;
  color:var(--dsw-alias-label-secondary,inherit);}
[data-dy-chip]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));}
[data-dy-chip][aria-selected=true]{color:var(--dsw-alias-label-primary,inherit);
  border-color:var(--dsw-alias-brand-primary,#4c8dff);background:rgba(76,141,255,.12);}
[data-dy-away]{display:none !important;}
`

    const TABS = [
      ['daily', '日常'],
      ['pref', '刷视频'],
      ['like', '互动'],
      ['dm', '私信'],
      ['sticker', '表情包'],
      ['adv', '高级'],
    ]

    /* ── 小部件 ─────────────────────────────────────────────────────── */
    const Sw = ({ on, onChange, disabled, title }) => h('button', {
      'data-dy-sw': '', 'data-on': on ? '' : undefined, disabled: disabled ? '' : undefined,
      title: title || '', onClick: () => { if (!disabled) onChange(!on) },
    }, h('i'))

    const Row = (props, ...kids) => h('div', { 'data-dy-row': '' }, ...kids)
    const Note = (text) => h('div', { 'data-dy-note': '' }, text)

    function Section(tab, title, ...kids) {
      return h('div', { 'data-dy-sec': '', 'data-dy-group': tab, 'data-dy-away': undefined }, ...kids)
    }

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [tab, setTab] = React.useState('daily')
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [tone, setTone] = React.useState('')
      const [draft, setDraft] = React.useState({})
      const [qr, setQr] = React.useState(null)
      const [showSms, setShowSms] = React.useState(false)
      const [smsPhone, setSmsPhone] = React.useState('')
      const [smsCode, setSmsCode] = React.useState('')
      const [report, setReport] = React.useState(null)
      const [checks, setChecks] = React.useState(null)
      const [logTail, setLogTail] = React.useState(null)
      const [comfyList, setComfyList] = React.useState(null)
      const [setupLog, setSetupLog] = React.useState(null)
      const [watched, setWatched] = React.useState(null)

      const load = async () => {
        try {
          const r = await jget('/status')
          setSt(r)
          const c = r.config || {}
          setDraft({
            ...c,
            peakValley: Boolean(c.peakValley), noon: Boolean(c.noon), night: Boolean(c.night),
            perDay: Number(c.perDay) || 0,
            keywords: Array.isArray(c.keywords) ? c.keywords.join('、') : '',
            reportLevel: String(c.reportLevel || 'full'),
            personaPrompt: String(c.personaPrompt || ''),
            autoReply: Boolean(c.autoReply), replyPerRun: c.replyPerRun ?? 3, replyPerDay: c.replyPerDay ?? 10,
            replyRandom: c.replyRandom !== false, replyVideoIds: String(c.replyVideoIds || ''), replyIntervalMin: c.replyIntervalMin ?? 30, replyOncePerUser: Boolean(c.replyOncePerUser), skipLive: c.skipLive !== false, shareToNick: String(c.shareToNick || ''), replyWorksDays: c.replyWorksDays ?? 3, autoClean: c.autoClean !== false, shareWithNote: c.shareWithNote !== false, shareNote: String(c.shareNote || ''), msgAllowTo: String(c.msgAllowTo || ''), dmAutoReply: c.dmAutoReply !== false, dmAutoIntervalSec: Number(c.dmAutoIntervalSec) || 15, dmReply: Boolean(c.dmReply), dmReplyOnlyTo: String(c.dmReplyOnlyTo || ''), dmReplyPerContact: c.dmReplyPerContact ?? 1, dmReplyPerDay: c.dmReplyPerDay ?? 5, sharePerDay: c.sharePerDay ?? 10, autoCommentPlain: Boolean(c.autoCommentPlain), plainCommentPerDay: c.plainCommentPerDay ?? 10, pickPerRound: c.pickPerRound ?? 2, skipOverMin: c.skipOverMin ?? 60, skimOverMin: c.skimOverMin ?? 5, streakNick: String(c.streakNick || ''), streakSticker: String(c.streakSticker || '大肥鱼'), streakPerDay: c.streakPerDay ?? 1, askDoubao: Boolean(c.askDoubao),
            autoLike: Boolean(c.autoLike), autoComment: Boolean(c.autoComment),
            autoPublish: Boolean(c.autoPublish), publishDraft: Boolean(c.publishDraft),
            commentPerDay: Number(c.commentPerDay) || 0, publishPerDay: Number(c.publishPerDay) || 0,
            publishTitle: String(c.publishTitle || ''), publishTags: String(c.publishTags || ''),
            mentionName: String(c.mentionName || ''), commentPerRound: Number(c.commentPerRound) || 0,
            pythonPath: String(c.pythonPath || ''), dshBin: String(c.dshBin || ''),
            comfyUrl: String(c.comfyUrl || ''), comfyOutputDir: String(c.comfyOutputDir || ''),
            comfyWorkflow: String(c.comfyWorkflow || ''),
            cdpUrl: String(c.cdpUrl || ''), cdpPort: Number(c.cdpPort) || 9222, watchFrames: Number(c.watchFrames) || 10,
          })
        } catch (e) { setMsg('读状态失败：' + String(e.message || e)); setTone('warn') }
      }
      React.useEffect(() => { load() }, [])
      const [dmInfo, setDmInfo] = React.useState(null)
      const [stk, setStk] = React.useState(null)
      const [stkKeyword, setStkKeyword] = React.useState('干饭')
      React.useEffect(() => {
        if (tab === 'dm') jget('/dm').then((r) => setDmInfo(r)).catch(() => {})
        if (tab === 'sticker') jget('/stickers').then((r) => setStk(r)).catch(() => {})
      }, [tab])

      /* ⭐ 二维码一出来就自己盯着登录态：扫完自动变「已登录」，不用再点「我扫完了」
         （使用者 2026-10-23：「我扫完登录了没反应」—— 之前只出码不轮询，看着就像没反应） */
      React.useEffect(() => {
        if (!qr?.qr) return undefined
        let n = 0
        const t = setInterval(async () => {
          n += 1
          try {
            const r = await jpost('/login/poll', {})
            if (r.loggedIn) {
              clearInterval(t)
              setQr(null)
              setMsg('登录成功，登录态已经留在那个 Chrome 里')
              setTone('good')
              await load()
            }
          } catch { /* 轮询失败就等下一次 */ }
          if (n > 40) {
            clearInterval(t)
            setMsg('二维码超时了（约 2 分钟）—— 再点一次「扫码登录」')
            setTone('warn')
          }
        }, 3000)
        return () => clearInterval(t)
      }, [qr?.qr])

      const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }))

      const save = async () => {
        setBusy('save'); setMsg('')
        try {
          const patch = {
            ...draft,
            peakValley: draft.peakValley, noon: draft.noon, night: draft.night,
            perDay: Number(draft.perDay) || 0,
            keywords: String(draft.keywords || '').split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean),
            reportLevel: draft.reportLevel, personaPrompt: draft.personaPrompt,
            autoLike: draft.autoLike, autoComment: draft.autoComment,
            autoReply: draft.autoReply, replyPerRun: Number(draft.replyPerRun) || 0,
            replyPerDay: Number(draft.replyPerDay) || 0, replyRandom: draft.replyRandom !== false,
            replyVideoIds: String(draft.replyVideoIds || ''), replyIntervalMin: Number(draft.replyIntervalMin) || 30, replyOncePerUser: Boolean(draft.replyOncePerUser), skipLive: draft.skipLive !== false, shareToNick: String(draft.shareToNick || ''), replyWorksDays: Number(draft.replyWorksDays) || 3, autoClean: draft.autoClean !== false, shareWithNote: draft.shareWithNote !== false, shareNote: String(draft.shareNote || ''), msgAllowTo: String(draft.msgAllowTo || ''), dmReply: Boolean(draft.dmReply), dmReplyOnlyTo: String(draft.dmReplyOnlyTo || ''), dmReplyPerContact: Number(draft.dmReplyPerContact) || 1, dmReplyPerDay: Number(draft.dmReplyPerDay) || 0, sharePerDay: Number(draft.sharePerDay) || 0, autoCommentPlain: Boolean(draft.autoCommentPlain), plainCommentPerDay: Number(draft.plainCommentPerDay) || 0, pickPerRound: Number(draft.pickPerRound) || 2, skipOverMin: Number(draft.skipOverMin) || 60, skimOverMin: Number(draft.skimOverMin) || 5, streakNick: String(draft.streakNick || ''), streakSticker: String(draft.streakSticker || '大肥鱼'), streakPerDay: Number(draft.streakPerDay) || 0, askDoubao: Boolean(draft.askDoubao),
            autoPublish: draft.autoPublish, publishDraft: draft.publishDraft,
            commentPerDay: Number(draft.commentPerDay) || 0, publishPerDay: Number(draft.publishPerDay) || 0,
            publishTitle: draft.publishTitle, publishTags: draft.publishTags,
            mentionName: draft.mentionName, commentPerRound: Number(draft.commentPerRound) || 0,
            pythonPath: draft.pythonPath, dshBin: draft.dshBin,
            comfyUrl: draft.comfyUrl, comfyOutputDir: draft.comfyOutputDir, comfyWorkflow: draft.comfyWorkflow,
            cdpUrl: draft.cdpUrl, cdpPort: Number(draft.cdpPort) || 9222, watchFrames: Math.max(3, Math.min(Number(draft.watchFrames) || 10, 48)),
          }
          const r = await jpost('/config', patch)
          setMsg(r.host && r.host.ok === false ? '已存到插件自己那份（宿主设置层没写成，不影响使用）' : '已保存')
          setTone(r.host && r.host.ok === false ? 'warn' : 'good')
          await load()
        } catch (e) { setMsg('保存失败：' + String(e.message || e)); setTone('warn') }
        setBusy('')
      }

      const runNow = async () => {
        setBusy('run'); setMsg('')
        try {
          const r = await jpost('/run', {})
          if (r.ok) {
            const acts = Array.isArray(r.actions) ? r.actions : []
            if (r.started) { setMsg('headless 会话已启动，工具经宿主检查后执行；完成状态请查看运行状态和日报。'); setTone('warn'); setBusy(''); return }
            if (r.skipped) { setMsg(r.skipped); setTone('warn'); setBusy(''); await load(); return }
            setMsg(`刷完一轮：挑了 ${r.picked ?? 0} 条${acts.length ? '，' + acts.join('；') : ''}`)
            setTone(acts.some((a) => /没|失败|未|待核对|额度|跳过|关闭/.test(a)) ? 'warn' : 'good')
            setWatched(null); setReport(null)
            await load()
            await loadWatched().catch(() => {})
          } else {
            setMsg('没跑成：' + (r.error || r.hint || '原因不明') + (Array.isArray(r.notes) && r.notes.length ? '（' + r.notes.join('；') + '）' : ''))
            setTone('warn')
          }
        } catch (e) { setMsg('跑一轮失败：' + String(e.message || e)); setTone('warn') }
        setBusy('')
      }

      const loginStart = async () => {
        setBusy('login'); setMsg('正在出二维码…')
        try {
          const r = await jpost('/login/qr', {})
          setQr(r)
          setMsg(r.qr ? '二维码出来了：手机抖音 → 扫一扫（约 180 秒有效）' : ('没截到二维码：' + (r.hint || r.error || '')))
          setTone(r.qr ? 'good' : 'warn')
        } catch (e) { setMsg('出码失败：' + String(e.message || e)); setTone('warn') }
        setBusy('')
      }

      const loginPoll = async () => {
        setBusy('poll')
        try {
          const r = await jpost('/login/poll', {})
          setMsg(r.loggedIn ? '登录成功，登录态已经留在那个 Chrome 里' : ('还没扫：' + (r.hint || '')))
          setTone(r.loggedIn ? 'good' : 'warn')
          if (r.loggedIn) { setQr(null); await load() }
        } catch (e) { setMsg('查询失败：' + String(e.message || e)); setTone('warn') }
        setBusy('')
      }

      const openChrome = async () => {
        setBusy('chrome'); setMsg('正在拉起带调试端口的 Chrome…')
        try {
          const r = await jpost('/chrome/open', {})
          setMsg(r.ok ? (r.already ? 'CDP 本来就通' : 'Chrome 起来了，直接用它刷') : (r.hint || r.error || '没起来'))
          setTone(r.ok ? 'good' : 'warn')
          await load()
        } catch (e) { setMsg('拉起失败：' + String(e.message || e)); setTone('warn') }
        setBusy('')
      }

      const selfcheck = async () => {
        setBusy('check'); setChecks(null)
        try {
          const r = await jpost('/selfcheck', {})
          setChecks(r.items || [])
          setMsg(r.ok ? '全部正常' : '有几项不通，看下面')
          setTone(r.ok ? 'good' : 'warn')
        } catch (e) { setMsg('自检失败：' + String(e.message || e)); setTone('warn') }
        setBusy('')
      }

      const showReport = async () => {
        if (report !== null) { setReport(null); return }
        setBusy('report')
        try {
          const r = await jget('/report/latest')
          setReport(r.report ? (r.report.text || '（空）') : '（还没有日报：' + (r.hint || '') + '）')
        } catch (e) { setReport('读失败：' + String(e.message || e)) }
        setBusy('')
      }

      const showLog = async () => {
        if (logTail !== null) { setLogTail(null); return }
        try {
          const r = await jget('/log/tail')
          setLogTail(r.tail || '')
        } catch (e) { setLogTail('读失败：' + String(e.message || e)) }
      }

      const sendSms = async () => {
        if (smsPhone.length !== 11) { setMsg('先填 11 位手机号'); setTone('warn'); return }
        setBusy('sms'); setMsg('正在发短信…')
        try {
          const r = await jpost('/login/sms', { phone: smsPhone })
          setMsg(r.ok ? (r.sent === false ? '点了发送，但没看到倒计时（可能没发出去）' : '短信已发出：把收到的 6 位填到右边那个框')
            : ('没发成：' + (r.error || r.hint || '')))
          setTone(r.ok ? 'good' : 'warn')
        } catch (e) { setMsg('发短信失败：' + String(e.message || e)); setTone('warn') }
        setBusy('')
      }

      const submitSms = async () => {
        if (smsCode.length < 4) { setMsg('先填验证码'); setTone('warn'); return }
        setBusy('sms'); setMsg('正在提交验证码…')
        try {
          const r = await jpost('/login/sms/submit', { code: smsCode })
          if (r.loggedIn) { setMsg('短信验证通过，已登录'); setTone('good'); setShowSms(false); setSmsCode(''); await load() }
          else { setMsg('没登上：' + (r.error || r.hint || '验证码可能不对')); setTone('warn') }
        } catch (e) { setMsg('提交失败：' + String(e.message || e)); setTone('warn') }
        setBusy('')
      }

      const replyNow = async () => {
        setBusy('reply'); setMsg('正在读我自己视频的评论…'); setTone('')
        try {
          const r = await jpost('/reply/round', { count: Number(draft.replyPerRun) || 0, random: draft.replyRandom !== false })
          if (r.ok) {
            const sent = Number(r.sent) || 0
            setMsg(`回了一轮：发出 ${sent} 条（今天已回 ${r.today}/${r.perDay}）`)
            setTone(sent ? 'good' : 'warn')
            setReport(null)
            await load()
          } else { setMsg('没回成：' + (r.error || '')); setTone('warn') }
        } catch (e) { setMsg('回评论失败：' + String(e.message || e)); setTone('warn') }
        setBusy('')
      }
      const openDir = async (what) => {
        try { await jpost('/open', { what }) } catch (e) { setMsg('打不开：' + String(e.message || e)) }
      }

      const doSetup = async () => {
        setBusy('setup'); setMsg('正在后台装主依赖（建 venv + install mcp/playwright）…')
        try {
          const r = await jpost('/setup', {})
          setMsg(r.ready ? '环境本来就已经就绪' : (r.started ? '已经在装了：几十秒到两分钟，装完点「看安装日志」确认' : ('没起来：' + (r.error || r.hint || ''))))
          setTone(r.ok ? 'good' : 'warn')
          setTimeout(() => { showSetupLog() }, 1500)
        } catch (e) { setMsg('装依赖失败：' + String(e.message || e)); setTone('warn') }
        setBusy('')
      }

      const showSetupLog = async () => {
        if (setupLog !== null) { setSetupLog(null); return }
        try {
          const r = await jget('/setup/log')
          const tail = String(r.tail || '')
          const head = r.venvReady ? `环境已就绪（${r.venvPython || ''}）` : `还缺：${(r.missing || []).join(' / ') || '未知'}`
          setSetupLog(head + '\n' + tail)
        } catch (e) { setSetupLog('读失败：' + String(e.message || e)) }
      }

      const loadWatched = async () => {
        if (watched !== null) { setWatched(null); return }
        setBusy('watched')
        try {
          const r = await jget('/watched')
          setWatched(Array.isArray(r.items) ? r.items : [])
          if (!r.items?.length) setMsg(r.hint || '这份报告里没有可显示的条目')
        } catch (e) { setMsg('读刷过的视频失败：' + String(e.message || e)); setWatched([]) }
        setBusy('')
      }

      const listComfy = async () => {        if (comfyList !== null) { setComfyList(null); return }
        setBusy('comfy')
        try {
          const r = await jget('/comfy/list')
          setComfyList(Array.isArray(r.items) ? r.items.slice(0, 6) : [])
          if (!r.exists) setMsg('ComfyUI 输出目录不存在：' + (r.dir || '') + '（去「高级」里改）')
        } catch (e) { setMsg('读成片失败：' + String(e.message || e)); setComfyList([]) }
        setBusy('')
      }

      const publishLatest = async () => {
        setBusy('publish'); setMsg('正在把最新成片发出去…')
        try {
          const r = await jpost('/publish', { draft: Boolean(draft.publishDraft) })
          if (r.ok) {
            setMsg((r.draft ? '已存草稿：' : '已发出：') + String(r.video || '').split(/[\\/]/).pop() + (r.url ? ' · ' + r.url : ''))
            setTone('good')
          } else {
            setMsg(r.already ? ('这条已经投过了（' + (r.publishedAt || '') + '）') : (r.hint || r.error || '没发出去'))
            setTone('warn')
          }
          await load()
        } catch (e) { setMsg('投稿失败：' + String(e.message || e)); setTone('warn') }
        setBusy('')
      }

      if (!st) return h('div', { 'data-dy-page': '' }, h('div', { 'data-dy-note': '' }, '读取中…'))

      const win = st.nextWindow || {}
      const cdpOk = Boolean(st.cdp && st.cdp.ok)
      const pyOk = st.mcpRunning === true || st.build?.loadedMcp != null

      return h('div', { 'data-dy-page': '' },
        /* ── 顶部：徽章 + 现在跑一轮 ── */
        h('div', { 'data-dy-top': '' },
          h('div', { 'data-dy-badges': '', 'data-dy-grow': '' },
            h('span', { 'data-dy-badge': '' }, `今天看过 ${st.watchedToday ?? 0}/${st.perDay ?? 0} 条`),
            h('span', { 'data-dy-badge': '', 'data-good': pyOk ? '' : undefined }, pyOk ? 'MCP 已启动' : '环境待自检'),
            h('span', { 'data-dy-badge': '', 'data-good': st.loggedIn ? '' : undefined, 'data-warn': st.loggedIn ? undefined : '' },
              st.loggedIn ? '抖音已登录' : '抖音未登录'),
            h('span', { 'data-dy-badge': '' }, 'v' + (st.build?.version || '未知')),
            st.headless ? h('span', { 'data-dy-badge': '' }, 'headless: ' + st.headless.status) : null),
          h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: Boolean(busy === 'run'), onClick: runNow }, '现在跑一轮')),

        /* ── tabs ── */
        h('div', { 'data-dy-tabs': '' }, TABS.map(([id, label]) => h('button', {
          key: id, 'data-dy-tab': '', role: 'tab', 'aria-selected': tab === id ? 'true' : 'false',
          onClick: () => { setTab(id); setMsg('') },
        }, label))),

        msg ? h('div', { 'data-dy-msg': '', 'data-good': tone === 'good' ? '' : undefined, 'data-warn': tone === 'warn' ? '' : undefined }, msg) : null,

        /* ══════════ 日常 ══════════ */
        h('div', { 'data-dy-sec': '', 'data-dy-group': 'daily', 'data-dy-away': tab === 'daily' ? undefined : '' },

          h('div', { 'data-dy-sec': '', 'data-dy-overview': '' },
            h('div', { 'data-dy-label': '' }, '今天'),
            h('div', { 'data-dy-note': '' },
              `跑了 ${st.ranToday ?? 0} 轮 · 看片 ${st.watchedToday ?? st.pickedToday ?? 0}/${st.perDay ?? 0} 条 · 回复 ${st.doing?.todayReplies ?? 0} 条`),
            h('div', { 'data-dy-note': '' },
              `登录：${st.loggedIn ? '✅' : '❌ 未登录'} · 浏览器：${st.cdp?.ok ? '✅ 已连上 CDP' : (st.cdp?.url ? '⚠️ CDP 没连上' : '✅ 自有 profile')} · 额度和窗口以左边提示为准`),
            h('div', { 'data-dy-note': '' }, `家目录：${st.home || ''}`)),

          /* ⭐ 账号摆在第一页最上面：登录入口要一眼看见（使用者 2026-10-23「你要有给登录入口啊」） */
          h('div', { 'data-dy-sec': '', 'data-dy-account': '' },
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' },
                h('div', { 'data-dy-label': '' }, st.loggedIn ? '账号：已登录' : '账号：还没登录'),
                Note(st.loggedIn
                  ? '登录态留在这个 Chrome 里，之后不用再扫'
                  : '不登录也能看热榜 / 详情 / 评论；搜索、点赞、评论、投稿要登录')),
              h('button', { 'data-dy-btn': '', 'data-primary': st.loggedIn ? undefined : '', disabled: Boolean(busy === 'login'), onClick: loginStart },
                st.loggedIn ? '重新扫码' : '扫码登录'),
              h('button', { 'data-dy-btn': '', disabled: Boolean(busy === 'poll'), onClick: loginPoll }, '我扫完了'),
              h('button', { 'data-dy-btn': '', disabled: Boolean(busy === 'sms'), onClick: () => { setShowSms((v) => !v); setMsg('') } },
                showSms ? '收起收验证码' : '收验证码登录')),
            showSms ? h('div', { 'data-dy-row': '', 'data-dy-sms': '' },
              h('input', { 'data-dy-input': '', 'data-dy-num': '', style: { width: '150px' }, placeholder: '手机号',
                value: smsPhone, onChange: (e) => setSmsPhone(e.target.value.replace(/\D/g, '').slice(0, 11)) }),
              h('button', { 'data-dy-btn': '', disabled: Boolean(busy === 'sms'), onClick: sendSms }, '发验证码'),
              h('input', { 'data-dy-input': '', 'data-dy-num': '', style: { width: '110px' }, placeholder: '验证码',
                value: smsCode, onChange: (e) => setSmsCode(e.target.value.replace(/\D/g, '').slice(0, 6)) }),
              h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: Boolean(busy === 'sms'), onClick: submitSms }, '提交验证码'),
              Note(st.loggedIn ? '已经登录了；换号时才需要这一步' : '扫码之后如果抖音要短信验证，就走这里：发验证码 → 把收到的 6 位填进来 → 提交')) : null,
            qr?.qr ? h('div', { 'data-dy-qr': '' },
              h('img', { src: qr.qr, alt: '抖音登录二维码' }),
              h('div', { 'data-dy-note': '' }, '手机抖音 → 扫一扫 → 选「长期 / 记住我」。', h('br'), '扫完点「我扫完了」。')) : null),

          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: Boolean(busy === 'save'), onClick: save }, '保存'),
            Note('改完记得点这一下（其它 tab 的改动也会一起存）')),

          h('div', { 'data-dy-sec': '' },
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' },
                h('div', { 'data-dy-label': '' }, '峰谷时段自动刷'),
                Note('只在谷时跑 —— 每天 12:00–14:00 与 00:30–08:30 两段（不区分工作日/周末）；关了就只能手动跑')),
              Sw({ on: Boolean(draft.peakValley), onChange: (v) => set('peakValley', v) })),
            draft.peakValley ? h('div', { 'data-dy-sub': '' },
              h('div', { 'data-dy-row': '' }, h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '中午 12:00–14:00')),
                Sw({ on: Boolean(draft.noon), onChange: (v) => set('noon', v) })),
              h('div', { 'data-dy-row': '' }, h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '夜间 00:30–08:30')),
                Sw({ on: Boolean(draft.night), onChange: (v) => set('night', v) }))) : null),

          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' },
              h('div', { 'data-dy-label': '' }, '每天最多看几条（真转写过才算）'),
              Note('填 0 = 不自动刷（还是能手动跑）')),
            h('input', { 'data-dy-input': '', 'data-dy-num': '', inputMode: 'numeric', style: { width: '80px' },
              value: draft.perDay ?? 5, onChange: (e) => set('perDay', e.target.value.replace(/[^0-9]/g, '')) })),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' },
              h('div', { 'data-dy-label': '' }, '一次挑几条'),
              Note('一轮就挑这么多，别一口气刷完（默认 2）')),
            h('input', { 'data-dy-input': '', 'data-dy-num': '', inputMode: 'numeric', style: { width: '80px' },
              value: draft.pickPerRound ?? 2, onChange: (e) => set('pickPerRound', e.target.value.replace(/[^0-9]/g, '')) })),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' },
              h('div', { 'data-dy-label': '' }, '超过多少分钟就划走'),
              Note('太长不值当；默认 60 分钟，超了不看不评不转')),
            h('input', { 'data-dy-input': '', 'data-dy-num': '', inputMode: 'numeric', style: { width: '80px' },
              value: draft.skipOverMin ?? 60, onChange: (e) => set('skipOverMin', e.target.value.replace(/[^0-9]/g, '')) })),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' },
              h('div', { 'data-dy-label': '' }, '超过多少分钟就跳着看'),
              Note('默认 5 分钟；跳着看时评论/附言会写明“跳着看的”')),
            h('input', { 'data-dy-input': '', 'data-dy-num': '', inputMode: 'numeric', style: { width: '80px' },
              value: draft.skimOverMin ?? 5, onChange: (e) => set('skimOverMin', e.target.value.replace(/[^0-9]/g, '')) })),

          h('div', { 'data-dy-h': '' }, '它刷过的视频'),
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', disabled: Boolean(busy === 'watched'), onClick: loadWatched },
              watched !== null ? '收起' : '看它刷过的视频'),
            h('button', { 'data-dy-btn': '', onClick: () => openDir('out') }, '打开报告文件夹'),
            Note(watched === null
              ? (win.opening ? `正在谷时窗口（${win.label || ''}）` : '按日期分组；封面 + 标题 + 数据，点卡片进抖音原片')
              : `共 ${watched.length} 条，按日期分组（点任意一张进原片）`)),
          watched !== null ? (watched.length ? (() => {
            // ⭐ 按日期分组（使用者：要分日期）
            const order = []
            const byDay = new Map()
            for (const v of watched) {
              const d = v.day || '未知日期'
              if (!byDay.has(d)) { byDay.set(d, []); order.push(d) }
              byDay.get(d).push(v)
            }
            const card = (v) => h('a', {
              key: v.aweme_id, 'data-dy-item': '', 'data-dy-card': '',
              href: v.url, target: '_blank', rel: 'noreferrer',
            },
              (() => {
                const fallback = (e) => {
                  // 封面/截图都失败 → 换成占位块，别留个破图标
                  const div = document.createElement('div')
                  div.setAttribute('data-dy-cover', '')
                  div.setAttribute('data-dy-nocover', '')
                  div.textContent = '没有截图'
                  e.currentTarget.replaceWith(div)
                }
                return v.cover
                  // ⭐ 先用本地截图缓存（/thumb，稳），再退到远端封面（/cover，抖音封面是签名 URL，会 403）
                  ? h('img', {
                    'data-dy-cover': '',
                    src: API + '/thumb?id=' + v.aweme_id,
                    loading: 'lazy', alt: '',
                    onError: (e) => {
                      const img = e.currentTarget
                      if (img.dataset.fell === '1' || !v.cover) { fallback(e); return }
                      img.dataset.fell = '1'
                      img.src = API + '/cover?u=' + encodeURIComponent(v.cover)
                    },
                  })
                  : h('img', {
                    'data-dy-cover': '', src: API + '/thumb?id=' + v.aweme_id, loading: 'lazy', alt: '',
                    onError: fallback,
                  })
              })(),
              h('div', { 'data-dy-item-body': '' },
                h('div', { 'data-dy-item-t': '' }, v.title || v.aweme_id),
                h('div', { 'data-dy-item-n': '' }, [v.tier, v.stat].filter(Boolean).join(' · '))))
            return h('div', null, order.map((d) => h('div', { key: d, 'data-dy-day': '' },
              h('div', { 'data-dy-dayhead': '' }, `${d} · ${byDay.get(d).length} 条`),
              h('div', { 'data-dy-list': '' }, byDay.get(d).map(card)))))
          })()
            : h('div', { 'data-dy-note': '' }, '报告里还没有条目')) : null,
          report !== null ? h('pre', { 'data-dy-pre': '' }, report) : null),

        /* ══════════ 偏好 ══════════ */
        h('div', { 'data-dy-sec': '', 'data-dy-group': 'pref', 'data-dy-away': tab === 'pref' ? undefined : '' },
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: Boolean(busy === 'save'), onClick: save }, '保存')),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' },
              h('div', { 'data-dy-label': '' }, '关注关键词'),
              Note('用「、」或逗号隔开；空着就用值班章程里默认那几组'))),
          h('input', { 'data-dy-input': '', value: draft.keywords ?? '', placeholder: 'AI、剪辑、vlog…',
            onChange: (e) => set('keywords', e.target.value) }),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '日报形态')),
            ['full', 'brief', 'off'].map((v) => h('button', {
              key: v, 'data-dy-chip': '', 'aria-selected': draft.reportLevel === v ? 'true' : 'false',
              onClick: () => set('reportLevel', v),
            }, v === 'full' ? '完整' : v === 'brief' ? '每条一两行' : '不写报告'))),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' },
              h('div', { 'data-dy-label': '' }, '人设提示词'),
              Note('模型模式的人设说明；本机模式使用转写素材生成短句，不提供自由模型推理'))),
          h('textarea', { 'data-dy-input': '', 'data-dy-area': '', value: draft.personaPrompt ?? '',
            onChange: (e) => set('personaPrompt', e.target.value) })),

        /* ══════════ 互动 ══════════ */
        h('div', { 'data-dy-sec': '', 'data-dy-group': 'like', 'data-dy-away': tab === 'like' ? undefined : '' },
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: Boolean(busy === 'save'), onClick: save }, '保存'),
            Note('这三件事都是拿你的号动手，默认全关；要用就自己开')),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-h': '' }, '回复我自己作品的评论'),
          h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '自动回我自己视频的评论'),
              ),
            Sw({ on: Boolean(draft.autoReply), onChange: (v) => set('autoReply', v) })),
          draft.autoReply ? h('div', { 'data-dy-sub': '' },
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '每次回几条')),
              h('input', { 'data-dy-input': '', 'data-dy-num': '', inputMode: 'numeric',
                value: draft.replyPerRun ?? 3, onChange: (e) => set('replyPerRun', e.target.value.replace(/[^0-9]/g, '')) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '每天最多回几条'),
                ),
              h('input', { 'data-dy-input': '', 'data-dy-num': '', inputMode: 'numeric',
                value: draft.replyPerDay ?? 10, onChange: (e) => set('replyPerDay', e.target.value.replace(/[^0-9]/g, '')) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '遇到直播就跳过')),
              Sw({ on: draft.skipLive !== false, onChange: (v) => set('skipLive', v) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-h': '' }, '转发'),
          h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '转发给谁'),
                Note('留空=不转发')),
              h('input', { 'data-dy-input': '', style: { width: '190px' }, value: draft.shareToNick ?? '',
                placeholder: '对方昵称', onChange: (e) => set('shareToNick', e.target.value) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '每天最多转发几条'),
                Note('和「评论@」互斥：同一条视频只做一件事（@ 了就不再转发）')),
              h('input', { 'data-dy-input': '', 'data-dy-num': '', inputMode: 'numeric', style: { width: '70px' },
                value: draft.sharePerDay ?? 10, onChange: (e) => set('sharePerDay', e.target.value.replace(/[^0-9]/g, '')) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '可以主动发消息的人'),
                Note('昵称，逗号分隔；留空=谁都不主动发（回复别人的消息不受限）')),
              h('input', { 'data-dy-input': '', style: { width: '220px' }, value: draft.msgAllowTo ?? '',
                placeholder: '一个人名，或 甲, 乙', onChange: (e) => set('msgAllowTo', e.target.value) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '回评论看几天内的作品'),
                Note('默认 3 天：三天内发的作品，新评论都会回')),
              h('input', { 'data-dy-input': '', 'data-dy-num': '', inputMode: 'numeric', style: { width: '70px' },
                value: draft.replyWorksDays ?? 3, onChange: (e) => set('replyWorksDays', e.target.value.replace(/[^0-9]/g, '')) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '每天自动清理一次'),
                Note('清临时垃圾 / 30天前缩略图 / 超大日志轮转 / 浏览器 Cache（不动登录态）')),
              Sw({ on: draft.autoClean !== false, onChange: (v) => set('autoClean', v) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '转发后跟一条消息 + 表情包'),
                Note('一个开关管两件事：转发完是否立刻发「一句话 + 一个表情包」（同一条会话，不重复找人）。关掉就只转发不吱声')),
              Sw({ on: draft.shareWithNote !== false, onChange: (v) => set('shareWithNote', v) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '续火花：每天给谁发一个表情包'),
                Note('留空 = 不续。只发表情包，不主动发文字')),
              h('input', { 'data-dy-input': '', style: { width: '150px' }, value: draft.streakNick ?? '',
                placeholder: '对方昵称', onChange: (e) => set('streakNick', e.target.value) }),
              h('input', { 'data-dy-input': '', 'data-dy-num': '', inputMode: 'numeric', style: { width: '80px' },
                value: draft.streakPerDay ?? 1, onChange: (e) => set('streakPerDay', e.target.value.replace(/[^0-9]/g, '')) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '遇到不会的视频：评论里 @ 豆包'),
                Note('当前本机模式未接入此动作；此项暂不执行，等待明确授权后接线')),
              h('span', { 'data-dy-badge': '' }, '暂未接入')),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '同一个人只回一次'),
                Note('开着的话，同一个人后来的新评论也不回；默认关（每条评论回一次）')),
              Sw({ on: Boolean(draft.replyOncePerUser), onChange: (v) => set('replyOncePerUser', v) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '随机挑（关掉=按顺序）')),
              Sw({ on: draft.replyRandom !== false, onChange: (v) => set('replyRandom', v) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '整个工作流多久跑一次（分钟）'),
              Note('刷视频 + 转发吐槽 + 回自己视频评论，都在这一条里；默认 30 分钟一次，和私信秒回完全分开')),
              h('input', { 'data-dy-input': '', 'data-dy-num': '', inputMode: 'numeric', style: { width: '80px' },
                value: draft.replyIntervalMin ?? 30,
                onChange: (e) => set('replyIntervalMin', e.target.value.replace(/[^0-9]/g, '')) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '要回的自己的视频 id'),
                Note('留空 = 用投稿账本里发过的；多个用逗号')),
              h('input', { 'data-dy-input': '', style: { width: '260px' }, value: draft.replyVideoIds ?? '',
                placeholder: '7698403173999992485, 7699518545823148977',
                onChange: (e) => set('replyVideoIds', e.target.value.replace(/[^0-9, ]/g, '')) })),
            h('div', { 'data-dy-row': '' },
              h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: Boolean(busy === 'reply'), onClick: replyNow }, '现在回一轮'),
              Note('你不用先保存，按当前填的条数就回'))) : null,
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-h': '' }, '互动闸门：点赞 / 评论 / 投稿'),
          h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '自动点赞'),
              Note('值得的才点；要登录')),
            Sw({ on: Boolean(draft.autoLike), onChange: (v) => set('autoLike', v) })),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '自动评论并 @ 你'),
              Note('评论存在的意义就是那一下 @；@ 谁没填就不会发')),
            Sw({ on: Boolean(draft.autoComment), onChange: (v) => set('autoComment', v) })),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '自动评论（不 @ 人）'),
              Note('就是普通评论一句，比如「这条我笑了[笑哭]」；和 @、转发 互斥，一个视频只做一件事')),
            Sw({ on: Boolean(draft.autoCommentPlain), onChange: (v) => set('autoCommentPlain', v) })),
          draft.autoCommentPlain !== false ? h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '每天最多几条普通评论')),
            h('input', { 'data-dy-input': '', 'data-dy-num': '', inputMode: 'numeric', style: { width: '70px' },
              value: draft.plainCommentPerDay ?? 10, onChange: (e) => set('plainCommentPerDay', e.target.value.replace(/[^0-9]/g, '')) })) : null,
          draft.autoComment ? h('div', { 'data-dy-sub': '' },
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '要 @ 谁的抖音昵称')),
              h('input', { 'data-dy-input': '', style: { width: '190px' }, value: draft.mentionName ?? '',
                placeholder: '你的抖音昵称', onChange: (e) => set('mentionName', e.target.value) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '每轮最多发几条')),
              h('input', { 'data-dy-input': '', 'data-dy-num': '', type: 'number', min: 0, max: 20,
                value: draft.commentPerRound ?? 1, onChange: (e) => set('commentPerRound', e.target.value.replace(/[^0-9]/g, '')) }))) : null,
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '允许手动工具 / headless 投稿'),
              Note('片子从 ComfyUI 出（下面「高级」里配它的输出目录）；默认只存草稿，等你看一眼')),
            Sw({ on: Boolean(draft.autoPublish), onChange: (v) => set('autoPublish', v) })),
          draft.autoPublish ? h('div', { 'data-dy-sub': '' },
            h('div', { 'data-dy-row': '' }, h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '只存草稿，不点发布')),
              Sw({ on: Boolean(draft.publishDraft), onChange: (v) => set('publishDraft', v) }))) : null,

          /* 今天真做了多少（账本里数出来的） */
          h('div', { 'data-dy-row': '' },
            h('span', { 'data-dy-badge': '' }, `今天评论 ${st.doing?.todayComments ?? 0}/${st.doing?.commentPerDay ?? 0} 条`),
            h('span', { 'data-dy-badge': '' }, `今天投稿 ${st.doing?.todayPublished ?? 0}/${st.doing?.publishPerDay ?? 0} 条`),
            st.doing?.lastPublished?.video
              ? Note(`上次投的：${String(st.doing.lastPublished.video).split(/[\\/]/).pop()} · ${st.doing.lastPublished.draft ? '草稿' : '已发'}`)
              : Note('还没投过片子')),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '评论每天最多几条'), Note('0 = 一条都不发')),
            h('input', { 'data-dy-input': '', 'data-dy-num': '', type: 'number', min: 0, max: 50,
              value: draft.commentPerDay ?? 3, onChange: (e) => set('commentPerDay', e.target.value.replace(/[^0-9]/g, '')) })),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '视频每天最多投几条'), Note('0 = 一条都不投；同一条片子不会重复投')),
            h('input', { 'data-dy-input': '', 'data-dy-num': '', type: 'number', min: 0, max: 20,
              value: draft.publishPerDay ?? 1, onChange: (e) => set('publishPerDay', e.target.value.replace(/[^0-9]/g, '')) })),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '视频标题模板'), Note('{date} 会换成今天的日期；留空 = 「日常 <日期>」'))),
          h('input', { 'data-dy-input': '', value: draft.publishTitle ?? '', placeholder: '日常 {date}',
            onChange: (e) => set('publishTitle', e.target.value) }),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '默认话题'), Note('空格或逗号分隔，投稿时带上'))),
          h('input', { 'data-dy-input': '', value: draft.publishTags ?? '', placeholder: 'AI、日常',
            onChange: (e) => set('publishTags', e.target.value) }),
        ),


        /* ══════════ 私信 ══════════ */
        h('div', { 'data-dy-sec': '', 'data-dy-group': 'dm', 'data-dy-away': tab === 'dm' ? undefined : '' },
          h('div', { 'data-dy-h': '' }, '后台自动回复'),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '后台静默回私信'),
              Note('每 N 秒看一次收件箱（默认 15），有新消息就自动回；不占对话窗口')),
            Sw({ on: Boolean(draft.dmAutoReply !== false), onChange: (v) => set('dmAutoReply', v) })),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '多久看一次（秒）'),
              Note('默认 15 秒；这就是「跟我聊天」这条，和下面的陌生人巡检完全分开')),
            h('input', { 'data-dy-input': '', 'data-dy-num': '', style: { width: '90px' }, value: draft.dmAutoIntervalSec ?? 15,
              onChange: (e) => set('dmAutoIntervalSec', Number(e.target.value) || 15) })),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '只回谁（昵称）'),
              Note('在「可以主动发消息的人」名单里再筛一次；留空 = 名单里的人全回')),
            h('input', { 'data-dy-input': '', style: { width: '220px' }, value: draft.dmReplyOnlyTo ?? '',
              onChange: (e) => set('dmReplyOnlyTo', e.target.value) })),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '条数'),
              Note('跟你聊天不设上限（白名单随便聊）'))),
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: Boolean(busy === 'save'), onClick: save }, '保存'),
            h('button', { 'data-dy-btn': '', disabled: Boolean(busy === 'dmtest'), onClick: async () => {
              setBusy('dmtest'); setMsg('')
              try {
                const r = await jpost('/dm/test', { text: '测试：后台私信通道正常吗' })
                setMsg(r.ok ? '测试消息已确认送达' : ('没发出去：' + String(r.error || '未知')))
                setTone(r.ok ? 'good' : 'warn')
              } catch (e) { setMsg('失败：' + String(e.message || e)); setTone('warn') } finally { setBusy('') }
            } }, '发一条测试消息'),
            Note('会真的发到「可以主动发消息的人」那里')),
          h('div', { 'data-dy-h': '' }, '陌生人巡检（另一条，不影响上面）'),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '自动回陌生人私信'),
              Note('就是原来那个「半小时巡检」；现在关着。开了只走主页面，不占聊天专用页')),
            Sw({ on: Boolean(draft.dmReply), onChange: (v) => set('dmReply', v) })),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '每隔多少分钟巡一次')),
            h('input', { 'data-dy-input': '', 'data-dy-num': '', style: { width: '90px' }, value: draft.replyIntervalMin ?? 30,
              onChange: (e) => set('replyIntervalMin', Number(e.target.value) || 30) })),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '陌生人每天最多回几条')),
            h('input', { 'data-dy-input': '', 'data-dy-num': '', style: { width: '90px' }, value: draft.dmReplyPerDay ?? 0,
              onChange: (e) => set('dmReplyPerDay', Number(e.target.value) || 0) })),

          h('div', { 'data-dy-h': '' }, '今天的聊天记录'),
          !dmInfo ? Note('切到这一页时读取…')
            : (!dmInfo.log || !dmInfo.log.length
              ? Note('今天还没有私信记录')
              : h('div', { 'data-dy-list': '' }, dmInfo.log.slice().reverse().map((x, i) => h('div', { key: i, 'data-dy-item': '' },
                h('div', { 'data-dy-item-t': '' }, `${x.name}：${String(x.text || '').slice(0, 30)}`),
                h('div', { 'data-dy-item-n': '' }, '我: ' + String(x.text || '').slice(0, 40)),
                h('div', { 'data-dy-item-n': '' }, (x.replied ? '大肥鱼: ' + String(x.replyText || '（已回，内容未记录）').slice(0, 40) : '⏳ 还没回') + ' · ' + new Date(x.at || 0).toLocaleTimeString()))))),

          h('div', { 'data-dy-h': '' }, '最近回过的'),
          !dmInfo ? Note('切到这一页时读取…')
            : (dmInfo.recent && dmInfo.recent.length
              ? h('div', { 'data-dy-list': '' }, dmInfo.recent.map((x) => h('div', { key: x.peer, 'data-dy-item': '' },
                h('div', { 'data-dy-item-t': '' }, String(x.name || x.peer || '')),
                h('div', { 'data-dy-item-n': '' }, `${x.day || ''} · 回了 ${x.count || 0} 次 · 最后一句：${String(x.lastReply || '').slice(0, 30)}`))))
              : Note('还没有回过私信')),
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', onClick: async () => {
              try { await jpost('/dm/seen/clear', {}); setMsg('已清空已读记录'); setTone('good') } catch (e) { setMsg('清空失败：' + String(e.message || e)); setTone('warn') }
            } }, '清空已读记录'),
            Note('清空后，之前回过的消息可能被当成新消息再处理一次')),
        ),

        /* ══════════ 表情包 ══════════ */
        h('div', { 'data-dy-sec': '', 'data-dy-group': 'sticker', 'data-dy-away': tab === 'sticker' ? undefined : '' },
          h('div', { 'data-dy-h': '' }, '收藏的表情包（大肥鱼 17 张）'),
          !stk ? Note('读取中…')
            : (stk.custom && stk.custom.length
              ? h('div', { 'data-dy-list': '' }, stk.custom.map((x) => h('div', { key: String(x.key || x.index), 'data-dy-item': '' },
                h('div', { 'data-dy-item-t': '' }, `#${x.index}`),
                h('div', { 'data-dy-item-n': '' }, (x.tags || []).join(' / ') || '（还没标签）'))))
              : Note('没读到收藏表情（favorites2.json）')),
          Note(`通用表情 ${stk?.emojiCount ?? '?'} 张也已逐张打标签，关键词命中就会用到`),
          h('div', { 'data-dy-h': '' }, '按心情发一个试试'),
          h('div', { 'data-dy-row': '' },
            h('input', { 'data-dy-input': '', style: { width: '240px' }, placeholder: '心情词，比如 干饭 / 压力 / 666',
              value: stkKeyword, onChange: (e) => setStkKeyword(e.target.value) }),
            h('button', { 'data-dy-btn': '', 'data-primary': '', onClick: async () => {
              setMsg('')
              try {
                const r = await jpost('/stickers/test', { keyword: stkKeyword })
                setMsg(r.ok ? '表情包已发出（已确认）' : ('没发出去：' + String(r.error || '未知')))
                setTone(r.ok ? 'good' : 'warn')
              } catch (e) { setMsg('失败：' + String(e.message || e)); setTone('warn') }
            } }, '发这个'),
            Note('发到「可以主动发消息的人」那里')),
        ),

        /* ══════════ 高级 ══════════ */
        h('div', { 'data-dy-sec': '', 'data-dy-group': 'adv', 'data-dy-away': tab === 'adv' ? undefined : '' },
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: Boolean(busy === 'save'), onClick: save }, '保存'),
            h('button', { 'data-dy-btn': '', disabled: Boolean(busy === 'check'), onClick: selfcheck }, '环境自检'),
            h('button', { 'data-dy-btn': '', onClick: showLog }, logTail !== null ? '收起日志' : '看日志')),

          checks && checks.length ? h('div', { 'data-dy-list': '' }, checks.map((x) => h('div', { key: x.name, 'data-dy-item': '' },
            h('div', { 'data-dy-item-t': '' }, (x.ok ? '正常 · ' : '有问题 · ') + x.name),
            h('div', { 'data-dy-item-n': '' }, String(x.detail || '').slice(0, 200)),
            x.ok ? null : h('div', { 'data-dy-item-n': '' }, '怎么办：' + (x.fix || '把诊断信息发给作者'))))) : null,
          logTail !== null ? h('pre', { 'data-dy-pre': '' }, logTail) : null,

          h('div', { 'data-dy-h': '' }, '执行与转写'),
          Note('两种模式都经宿主检查额度、对象名单和重复发送。未确认发送会显示待核对，不自动重发。'),
          [['localRound','本机运行'],['watchBeforeAct','互动前先看片转写'],['memory','记录记忆'],['overlayMcp','headless 挂 MCP'],['replyOneShot','指定回复作品只用一次']].map(([k, label]) => h('div', { key: k, 'data-dy-row': '' },
            h('span', null, label),
            Sw({ on: Boolean(draft[k]), onChange: v => set(k, v) }))),

          h('div', { 'data-dy-h': '' }, '路径与运行参数'),
          Note('一般不用动；留空就让插件自己找。'),
          [
            ['pythonPath', 'Python 路径', '转写/依赖用的解释器，留空=自动找'],
            ['dshBin', 'DSH 启动脚本', '只有 headless 模式用，留空=自动找当前安装'],
            ['headlessProfile', 'headless 用的 profile', '默认 headless'],
            ['headlessModel', 'headless 用的模型', '留空=跟随默认模型'],
            ['workspace', 'headless 工作目录', '留空=用插件家目录'],
            ['chromePath', 'Chrome 路径', '留空=自动找系统 Chrome'],
            ['cdpUrl', 'CDP 地址', '留空=用插件自己的浏览器（推荐）；想复用你已登录的 Chrome 才填'],
            ['cdpPort', 'CDP 端口', '默认 9222'],
            ['watchSeconds', '看片最多听多少秒', '默认 90 秒'],
            ['watchFrames', '看片抽多少帧', '默认 10 帧；按整片均匀抽，越多越慢'],
            ['pickPerRound', '一轮挑几条', '默认 2'],
            ['myNickname', '我的昵称', '回读评论时用来认出自己'],
          ].map(([k, label, hint]) => h('div', { key: k, 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, label), hint ? Note(hint) : null),
            h('input', { 'data-dy-input': '', style: { width: '300px' }, value: draft[k] ?? '',
              onChange: e => set(k, ['cdpPort','watchSeconds','watchFrames','pickPerRound'].includes(k) ? Number(e.target.value) : e.target.value) }))),

          /* ⭐ 主依赖（照「刷B站」那页：装主依赖 + 安装日志） */
          h('div', { 'data-dy-h': '' }, '主依赖（Python 半边：MCP + Playwright）'),
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', disabled: Boolean(busy === 'setup'), onClick: doSetup }, '装主依赖（建 venv）'),
            h('button', { 'data-dy-btn': '', onClick: showSetupLog }, setupLog !== null ? '收起安装日志' : '看安装日志'),
            Note('安装 MCP、Playwright、numpy、faster-whisper；ffmpeg 和模型状态需再运行环境自检。')),
          setupLog !== null ? h('pre', { 'data-dy-pre': '' }, setupLog) : null,

          /* ⭐ 它的地盘（家目录 / 今天的报告 / 打开文件夹） */
          h('div', { 'data-dy-h': '' }, '它的地盘'),
          h('div', { 'data-dy-note': '' }, `家目录：${st.home}`),
          h('div', { 'data-dy-note': '' }, `今天的报告：${st.report}`),
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', disabled: Boolean(busy === 'report'), onClick: showReport }, report !== null ? '收起报告' : '看今天的报告'),
            h('button', { 'data-dy-btn': '', onClick: () => openDir('out') }, '打开报告文件夹'),
            h('button', { 'data-dy-btn': '', onClick: () => openDir('home') }, '打开家目录'),
            h('button', { 'data-dy-btn': '', onClick: () => { try { navigator.clipboard && navigator.clipboard.writeText(String(st.report || '')); setMsg('报告路径已复制'); setTone('good') } catch (e) { setMsg('复制失败') } } }, '复制报告路径')),
          report !== null ? h('pre', { 'data-dy-pre': '' }, report) : null,

          h('div', { 'data-dy-h': '' }, '账号与浏览器'),
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', disabled: Boolean(busy === 'login'), onClick: loginStart }, '扫码登录'),
            h('button', { 'data-dy-btn': '', disabled: Boolean(busy === 'poll'), onClick: loginPoll }, '我扫完了'),
            Note(st.loggedIn ? '已经登录了' : '没登录也能用：热榜 / 视频详情 / 评论；搜索、点赞、评论、投稿要登录')),
          qr?.qr ? h('div', { 'data-dy-qr': '' },
            h('img', { src: qr.qr, alt: '抖音登录二维码' }),
            h('div', { 'data-dy-note': '' }, '手机抖音 → 扫一扫。', h('br'), '确认时选「长期 / 记住我」那张。')) : null,
        ),
      )
    }

    /* ── 会话头那个「抖音刷过的视频」tab（跟刷B站那个并排） ───────────── */
    function DouyinWatchedTab() {
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState('')
      React.useEffect(() => {
        let alive = true
        jget('/watched?days=14').then((r) => { if (alive) setData(r) },
          (e) => { if (alive) setErr(String(e.message || e)) })
        return () => { alive = false }
      }, [])
      if (err) return h('div', { 'data-dy-page': '' }, h('div', { 'data-dy-msg': '', 'data-warn': '' }, '读失败：' + err))
      if (!data) return h('div', { 'data-dy-page': '' }, h('div', { 'data-dy-note': '' }, '读取中…'))
      const items = Array.isArray(data.items) ? data.items : []
      if (!items.length) return h('div', { 'data-dy-page': '' }, h('div', { 'data-dy-note': '' }, data.hint || '还没有刷过的记录'))
      const order = []
      const byDay = new Map()
      for (const v of items) {
        const d = v.day || '未知日期'
        if (!byDay.has(d)) { byDay.set(d, []); order.push(d) }
        byDay.get(d).push(v)
      }
      const card = (v) => h('a', {
        key: v.aweme_id, 'data-dy-item': '', 'data-dy-card': '',
        href: v.url, target: '_blank', rel: 'noreferrer',
      },
        h('img', {
          'data-dy-cover': '', loading: 'lazy', alt: '',
          // 先用本地截图缓存（稳），失败再退远端封面，再失败换占位块
          src: API + '/thumb?id=' + v.aweme_id,
          onError: (e) => {
            const img = e.currentTarget
            if (img.dataset.fell === '1' || !v.cover) {
              const div = document.createElement('div')
              div.setAttribute('data-dy-cover', '')
              div.setAttribute('data-dy-nocover', '')
              div.textContent = '没有截图'
              img.replaceWith(div)
              return
            }
            img.dataset.fell = '1'
            img.src = API + '/cover?u=' + encodeURIComponent(v.cover)
          },
        }),
        h('div', { 'data-dy-item-body': '' },
          h('div', { 'data-dy-item-t': '' }, v.title || v.aweme_id),
          h('div', { 'data-dy-item-n': '' }, [v.tier, v.stat].filter(Boolean).join(' · '))))

      const groups = order.map((d) => h('div', { key: d, 'data-dy-day': '' },
        h('div', { 'data-dy-dayhead': '' }, `${d} · ${byDay.get(d).length} 条`),
        h('div', { 'data-dy-list': '' }, byDay.get(d).map(card))))

      return h('div', { 'data-dy-page': '' }, groups)
    }

    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        const style = document.createElement('style')
        try {
          if (!window.__dyErrHooked) {
            window.__dyErrHooked = true
            window.addEventListener('error', (ev) => {
              try {
                fetch('/api/douyin-duty/log', {
                  method: 'POST', credentials: 'same-origin',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ msg: 'window.onerror: ' + String(ev && ev.message), stack: String((ev && ev.error && ev.error.stack) || ev && ev.filename || '') }),
                }).catch(() => {})
              } catch { /* 忽略 */ }
            })
          }
        } catch { /* 忽略 */ }

        style.setAttribute('data-plugin-css', 'dsh-douyin-life')
        style.textContent = CSS + '\n' + MEM_CSS
        document.head.appendChild(style)
        try { ctx.effect(() => () => style.remove(), 'dsh-douyin-life: 设置页样式') } catch {}

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'douyin-life', order: 31, label: '刷抖音' },
          () => h(Panel),
        ))

        // ⭐ 2026-10-26 使用者：记忆塞进设置左侧列表；UI 照记忆插件那套（标题/徽章/胶囊 tab/卡片/力导向图谱）
        const memCall = async (method, params) => {
          const conn = (typeof ctx.get === 'function' ? ctx.get('connection') : undefined) || ctx.connection
          if (!conn?.rpc?.call) throw new Error('没有 connection.rpc')
          const raw = await conn.rpc.call('/api', 'memory.' + method, params || {})
          if (raw && typeof raw === 'object' && raw.ok === false) throw new Error(String(raw.error?.message || raw.error || raw.message || '记忆服务返回失败'))
          if (raw && typeof raw === 'object' && 'ok' in raw) return raw.value !== undefined ? raw.value : raw
          return raw
        }

        const MemTabs = [
          { id: 'graph', label: '图谱' },
          { id: 'character', label: '角色卡' },
          { id: 'timeline', label: '时间线' },
          { id: 'clean', label: '清理' },
          { id: 'raw', label: '原始记录' },
        ]

        // 把对象/数组拍平成一行人话（角色卡「其它字段」用）
        const flatText = (v) => {
          if (v == null) return '—'
          if (typeof v !== 'object') return String(v)
          if (Array.isArray(v)) {
            if (!v.length) return '（空）'
            return v.map((x) => (typeof x === 'object' ? Object.entries(x).map(([k2, v2]) => k2 + '=' + v2).join('、') : String(x))).join('；')
          }
          return Object.entries(v).map(([k2, v2]) => k2 + '=' + (typeof v2 === 'object' ? JSON.stringify(v2) : v2)).join('、')
        }
        const Card = ({ children, style }) => h('div', { className: 'dym-card', style }, children)
        const KV = (k, v) => h('div', { className: 'dym-kv' },
          h('span', { className: 'dym-k' }, k), h('span', null, String(v ?? '—')))

        // 真正兜住渲染异常：Comp 在 React 里被调用时才会执行，所以必须在组件内部 try
        class Guard extends React.Component {
          constructor(props) { super(props); this.state = { error: null } }
          static getDerivedStateFromError(error) { return { error } }
          componentDidCatch(error) {
            fetch('/api/douyin-duty/log', { method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg: '记忆组件渲染失败：' + String(error) }) }).catch(() => {})
          }
          render() {
            if (this.state.error) return h('div', { className: 'dym-card', role: 'alert' }, '页面读取失败：' + String(this.state.error.message || this.state.error))
            return h(this.props.Comp, this.props.props || {})
          }
        }

        const MemGraph = ({ data, busy }) => {
          const wrapRef = React.useRef(null)
          const [size, setSize] = React.useState({ w: 640, h: 380 })
          const posRef = React.useRef(null)
          const viewRef = React.useRef({ k: 1, x: 0, y: 0 })
          const dragRef = React.useRef(null)
          const [, tick] = React.useState(0)
          const [sel, setSel] = React.useState(null)

          React.useEffect(() => {
            const el = wrapRef.current
            if (!el) return
            const w = el.clientWidth || 640
            setSize({ w, h: 380 })
          }, [])

          // 力导向：只在数据变化时算一次（240 帧）
          React.useEffect(() => {
            posRef.current = null
            viewRef.current = { k: 1, x: 0, y: 0 }
            const nodes = (data && data.nodes) || []
            if (!nodes.length) return
            const W = size.w, H = size.h
            const ns = nodes.map((n, i) => {
              const ang = (i / nodes.length) * Math.PI * 2
              const r0 = Math.min(W, H) * 0.3
              return {
                id: n.id, label: n.label || n.name || n.id, type: n.type || '', importance: n.importance || 0,
                tags: n.tags || [], created_at: n.created_at || '',
                x: W / 2 + Math.cos(ang) * r0 * (0.45 + Math.random() * 0.55),
                y: H / 2 + Math.sin(ang) * r0 * (0.45 + Math.random() * 0.55),
                vx: 0, vy: 0, r: 5 + Math.min(1, Math.max(0, n.importance || 0)) * 13,
              }
            })
            const byId = {}
            for (const n of ns) byId[n.id] = n
            const es = ((data && data.edges) || []).map((e) => ({ a: byId[e.source], b: byId[e.target] })).filter((e) => e.a && e.b)
            posRef.current = { nodes: ns, edges: es, home: ns.map((n) => ({ x: n.x, y: n.y })) }
            let alpha = 1, raf = 0, ticks = 0
            const step = () => {
              const s = posRef.current
              if (!s) return
              alpha *= 0.972
              for (let i = 0; i < s.nodes.length; i++) {
                for (let j = i + 1; j < s.nodes.length; j++) {
                  const a = s.nodes[i], b = s.nodes[j]
                  const dx = b.x - a.x, dy = b.y - a.y
                  const d2 = dx * dx + dy * dy || 1
                  const d = Math.sqrt(d2)
                  const f = Math.min(5, 2600 / d2) * alpha
                  const fx = (dx / d) * f, fy = (dy / d) * f
                  a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy
                }
              }
              for (const e of s.edges) {
                const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y
                const d = Math.sqrt(dx * dx + dy * dy) || 1
                const f = (d - 118) * 0.012 * alpha
                e.a.vx += (dx / d) * f; e.a.vy += (dy / d) * f
                e.b.vx -= (dx / d) * f; e.b.vy -= (dy / d) * f
              }
              for (const n of s.nodes) {
                n.vx += (W / 2 - n.x) * 0.0018 * alpha
                n.vy += (H / 2 - n.y) * 0.0018 * alpha
                n.vx *= 0.86; n.vy *= 0.86
                n.x = Math.max(28, Math.min(W - 28, n.x + n.vx))
                n.y = Math.max(28, Math.min(H - 28, n.y + n.vy))
              }
              ticks += 1
              tick((v) => v + 1)
              if (ticks < 240) raf = requestAnimationFrame(step)
            }
            raf = requestAnimationFrame(step)
            return () => cancelAnimationFrame(raf)
          }, [data, size.w, size.h])

          const sim = posRef.current
          const view = viewRef.current
          const zoomAt = (factor, cx, cy) => {
            const v = viewRef.current
            const k2 = Math.max(0.35, Math.min(3.5, v.k * factor))
            const wx = (cx - v.x) / v.k, wy = (cy - v.y) / v.k
            viewRef.current = { k: k2, x: cx - wx * k2, y: cy - wy * k2 }
            tick((n) => n + 1)
          }
          const onWheel = (e) => {
            e.preventDefault()
            const r = e.currentTarget.getBoundingClientRect()
            zoomAt(e.deltaY < 0 ? 1.12 : 0.89, e.clientX - r.left, e.clientY - r.top)
          }
          const onDown = (e, node) => {
            const r = e.currentTarget.getBoundingClientRect()
            dragRef.current = { node, sx: e.clientX, sy: e.clientY, ox: node ? node.x : viewRef.current.x, oy: node ? node.y : viewRef.current.y, rect: r }
            e.currentTarget.classList?.add('dragging')
            try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* 忽略 */ }
          }
          const onMove = (e) => {
            const d = dragRef.current
            if (!d) return
            const dx = e.clientX - d.sx, dy = e.clientY - d.sy
            if (d.node) {
              const k = viewRef.current.k || 1
              d.node.x = d.ox + dx / k
              d.node.y = d.oy + dy / k
            } else {
              viewRef.current = { ...viewRef.current, x: d.ox + dx, y: d.oy + dy }
            }
            tick((n) => n + 1)
          }
          const onUp = (e) => {
            dragRef.current = null
            e.currentTarget?.classList?.remove('dragging')
          }
          const reset = (relayout) => {
            const s = posRef.current
            if (!s) return
            if (relayout && s.home) s.nodes.forEach((n, i) => { n.x = s.home[i].x; n.y = s.home[i].y; n.vx = 0; n.vy = 0 })
            viewRef.current = { k: 1, x: 0, y: 0 }
            tick((n) => n + 1)
          }

          if (!sim) return h(Card, null, busy ? '读取中…' : '（图谱为空）')
          const color = (ty) => (ty === 'person' ? '#7c6ff7' : ty === 'preference' ? '#f0a35e'
            : ty === 'event' ? '#4bb6a8' : ty === 'fact' ? '#5b8def' : '#9aa3b2')
          return h('div', null,
            h(Card, null, '节点 ' + sim.nodes.length + ' 个 · 关系 ' + sim.edges.length + ' 条 · 滚轮缩放，拖空白移动，拖节点可挪，右下角 ⟲ 复位'),
            h('div', { className: 'dym-graph', ref: wrapRef },
              h('svg', {
                width: '100%', height: size.h, viewBox: '0 0 ' + size.w + ' ' + size.h,
                onWheel, onPointerDown: (e) => onDown(e, null), onPointerMove: onMove, onPointerUp: onUp, onPointerLeave: onUp,
              },
                h('g', { transform: 'translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')' },
                  sim.edges.map((e, i) => h('line', {
                    key: 'e' + i, x1: e.a.x, y1: e.a.y, x2: e.b.x, y2: e.b.y,
                    stroke: 'rgba(140,150,170,.4)', strokeWidth: 1 / view.k,
                  })),
                  sim.nodes.map((n, i) => h('g', {
                    key: 'n' + i, style: { cursor: 'pointer' },
                    onPointerDown: (e) => { e.stopPropagation(); onDown(e, n) },
                    onClick: () => setSel(n),
                  },
                    h('circle', { cx: n.x, cy: n.y, r: n.r, fill: color(n.type), opacity: 0.92 }),
                    h('text', {
                      x: n.x, y: n.y - n.r - 5, textAnchor: 'middle',
                      style: { fontSize: (10.5 / view.k) + 'px', fill: 'currentColor', opacity: 0.82 },
                    }, String(n.label).slice(0, 12)))))),
              h('div', { className: 'dym-gctrl' },
                h('button', { className: 'dym-gbtn', title: '放大', onClick: () => zoomAt(1.25, size.w / 2, size.h / 2) }, '+'),
                h('button', { className: 'dym-gbtn', title: '缩小', onClick: () => zoomAt(0.8, size.w / 2, size.h / 2) }, '−'),
                h('button', { className: 'dym-gbtn', title: '复位（回到初始位置与缩放）', onClick: () => reset(true) }, '⟲')),
              h('div', { className: 'dym-tip' }, '缩放 ' + Math.round(view.k * 100) + '%'),
            ),
            sel ? h(Card, { style: { marginTop: '8px' } },
              h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, sel.label),
              h('div', { style: { opacity: 0.7 } },
                [sel.type || '未分类', sel.importance != null ? '重要度 ' + sel.importance : '', (sel.tags || []).join(' / ')].filter(Boolean).join(' · ')),
              sel.created_at ? h('div', { style: { opacity: 0.55, fontSize: '11.5px' } }, sel.created_at) : null,
            ) : null,
          )
        }

        // 人设（persona.md）：能看能改；每天还会按记忆自动补一段
        const PersonaBox = () => {
          const [text, setText] = React.useState(null)
          const [at, setAt] = React.useState('')
          const [msg, setMsg] = React.useState('')
          const [busy2, setBusy2] = React.useState(false)
          React.useEffect(() => {
            let alive = true
            fetch('/api/douyin-duty/memory', { credentials: 'same-origin' })
              .then((r) => r.json())
              .then((j) => { if (alive) { setText(j.persona || ''); setAt(j.personaAt || '') } })
              .catch(() => { if (alive) setText('') })
            return () => { alive = false }
          }, [])
          const save = async () => {
            setBusy2(true); setMsg('')
            try {
              const r = await fetch('/api/douyin-duty/persona', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text }),
              })
              const j = await r.json()
              setMsg(j.ok ? '人设已保存（备份 persona.md.bak）' : '保存失败：' + (j.error || ''))
            } catch (e) { setMsg('保存失败：' + String((e && e.message) || e)) } finally { setBusy2(false) }
          }
          if (text === null) return h('div', { className: 'dym-card' }, '人设读取中…')
          return h('div', { className: 'dym-card', style: { marginTop: '10px' } },
            h('div', { className: 'dym-k', style: { marginBottom: '6px' } },
              '人设（persona.md）· 每天按记忆自动更新',
              at ? h('span', { style: { opacity: 0.5, marginLeft: '8px', fontSize: '11px' } }, '上次写入 ' + String(at).slice(0, 16).replace('T', ' ')) : null),
            h('textarea', {
              value: text, rows: 12, onChange: (e) => setText(e.target.value),
              style: { width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '12.5px', lineHeight: 1.6,
                padding: '10px 12px', borderRadius: '8px', border: '1px solid rgba(128,128,128,.3)',
                background: 'transparent', color: 'inherit' },
            }),
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' } },
              h('button', { className: 'dym-tab on', disabled: Boolean(busy2), onClick: save }, busy2 ? '保存中…' : '保存人设'),
              msg ? h('span', { style: { fontSize: '12px', opacity: 0.8 } }, msg) : null))
        }

        const CharEditor = ({ data, onSaved }) => {
          const base = (data && (data.character || data)) || {}
          const id = base.identity || {}
          const prefs = base.preferences || {}
          const cons = Array.isArray(base.constraints) ? base.constraints : []
          const refName = React.useRef(null)
          const refTz = React.useRef(null)
          const refStyle = React.useRef(null)
          const refLen = React.useRef(null)
          const refCons = React.useRef(null)
          const [saving, setSaving] = React.useState(false)
          const [msg, setMsg] = React.useState('')
          const [bad, setBad] = React.useState(false)

          React.useEffect(() => {
            if (refName.current) refName.current.value = id.name || ''
            if (refTz.current) refTz.current.value = id.timezone || 'Asia/Shanghai'
            if (refStyle.current) refStyle.current.value = prefs.communication_style || ''
            if (refLen.current) refLen.current.value = prefs.response_length || 'short'
            if (refCons.current) refCons.current.value = cons.join('\n')
          }, [data])

          const inputStyle = { width: '100%', fontSize: '12.5px', padding: '7px 10px', borderRadius: '8px',
            border: '1px solid rgba(128,128,128,.3)', background: 'transparent', color: 'inherit' }
          const field = (label, ref2, ph, multi) => h('div', { style: { marginBottom: '10px' } },
            h('div', { className: 'dym-k', style: { marginBottom: '4px' } }, label),
            multi
              ? h('textarea', { ref: ref2, defaultValue: '', rows: 3, placeholder: ph, style: { ...inputStyle, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.55 } })
              : h('input', { ref: ref2, type: 'text', defaultValue: '', placeholder: ph, style: inputStyle, autoComplete: 'off', spellCheck: false }))

          const save = async () => {
            const val = (r) => ((r.current && r.current.value) || '').trim()
            setSaving(true); setMsg(''); setBad(false)
            try {
              const updates = {
                identity: { ...(id || {}), name: val(refName) || id.name || '', timezone: val(refTz) || id.timezone || 'Asia/Shanghai' },
                preferences: { ...(prefs || {}), communication_style: val(refStyle) || prefs.communication_style || '',
                  response_length: val(refLen) || prefs.response_length || 'short' },
                constraints: String(val(refCons) || '').split('\n').map((s) => s.trim()).filter(Boolean),
              }
              await memCall('character', { action: 'update', updates })
              const checked = await memCall('character', { action: 'read' })
              const actual = checked?.character || checked
              if (actual?.identity?.name !== updates.identity.name || actual?.preferences?.communication_style !== updates.preferences.communication_style ||
                  JSON.stringify(actual?.constraints || []) !== JSON.stringify(updates.constraints)) throw new Error('回读与保存内容不一致')
              setMsg('已保存（已回读核对）')
              if (onSaved) onSaved()
            } catch (e) { setBad(true); setMsg('保存失败：' + String((e && e.message) || e)) } finally { setSaving(false) }
          }

          return h('div', null,
            h(Card, null,
              h('div', { className: 'dym-k', style: { marginBottom: '10px' } },
                '改完点「保存角色卡」；这些值会进记忆库，影响它说话的样子。'),
              field('称呼（identity.name）', refName, 'YG'),
              field('时区（identity.timezone）', refTz, 'Asia/Shanghai'),
              field('沟通风格（preferences.communication_style）', refStyle, '傲娇, 可爱, 撒娇'),
              field('回复长度（preferences.response_length）', refLen, 'short / medium / long'),
              field('约束（constraints，一行一条）', refCons, '不聊政治\n不编数据', true)),
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' } },
              h('button', { className: 'dym-tab on', disabled: saving ? '' : undefined, onClick: save },
                saving ? '保存中…' : '保存角色卡'),
              msg ? h('span', { style: { fontSize: '12px', opacity: 0.8, color: bad ? '#e06' : undefined } }, msg) : null),
            (base.expertise || base.persona || base.habits)
              ? h(Card, { style: { marginTop: '10px' } },
                  h('div', { className: 'dym-k', style: { marginBottom: '6px' } }, '其它字段（只读）'),
                  base.persona ? KV('人设（persona）', flatText(base.persona)) : null,
                  base.expertise ? KV('专长（expertise）', flatText(base.expertise)) : null,
                  base.habits ? KV('习惯（habits）', flatText(base.habits)) : null)
              : null,
            h(PersonaBox, null),
            h('div', { style: { fontSize: '11.5px', opacity: 0.55 } },
              '更新时间：' + (base.updated_at || base._last_updated || '—')))
        }

        const Timelines = ({ items, busy }) => {
          const [q, setQ] = React.useState('')
          const list = (items || []).filter((it) => {
            if (!q.trim()) return true
            const s = (it.text || it.summary || it.content || '') + ' ' + (it.kind || '') + ' ' + (it.type || '')
            return s.toLowerCase().includes(q.trim().toLowerCase())
          })
          const KIND_COLOR = { preference: '#f0a35e', fact: '#5b8def', lesson: '#e0705e', event: '#4bb6a8',
            person: '#7c6ff7', task: '#9aa3b2', note: '#9aa3b2' }
          const fmt = (s) => {
            const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/)
            return m ? m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] : String(s || '')
          }
          return h('div', null,
            h('div', { style: { display: 'flex', gap: '8px', marginBottom: '10px' } },
              h('input', {
                value: q, placeholder: '搜索记忆内容 / 类型…',
                onChange: (e) => setQ(e.target.value),
                style: { flex: 1, fontSize: '12.5px', padding: '7px 10px', borderRadius: '8px',
                  border: '1px solid rgba(128,128,128,.3)', background: 'transparent', color: 'inherit' },
              }),
              h('span', { className: 'dym-chip' }, '共 ', h('b', null, (items || []).length), ' 条，显示 ', h('b', null, list.length))),
            list.length
              ? list.slice(0, 60).map((it, i) => {
                  const kind = it.kind || it.type || ''
                  return h('div', { key: i, className: 'dym-card', style: { padding: '9px 12px' } },
                    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px' } },
                      kind ? h('span', {
                        style: { fontSize: '10.5px', padding: '1px 7px', borderRadius: '999px',
                          border: '1px solid ' + (KIND_COLOR[kind] || '#9aa3b2'), color: KIND_COLOR[kind] || '#9aa3b2' },
                      }, kind) : null,
                      h('span', { style: { fontSize: '11px', opacity: 0.55 } }, fmt(it.created_at || it.at || '')),
                      it.importance != null ? h('span', { style: { fontSize: '11px', opacity: 0.55 } }, '· 重要度 ' + it.importance) : null),
                    String(it.text || it.summary || it.content || '').slice(0, 500))
                })
              : h(Card, null, busy ? '读取中…' : (q ? '没有匹配的记忆' : '（还没有回忆条目）')))
        }

        // 清理：按工作区列出记忆条目，能单条删、也能整区清空（走 memory.forget）
        const Cleanup = () => {
          const [list, setList] = React.useState(null)
          const [open, setOpen] = React.useState('')
          const [items, setItems] = React.useState({})
          const [msg, setMsg] = React.useState('')
          const [busy3, setBusy3] = React.useState(false)

          const loadWs = async () => {
            try { setList(await memCall('workspaces', {})) } catch (e) { setMsg('读工作区失败：' + String(e && e.message || e)) }
          }
          React.useEffect(() => { loadWs() }, [])

          const loadItems = async (wid) => {
            if (items[wid]) return
            try {
              const r = await memCall('workspace_detail', { workspace_id: wid, limit: 300 })
              setItems({ ...items, [wid]: (r && r.items) || [] })
            } catch (e) { setMsg('读条目失败：' + String(e && e.message || e)) }
          }

          const delOne = async (wid, id) => {
            setBusy3(true); setMsg('')
            try {
              await memCall('forget', { id })
              setItems({ ...items, [wid]: (items[wid] || []).filter((x) => x.id !== id) })
              setMsg('已删除 1 条')
              loadWs()
            } catch (e) { setMsg('删除失败：' + String(e && e.message || e)) } finally { setBusy3(false) }
          }

          const delAll = async (wid, label) => {
            setBusy3(true); setMsg('')
            try {
              let deleted = 0
              const failed = new Set()
              for (let page = 0; page < 100; page++) {
                const r = await memCall('workspace_detail', { workspace_id: wid, limit: 500 })
                if (!Array.isArray(r?.items)) throw new Error('记忆服务条目格式无效')
                const rows = r.items.filter(x => !failed.has(x.id))
                if (!rows.length) break
                let progress = 0
                for (const it of rows) {
                  try { await memCall('forget', { id: it.id }); deleted++; progress++ } catch { failed.add(it.id) }
                }
                if (!progress) break
              }
              const after = await memCall('workspace_detail', { workspace_id: wid, limit: 500 })
              if (!Array.isArray(after?.items)) throw new Error('删除后无法回读')
              setItems(prev => ({ ...prev, [wid]: after.items }))
              setMsg('已删除 ' + deleted + ' 条；失败 ' + failed.size + ' 条；当前仍可读到 ' + after.items.length + ' 条')
              await loadWs()
            } catch (e) { setMsg('清理未完成：' + String(e && e.message || e)) } finally { setBusy3(false) }
          }

          if (!list) return h('div', { className: 'dym-card' }, '工作区读取中…')
          const wss = list.workspaces || list.results || list || []
          return h('div', null,
            h('div', { className: 'dym-card', style: { fontSize: '12px', opacity: 0.85 } },
              '想清掉哪些记忆就点开对应工作区；删掉后会同步删每日 md 里那一行（记忆插件自己做的）。'),
            msg ? h('div', { className: 'dym-card', style: { color: '#0a0' } }, msg) : null,
            (wss || []).map((w) => {
              const wid = w.id || w.workspace_id || ''
              const label = w.label || wid || '（未命名）'
              const count = w.count ?? w.total ?? 0
              const isOpen = open === wid
              return h('div', { key: wid, className: 'dym-card' },
                h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                  h('button', {
                    className: 'dym-tab' + (isOpen ? ' on' : ''),
                    onClick: () => { const nx = isOpen ? '' : wid; setOpen(nx); if (nx) loadItems(nx) },
                  }, isOpen ? '收起' : '展开'),
                  h('span', { style: { fontWeight: 600 } }, label),
                  h('span', { className: 'dym-chip' }, count + ' 条'),
                  h('span', { style: { marginLeft: 'auto' } },
                    h('button', {
                      className: 'dym-tab', disabled: Boolean(busy3),
                      onClick: () => delAll(wid, label),
                    }, '整区清空'))),
                isOpen ? h('div', { style: { marginTop: '8px' } },
                  (items[wid] || []).length
                    ? (items[wid] || []).map((it) => h('div', {
                        key: it.id, style: { display: 'flex', gap: '8px', alignItems: 'flex-start',
                          padding: '6px 0', borderTop: '1px dashed rgba(128,128,128,.2)' },
                      },
                      h('span', { style: { fontSize: '11px', opacity: 0.5, minWidth: '64px' } }, String(it.created_at || '').slice(5, 16)),
                      h('span', { style: { flex: 1, fontSize: '12px' } }, String(it.content || '').slice(0, 160)),
                      h('button', { className: 'dym-tab', disabled: Boolean(busy3),
                        onClick: () => delOne(wid, it.id) }, '删')))
                    : h('div', { style: { fontSize: '12px', opacity: 0.6 } }, '（这一区没有条目了）'))
                : null)
            }))
        }

        const MemoryPage = () => { try {
          const [tab, setTab] = React.useState('graph')
          const [char, setChar] = React.useState(null)
          const [tl, setTl] = React.useState(null)
          const [g, setG] = React.useState(null)
          const [raw, setRaw] = React.useState(null)
          const [stats, setStats] = React.useState(null)
          const [err, setErr] = React.useState('')
          const [busy, setBusy] = React.useState(false)
          const [memOk, setMemOk] = React.useState(null)

          // 先探一次记忆服务：没有可选记忆插件时只显示「原始记录 + 人设」，不报 404
          React.useEffect(() => {
            let alive = true
            memCall('stats', {})
              .then(() => { if (alive) setMemOk(true) })
              .catch(() => { if (alive) { setMemOk(false); setTab('raw') } })
            return () => { alive = false }
          }, [])

          const load = React.useCallback(async (force) => {
            setBusy(true); setErr('')
            try {
              if (tab === 'raw' && (force || raw === null)) {
                const r = await fetch('/api/douyin-duty/memory', { credentials: 'same-origin' })
                setRaw(await r.json())
                return
              }
              if (memOk === false) return
              if (force || stats === null) { try { setStats(await memCall('stats', {})) } catch { /* 忽略 */ } }
              if (tab === 'character' && (force || char === null)) setChar(await memCall('character', { action: 'read' }))
              if (tab === 'timeline' && (force || tl === null)) setTl(await memCall('recall', { limit: 80 }))
              if (tab === 'graph' && (force || g === null)) setG(await memCall('graph', { limit: 60, min_importance: 0.03 }))
            } catch (e) { setErr(String((e && e.message) || e)) } finally { setBusy(false) }
          }, [tab, char, tl, g, raw, stats, memOk])
          React.useEffect(() => { if (memOk !== null) load(false) }, [tab, memOk])

          // ⭐ 角色卡：照记忆插件那套——**一直可编辑的表单**（称呼/时区/沟通风格/回复长度/约束 + 保存）


          const rawBody = () => {
            if (!raw) return h(Card, null, busy ? '读取中…' : '（读不到）')
            return h('div', null,
              h(Card, null, KV('记忆目录', raw.mdDir || '—'),
                KV('数据库', raw.dbPath ? raw.dbPath + '（' + raw.dbMb + ' MB）' : '（没找到）'),
                KV('文件', (raw.files || []).join(' / ') || '—')),
              (raw.lines || []).length ? h('div', null, raw.lines.map((ln, i) => h(Card, { key: i }, ln))) : h(Card, null, raw.hint || '还没有记录'))
          }

          return h('div', { className: 'dym-root' },
            h('div', { className: 'dym-head' },
              h('span', { className: 'dym-title' }, '记忆'),
              h('span', { className: 'dym-badge' }, memOk === false ? '本地记忆' : 'memory-system'),
              h('div', { className: 'dym-chips' },
                memOk === false
                  ? h('span', { className: 'dym-chip' }, '未装可选记忆插件：显示本地记忆 + 人设')
                  : [
                    h('span', { key: 'm', className: 'dym-chip' }, h('b', null, stats?.total_memories ?? '–'), ' 条记忆'),
                    h('span', { key: 'n', className: 'dym-chip' }, h('b', null, (g?.nodes || []).length || '–'), ' 节点'),
                    h('span', { key: 'e', className: 'dym-chip' }, h('b', null, (g?.edges || []).length || '–'), ' 关系'),
                  ])),
            h('div', { className: 'dym-tabs' },
              (memOk === false ? MemTabs.filter((t2) => t2.id === 'raw') : MemTabs).map((t2) => h('button', {
                key: t2.id, className: 'dym-tab' + (tab === t2.id ? ' on' : ''), onClick: () => setTab(t2.id),
              }, t2.label)),
              h('button', { className: 'dym-tab', onClick: () => load(true) }, busy ? '刷新中…' : '刷新')),
            err ? h(Card, null, '读取失败：' + err) : null,
            memOk === false ? h('div', null,
              h(Card, null, '没装可选记忆插件，只显示本插件自己的记忆文件和人设；装不装都不影响刷抖音。'),
              rawBody(),
              h(PersonaBox)) : null,
            memOk !== false && tab === 'graph' ? h(Guard, { Comp: MemGraph, props: { data: g, busy }, label: '图谱' }) : null,
            memOk !== false && tab === 'character' ? h(Guard, { Comp: CharEditor, props: { data: char, onSaved: () => load(true) }, label: '角色卡' }) : null,
            memOk !== false && tab === 'timeline' ? h(Guard, { Comp: Timelines, props: { items: (tl && (tl.results || tl)) || [], busy }, label: '时间线' }) : null,
            memOk !== false && tab === 'clean' ? h(Guard, { Comp: Cleanup, props: {}, label: '清理' }) : null,
            memOk !== false && tab === 'raw' ? rawBody() : null,
          )
        } catch (e) {
          try {
            fetch('/api/douyin-duty/log', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ msg: 'memory page failed: ' + String(e && e.message), stack: String((e && e.stack) || '') }),
            }).catch(() => {})
          } catch { /* 忽略 */ }
          return h('div', { className: 'dym-root', style: { padding: '12px' } },
            h('div', { className: 'dym-title' }, '记忆页出错'),
            h('div', { className: 'dym-card', style: { color: '#e06', whiteSpace: 'pre-wrap' } },
              String((e && e.message) || e) + '\n' + String((e && e.stack) || '').split('\n').slice(0, 5).join('\n')))
        }
      }

        // 兜底：任何渲染异常都画成红字，不再白屏（2026-10-26 使用者连续两次看到空白）
        const MemorySafe = () => h(Guard, { Comp: MemoryPage, label: '记忆页' })

        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'douyin-memory', order: 32, label: '记忆' },
          () => h(MemorySafe),
        ))

        // ⭐ 会话头第三个 tab：抖音刷过的视频（使用者 2026-10-23 要求跟 B站 那个并排）
        try {
          slots.inject('conversation.view', () => slots.register({
            name: 'conversation.view',
            id: 'douyin-watched',
            order: 21,
            label: '抖音刷过的视频',
            scope: 'session',
          }, () => h(DouyinWatchedTab)))
        } catch (e) { /* 老版本没有这个槽位就算了 */ }
      },
    }
  },
})
