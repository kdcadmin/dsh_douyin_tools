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
      ['pref', '偏好'],
      ['like', '互动'],
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
            peakValley: Boolean(c.peakValley), noon: Boolean(c.noon), night: Boolean(c.night),
            perDay: Number(c.perDay) || 0,
            keywords: Array.isArray(c.keywords) ? c.keywords.join('、') : '',
            reportLevel: String(c.reportLevel || 'full'),
            personaPrompt: String(c.personaPrompt || ''),
            autoReply: Boolean(c.autoReply), replyPerRun: c.replyPerRun ?? 3, replyPerDay: c.replyPerDay ?? 10,
            replyRandom: c.replyRandom !== false, replyVideoIds: String(c.replyVideoIds || ''), replyIntervalMin: c.replyIntervalMin ?? 30, replyOncePerUser: Boolean(c.replyOncePerUser), skipLive: c.skipLive !== false, shareToNick: String(c.shareToNick || ''), shareNote: String(c.shareNote || ''), msgAllowTo: String(c.msgAllowTo || ''), dmReply: c.dmReply !== false, dmReplyPerContact: c.dmReplyPerContact ?? 1, dmReplyPerDay: c.dmReplyPerDay ?? 5, sharePerDay: c.sharePerDay ?? 10, autoCommentPlain: c.autoCommentPlain !== false, plainCommentPerDay: c.plainCommentPerDay ?? 3, streakNick: String(c.streakNick || ''), streakPerDay: c.streakPerDay ?? 1, askDoubao: Boolean(c.askDoubao),
            autoLike: Boolean(c.autoLike), autoComment: Boolean(c.autoComment),
            autoPublish: Boolean(c.autoPublish), publishDraft: Boolean(c.publishDraft),
            commentPerDay: Number(c.commentPerDay) || 0, publishPerDay: Number(c.publishPerDay) || 0,
            publishTitle: String(c.publishTitle || ''), publishTags: String(c.publishTags || ''),
            mentionName: String(c.mentionName || ''), commentPerRound: Number(c.commentPerRound) || 0,
            pythonPath: String(c.pythonPath || ''), dshBin: String(c.dshBin || ''),
            comfyUrl: String(c.comfyUrl || ''), comfyOutputDir: String(c.comfyOutputDir || ''),
            comfyWorkflow: String(c.comfyWorkflow || ''),
            cdpUrl: String(c.cdpUrl || ''), cdpPort: Number(c.cdpPort) || 9222,
          })
        } catch (e) { setMsg('读状态失败：' + String(e.message || e)); setTone('warn') }
      }
      React.useEffect(() => { load() }, [])

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
            peakValley: draft.peakValley, noon: draft.noon, night: draft.night,
            perDay: Number(draft.perDay) || 0,
            keywords: String(draft.keywords || '').split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean),
            reportLevel: draft.reportLevel, personaPrompt: draft.personaPrompt,
            autoLike: draft.autoLike, autoComment: draft.autoComment,
            autoReply: draft.autoReply, replyPerRun: Number(draft.replyPerRun) || 0,
            replyPerDay: Number(draft.replyPerDay) || 0, replyRandom: draft.replyRandom !== false,
            replyVideoIds: String(draft.replyVideoIds || ''), replyIntervalMin: Number(draft.replyIntervalMin) || 30, replyOncePerUser: Boolean(draft.replyOncePerUser), skipLive: draft.skipLive !== false, shareToNick: String(draft.shareToNick || ''), shareNote: String(draft.shareNote || ''), msgAllowTo: String(draft.msgAllowTo || ''), dmReply: draft.dmReply !== false, dmReplyPerContact: Number(draft.dmReplyPerContact) || 1, dmReplyPerDay: Number(draft.dmReplyPerDay) || 0, sharePerDay: Number(draft.sharePerDay) || 0, autoCommentPlain: draft.autoCommentPlain !== false, plainCommentPerDay: Number(draft.plainCommentPerDay) || 0, streakNick: String(draft.streakNick || ''), streakPerDay: Number(draft.streakPerDay) || 0, askDoubao: Boolean(draft.askDoubao),
            autoPublish: draft.autoPublish, publishDraft: draft.publishDraft,
            commentPerDay: Number(draft.commentPerDay) || 0, publishPerDay: Number(draft.publishPerDay) || 0,
            publishTitle: draft.publishTitle, publishTags: draft.publishTags,
            mentionName: draft.mentionName, commentPerRound: Number(draft.commentPerRound) || 0,
            pythonPath: draft.pythonPath, dshBin: draft.dshBin,
            comfyUrl: draft.comfyUrl, comfyOutputDir: draft.comfyOutputDir, comfyWorkflow: draft.comfyWorkflow,
            cdpUrl: draft.cdpUrl, cdpPort: Number(draft.cdpPort) || 9222,
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
            setMsg(`刷完一轮：挑了 ${r.picked ?? 0} 条${acts.length ? '，' + acts.join('；') : ''}`)
            setTone(acts.some((a) => /没|失败/.test(a)) ? 'warn' : 'good')
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
          const r = await jpost('/reply/round', { count: Number(draft.replyPerRun) || 3, random: draft.replyRandom !== false })
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
      const pyOk = st.python && st.python.via !== 'path' ? true : true

      return h('div', { 'data-dy-page': '' },
        /* ── 顶部：徽章 + 现在跑一轮 ── */
        h('div', { 'data-dy-top': '' },
          h('div', { 'data-dy-badges': '', 'data-dy-grow': '' },
            h('span', { 'data-dy-badge': '' }, `今天已挑 ${st.pickedToday ?? 0}/${st.perDay ?? 0} 条`),
            h('span', { 'data-dy-badge': '', 'data-good': pyOk ? '' : undefined }, pyOk ? '环境已就绪' : '环境未装'),
            h('span', { 'data-dy-badge': '', 'data-good': st.loggedIn ? '' : undefined, 'data-warn': st.loggedIn ? undefined : '' },
              st.loggedIn ? '抖音已登录' : '抖音未登录'),
            h('span', { 'data-dy-badge': '' }, 'v0.1.0')),
          h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: busy === 'run' ? '' : undefined, onClick: runNow }, '现在跑一轮')),

        /* ── tabs ── */
        h('div', { 'data-dy-tabs': '' }, TABS.map(([id, label]) => h('button', {
          key: id, 'data-dy-tab': '', role: 'tab', 'aria-selected': tab === id ? 'true' : 'false',
          onClick: () => { setTab(id); setMsg('') },
        }, label))),

        msg ? h('div', { 'data-dy-msg': '', 'data-good': tone === 'good' ? '' : undefined, 'data-warn': tone === 'warn' ? '' : undefined }, msg) : null,

        /* ══════════ 日常 ══════════ */
        h('div', { 'data-dy-sec': '', 'data-dy-group': 'daily', 'data-dy-away': tab === 'daily' ? undefined : '' },

          /* ⭐ 账号摆在第一页最上面：登录入口要一眼看见（使用者 2026-10-23「你要有给登录入口啊」） */
          h('div', { 'data-dy-sec': '', 'data-dy-account': '' },
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' },
                h('div', { 'data-dy-label': '' }, st.loggedIn ? '账号：已登录' : '账号：还没登录'),
                Note(st.loggedIn
                  ? '登录态留在这个 Chrome 里，之后不用再扫'
                  : '不登录也能看热榜 / 详情 / 评论；搜索、点赞、评论、投稿要登录')),
              h('button', { 'data-dy-btn': '', 'data-primary': st.loggedIn ? undefined : '', disabled: busy === 'login' ? '' : undefined, onClick: loginStart },
                st.loggedIn ? '重新扫码' : '扫码登录'),
              h('button', { 'data-dy-btn': '', disabled: busy === 'poll' ? '' : undefined, onClick: loginPoll }, '我扫完了'),
              h('button', { 'data-dy-btn': '', disabled: busy === 'sms' ? '' : undefined, onClick: () => { setShowSms((v) => !v); setMsg('') } },
                showSms ? '收起收验证码' : '收验证码登录')),
            showSms ? h('div', { 'data-dy-row': '', 'data-dy-sms': '' },
              h('input', { 'data-dy-input': '', 'data-dy-num': '', style: { width: '150px' }, placeholder: '手机号',
                value: smsPhone, onChange: (e) => setSmsPhone(e.target.value.replace(/\D/g, '').slice(0, 11)) }),
              h('button', { 'data-dy-btn': '', disabled: busy === 'sms' ? '' : undefined, onClick: sendSms }, '发验证码'),
              h('input', { 'data-dy-input': '', 'data-dy-num': '', style: { width: '110px' }, placeholder: '验证码',
                value: smsCode, onChange: (e) => setSmsCode(e.target.value.replace(/\D/g, '').slice(0, 6)) }),
              h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: busy === 'sms' ? '' : undefined, onClick: submitSms }, '提交验证码'),
              Note(st.loggedIn ? '已经登录了；换号时才需要这一步' : '扫码之后如果抖音要短信验证，就走这里：发验证码 → 把收到的 6 位填进来 → 提交')) : null,
            qr?.qr ? h('div', { 'data-dy-qr': '' },
              h('img', { src: qr.qr, alt: '抖音登录二维码' }),
              h('div', { 'data-dy-note': '' }, '手机抖音 → 扫一扫 → 选「长期 / 记住我」。', h('br'), '扫完点「我扫完了」。')) : null),

          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: busy === 'save' ? '' : undefined, onClick: save }, '保存'),
            Note('改完记得点这一下（其它 tab 的改动也会一起存）')),

          h('div', { 'data-dy-sec': '' },
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' },
                h('div', { 'data-dy-label': '' }, '峰谷时段自动刷'),
                Note('只在谷时跑 —— 工作日 12:00–14:00 与 18:00 之后（整个周末也算谷时）；关了就只能手动跑')),
              Sw({ on: Boolean(draft.peakValley), onChange: (v) => set('peakValley', v) })),
            draft.peakValley ? h('div', { 'data-dy-sub': '' },
              h('div', { 'data-dy-row': '' }, h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '中午 12:00–14:00')),
                Sw({ on: Boolean(draft.noon), onChange: (v) => set('noon', v) })),
              h('div', { 'data-dy-row': '' }, h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '夜间 00:30–08:30')),
                Sw({ on: Boolean(draft.night), onChange: (v) => set('night', v) }))) : null),

          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' },
              h('div', { 'data-dy-label': '' }, '每天最多挑几条'),
              Note('填 0 = 不自动刷（还是能手动跑）')),
            h('input', { 'data-dy-input': '', 'data-dy-num': '', type: 'number', min: 0, max: 50,
              value: draft.perDay ?? 5, onChange: (e) => set('perDay', e.target.value.replace(/[^0-9]/g, '')) })),

          h('div', { 'data-dy-h': '' }, '它刷过的视频'),
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', disabled: busy === 'watched' ? '' : undefined, onClick: loadWatched },
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
            h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: busy === 'save' ? '' : undefined, onClick: save }, '保存')),
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
              Note('想让它用什么口气说话就写在这儿；留空 = 中性'))),
          h('textarea', { 'data-dy-input': '', 'data-dy-area': '', value: draft.personaPrompt ?? '',
            onChange: (e) => set('personaPrompt', e.target.value) })),

        /* ══════════ 互动 ══════════ */
        h('div', { 'data-dy-sec': '', 'data-dy-group': 'like', 'data-dy-away': tab === 'like' ? undefined : '' },
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: busy === 'save' ? '' : undefined, onClick: save }, '保存'),
            Note('这三件事都是拿你的号动手，默认全关；要用就自己开')),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '自动回我自己视频的评论'),
              Note('随机挑视频、随机挑评论；每条不超过 20 字，敏感话题婉拒')),
            Sw({ on: Boolean(draft.autoReply), onChange: (v) => set('autoReply', v) })),
          draft.autoReply ? h('div', { 'data-dy-sub': '' },
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '每次回几条')),
              h('input', { 'data-dy-input': '', 'data-dy-num': '', inputMode: 'numeric',
                value: draft.replyPerRun ?? 3, onChange: (e) => set('replyPerRun', e.target.value.replace(/[^0-9]/g, '')) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '每天最多回几条'),
                Note(`今天已回 ${st.doing?.todayReplies ?? 0} 条`)),
              h('input', { 'data-dy-input': '', 'data-dy-num': '', inputMode: 'numeric',
                value: draft.replyPerDay ?? 10, onChange: (e) => set('replyPerDay', e.target.value.replace(/[^0-9]/g, '')) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '遇到直播就跳过')),
              Sw({ on: draft.skipLive !== false, onChange: (v) => set('skipLive', v) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '转发给谁（留空=不转发）'),
                Note('把好看的视频私信发给他，正文是视频链接')),
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
                placeholder: '主人', onChange: (e) => set('msgAllowTo', e.target.value) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '自动回私信'),
                Note('别人（含陌生人）发来消息就回一句；默认每人和每天各有限额')),
              Sw({ on: draft.dmReply !== false, onChange: (v) => set('dmReply', v) })),
            draft.dmReply !== false ? h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '每个联系人每天回几条')), h('span', null,
                h('input', { 'data-dy-input': '', 'data-dy-num': '', inputMode: 'numeric', style: { width: '70px' },
                  value: draft.dmReplyPerContact ?? 1, onChange: (e) => set('dmReplyPerContact', e.target.value.replace(/[^0-9]/g, '')) }),
                '  每天合计 ',
                h('input', { 'data-dy-input': '', 'data-dy-num': '', inputMode: 'numeric', style: { width: '70px' },
                  value: draft.dmReplyPerDay ?? 5, onChange: (e) => set('dmReplyPerDay', e.target.value.replace(/[^0-9]/g, '')) }))) : null,
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '转发时附带的一句话'),
                Note('留空=随机一句；可带 [笑哭] 这类表情码，转发完紧跟一条私信')),
              h('input', { 'data-dy-input': '', style: { width: '260px' }, value: draft.shareNote ?? '',
                placeholder: '这个视频好好笑，主人你也看看，哈哈哈[笑哭]',
                onChange: (e) => set('shareNote', e.target.value) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '续火花：每天给谁发一句'),
                Note('留空=不续；表情包用 [憨笑] 这类文本码一起发')),
              h('input', { 'data-dy-input': '', style: { width: '150px' }, value: draft.streakNick ?? '',
                placeholder: '对方昵称', onChange: (e) => set('streakNick', e.target.value) }),
              h('input', { 'data-dy-input': '', 'data-dy-num': '', inputMode: 'numeric', style: { width: '80px' },
                value: draft.streakPerDay ?? 1, onChange: (e) => set('streakPerDay', e.target.value.replace(/[^0-9]/g, '')) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '遇到不会的视频：评论里 @ 豆包'),
                Note('默认关；开了会在评论里 @豆包 求解答')),
              Sw({ on: Boolean(draft.askDoubao), onChange: (v) => set('askDoubao', v) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '同一个人只回一次'),
                Note('开着的话，同一个人后来的新评论也不回；默认关（每条评论回一次）')),
              Sw({ on: Boolean(draft.replyOncePerUser), onChange: (v) => set('replyOncePerUser', v) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '随机挑（关掉=按顺序）')),
              Sw({ on: draft.replyRandom !== false, onChange: (v) => set('replyRandom', v) })),
            h('div', { 'data-dy-row': '' },
              h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '每隔多少分钟看一次评论和私信'),
                Note('默认 30 分钟，实际 ±20% 抖动（24~36 分钟）。到点会：看评论（自动回开着才回）+ 看私信（自动回私信开着才回）+ 续火花（每天 1 次）')),
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
              h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: busy === 'reply' ? '' : undefined, onClick: replyNow }, '现在回一轮'),
              Note('你不用先保存，按当前填的条数就回'))) : null,
          h('div', { 'data-dy-row': '' },
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
            Sw({ on: draft.autoCommentPlain !== false, onChange: (v) => set('autoCommentPlain', v) })),
          draft.autoCommentPlain !== false ? h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '每天最多几条普通评论')),
            h('input', { 'data-dy-input': '', 'data-dy-num': '', inputMode: 'numeric', style: { width: '70px' },
              value: draft.plainCommentPerDay ?? 3, onChange: (e) => set('plainCommentPerDay', e.target.value.replace(/[^0-9]/g, '')) })) : null,
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
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '自动发布视频'),
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

          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', disabled: busy === 'comfy' ? '' : undefined, onClick: listComfy },
              comfyList !== null ? '收起成片列表' : '看 ComfyUI 最新成片'),
            h('button', { 'data-dy-btn': '', disabled: busy === 'publish' ? '' : undefined, onClick: publishLatest },
              '把最新那条发出去'),
            Note('「发出去」= 你自己点的，所以会真的走一遍投稿；草稿开关照样生效')),
          comfyList !== null ? h('div', { 'data-dy-list': '' },
            (comfyList.length ? comfyList : [{ name: '（输出目录里没有 .mp4）', mtimeText: '' }]).map((v, i) => h('div', { key: String(v.path || i), 'data-dy-item': '' },
              h('div', { 'data-dy-item-t': '' }, String(v.name || '')),
              h('div', { 'data-dy-item-n': '' }, `${v.mtimeText || ''}${v.size ? ' · ' + Math.round(v.size / 1024 / 1024) + 'MB' : ''}`)))) : null),

        /* ══════════ 高级 ══════════ */
        h('div', { 'data-dy-sec': '', 'data-dy-group': 'adv', 'data-dy-away': tab === 'adv' ? undefined : '' },
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: busy === 'save' ? '' : undefined, onClick: save }, '保存'),
            h('button', { 'data-dy-btn': '', disabled: busy === 'check' ? '' : undefined, onClick: selfcheck }, '环境自检'),
            h('button', { 'data-dy-btn': '', onClick: showLog }, logTail !== null ? '收起日志' : '看日志')),

          checks && checks.length ? h('div', { 'data-dy-list': '' }, checks.map((x) => h('div', { key: x.name, 'data-dy-item': '' },
            h('div', { 'data-dy-item-t': '' }, (x.ok ? '正常 · ' : '有问题 · ') + x.name),
            h('div', { 'data-dy-item-n': '' }, String(x.detail || '').slice(0, 200)),
            x.ok ? null : h('div', { 'data-dy-item-n': '' }, '怎么办：' + (x.fix || '把诊断信息发给作者'))))) : null,
          logTail !== null ? h('pre', { 'data-dy-pre': '' }, logTail) : null,

          /* ⭐ 主依赖（照「刷B站」那页：装主依赖 + 安装日志） */
          h('div', { 'data-dy-h': '' }, '主依赖（Python 半边：MCP + Playwright）'),
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', disabled: busy === 'setup' ? '' : undefined, onClick: doSetup }, '装主依赖（建 venv）'),
            h('button', { 'data-dy-btn': '', onClick: showSetupLog }, setupLog !== null ? '收起安装日志' : '看安装日志'),
            Note('装的是 mcp<2 + playwright（用系统 Chrome，不下载浏览器）')),
          setupLog !== null ? h('pre', { 'data-dy-pre': '' }, setupLog) : null,

          /* ⭐ 它的地盘（家目录 / 今天的报告 / 打开文件夹） */
          h('div', { 'data-dy-h': '' }, '它的地盘'),
          h('div', { 'data-dy-note': '' }, `家目录：${st.home}`),
          h('div', { 'data-dy-note': '' }, `今天的报告：${st.report}`),
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', disabled: busy === 'report' ? '' : undefined, onClick: showReport }, report !== null ? '收起报告' : '看今天的报告'),
            h('button', { 'data-dy-btn': '', onClick: () => openDir('out') }, '打开报告文件夹'),
            h('button', { 'data-dy-btn': '', onClick: () => openDir('home') }, '打开家目录'),
            h('button', { 'data-dy-btn': '', onClick: () => { try { navigator.clipboard && navigator.clipboard.writeText(String(st.report || '')); setMsg('报告路径已复制'); setTone('good') } catch (e) { setMsg('复制失败') } } }, '复制报告路径')),
          report !== null ? h('pre', { 'data-dy-pre': '' }, report) : null,

          h('div', { 'data-dy-h': '' }, '账号与浏览器'),
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', disabled: busy === 'login' ? '' : undefined, onClick: loginStart }, '扫码登录'),
            h('button', { 'data-dy-btn': '', disabled: busy === 'poll' ? '' : undefined, onClick: loginPoll }, '我扫完了'),
            Note(st.loggedIn ? '已经登录了' : '没登录也能用：热榜 / 视频详情 / 评论；搜索、点赞、评论、投稿要登录')),
          qr?.qr ? h('div', { 'data-dy-qr': '' },
            h('img', { src: qr.qr, alt: '抖音登录二维码' }),
            h('div', { 'data-dy-note': '' }, '手机抖音 → 扫一扫。', h('br'), '确认时选「长期 / 记住我」那张。')) : null,

          h('div', { 'data-dy-h': '' }, 'ComfyUI（片子从哪儿来）'),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '地址')),
            h('input', { 'data-dy-input': '', style: { width: '240px' }, value: draft.comfyUrl ?? '',
              onChange: (e) => set('comfyUrl', e.target.value) })),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '输出目录（取最新的 .mp4）'),
              Note(st.comfy?.outputDirExists ? '目录存在' : '目录不存在，发布前改对')),
            h('input', { 'data-dy-input': '', style: { width: '300px' }, value: draft.comfyOutputDir ?? '',
              onChange: (e) => set('comfyOutputDir', e.target.value) })),
          h('div', { 'data-dy-row': '' }, h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-label': '' }, '工作流 JSON（可选，填了就先生成再发）'))),
          h('textarea', { 'data-dy-input': '', 'data-dy-area': '', value: draft.comfyWorkflow ?? '',
            placeholder: '留空 = 直接发输出目录里最新的那个 mp4', onChange: (e) => set('comfyWorkflow', e.target.value) })),
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
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-douyin-life')
        style.textContent = CSS
        document.head.appendChild(style)
        try { ctx.effect(() => () => style.remove(), 'dsh-douyin-life: 设置页样式') } catch {}

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'douyin-life', order: 31, label: '刷抖音' },
          () => h(Panel),
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
