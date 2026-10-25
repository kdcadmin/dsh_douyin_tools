/**
 * dsh-douyin-life —— host 半端（「刷抖音」）
 * ============================================================================
 * 它是什么：
 *   1. **插件内部起那份 Python MCP**（`vendor/douyin-mcp/mcp_server.py`，运行时铺到
 *      `<家>/mcp_server.py`），把它的能力注册成 14 个 `dy_*` dsh 工具
 *      （状态 / 配置 / 登录 / 搜 / 单条 / 评论 / 点赞 / 发评论 / 投稿 / ComfyUI / 跑一轮 / 自检）。
 *   2. **谷时定时器**：`lib/state.mjs` 的 `WINDOWS`（中午 12:00–14:00、夜间 00:30–08:30），
 *      开了哪个窗口才在哪个窗口自动跑；`perDay` 是**每天总量上限**。
 *   3. **跑一轮** = 起一个 `dsh --profile headless <prompt>`，把 `duty.md` 交过去，
 *      报告写进 `<家>/out/<日期>.md`。那一轮通过 overlay 挂上本插件的 Python MCP。
 *   4. **ComfyUI 桥**（纯 HTTP，宿主侧做）：`dy_comfy_list` 列成片、`dy_publish(latest:true)`
 *      取最新一个 `.mp4` 去投；`comfyWorkflow` 非空时先 `POST /prompt` 排队再轮询 `/history/<id>`。
 *   5. **闸门**（SPEC 3.3）：`autoLike` / `autoComment` / `autoPublish` **默认全关**，
 *      拿使用者的号动手的事默认一律不做；越闸只能靠调用方传 `force: true`。
 *
 * 家里（`<dsh home>/douyin-duty/`）都有什么：`config.json` / `state.json` / `duty.log` /
 * `mcp_server.py`（从 vendor 铺过来，凭证与浏览器 profile 就落在家里的 `browser/`）/
 * `duty.md` / `login-qr.png` / `out/`。
 *
 * ⚠️ 骨架照 `dsh-bili-scroll`，业务一条没搬。
 * ⚠️ **任何一步抛错都要被兜住**：插件加载失败比少个功能糟得多。
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

// ⭐ 这两样从**宿主那棵树**里取（拿不到就退到自己的依赖；再拿不到，defineTool 用本地等价实现）。
//    它们是 optional peer，桌面版 profile（autoInstallPeers: false）永远不装 ⇒
//    **裸 import 会让整条插件不激活** ✗（详见 lib/hostdeps.mjs 的注释）
const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { McpClient } from './lib/mcp.mjs'
import { WINDOWS, stateDirOf, readJson, writeJson, ensureHomeFiles, ensureCharter, charterPath, inWindow, dayKey } from './lib/state.mjs'

export const name = 'douyin-life'
export const inject = ['webServer', 'tools', 'settings']

/**
 * 🔴 每个字段都要 `.extra('volatile', true)`：DSH 的 settings.update() 只认 volatile 字段。
 *    另外两个条件是：**loader entry 的 id 必须等于命名空间名**（`douyin-life`，见 cordis.patch.yml）
 *    + **本模块导出 Config**。
 * ⚠️ schemastery 彻底拿不到时这里会是 undefined —— **插件照常加载**，只是没有设置表单。
 */
export const Config = !z ? undefined : z.object({
  /** 定量刷：每天最多挑几条 */
  perDay: z.natural().default(5).extra('volatile', true),
  /** 峰谷自动刷（总开关）—— 默认关：不点头就不许自己动 */
  peakValley: z.boolean().default(false).extra('volatile', true),
  /** 峰谷子开关：中午 / 夜间 */
  noon: z.boolean().default(true).extra('volatile', true),
  night: z.boolean().default(true).extra('volatile', true),
  /** 自动点赞（默认关 —— 拿用户的号动手） */
  autoLike: z.boolean().default(false).extra('volatile', true),
  /** 自动评论并 @ 使用者（默认关） */
  autoComment: z.boolean().default(false).extra('volatile', true),
  /** 自动发布视频（默认关；开了也默认只存草稿） */
  autoPublish: z.boolean().default(false).extra('volatile', true),
  /** ⭐ 要 @ 谁（抖音昵称）；**留空 = 不发评论** —— 评论存在的意义就是 @ 那一下 */
  mentionName: z.string().default('').extra('volatile', true),
  /** 每轮最多发几条评论（0 = 不发） */
  commentPerRound: z.natural().default(1).extra('volatile', true),
  /** 关注关键词（空了用章程里默认那几组） */
  keywords: z.array(z.string()).default([]).extra('volatile', true),
  /** Python：指向 venv 里的那个最好；也可以填 `uv` */
  pythonPath: z.string().default('python').extra('volatile', true),
  /** dsh 的 bin.js（不填就自动探测，再退化成 PATH 里的 dsh） */
  dshBin: z.string().default('').extra('volatile', true),
  /** headless 那一轮用哪个 profile */
  headlessModel: z.string().default('').extra('volatile', true),
  headlessProfile: z.string().default('headless').extra('volatile', true),
  /** 给那一轮叠一份插件自己的 patch（把抖音 MCP 挂上）—— 用户 profile 一个字都不用改 */
  overlayMcp: z.boolean().default(true).extra('volatile', true),
  /** 跑 headless 时的工作目录留空 = 用插件家（沙箱只让它写自己工作目录） */
  workspace: z.string().default('').extra('volatile', true),
  /** 日报形态：full=完整 · brief=每条一两行 · off=不写报告 */
  reportLevel: z.string().default('full').extra('volatile', true),
  /** ⭐ 人设：说话的口吻 / 挑片口味（自由、调皮那种就写在这儿；留空 = 中性） */
  personaPrompt: z.string().default('').extra('volatile', true),
  /** ⭐ 记忆：把每天刷到的、读到的攒起来（<家>/memory/），下一轮开头带上最近几条 */
  memory: z.boolean().default(true).extra('volatile', true),
  /** ComfyUI 地址 */
  comfyUrl: z.string().default('http://127.0.0.1:8188').extra('volatile', true),
  /** ComfyUI 输出目录（`dy_publish(latest:true)` 和 `dy_comfy_list` 都读它） */
  comfyOutputDir: z.string().default('E:\\Comfy-Desktop\\ComfyUI-Shared\\output').extra('volatile', true),
  /** 可选：一份 ComfyUI workflow（JSON 正文，或一个 .json 的路径）；非空就先排队出片再投 */
  comfyWorkflow: z.string().default('').extra('volatile', true),
  /** 等 ComfyUI 出片最多等几秒 */
  comfyWaitSeconds: z.natural().default(900).extra('volatile', true),
  /** `dy_comfy_list` 默认列几条 */
  comfyListLimit: z.natural().default(20).extra('volatile', true),
  /** 投稿默认存草稿（`draft=True`）—— 等本人过一眼 */
  publishDraft: z.boolean().default(true).extra('volatile', true),
  /** 它自己发评论：每天最多几条（0 = 不发） */
  commentPerDay: z.natural().default(10).extra('volatile', true),
  /* ── 回我自己视频下的评论（随机读、限量回） ── */
  /** 开关：自动回自己视频下的评论（默认关：这是拿号动手） */
  autoReply: z.boolean().default(false).extra('volatile', true),
  /** 每次回几条 */
  replyPerRun: z.natural().default(3).extra('volatile', true),
  /** 每天最多回几条 */
  replyPerDay: z.natural().default(10).extra('volatile', true),
  /** 随机挑视频 / 随机挑评论（关掉 = 按顺序来） */
  replyRandom: z.boolean().default(true).extra('volatile', true),
  /** 指定要回的自己的视频 id（逗号分隔；留空 = 用投稿账本里发过的） */
  replyVideoIds: z.string().default('').extra('volatile', true),
  /** 「要回的自己的视频 id」是否只算一次（true=回完清空；false=长期保留） */
  replyOneShot: z.boolean().default(true).extra('volatile', true),
  /** 同一个人只回一次（默认关；开了之后同一个人后来的新评论也不回） */
  replyOncePerUser: z.boolean().default(false).extra('volatile', true),
  /** 「跑一轮」直接用宿主自己跑（不 spawn headless）：沙箱不让子进程开管道时也能刷 */
  localRound: z.boolean().default(true).extra('volatile', true),
  /** 每天最多转发几条（和「评论@」互斥：同一条视频不会被既@又转发） */
  sharePerDay: z.natural().default(10).extra('volatile', true),
  /** 超过这个分钟数直接划走（不看、不评、不转） */
  skipOverMin: z.natural().default(60).extra('volatile', true),
  /** 超过这个分钟数就算「跳着看」（挑重点段落，评论措辞也要体现） */
  skimOverMin: z.natural().default(5).extra('volatile', true),
  /** 一轮最多挑几条（别一口气刷完） */
  pickPerRound: z.natural().default(2).extra('volatile', true),
  /** 自动评论（**不@人**，就是普通评论一句） */
  autoCommentPlain: z.boolean().default(true).extra('volatile', true),
  /** 每天最多发几条普通评论 */
  plainCommentPerDay: z.natural().default(10).extra('volatile', true),
  /** 允许「主动发消息」的人（昵称，逗号分隔；留空=谁都不主动发）。回复别人的消息不受这个限制 */
  msgAllowTo: z.string().default('').extra('volatile', true),
  /** 自动回复私信（别人发来消息就回一条） */
  dmReply: z.boolean().default(true).extra('volatile', true),
  /** 每个联系人每天最多回几条 */
  dmReplyPerContact: z.natural().default(1).extra('volatile', true),
  /** 每天最多回几条私信（所有人合计） */
  dmReplyPerDay: z.natural().default(5).extra('volatile', true),
  /** 转发视频时附带的一句话（留空=从内置几句里随机；可带 [笑哭] 这类表情码） */
  shareNote: z.string().default('').extra('volatile', true),
  /** 遇到直播就跳过（默认开） */
  skipLive: z.boolean().default(true).extra('volatile', true),
  /** 转发视频给谁（昵称；留空=不转发） */
  shareToNick: z.string().default('').extra('volatile', true),
  /** 续火花：每天给谁发一句（昵称；留空=不续） */
  streakNick: z.string().default('').extra('volatile', true),
  /** 续火花每天最多几次 */
  streakPerDay: z.natural().default(1).extra('volatile', true),
  /** 遇到不会的视频，评论里 @ 豆包 求解答（默认关） */
  askDoubao: z.boolean().default(false).extra('volatile', true),
  /** 隔多少分钟看一次评论区（默认 30；会自动 ±20% 抖动，像人在看） */
  replyIntervalMin: z.natural().default(30).extra('volatile', true),
  /** 我自己在抖音的昵称（跳过自己的评论/回复；留空自动认「大白鲸」那几个） */
  myNickname: z.string().default('').extra('volatile', true),
  /** 它自己发视频：每天最多几条（0 = 不发） */
  publishPerDay: z.natural().default(1).extra('volatile', true),
  /** 视频标题模板（可用 {date} 占位；留空 = 「日常 <日期>」） */
  publishTitle: z.string().default('').extra('volatile', true),
  /** 投稿默认带的话题（空格/逗号分隔） */
  publishTags: z.string().default('').extra('volatile', true),
  /** ⭐ 复用「已经登录的 Chrome」：CDP 调试地址（空 = 用自己的持久 profile，首次要扫一次码） */
  cdpUrl: z.string().default('http://127.0.0.1:9222').extra('volatile', true),
  /** 调试端口（`dy_chrome_open` 用它拉 Chrome） */
  cdpPort: z.natural().default(9222).extra('volatile', true),
  /** Chrome 可执行文件路径（留空 = 自动探测） */
  chromePath: z.string().default('').extra('volatile', true),
})

export function apply(ctx, config) {
  /* ─────────────── 基础：家、日志、文件 ─────────────── */
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  const stateDir = stateDirOf(ctx)
  const outDir = join(stateDir, 'out')
  const logFile = join(stateDir, 'duty.log')
  const stateFile = join(stateDir, 'state.json')
  const cfgFile = join(stateDir, 'config.json')
  const qrFile = join(stateDir, 'login-qr.png')
  const scriptPath = join(stateDir, 'mcp_server.py')

  try { mkdirSync(outDir, { recursive: true }) } catch { /* 建不出来也别在 apply 里抛 */ }

  /** 一行一件事：时间 + 内容（写不进去也不致命） */
  const log = (msg) => {
    const line = `${new Date().toISOString()}  ${msg}`
    try { appendFileSync(logFile, line + '\n', 'utf8') } catch { /* 日志写不进去也不致命 */ }
    try { ctx.logger?.info?.(`[douyin-duty] ${msg}`) } catch { /* 没有 logger 就算了 */ }
  }
  const rotateLogIfBig = () => {
    try {
      const st = statSync(logFile)
      if (st.size < 2_000_000) return
      try { renameSync(logFile, logFile + '.1') } catch { /* 换不动就算了 */ }
    } catch { /* 没有日志文件 */ }
  }

  // 宿主依赖是从哪儿取的（排查看这里：duty.log 里会写明白）
  for (const n of hostDeps.notes) log(n)

  // ⭐ 铺 Python 半边：家里没有才铺；内容不一样**不覆盖**（新版落 .new），`--force` 才硬覆盖
  const forceRequested = () => {
    try { return process.argv.includes('--force') || process.env.DOUYIN_FORCE_COPY === '1' } catch { return false }
  }
  let homeFiles = { copied: false, reason: 'skipped' }
  try { homeFiles = ensureHomeFiles(pluginDir, stateDir, log, { force: forceRequested() }) } catch (e) {
    log(`铺 Python MCP 失败（已兜住，接着挂工具）：${e?.message ?? e}`)
  }
  // ⭐ 值班章程单独记账（用户改过就得留着）
  try { ensureCharter(pluginDir, stateDir, log) } catch (e) {
    log(`铺值班章程失败（已兜住）：${e?.message ?? e}`)
  }

  /* ─────────────── 配置 ─────────────── */

  const DEFAULTS = {
    perDay: 5, peakValley: false, noon: true, night: true,
    autoLike: false, autoComment: false, autoPublish: false,
    mentionName: '', commentPerRound: 1, keywords: [],
    pythonPath: 'python', dshBin: '', headlessProfile: 'headless', overlayMcp: true,
    workspace: '', reportLevel: 'full',
    personaPrompt: '',
    memory: true,
    autoReply: false, replyPerRun: 3, replyPerDay: 10, replyRandom: true, replyVideoIds: '', replyOneShot: true, myNickname: '', replyOncePerUser: false, replyIntervalMin: 30, skipLive: true, shareToNick: '', streakNick: '', streakPerDay: 1, askDoubao: false,
    headlessModel: '',
    shareNote: '', sharePerDay: 10, pickPerRound: 2, skipOverMin: 60, skimOverMin: 5, autoCommentPlain: true, plainCommentPerDay: 10, msgAllowTo: '', dmReply: true, dmReplyPerContact: 1, dmReplyPerDay: 5, localRound: true,
    comfyUrl: 'http://127.0.0.1:8188',
    comfyOutputDir: 'E:\\Comfy-Desktop\\ComfyUI-Shared\\output',
    comfyWorkflow: '', comfyWaitSeconds: 900, comfyListLimit: 20, publishDraft: true,
    commentPerDay: 10, publishPerDay: 1, publishTitle: '', publishTags: '',
    cdpUrl: 'http://127.0.0.1:9222', cdpPort: 9222, chromePath: '',
  }

  /**
   * ⚠️ bili 版踩过的事故（原样保留这条教训）：`apply(ctx, config)` 传进来的 `config`，
   *   字段值**不保证是标量** —— 于是 `if (!cfg.peakValley) return` 这类守卫会失效，
   *   一路走到 `cfg.keywords.filter(...)` 抛 TypeError，而那发生在**定时器回调**里 ⇒ 整个 dsh 被带走。
   *   ⇒ ① 逐字段按默认值的类型挑一遍；② 定时器回调里绝不让异常外冒。
   */
  const normalize = (src, base) => {
    const out = { ...base }
    for (const k of Object.keys(base)) {
      const v = src?.[k]
      if (v === undefined || v === null) continue
      if (Array.isArray(base[k])) { if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string') }
      else if (typeof base[k] === 'number') { const n = Number(v); if (Number.isFinite(n)) out[k] = n }
      else if (typeof base[k] === 'boolean') { if (typeof v === 'boolean') out[k] = v }
      else if (typeof base[k] === 'string') { if (typeof v === 'string') out[k] = v }
    }
    return out
  }

  /** 「设置里能写什么范围」只有这一份 —— HTTP 接口、dy_config、读配置三处都走它 */
  const clampPatch = (patch) => {
    const p = { ...patch }
    if ('perDay' in p) p.perDay = Math.max(0, Math.min(Number(p.perDay) || 0, 50))
    if ('commentPerRound' in p) p.commentPerRound = Math.max(0, Math.min(Number(p.commentPerRound) || 0, 20))
    if ('comfyWaitSeconds' in p) p.comfyWaitSeconds = Math.max(30, Math.min(Number(p.comfyWaitSeconds) || 900, 7200))
    if ('comfyListLimit' in p) p.comfyListLimit = Math.max(1, Math.min(Number(p.comfyListLimit) || 20, 200))
    if ('reportLevel' in p) p.reportLevel = ['full', 'brief', 'off'].includes(String(p.reportLevel)) ? String(p.reportLevel) : 'full'
    if ('personaPrompt' in p) p.personaPrompt = String(p.personaPrompt || '').slice(0, 4000)
    if ('memory' in p) p.memory = Boolean(p.memory)
    for (const k of ['peakValley', 'noon', 'night', 'autoLike', 'autoComment', 'autoPublish', 'overlayMcp', 'publishDraft']) {
      if (k in p) p[k] = Boolean(p[k])
    }
    if ('mentionName' in p) p.mentionName = String(p.mentionName || '').trim().slice(0, 60)
    if ('keywords' in p) p.keywords = Array.isArray(p.keywords) ? p.keywords.filter((x) => typeof x === 'string' && x.trim()).slice(0, 30) : []
    if ('comfyUrl' in p) p.comfyUrl = String(p.comfyUrl || '').trim().replace(/\/+$/, '')
    if ('comfyOutputDir' in p) p.comfyOutputDir = String(p.comfyOutputDir || '').trim()
    if ('comfyWorkflow' in p) p.comfyWorkflow = String(p.comfyWorkflow || '').slice(0, 400_000)
    if ('pythonPath' in p) p.pythonPath = String(p.pythonPath || 'python').trim()
    if ('cdpUrl' in p) p.cdpUrl = String(p.cdpUrl || '').trim().replace(/\/+$/, '')
    if ('commentPerDay' in p) p.commentPerDay = Math.max(0, Math.min(Number(p.commentPerDay) || 0, 50))
    if ('autoReply' in p) p.autoReply = Boolean(p.autoReply)
    if ('replyPerRun' in p) p.replyPerRun = Math.max(0, Math.min(Number(p.replyPerRun) || 0, 20))
    if ('replyPerDay' in p) p.replyPerDay = Math.max(0, Math.min(Number(p.replyPerDay) || 0, 1000))
    if ('replyRandom' in p) p.replyRandom = Boolean(p.replyRandom)
    if ('replyVideoIds' in p) p.replyVideoIds = String(p.replyVideoIds || '').replace(/[^0-9,\s]/g, '').slice(0, 400)
    if ('replyOneShot' in p) p.replyOneShot = Boolean(p.replyOneShot)
    if ('myNickname' in p) p.myNickname = String(p.myNickname || '').slice(0, 40)
    if ('replyIntervalMin' in p) p.replyIntervalMin = Math.max(5, Math.min(Number(p.replyIntervalMin) || 30, 1440))
    if ('replyOncePerUser' in p) p.replyOncePerUser = Boolean(p.replyOncePerUser)
    if ('skipLive' in p) p.skipLive = Boolean(p.skipLive)
    if ('shareNote' in p) p.shareNote = String(p.shareNote || '').slice(0, 80)
    if ('sharePerDay' in p) p.sharePerDay = Math.max(0, Math.min(Number(p.sharePerDay) || 0, 50))
    if ('pickPerRound' in p) p.pickPerRound = Math.max(1, Math.min(Number(p.pickPerRound) || 1, 5))
    if ('skipOverMin' in p) p.skipOverMin = Math.max(1, Math.min(Number(p.skipOverMin) || 60, 600))
    if ('skimOverMin' in p) p.skimOverMin = Math.max(1, Math.min(Number(p.skimOverMin) || 5, 120))
    if ('autoCommentPlain' in p) p.autoCommentPlain = Boolean(p.autoCommentPlain)
    if ('plainCommentPerDay' in p) p.plainCommentPerDay = Math.max(0, Math.min(Number(p.plainCommentPerDay) || 0, 30))
    if ('msgAllowTo' in p) p.msgAllowTo = String(p.msgAllowTo || '').slice(0, 200)
    if ('dmReply' in p) p.dmReply = Boolean(p.dmReply)
    if ('dmReplyPerContact' in p) p.dmReplyPerContact = Math.max(1, Math.min(Number(p.dmReplyPerContact) || 1, 10))
    if ('dmReplyPerDay' in p) p.dmReplyPerDay = Math.max(0, Math.min(Number(p.dmReplyPerDay) || 0, 100))
    if ('localRound' in p) p.localRound = Boolean(p.localRound)
    if ('askDoubao' in p) p.askDoubao = Boolean(p.askDoubao)
    if ('shareToNick' in p) p.shareToNick = String(p.shareToNick || '').slice(0, 40)
    if ('streakNick' in p) p.streakNick = String(p.streakNick || '').slice(0, 40)
    if ('streakPerDay' in p) p.streakPerDay = Math.max(0, Math.min(Number(p.streakPerDay) || 0, 20))
    if ('publishPerDay' in p) p.publishPerDay = Math.max(0, Math.min(Number(p.publishPerDay) || 0, 20))
    if ('publishTitle' in p) p.publishTitle = String(p.publishTitle || '').slice(0, 120)
    if ('publishTags' in p) p.publishTags = String(p.publishTags || '').slice(0, 200)
    if ('cdpPort' in p) p.cdpPort = Math.max(1024, Math.min(Number(p.cdpPort) || 9222, 65535))
    if ('chromePath' in p) p.chromePath = String(p.chromePath || '').trim()
    if ('dshBin' in p) p.dshBin = String(p.dshBin || '').trim()
    if ('headlessModel' in p) p.headlessModel = String(p.headlessModel || '').slice(0, 80)
    if ('headlessProfile' in p) p.headlessProfile = String(p.headlessProfile || 'headless').trim()
    if ('workspace' in p) p.workspace = String(p.workspace || '').trim()
    return p
  }

  let touchedKeys = (() => {
    try {
      const raw = readJson(cfgFile, {})
      if (Array.isArray(raw._set)) return new Set(raw._set)
      return new Set(Object.keys(DEFAULTS).filter((k) => k in raw && JSON.stringify(raw[k]) !== JSON.stringify(DEFAULTS[k])))
    } catch { return new Set() }
  })()

  let settingsRow = { at: 0, row: null }
  /**
   * 我们那一行设置表单（拿不到就返回 null ⇒ 一切按 config.json 来）。
   * ⚠️ DSH 自带的「插件设置」页不需要注册：describe() 自己扫带 volatile 字段的条目，
   *    ns 等于 loader 条目 id（`douyin-life`）。
   */
  const settingsDesc = (fresh = false) => {
    const t = Date.now()
    if (!fresh && t - settingsRow.at < 3000) return settingsRow.row
    let row = null
    try {
      const rows = ctx.settings?.describe?.() || []
      row = rows.find((r) => r?.value && 'perDay' in r.value && 'comfyOutputDir' in r.value) || null
    } catch (e) { log(`读 DSH 设置表单失败（不影响跑）：${e?.message ?? e}`) }
    settingsRow = { at: t, row }
    return row
  }

  const savedCfg = () => normalize(readJson(cfgFile, {}), { ...DEFAULTS })

  /**
   * 配置怎么合：**插件面板/config.json 存过的键 > DSH 原生设置页 > 默认值**。
   * （桌面版里 apply 收到的那份 config 是挂载时的快照，写进去的值不会热刷新 ⇒ 必须靠 describe() 的 value）
   */
  const loadCfg = () => {
    const saved = savedCfg()
    const row = settingsDesc()
    if (!row) return clampPatch(saved)
    const user = row.user || {}
    const out = normalize(row.value && typeof row.value === 'object' ? row.value : config, { ...DEFAULTS })
    const touched = new Set([
      ...touchedKeys,
      'pythonPath',   // 插件自己算出来的路径，不该被界面上的旧值压住
      ...Object.keys(DEFAULTS).filter((k) => JSON.stringify(saved[k]) !== JSON.stringify(DEFAULTS[k])),
    ])
    for (const k of Object.keys(DEFAULTS)) {
      if (touched.has(k)) { out[k] = saved[k]; continue }
      if (user[k] !== undefined) { out[k] = user[k]; continue }
      out[k] = saved[k]
    }
    return clampPatch(out)
  }

  const cfg = loadCfg()
  /** 配置随时可能被设置页改掉 ⇒ 每个入口用之前重算一遍（cfg 这个对象要一直指向同一份） */
  const refreshCfg = () => { try { Object.assign(cfg, loadCfg()) } catch (e) { log(`重读配置失败（沿用旧值）：${e?.message ?? e}`) } }

  const saveCfg = (patch) => {
    Object.assign(cfg, normalize(patch, cfg))
    for (const k of Object.keys(patch || {})) if (k in DEFAULTS) touchedKeys.add(k)
    writeJson(cfgFile, { ...cfg, _set: [...touchedKeys] })
  }

  const saveCfgHost = async (patch) => {
    if (typeof ctx.settings?.update !== 'function') return { ok: false, error: '宿主没有 settings.update' }
    try {
      const row = settingsDesc(true)
      if (!row?.ns) return { ok: false, error: '宿主里没有可写的设置表单（值只落在 config.json）' }
      await ctx.settings.update(row.ns, patch, row.revision)
      return { ok: true, ns: row.ns }
    } catch (e) {
      log(`写 DSH 设置失败（本地那份仍然生效）：${e?.message ?? e}`)
      return { ok: false, error: String(e?.message ?? e) }
    }
  }

  /** 落配置的唯一入口：插件自己那份 + DSH 原生设置那份，钳完范围一起写 */
  const persistCfg = async (patch) => {
    const clean = clampPatch(patch)
    saveCfg(clean)
    const host = await saveCfgHost(clean)
    return { clean, host }
  }

  /* ─────────────── Python / MCP ─────────────── */

  const venvPython = () => process.platform === 'win32'
    ? join(stateDir, '.venv', 'Scripts', 'python.exe')
    : join(stateDir, '.venv', 'bin', 'python')

  /**
   * Python 路径优先级（SPEC 关键约束）：
   *   config.pythonPath（显式填的） → 家里的 `.venv\Scripts\python.exe` → `uv` → `python`
   */
  const pythonNow = () => {
    const raw = String(cfg.pythonPath || '').trim()
    if (raw && raw !== 'python' && raw !== 'py') {
      if (/^uv$/i.test(raw) || /[\\/]uv(\.exe)?$/i.test(raw)) {
        return { command: raw, args: ['run', '--no-project', 'python'], via: 'uv' }
      }
      return { command: raw, args: [], via: 'config' }
    }
    const v = venvPython()
    if (existsSync(v)) return { command: v, args: [], via: 'venv' }
    return { command: 'python', args: [], via: 'path' }
  }

  /** 给所有 Python 子进程统一 UTF-8（Windows 默认 GBK，中文/emoji 一进管道就可能炸） */
  const pyEnv = (extra = {}) => ({
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    ...extra,
  })
  /** uv 的缓存/工具目录钉在插件家里（默认放 %LOCALAPPDATA% 时没权限就彻底装不动） */
  const uvEnv = (extra = {}) => pyEnv({
    UV_CACHE_DIR: join(stateDir, 'uv-cache'),
    UV_TOOL_DIR: join(stateDir, 'uv-tools'),
    UV_PYTHON_INSTALL_DIR: join(stateDir, 'uv-python'),
    ...extra,
  })

  let mcp = null
  let mcpKey = ''
  const mcpKeyNow = () => { const p = pythonNow(); return `${p.command}|${p.args.join(' ')}|${scriptPath}|${cfg.cdpUrl}` }

  const ensureMcp = async () => {
    if (mcp?.running && mcpKey === mcpKeyNow()) return mcp
    if (mcp) { try { mcp.stop() } catch { /* 已经没了 */ } mcp = null }
    if (!existsSync(scriptPath)) {
      throw new Error(`家里没有 mcp_server.py（应有 ${scriptPath}）—— 把 vendor/douyin-mcp/mcp_server.py 放好再重启一次 dsh；或者用 --force 让插件重铺`)
    }
    mcpKey = mcpKeyNow()
    try { mkdirSync(join(stateDir, '.tmp'), { recursive: true }) } catch { /* 建不了就让 Playwright 报 */ }
    const p = pythonNow()
    mcp = new McpClient({
      command: p.command,
      args: [...p.args, scriptPath],
      cwd: stateDir,      // 凭证 / 浏览器 profile 落在家里 ✓
      // ⭐ 家目录钉死（宿主与 Python 必须同一个）；CDP 给了就走「已登录的 Chrome」
      // ⭐ 2026-10-25：这台机器上系统 Temp 对子进程不放行，Playwright 的 mkdtemp 直接 EPERM。
      //    MCP 子进程也必须把 TEMP 指到家目录下，否则每个浏览器工具都起不来。
      env: uvEnv({
        DSH_DOUYIN_HOME: stateDir,
        DOUYIN_CDP_URL: String(cfg.cdpUrl || ''),
        TEMP: join(stateDir, '.tmp'),
        TMP: join(stateDir, '.tmp'),
        TMPDIR: join(stateDir, '.tmp'),
      }),
      log,
    })
    return mcp
  }

  const call = async (toolName, args, opts) => {
    const client = await ensureMcp()
    return client.call(toolName, args, opts)
  }

  /* ─────────────── 小工具 ─────────────── */

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }

  /** 工具返回值一律过这里：宿主只吃"无损 JSON" */
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }

  /** 日志里那一句话的结果摘要 */
  const brief = (v) => {
    try {
      if (v === null || v === undefined) return 'null'
      if (typeof v === 'string') return v.replace(/\s+/g, ' ').slice(0, 160)
      if (typeof v !== 'object') return String(v)
      if (v.blocked) return '被闸门挡住（blocked）'
      if (v.needLogin) return '需要登录（needLogin）'
      if (v.ok === false) return 'ok=false ' + String(v.error || v.hint || '').replace(/\s+/g, ' ').slice(0, 140)
      return 'ok=' + String(v.ok) + ' {' + Object.keys(v).slice(0, 6).join(',') + '}'
    } catch { return '?' }
  }

  /** 已注册的工具名（收尾日志和 selfcheck 都对得上） */
  const registeredTools = []
  /** 名字 → spec（设置页的按钮要复用工具的闸门/配额逻辑，别在 HTTP 层再写一遍） */
  const toolSpecs = new Map()
  const toolByName = (n) => toolSpecs.get(n) || { execute: async () => ({ ok: false, error: `没有 ${n} 这个工具` }) }

  /** 每条工具调用写一行 duty.log（时间 + 工具名 + 一句话结果），异常也兜住 */
  const tool = (spec) => {
    registeredTools.push(spec.name)
    toolSpecs.set(spec.name, spec)
    return ctx.tools.register(defineTool({
    ...spec,
    output: textOutput,
    async execute(args, exec) {
      let out
      try {
        out = await spec.execute(args && typeof args === 'object' ? args : {}, exec)
      } catch (e) {
        out = { ok: false, error: String(e?.message ?? e) }
        log(`工具 ${spec.name} 抛错（已兜住）：${e?.stack ?? e}`)
      }
      try { log(`工具 ${spec.name} → ${brief(out)}`) } catch { /* 日志失败不影响结果 */ }
      return safe(out)
    },
    }))
  }

  /* ─────────────── 家目录里的状态 ─────────────── */

  const readState = () => {
    const st = readJson(stateFile, {})
    return st && typeof st === 'object' ? st : {}
  }
  const bumpState = (patch) => {
    const st = readState()
    const today = dayKey()
    if (st.day !== today) { st.day = today; st.count = 0; st.picked = 0; st.windows = {} }
    const next = { ...st, ...patch }
    writeJson(stateFile, next)
    return next
  }

  const reportFileOf = (now = new Date()) => join(outDir, `${dayKey(now)}.md`)

  /** 今天挑了几条：数今天报告里 `### <视频id>` 那种标题行（围栏里的不算） */
  const PICK_RE = /^###[ \t]+(\d{6,})/gm
  const countPicks = (file) => {
    try {
      const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '')
      const ids = new Set()
      for (const m of text.matchAll(PICK_RE)) ids.add(m[1])
      return ids.size
    } catch { return 0 }
  }
  const countPickedToday = (now = new Date()) => {
    const st = readState()
    const fromState = st.day === dayKey(now) ? Number(st.picked || 0) : 0
    return Math.max(fromState, countPicks(reportFileOf(now)))
  }
  const roundsToday = (now = new Date()) => {
    const st = readState()
    return st.day === dayKey(now) ? Number(st.count || 0) : 0
  }

  /** 登录态是"上次查到的"，dy_status 不为了它去起 Python */
  const hasLogin = () => readState().loggedIn === true

  /* ─────────────── 账本：真发出去的东西（防重复、防超量） ─────────────── */
  // 使用者 2026-10-23 说「还会自己发评论和发视频，这个也要做进去」——
  // 那就必须记住"发过什么"，不然一轮跑两遍会把同一条视频投两次、把同一句话刷两遍。
  const ledgerFile = join(stateDir, 'ledger.json')
  const readLedger = () => {
    const j = readJson(ledgerFile, {})
    const published = j && typeof j.published === 'object' && j.published ? j.published : {}
    const comments = Array.isArray(j?.comments) ? j.comments : []
    const replies = j && typeof j.replies === 'object' && j.replies ? j.replies : {}
    return { published, comments, replies }
  }
  const writeLedger = (v) => writeJson(ledgerFile, v)
  const videoKey = (p) => {
    try { const st = statSync(p); return `${p}|${st.size}|${Math.round(st.mtimeMs)}` } catch { return String(p) }
  }
  const commentsToday = (now = new Date()) => readLedger().comments.filter((c) => c.day === dayKey(now)).length
  const publishedToday = (now = new Date()) => Object.values(readLedger().published).filter((p) => p && p.day === dayKey(now)).length
  const lastPublished = () => {
    const list = Object.values(readLedger().published).filter(Boolean)
    list.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    return list[0] || null
  }
  const noteComment = (rec) => {
    const l = readLedger()
    l.comments.push({ day: dayKey(), at: new Date().toISOString(), ...rec })
    l.comments = l.comments.slice(-500)
    writeLedger(l)
  }
  /* ── 回自己视频下的评论（随机读、限量回） ───────────────────────── */
  const SENSITIVE_WORDS = ['政治', '政府', '领导人', '主席', '总统', '选举', '游行', '抗议', '民族', '宗教', '邪教',
    '病', '癌', '药', '治疗', '诊断', '自杀', '抑郁', '起诉', '律师', '判', '违法', '坐牢', '报案',
    '身份证', '住址', '手机号', '人肉', '开盒', '社工', '裸', '色情', '约炮', '包养', '赌博', '博彩',
    '洗钱', '跑分', '股票', '荐股', '基金', '炒币', '贷款', '套现', '返利', '破解', '外挂', '盗号', '黑产', '刷单', '代考']
  const plainCommentsToday = (now = new Date()) => Object.values(readLedger().plainComments || {})
    .filter((r) => r && r.day === dayKey(now)).length
  const notePlainComment = (awemeId, text) => {
    const l = readLedger()
    l.plainComments = l.plainComments || {}
    l.plainComments[String(awemeId)] = { day: dayKey(), at: new Date().toISOString(), text: String(text).slice(0, 40) }
    writeLedger(l)
  }
  /** 表情包关键词：什么话配什么表情（只有「大肥鱼」系列是现成的） */
  const pickStickerKeyword = (note) => {
    const s = String(note || '')
    if (/好看|颜值|太好看了/.test(s)) return '大肥鱼'
    if (/总结|讲|收获|有用/.test(s)) return '大肥鱼'
    if (/笑|哈哈|笑死/.test(s)) return '大肥鱼'
    return '大肥鱼'
  }
  const sentBrief = (r) => {
    const arr = Array.isArray(r?.sent) ? r.sent : []
    return arr.join(' / ').slice(0, 40) || 'ok'
  }
  const makeMentionComment = (video, mention) => {
    const raw = String(video?.title || '').replace(/\s+/g, ' ').trim()
    const short = raw.length > 18 ? raw.slice(0, 18) + '…' : raw
    const pool = [
      `这条「${short}」好看，${mention} 你也看看[比心]`,
      `刚看完「${short}」，${mention} 你应该会喜欢[笑哭]`,
      `「${short}」这个真的可以，${mention} 你来看看[赞]`,
    ]
    return pool[Math.floor(Math.random() * pool.length)]
  }

  /** 看完再评论：拿标题 +（有的话）热评，说清这条讲了啥，比「说得对」像人 */
  const makePlainComment = (video, topComment) => {
    const skim = Boolean(video?.skim)
    const raw = String(video?.title || '').replace(/\s+/g, ' ').trim()
    const short = raw.length > 20 ? raw.slice(0, 20) + '…' : raw
    const tag = String(topComment || '').replace(/\s+/g, ' ').slice(0, 14)
    const pool = []
    if (short) {
      pool.push(`这条讲「${short}」，看完比想象中讲得清楚[比心]`)
      pool.push(`刚看完「${short}」，中间那段确实有意思[笑哭]`)
      if (tag) pool.push(`「${short}」看完最有感的是评论区那句「${tag}」[憨笑]`)
      pool.push(`「${short}」这个我还真看完了一遍，挺值[赞]`)
    }
    if (skim) {
      pool.push(`这条 ${Math.round(Number(video?.mins) || 0)} 分钟，我跳着看了几段，重点都在后半段[比心]`)
      pool.push(`太长了，跳着看完了「${short}」，中间那段最值[憨笑]`)
    } else {
      pool.push('这条我一路看完了，比标题写得好[笑哭]', '笑死我了，看到一半就忍不住了[捂脸]')
    }
    return pool[Math.floor(Math.random() * pool.length)]
  }

  /** 普通评论（不@人）用的短句 */
  const PLAIN_COMMENTS = [
    '这条我笑了[笑哭]', '讲得挺好[比心]', '学到了[憨笑]', '这个真不错[赞]',
    '看完心情好了[微笑]', '有点东西[比心]', '刚刷到就看完了[笑哭]', '说得对[赞]',
  ]

  const sharesToday = (now = new Date()) => Object.values(readLedger().shares || {})
    .filter((r) => r && r.day === dayKey(now)).length
  const noteShare = (awemeId, rec) => {
    const l = readLedger()
    l.shares = l.shares || {}
    l.shares[String(awemeId)] = { day: dayKey(), at: new Date().toISOString(), ...rec }
    writeLedger(l)
  }

  const repliesToday = (now = new Date()) => Object.values(readLedger().replies || {})
    .filter((r) => r && r.day === dayKey(now)).length
  /** 回过的 cid 索引（一行一个，只有宿主导入；不进模型上下文，所以不费 token） */
  const replyIndexFile = join(stateDir, 'replied-cids.txt')
  const readReplyIndex = () => {
    try {
      return new Set(readFileSync(replyIndexFile, 'utf8').split(/\r?\n/).filter(Boolean))
    } catch { return new Set() }
  }
  const appendReplyIndex = (cid) => {
    try { appendFileSync(replyIndexFile, String(cid) + '\n', 'utf8') } catch { /* 记不上不影响去重 */ }
  }
  /** 账本按「年/月/日」归档：主账本只留**今天**，往前的按 ledger/YYYY/MM/DD.json 存
   *  使用者 2026-10-24 要求：年文件夹 → 月文件夹 → 日文件
   */
  const dayFilePath = (day) => {
    const d = String(day || dayKey()).slice(0, 10)
    const [y, m, dd] = d.split('-')
    return join(stateDir, 'ledger', y, m, `${dd}.json`)
  }
  const moveToDayFile = (day, replies, comments) => {
    try {
      const fp = dayFilePath(day)
      mkdirSync(join(fp, '..'), { recursive: true })
      const prev = existsSync(fp) ? readJson(fp, {}) : {}
      writeJson(fp, {
        day,
        replies: { ...(prev.replies || {}), ...replies },
        comments: [...(prev.comments || []), ...comments],
      })
      return true
    } catch (e) {
      log('按日归档失败：' + String(e?.message ?? e))
      return false
    }
  }
  const pruneLedger = (l) => {
    const today = dayKey()
    const byDay = new Map()
    for (const [cid, rec] of Object.entries(l.replies || {})) {
      const d = String(rec?.day || today).slice(0, 10)
      if (d === today) continue
      if (!byDay.has(d)) byDay.set(d, { replies: {}, comments: [] })
      byDay.get(d).replies[cid] = rec
      delete l.replies[cid]
    }
    const keep = []
    for (const c of l.comments || []) {
      const d = String(c?.day || today).slice(0, 10)
      if (d === today) { keep.push(c); continue }
      if (!byDay.has(d)) byDay.set(d, { replies: {}, comments: [] })
      byDay.get(d).comments.push(c)
    }
    l.comments = keep
    for (const [d, bucket] of byDay) moveToDayFile(d, bucket.replies, bucket.comments)
    return l
  }
  const repliedCids = () => new Set([...readReplyIndex(), ...Object.keys(readLedger().replies || {})])
  /** 回过谁（昵称归一化）+ 索引文件，给「同一个人只回一次」用 */
  const normUser = (u) => String(u || '').replace(/[\s（）()【】]/g, '').toLowerCase()
  const repliedUsersFile = join(stateDir, 'replied-users.txt')
  const readRepliedUsers = () => {
    const s = new Set()
    try {
      for (const line of readFileSync(repliedUsersFile, 'utf8').split(/\r?\n/)) if (line.trim()) s.add(line.trim())
    } catch { /* 没文件 */ }
    for (const r of Object.values(readLedger().replies || {})) if (r?.user) s.add(normUser(r.user))
    return s
  }
  const appendRepliedUser = (user) => {
    const n = normUser(user)
    if (!n) return
    try { appendFileSync(repliedUsersFile, n + '\n', 'utf8') } catch { /* 记不上不影响 */ }
  }
  /** 我自己在抖音的昵称（用来跳过"我自己的评论/我自己的回复"） */
  const myNames = () => {
    const raw = [String(cfg.myNickname || ''), '大白鲸', '大白鲸（爱吃白饭版）', '大白鲸爱吃白饭版']
    return new Set(raw.map((s) => s.replace(/[\s（）()【】]/g, '')).filter(Boolean))
  }
  const isMine = (user) => {
    const norm = String(user || '').replace(/[\s（）()【】]/g, '')
    if (!norm) return false
    for (const n of myNames()) if (norm.includes(n) || n.includes(norm)) return true
    return false
  }
  /** 我回过的句子（用来兜底：万一账本丢了，看到自己那句就不再回） */
  const myReplyTexts = () => new Set(Object.values(readLedger().replies || {}).map((r) => String(r?.text || '').trim()).filter(Boolean))
  const noteReply = (cid, rec) => {
    const l = readLedger()
    l.replies = l.replies || {}
    l.replies[String(cid)] = { day: dayKey(), at: new Date().toISOString(), ...rec }
    writeLedger(pruneLedger(l))
    appendReplyIndex(cid)
  }
  /** 今天发过的作品 id（只有当日发布的才回；过了当天就不碰）
   *  来源：抖音站内 /aweme/post（登录态）→ 按 create_time 过滤今天
   *  退路：配置里手填的 replyVideoIds（当你就是想固定回某几条时）
   */
  const todayVideoIds = async () => {
    // 「只回当日发布」：站内接口按 create_time 过滤今天
    let ids = []
    let titles = []
    let source = 'none'
    try {
      const r = await call('douyin_my_posts', { days: 1 }, { timeoutMs: 90_000 })
      const list = Array.isArray(r?.items) ? r.items : []
      ids = list.map((x) => String(x.aweme_id || '')).filter(Boolean)
      titles = list.map((x) => x.title)
      if (ids.length) source = 'douyin_my_posts'
    } catch (e) {
      log('取今日作品失败：' + String(e?.message ?? e))
    }
    // ⭐ 额外允许的视频（比如「昨天那条也算今天」）：
    //    ① <家>/reply-allow.txt 一行一个 id —— 文件在就一直生效（重启也不丢，不依赖配置字段）
    //    ② 设置里「要回的自己的视频 id」—— 一次性/长期看 replyOneShot
    let fileExtras = []
    try {
      const fp = join(stateDir, 'reply-allow.txt')
      if (existsSync(fp)) {
        fileExtras = readFileSync(fp, 'utf8').split(/[^0-9]+/).map((s) => s.trim()).filter((s) => s.length >= 6)
      }
    } catch { /* 没文件就算了 */ }
    const cfgExtras = String(cfg.replyVideoIds || '').split(/[^0-9]+/).map((s) => s.trim()).filter((s) => s.length >= 6)
    const extras = [...new Set([...fileExtras, ...cfgExtras])]
    if (extras.length) {
      source = source === 'none' ? 'replyVideoIds' : source + '+replyVideoIds'
      ids = [...new Set([...ids, ...extras])]
    }
    return { ids, source, titles, extras }
  }
  const myVideoIds = () => {
    const fromCfg = String(cfg.replyVideoIds || '').split(/[^0-9]+/).map((s) => s.trim()).filter((s) => s.length >= 6)
    const fromLedger = Object.values(readLedger().published || {}).map((p) => String(p?.awemeId || p?.video_id || '')).filter(Boolean)
    return [...new Set([...fromCfg, ...fromLedger])]
  }
  /** 转发时配的那句话：按视频类型变——
   *   · 好看/娱乐的 ⇒ 直接夸「好好看，给我看」
   *   · 知识/干货的 ⇒ 说清它讲了什么 + 感觉有用
   *   · 其它 ⇒ 随口一句吐槽
   *  设置里填了 shareNote 就按你写的发。
   */
  const makeShareNote = (video) => {
    const skim = Boolean(video?.skim)
    const fixed = String(cfg.shareNote || '').trim()
    if (fixed) return fixed
    const raw = String(video?.title || '').replace(/\s+/g, ' ').trim()
    const short = raw.length > 26 ? raw.slice(0, 26) + '…' : raw
    const kw = (s) => raw.includes(s)
    const know = ['知识', '教程', '讲解', '解析', '科普', '课程', '习题', '考研', '入门', '实战',
      '原理', '源码', '框架', '教学', '精讲', '干货', '方法论', '如何', '怎么', '技巧', '复盘']
      .some(kw)
    const pretty = ['好看', '颜值', '舞蹈', '翻唱', '剧情', '短片', 'MV', '摄影', '穿搭', 'cos', 'cosplay']
      .some(kw)
    const fun = ['搞笑', '沙雕', '整活', '段子', '笑死', '沙雕', '游戏', '王者', '三角洲', '萌宠', '猫', '狗']
      .some(kw)

    if (skim && short) {
      return [`这条 ${Math.round(Number(video?.mins) || 0)} 分钟，我跳着看了，重点在「${short}」这段[比心]`,
        `太长没细看，跳着扫了一遍：${short}，你可以挑着看[憨笑]`][Math.floor(Math.random() * 2)]
    }
    if (know) {
      const pool = short
        ? [`这期讲「${short}」，感觉挺有用的[比心]`,
           `总结一下：${short}。看完有点收获[憨笑]`,
           `这个视频把「${short}」讲清楚了，你可以看看[微笑]`]
        : ['这条挺干货的，感觉有用[比心]']
      return pool[Math.floor(Math.random() * pool.length)]
    }
    if (pretty || fun) {
      const pool = ['好好看，给我看[比心]', '这个太好看了，你也看看[笑哭]',
        '刷到这个就想到你，好看[害羞]', '好看！这个必须给你看[比心]']
      return pool[Math.floor(Math.random() * pool.length)]
    }
    const other = ['这个视频好好笑，主人你也看看，哈哈哈[笑哭]', '笑死我了[捂脸]你也来看看',
      '刚刷到这个，觉得你会喜欢[比心]', '这条真的有点东西，你看看']
    return other[Math.floor(Math.random() * other.length)]
  }

  /** 这个人允不允许我「主动」发消息（白名单，空=谁都不许）；回复别人的消息不走这个 */
  const allowInitiate = (name) => {
    const list = String(cfg.msgAllowTo || '').split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean)
    if (!list.length) return false
    const key = String(name || '').replace(/\s+/g, '').slice(0, 4)
    return list.some((n) => String(n).replace(/\s+/g, '').slice(0, 4) === key)
  }

  const shuffle = (arr) => {
    const a = [...arr]
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }
  /** 一句回复（≤20 字）：敏感话题婉拒；其余带点人味，可以挂一个抖音表情
   *  表情用抖音的文本码（[憨笑] [笑哭] …），一条最多一个，别堆。
   */
  const EMOJIS = ['[憨笑]', '[笑哭]', '[捂脸]', '[比心]', '[害羞]', '[赞]', '[微笑]']
  const pickEmoji = () => (Math.random() < 0.65 ? EMOJIS[Math.floor(Math.random() * EMOJIS.length)] : '')
  const pickReply = (comment) => {
    const c = String(comment || '').trim()
    if (SENSITIVE_WORDS.some((k) => c.includes(k))) {
      return { text: '这个我不太方便聊，换个话题吧。', sensitive: true }
    }
    const e = pickEmoji()
    let t
    if (/[?？]|怎么|为什么|能不能|有没有|求/.test(c)) t = `这个我也说不好${e || '，回头细说'}`
    else if (/谢谢|感谢|爱你|喜欢|好可爱|太棒|厉害/.test(c)) t = `谢谢喜欢～${e}`
    else if (/哈哈|笑死|草|绝了/.test(c)) t = `哈哈哈你抓到重点了${e}`
    else if (/更新|什么时候|催|快更/.test(c)) t = `在弄了在弄了${e || '，别催'}`
    else if (/回我|理我|在吗|说话/.test(c)) t = `在的在的${e}`
    else t = [`我懂你意思${e}`, `这条我看完了${e}`, `嗯…你说得对${e || ''}`, `收到，记下了${e}`][Math.floor(Math.random() * 4)]
    t = String(t).trim()
    if (!t) t = '收到[微笑]'
    if (t.length > 20) {
      const cut = t.slice(0, 20)
      const m = cut.match(/^.*[，。！？~、,.!?]/)
      t = (m ? m[0] : cut).replace(/[，。、]$/, '').slice(0, 20)
    }
    return { text: t, sensitive: false, emoji: Boolean(e) }
  }

  /** 回一轮：随机挑视频 → 读该视频评论 → 跳过已回过的 → 回 N 条 */
  const replyRound = async ({ count, random } = {}) => {
    const perDay = Math.max(0, Number(cfg.replyPerDay) || 0)
    const today = repliesToday()
    if (!perDay) return { ok: false, error: '「每天最多回」是 0 ⇒ 不回', today, perDay }
    if (today >= perDay) return { ok: false, error: '今天已经回满了', today, perDay }
    const want = Math.max(1, Math.min(Number(count) || Number(cfg.replyPerRun) || 3, perDay - today, 10))
    const rand = random === undefined ? Boolean(cfg.replyRandom) : Boolean(random)
    const got = await todayVideoIds()
    const vids = got.ids
    if (!vids.length) {
      return { ok: false, error: '今天还没有发过视频（只回当日发布的）；要固定回某几条，可在「要回的自己的视频 id」里填', today, perDay, source: got.source }
    }
    const order = rand ? shuffle(vids) : vids
    const doneCids = repliedCids()
    const out = []
    for (const v of order) {
      if (out.filter((x) => x.sent).length >= want) break
      let list = []
      try {
        const r = await call('douyin_comments', { aweme_id: v, num: 20, compact: true, exclude_cids: [...doneCids].slice(-300) }, { timeoutMs: 120_000 })
        list = Array.isArray(r?.items) ? r.items : []
      } catch (e) {
        out.push({ aweme_id: v, ok: false, error: String(e?.message ?? e) })
        continue
      }
      const myTexts = myReplyTexts()
      const repliedUsers = cfg.replyOncePerUser ? readRepliedUsers() : new Set()
      const seenThisRound = new Set()
      let fresh = list.filter((c) => {
        if (!c || !c.cid) return false
        const cid = String(c.cid)
        if (doneCids.has(cid) || seenThisRound.has(cid)) return false
        if (isMine(c.user)) return false                       // 我自己发的评论/回复
        if (cfg.replyOncePerUser && repliedUsers.has(normUser(c.user))) return false  // 同一个人只回一次（默认关）
        const txt = String(c.text || '').trim()
        if (myTexts.has(txt)) return false                      // 兜底：那是我回过的句子
        const rec = readLedger().replies?.[cid]
        if (rec && rec.ok === false && Number(rec.attempts || 0) >= 2) return false  // 失败两次别死磕
        seenThisRound.add(cid)
        return true
      })
      if (!fresh.length) { out.push({ aweme_id: v, ok: true, skipped: '这个视频没有新评论' }); continue }
      if (rand) fresh = shuffle(fresh)
      for (const c of fresh.slice(0, Math.max(1, want - out.filter((x) => x.sent).length))) {
        const { text, sensitive } = pickReply(c.text)
        try {
          const r = await call('douyin_comment', { aweme_id: v, text, reply_cid: String(c.cid), mention: '' }, { timeoutMs: 150_000 })
          const okk = r && r.ok !== false && r.needLogin !== true
          const prev = (readLedger().replies || {})[String(c.cid)] || {}
          noteReply(c.cid, { aweme_id: v, user: String(c.user || ''), text, sensitive, ok: okk, attempts: Number(prev.attempts || 0) + 1, comment: String(c.text || '').slice(0, 60) })
          if (okk) appendRepliedUser(c.user)
          out.push({ aweme_id: v, cid: String(c.cid), comment: String(c.text || '').slice(0, 40), reply: text, sensitive, sent: okk, error: okk ? undefined : (r?.error || '没发出去') })
        } catch (e) {
          const prev2 = (readLedger().replies || {})[String(c.cid)] || {}
          noteReply(c.cid, { aweme_id: v, text, sensitive, ok: false, attempts: Number(prev2.attempts || 0) + 1, error: String(e?.message ?? e).slice(0, 80) })
          out.push({ aweme_id: v, cid: String(c.cid), reply: text, sent: false, error: String(e?.message ?? e) })
        }
      }
    }
    // 一次性附加 id 用完即清（只限这一次）
    if ((got.extras || []).length && cfg.replyOneShot === true) {
      try {
        cfg.replyVideoIds = ''
        saveCfg({ replyVideoIds: '' })
        appendMemory(`回评论用过一次性 id：${got.extras.join(',')}（已清空，只算这一次）`)
        out.push({ note: '一次性 id 已清空：' + got.extras.join(',') })
      } catch (e) { log('清空一次性 id 失败：' + String(e?.message ?? e)) }
    }
    const sent = out.filter((x) => x.sent).length
    log(`回评论一轮：今日作品 ${vids.length} 条（来源 ${got.source}），想回 ${want} 条，实际发出 ${sent} 条`)
    return { ok: true, want, sent, today: repliesToday(), perDay, videos: vids, source: got.source, titles: got.titles, items: out }
  }

  const notePublish = (key, rec) => {
    const l = readLedger()
    l.published[key] = { day: dayKey(), at: new Date().toISOString(), ...rec }
    writeLedger(l)
  }

  /* ─────────────── 记忆：每天刷到的都攒着 ─────────────── */
  // 使用者 2026-10-23：「我希望你每天刷的视频、读的评论感悟都会记住」——
  // 正式的记忆系统他后面做；这里先落一层朴素的：<家>/memory/YYYY-MM.md，一行一条，
  // 下一轮开头把最近几十行喂给自己，至少"接得上话"。
  const memDir = join(stateDir, 'memory')
  const memFileOf = (now = new Date()) => join(memDir, `${dayKey(now).slice(0, 7)}.md`)
  const readMemory = (maxLines = 60) => {
    try {
      const files = readdirSync(memDir).filter((f) => /^\d{4}-\d{2}\.md$/.test(f)).sort()
      const last = files.slice(-2)
      const lines = []
      for (const f of last) {
        try {
          const text = readFileSync(join(memDir, f), 'utf8')
          for (const line of text.split('\n')) if (line.trim()) lines.push(line.trim())
        } catch { /* 单月读不到就算了 */ }
      }
      return lines.slice(-maxLines)
    } catch { return [] }
  }
  const appendMemory = (line) => {
    try {
      mkdirSync(memDir, { recursive: true })
      appendFileSync(memFileOf(), line.endsWith('\n') ? line : line + '\n', 'utf8')
    } catch { /* 记不上也不影响这一轮 */ }
  }

  const markLogin = (loggedIn, extra = {}) => {
    try { bumpState({ loggedIn: Boolean(loggedIn), loginCheckedAt: new Date().toISOString(), ...extra }) } catch { /* 记不上就算了 */ }
  }

  const nextWindowInfo = (now = new Date()) => {
    let best = null
    for (const k of ['noon', 'night']) {
      if (!cfg[k]) continue
      const w = WINDOWS[k]
      if (inWindow(now, w)) return { window: k, label: w.label, start: w.start, end: w.end, opening: true, inMinutes: 0 }
      const [h, m] = String(w.start).split(':').map(Number)
      const t = new Date(now)
      t.setHours(h || 0, m || 0, 0, 0)
      if (t <= now) t.setDate(t.getDate() + 1)
      const mins = Math.round((t.getTime() - now.getTime()) / 60000)
      if (!best || mins < best.inMinutes) {
        best = { window: k, label: w.label, start: w.start, end: w.end, opening: false, inMinutes: mins, at: t.toISOString() }
      }
    }
    return best || { window: null, opening: false, hint: '两个窗口都关着（或者峰谷总开关关着）' }
  }

  /* ─────────────── Chrome / CDP（复用"已经登录的 Chrome"） ─────────────── */

  const cdpBase = () => String(cfg.cdpUrl || '').trim().replace(/\/+$/, '')

  /** CDP 端口现在通不通（顺带能看出用的是哪个浏览器） */
  const cdpProbe = async (timeoutMs = 1500) => {
    const base = cdpBase()
    if (!base) return { ok: false, url: '', hint: 'cdpUrl 是空的 ⇒ 走插件自己的持久 profile（首次要扫码）' }
    try {
      const res = await fetch(base + '/json/version', { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) return { ok: false, url: base, error: `HTTP ${res.status}` }
      const info = await res.json()
      return { ok: true, url: base, browser: String(info?.Browser || ''), ws: String(info?.webSocketDebuggerUrl || '') }
    } catch (e) {
      return { ok: false, url: base, error: String(e?.message ?? e), hint: 'Chrome 没带调试端口在跑：调 dy_chrome_open（先全关 Chrome）' }
    }
  }

  /** 常见安装位置 + 注册表式路径探测 */
  const chromeNow = () => {
    const explicit = String(cfg.chromePath || '').trim()
    if (explicit && existsSync(explicit)) return { path: explicit, via: 'config' }
    const cands = process.platform === 'win32'
      ? [
          join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(process.env.LOCALAPPDATA || '', 'Chromium', 'Application', 'chrome.exe'),
          join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ]
      : ['/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium']
    for (const p of cands) { if (p && existsSync(p)) return { path: p, via: 'probe' } }
    return { path: '', via: 'none' }
  }

  /** 默认 user-data-dir（默认 profile 里就是本人已经登录的那个抖音） */
  const chromeUserDataDir = () => process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data')
    : process.platform === 'darwin'
      ? join(process.env.HOME || '', 'Library', 'Application Support', 'Google', 'Chrome')
      : join(process.env.HOME || '', '.config', 'google-chrome')

  const chromeRunning = () => {
    try {
      const req = createRequire(import.meta.url)
      const { execFileSync } = req('node:child_process')
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], { encoding: 'utf8', timeout: 5000 })
      return /chrome\.exe/i.test(out)
    } catch { return false }
  }

  const openChromeWithCdp = async () => {
    const port = Math.max(1024, Math.min(Number(cfg.cdpPort) || 9222, 65535))
    const before = await cdpProbe(1200)
    if (before.ok) return { ok: true, already: true, ...before, hint: 'CDP 端口本来就通，直接用' }
    const exe = chromeNow()
    if (!exe.path) return { ok: false, error: '没找到 Chrome', hint: '在设置里把 chromePath 指到 chrome.exe' }
    if (chromeRunning()) {
      return {
        ok: false,
        needClose: true,
        chrome: exe.path,
        hint: 'Chrome 正在跑，带着同一个默认 profile 再拉一次不会开调试端口。先把所有 Chrome 窗口关掉（确认托盘/后台也没了），再调一次 dy_chrome_open。',
        command: `"${exe.path}" --remote-debugging-port=${port}`,
      }
    }
    const args = [`--remote-debugging-port=${port}`, '--remote-allow-origins=*', '--no-first-run', '--no-default-browser-check']
    const udd = chromeUserDataDir()
    if (udd && existsSync(udd)) args.push(`--user-data-dir=${udd}`)
    try {
      const child = spawn(exe.path, args, { detached: true, stdio: 'ignore', windowsHide: false })
      child.unref()
      log(`拉 Chrome：${exe.path} --remote-debugging-port=${port}`)
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e), chrome: exe.path }
    }
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      await sleep(700)
      const probe = await cdpProbe(1200)
      if (probe.ok) return { ok: true, started: true, chrome: exe.path, userDataDir: udd, ...probe }
    }
    return { ok: false, error: '20s 内 CDP 端口没起来', chrome: exe.path, url: cdpBase() }
  }

  /* ─────────────── ComfyUI 桥（纯 HTTP） ─────────────── */

  const comfyBase = () => String(cfg.comfyUrl || '').trim().replace(/\/+$/, '')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /** 递归找 .mp4，按 mtime 从新到旧（ComfyUI 的 output 目录常有子目录） */
  const listVideos = (limit) => {
    const root = String(cfg.comfyOutputDir || '').trim()
    const found = []
    const walk = (dir, depth) => {
      if (depth > 6 || found.length > 20000) return
      let ents = []
      try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const d of ents) {
        const p = join(dir, d.name)
        if (d.isDirectory()) { walk(p, depth + 1); continue }
        if (!/\.mp4$/i.test(d.name)) continue
        let st = null
        try { st = statSync(p) } catch { continue }
        found.push({ path: p, name: d.name, size: st.size, mtime: st.mtimeMs, mtimeText: new Date(st.mtimeMs).toISOString() })
      }
    }
    if (root) walk(root, 0)
    found.sort((a, b) => b.mtime - a.mtime)
    const n = Math.max(1, Math.min(Number(limit) || Number(cfg.comfyListLimit) || 20, 200))
    return {
      dir: root,
      exists: Boolean(root) && existsSync(root),
      total: found.length,
      items: found.slice(0, n),
    }
  }

  const comfyFetch = async (path, init = {}, timeoutMs = 15000) => {
    const url = comfyBase() + path
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    if (!res.ok) throw new Error(`ComfyUI ${path} → HTTP ${res.status} ${String(text).slice(0, 200)}`)
    return json ?? text
  }

  /** 可选：先排队一份 workflow，等它出片（只排队和读文件，不做转码） */
  const runComfyWorkflow = async () => {
    const raw = String(cfg.comfyWorkflow || '').trim()
    if (!raw) return { ok: false, skipped: true, hint: '没配 comfyWorkflow ⇒ 直接取输出目录里最新的成片' }
    let wf = null
    let source = 'inline'
    if (!/^[[{]/.test(raw) && existsSync(raw)) {
      wf = JSON.parse(readFileSync(raw, 'utf8'))
      source = raw
    } else {
      wf = JSON.parse(raw)
    }
    const prompt = wf && typeof wf === 'object' && wf.prompt && typeof wf.prompt === 'object' ? wf.prompt : wf
    const r = await comfyFetch('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: 'dsh-douyin-life' }),
    }, 20000)
    const id = String(r?.prompt_id || r?.id || '')
    if (!id) throw new Error('ComfyUI 没返回 prompt_id：' + JSON.stringify(r).slice(0, 200))
    log(`ComfyUI 已排队（prompt_id=${id}），等出片…`)
    const waitMs = Math.max(30, Number(cfg.comfyWaitSeconds) || 900) * 1000
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      await sleep(2000)
      let h = null
      try { h = await comfyFetch('/history/' + encodeURIComponent(id), {}, 15000) } catch { continue }
      if (!h || typeof h !== 'object' || !Object.keys(h).length) continue
      const entry = h[id] || Object.values(h)[0] || {}
      const status = entry.status || {}
      const msgs = Array.isArray(status.messages) ? status.messages : []
      if (status.status_str === 'error' || msgs.some((m) => Array.isArray(m) && m[0] === 'error')) {
        throw new Error('ComfyUI 执行出错：' + JSON.stringify(status).slice(0, 300))
      }
      if (status.completed === true || status.status_str === 'success') {
        log(`ComfyUI 出片完成（prompt_id=${id}）`)
        return { ok: true, promptId: id, source }
      }
    }
    throw new Error(`等 ComfyUI 出片超时（${Number(cfg.comfyWaitSeconds) || 900}s）—— 它可能还在排队，或者显卡正忙`)
  }

  /* ─────────────── dsh 在哪（跑一轮要用） ─────────────── */

  const findDshCli = () => {
    const explicit = String(cfg.dshBin || '').trim()
    if (explicit && existsSync(explicit)) return explicit
    try {
      const req = createRequire(import.meta.url)
      for (const spec of ['@deepseek-ai/dsh/lib/bin.js', '@deepseek-ai/dsh']) {
        try { const p = req.resolve(spec); if (p && existsSync(p)) return p } catch { /* 换下一个 */ }
      }
    } catch { /* 解析器不可用就跳过 */ }
    for (const g of [
      join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      join(process.env.ProgramFiles || '', 'nodejs', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
      '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    ].filter(Boolean)) if (existsSync(g)) return g
    // ⭐ 2026-10-25：新版把 dsh 打进 app.asar（磁盘上没有 @deepseek-ai/dsh 这个目录了），
    //    但 Electron 主进程能直接读到 asar 内的路径 ⇒ 直接试这几个。
    for (const rel of [
      join('app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      join('app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      join('app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    ]) {
      const base = process.resourcesPath || (() => { try { return join(dirname(process.execPath), 'resources') } catch { return '' } })()
      if (!base) continue
      const full = join(base, rel)
      try { if (existsSync(full)) return full } catch { /* 读不到就跳过 */ }
    }
    const roots = []
    if (process.resourcesPath) roots.push(process.resourcesPath)
    try { roots.push(join(dirname(process.execPath), 'resources')) } catch { /* 没有就算了 */ }
    const tried = []
    for (const root of roots) {
      if (!root || tried.includes(root) || !existsSync(root)) continue
      tried.push(root)
      const hit = scanForDsh(root, 0, { n: 0 })
      if (hit) return hit
    }
    return ''
  }
  // 有界递归：深度 ≤ 7、最多翻 4000 个目录
  const scanForDsh = (dir, depth, budget) => {
    if (depth > 7 || budget.n > 4000) return ''
    let ents = []
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return '' }
    for (const d of ents) {
      if (!d.isDirectory()) continue
      if (++budget.n > 4000) return ''
      const p = join(dir, d.name)
      if (d.name === 'dsh') {
        const bin = join(p, 'lib', 'bin.js')
        if (existsSync(bin)) return bin
      }
      const hit = scanForDsh(p, depth + 1, budget)
      if (hit) return hit
    }
    return ''
  }
  const hasDshOnPath = () => {
    const exts = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat', '.ps1'] : ['']
    const dirs = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')
    for (const d of dirs) {
      const dir = d.replace(/^"|"$/g, '').trim()
      if (!dir) continue
      for (const e of exts) {
        try { if (existsSync(join(dir, 'dsh' + e))) return true } catch { /* 忽略坏路径 */ }
      }
    }
    return false
  }
  let dshCliCache = { v: null, at: 0, key: '' }
  /**
   * ⭐ 缓存键里带上 `dshBin`：不然刚在设置里填的路径要等缓存过期（60s）才生效 ——
   *    表现成"填了 dsh 路径还是说找不到"，那种静默延迟最难查。
   */
  const dshCliCached = () => {
    const key = String(cfg.dshBin || '').trim()
    const now = Date.now()
    if (dshCliCache.key === key && dshCliCache.v !== null && now - dshCliCache.at < 60_000) {
      if (!dshCliCache.v || existsSync(dshCliCache.v)) return dshCliCache.v     // 文件被删了就重算
    }
    let v = ''
    try { v = findDshCli() } catch { v = '' }
    dshCliCache = { v, at: now, key }
    return v
  }
  const resolveDsh = () => {
    const cli = dshCliCached()
    if (cli) return { command: process.execPath, args: [cli], shell: false }
    const hint = '新版把 dsh 打进 app.asar 了，理论上应该能自动找到；实在找不到就把「dsh 路径」填成 D:\\DeepSeekHarness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
    if (!hasDshOnPath()) {
      log('⚠️ 找不到 dsh（常见位置、应用目录、PATH 里都没有）⇒ ' + hint)
      return { missing: true, hint }
    }
    log('⚠️ 没在常见位置找到 dsh，最后试一下 PATH 里的 `dsh` ⇒ ' + hint)
    return { command: 'dsh', args: [], shell: true, fallback: true, hint }
  }

  /* ─────────────── 跑一轮 ─────────────── */

  const mcpWhitelist = () => {
    // ⭐ 2026-10-25：之前漏了 feed/my_posts/chat/share —— 结果「刷推荐流」「转发」「续火花」「@豆包」
    //    在那一轮里根本看不到工具，所以永远不会发生。
    const list = ['douyin_feed', 'douyin_hot', 'douyin_hot_videos', 'douyin_search', 'douyin_video',
      'douyin_comments', 'douyin_my_posts']
    if (cfg.autoLike) list.push('douyin_like')
    if (cfg.autoComment && String(cfg.mentionName || '').trim()) list.push('douyin_comment')
    if (cfg.autoPublish) list.push('douyin_publish')
    if (String(cfg.shareToNick || '').trim()) list.push('douyin_share_video')
    if (String(cfg.streakNick || '').trim()) list.push('douyin_chat_send')
    return list
  }

  /**
   * 给 headless 那一轮写一份 overlay —— 把抖音 MCP 挂上去。
   * 某个 profile 能拿到什么工具取决于它自己那层的 patch；分发给别人时不能要求人家改 profile，
   * 所以插件自己生成一份、跑的时候 `--patch` 带上。
   */
  const ensureOverlay = () => {
    const file = join(stateDir, 'headless-overlay.yml')
    const posix = (p) => String(p).replace(/\\/g, '/')
    const yml = []
    // 有些 DSH 版本的 headless 自带 patch 会把这几个服务 disabled ⇒ 那一轮没有账号模型可用
    for (const id of ['credentials', 'authorization', 'deepseek-account']) {
      yml.push('- id: ' + id, '  disabled: false', '')
    }
    // 跟随使用者当前选的模型（拿不到就不写，保持原行为）
    // ⚠️ 2026-10-25 实测：桌面端用的 provider（比如 qwen-token-plan-cn）是**桌面 profile 里装的插件**，
    //    headless profile 没有那个 adapter ⇒ 直接报 `NO_ADAPTER: no adapter registered for provider "…"`，那一轮根本跑不起来。
    //    所以默认**不写** provider/model：让 headless 用它自己的默认模型；真要指定就填设置里的「headless 模型」。
    // 桌面端用登录态（deepseek-account）；headless 默认走 llm-deepseek 的 deepseek-official 需要 API key，
    // 没填 key 就会 MISSING_CREDENTIAL ⇒ 默认指定成账号路由。
    const forced = String(cfg.headlessModel || '').trim() || 'deepseek-account/deepseek-flash'
    try {
      let selProvider = ''
      let selModel = ''
      if (forced) {
        const [fp, fm] = forced.includes('/') ? forced.split('/') : ['', forced]
        selProvider = fp.trim()
        selModel = fm.trim()
      }
      if (selProvider && selModel) {
        yml.push(
          '- id: agent-default-model',
          '  config:',
          '    provider: ' + String(selProvider),
          '    model: ' + String(selModel),
          '',
        )
      }
    } catch { /* 老版本没有这个服务 —— 不写就退回原行为 */ }
    if (cfg.overlayMcp) {
      const p = pythonNow()
      const args = [...p.args, scriptPath].map((a) => `          - '${posix(a)}'`)
      yml.push(
        '- insert:',
        '    - id: mcp-douyin-duty',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: douyin-duty',
        '        transport: stdio',
        `        command: '${posix(p.command)}'`,
        '        args:',
        ...args,
        '        env:',
        `          DOUYIN_MCP_TOOLS: '${mcpWhitelist().join(',')}'`,
        `          TEMP: '${posix(join(stateDir, '.tmp'))}'`,
        `          TMP: '${posix(join(stateDir, '.tmp'))}'`,
        `          TMPDIR: '${posix(join(stateDir, '.tmp'))}'`,
        ...(String(cfg.cdpUrl || '').trim() ? [`          DOUYIN_CDP_URL: '${String(cfg.cdpUrl).trim()}'`] : []),
        '',
      )
    }
    try { writeFileSync(file, yml.join('\n'), 'utf8'); return file } catch (e) {
      log(`写 overlay 失败：${e?.message ?? e}`)
      return null
    }
  }

  const promptFor = () => {
    const duty = charterPath(pluginDir, stateDir)
    let charterText = ''
    try { charterText = readFileSync(duty, 'utf8').split('<家目录>').join(stateDir) } catch { /* 读不到就让它自己读 */ }
    const kws = Array.isArray(cfg.keywords) ? cfg.keywords.filter(Boolean) : []
    const quota = Math.max(0, Number(cfg.perDay) || 0)
    const already = countPickedToday()
    const left = Math.max(0, quota - already)
    const likeOn = Boolean(cfg.autoLike)
    const mention = String(cfg.mentionName || '').trim()
    const commentOn = Boolean(cfg.autoComment && mention)
    const publishOn = Boolean(cfg.autoPublish)
    return '你是这个账号的抖音助手。'
      + (String(cfg.personaPrompt || '').trim()
        ? '\n\n**你的人设（说话、挑片、写日报都按这个来，别写成客服腔）：**\n' + String(cfg.personaPrompt).trim() + '\n\n'
        : '')
      + (cfg.memory && readMemory(24).length
        ? '\n\n**你记得的最近这些（前几轮刷到的 / 读到的，别重复挑，也别装作没看过）：**\n'
          + readMemory(24).map((l) => '- ' + l).join('\n') + '\n\n'
        : '')
      + (charterText
        ? '下面是**值班章程**（里面的「<家目录>」已经替换成真实绝对路径了）—— 严格按它执行：\n\n' + charterText + '\n\n按上面的章程刷一轮抖音，'
        : `先读章程 ${duty}（里面的 <家目录> = ${stateDir}），按它刷一轮抖音，`)
      + (cfg.reportLevel === 'off'
        ? '这一轮不要写日报文件；只有真动了手才一句话记下。'
        : `把报告写到 ${reportFileOf()}。` + (cfg.reportLevel === 'brief' ? '日报写成薄版：每条一两行（值不值得 + 链接）就够。' : ''))
      + (cfg.reportLevel === 'off'
        ? ''
        : '⭐ 报告里**每挑中一条**，第一行写成 `### <视频id>`（顶格，抖音视频 id 就写在 ### 后面）—— 宿主**就数这些标题行**算今天挑了几条：漏写当成没挑中，给只是提到/跳过的视频加上标题则当成挑中。')
      + (already > 0
        ? `今天已经挑过 ${already} 条了 ⇒ **这一轮最多再挑 ${left} 条**（「每天最多 ${quota} 条」是全天总量，不是每轮）；`
        : `今天最多挑 ${quota} 条；`)
      + `关键词${kws.length ? `用这些：${kws.join('、')}` : '用章程里的默认那几组'}。`
      + `点赞：${likeOn ? '开着（值得的可以点，别乱点）' : '关着（一条都不要点，也不要调 douyin_like）'}；`
      + `评论并 @ ${mention || '（还没填要 @ 谁）'}：${commentOn
        ? `开着（每轮最多 ${Number(cfg.commentPerRound) || 1} 条，每条 150 字内，正文里纯文本 @ ${mention}）`
        : '关着（一条公开评论都不许发）'}；`
      + `发布视频：${publishOn
        ? `开着（默认只存草稿：${cfg.publishDraft ? '是，等本人过一眼' : '否，会真发出去'}）`
        : '关着（这条别碰，也不要调 dy_publish）'}。`
      + '最后用一句话汇报你挑到了什么。现在几点了自己看一眼系统时间。'
  }

  const stubReportIfMissing = (code) => {
    try {
      if (String(cfg.reportLevel || 'full') === 'off') return
      const f = reportFileOf()
      if (existsSync(f)) return
      let tail = ''
      try { tail = readFileSync(logFile, 'utf8').slice(-1500) } catch { /* 读不到就算了 */ }
      writeFileSync(f, [
        `# 刷抖音 · ${dayKey()} —— 这一轮没写出报告`,
        '',
        `> ⚠️ 那一轮结束了，但没有生成正常报告（退出码 ${code}）。`,
        '> 常见原因是它卡在某个工具上反复重试、或者把预算烧完了。下一轮它会重来。',
        '> 下面附插件日志尾部（完整版见插件家目录的 `duty.log`）。',
        '',
        '```',
        String(tail).trim(),
        '```',
        '',
      ].join('\n'), 'utf8')
      log('这一轮没写报告 ⇒ 宿主补了一份占位报告')
    } catch (e) { log(`补占位报告失败：${e?.message ?? e}`) }
  }

  /** 本机直跑一轮（下面赋值；这里先声明，保证 HTTP 路由一定能看到它） */
  let localRound = null

  const runDuty = (why = 'window') => {
    try {
      refreshCfg()
      const tmpDir = join(stateDir, '.tmp')
      try { mkdirSync(tmpDir, { recursive: true }) } catch { /* 建不了就让 Playwright 报 */ }
      const dsh = resolveDsh()
      if (dsh.missing) {
        const msg = '这一轮没跑：找不到 dsh。' + dsh.hint
        log(msg)
        try { stubReportIfMissing(1) } catch { /* 补不上也不影响这句话已经进日志 */ }
        return { started: false, why, error: msg }
      }
      refreshCfg()
      // cdpUrl 填了但端口不通 ⇒ 那一轮的 MCP 会退回自己启动（还要过验证码）。这里先探一下，通不了就明确记一笔。
      const cdp = String(cfg.cdpUrl || '').trim()
      if (cdp) {
        try {
          const port = Number((cdp.match(/:(\d+)/) || [])[1] || 0)
          const ok = port ? awaitablePortOpen(port) : false
          if (!ok) log(`⚠️ cdpUrl=${cdp} 端口不通：那一轮会用插件自己的浏览器（可能要过验证码）`)
        } catch { /* 探不到就算了 */ }
      }
      const overlay = ensureOverlay()
      const args = [...dsh.args, '--profile', cfg.headlessProfile || 'headless']
      if (overlay) args.push('--patch', overlay)
      args.push(promptFor())
      const cwd = String(cfg.workspace || '').trim() && existsSync(String(cfg.workspace).trim())
        ? String(cfg.workspace).trim()
        : stateDir
      log(`刷抖音开跑（${why}）：${dsh.command} ${args.slice(0, 3).join(' ')} …  cwd=${cwd}`)
      const child = spawn(dsh.command, args, {
        cwd,
        shell: dsh.shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: uvEnv({
          DOUYIN_DUTY_HOME: stateDir,
          // ⭐ 2026-10-25：headless 那轮被宿主的文件沙箱挡住写系统 Temp，
          //    Playwright 的 mkdtemp 直接 EPERM。把 TMP/TEMP/TMPDIR 指到家目录下就绕开了。
          TEMP: tmpDir,
          TMP: tmpDir,
          TMPDIR: tmpDir,
          // ⭐ 2026-10-25：headless 子进程默认在受限沙箱里跑，Playwright 给 driver 开命名管道
          //    （\\.\\pipe\\…）被拒 ⇒ EPERM。这两行把它放开到完整访问，实测 douyin_whoami 能通。
          DSH_SANDBOX: 'danger-full-access',
          DSH_FILE_POLICY: 'danger-full-access',
          ...(String(cfg.cdpUrl || '').trim() ? { DOUYIN_CDP_URL: String(cfg.cdpUrl).trim() } : {}),
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        }),
      })
      // ⚠️ 这里是 stream 的 data 回调：写日志失败绝不能抛（未捕获异常=整个宿主没了）
      const toText = (buf) => {
        try {
          const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf))
          const u = b.toString('utf8')
          if (!u.includes('\uFFFD')) return u
          try { return new TextDecoder('gbk').decode(b) } catch { return u }
        } catch { return String(buf) }
      }
      const pick = (buf) => { try { appendFileSync(logFile, toText(buf), 'utf8') } catch { /* 写不进去就丢，绝不能抛 */ } }
      child.stdout?.on('data', pick)
      child.stderr?.on('data', pick)
      child.on('error', (e) => log(`刷抖音起不来：${e?.message ?? e}`))
      child.on('exit', (code) => {
        try {
          log(`刷抖音结束（${why}，code=${code}）`)
          stubReportIfMissing(code)
          rotateLogIfBig()
          const st = readState()
          const prev = st.day === dayKey() ? Number(st.picked || 0) : 0
          const picked = countPickedToday()
          if (picked > prev) {
            bumpState({ picked })
            log(`今天挑到 ${picked} 条（上限 ${Number(cfg.perDay) || 0} 条）`)
          }
        } catch (e) { log(`收尾时出错（已兜住）：${e?.message ?? e}`) }
      })
      return { started: true, why, profile: cfg.headlessProfile, cwd, log: logFile }
    } catch (e) {
      log(`刷抖音开跑失败（${why}）：${e?.stack ?? e}`)
      return { started: false, why, error: String(e?.message ?? e) }
    }
  }

  /* ─────────────── 工具（14 个 dy_*） ─────────────── */

  // ⭐ 整块包在 try/catch 里：注册工具时任何一步出错都只该"少个工具"，绝不该让整条插件不激活
  try {
  tool({
    name: 'dy_status',
    description: '看它今天的状态：跑了没跑、挑了几条、额度剩多少、报告在哪、登录过没有、家目录、下次窗口什么时候开。',
    parameters: {},
    async execute() {
      refreshCfg()
      const now = new Date()
      const st = readState()
      const py = pythonNow()
      const comfyDir = String(cfg.comfyOutputDir || '').trim()
      return {
        ok: true,
        today: dayKey(now),
        ranToday: roundsToday(now),
        pickedToday: countPickedToday(now),
        perDay: Number(cfg.perDay) || 0,
        windows: Object.fromEntries(Object.entries(WINDOWS).map(([k, w]) => [k, {
          label: w.label, start: w.start, end: w.end,
          switchOn: Boolean(cfg[k]),
          opening: inWindow(now, w),
        }])),
        nextWindow: nextWindowInfo(now),
        peakValley: Boolean(cfg.peakValley),
        gates: { autoLike: Boolean(cfg.autoLike), autoComment: Boolean(cfg.autoComment), autoPublish: Boolean(cfg.autoPublish), autoReply: Boolean(cfg.autoReply), mentionName: String(cfg.mentionName || '') },
        doing: {
          todayComments: commentsToday(now),
          commentPerDay: Math.max(0, Number(cfg.commentPerDay) || 0),
          todayPublished: publishedToday(now),
          publishPerDay: Math.max(0, Number(cfg.publishPerDay) || 0),
          lastPublished: lastPublished(),
          todayReplies: repliesToday(now),
          replyTimer: replyState(),
          replyPerDay: Math.max(0, Number(cfg.replyPerDay) || 0),
          replyPerRun: Math.max(0, Number(cfg.replyPerRun) || 0),
          myVideos: myVideoIds().length,
        },
        loggedIn: hasLogin(),
        loginCheckedAt: String(st.loginCheckedAt || ''),
        loginQr: existsSync(qrFile) ? qrFile : '',
        home: stateDir,
        report: reportFileOf(now),
        reportExists: existsSync(reportFileOf(now)),
        python: { command: py.command, args: py.args, via: py.via, exists: py.via !== 'config' || existsSync(py.command) },
        mcpScript: scriptPath,
        mcpScriptReady: existsSync(scriptPath),
        mcpRunning: Boolean(mcp?.running),
        dshCli: dshCliCached(),
        comfy: { url: comfyBase(), outputDir: comfyDir, outputDirExists: Boolean(comfyDir) && existsSync(comfyDir), workflow: Boolean(String(cfg.comfyWorkflow || '').trim()), draftByDefault: Boolean(cfg.publishDraft) },
        cdp: { url: cdpBase(), ...(await cdpProbe(1200)), chrome: chromeNow(), running: chromeRunning() },
        reportLevel: String(cfg.reportLevel || 'full'),
      }
    },
  })

  tool({
    name: 'dy_chrome_open',
    description: '把「本人已经登录的那个 Chrome」拉起来并开 CDP 调试端口，之后所有抖音动作都走这个浏览器（登录态直接用，不用再扫码）。\n'
      + '⚠️ Chrome 已经开着的时候，带同一个默认 profile 再拉一次**不会**开调试端口 —— 先全关 Chrome 再调这个。\n'
      + '不开 CDP 也能用：那就退回插件自己的持久 profile，首次扫码一次。',
    parameters: {
      port: { type: 'number', description: '调试端口（默认用设置里的 cdpPort / 9222）' },
    },
    async execute(args) {
      refreshCfg()
      const port = Number(args?.port) || Number(cfg.cdpPort) || 9222
      if (port !== Number(cfg.cdpPort)) {
        await persistCfg({ cdpPort: port, cdpUrl: `http://127.0.0.1:${port}` })
      }
      const r = await openChromeWithCdp()
      log(`dy_chrome_open → ${r.ok ? (r.already ? 'CDP 本来就通' : '已拉起') : (r.needClose ? 'Chrome 在跑，需要先关' : '失败')}`)
      return {
        ...r,
        cdpUrl: cdpBase(),
        // 端口一变就要重起 MCP，让它用新的 CDP 地址
        mcpRestartHint: r.ok ? 'MCP 下次调用会自动换到新的 CDP 地址（mcpKey 里带了 cdpUrl）' : '先解决上面的问题',
        douyinHome: stateDir,
      }
    },
  })

  tool({
    name: 'dy_config',
    description: '读 / 改「刷抖音」的设置。不给 `patch` 就是读；给了就改（只认 schema 里的字段）。\n'
      + '例：`{"perDay":5,"peakValley":true,"autoLike":false,"autoComment":false,"mentionName":""}`；'
      + 'ComfyUI：`{"comfyUrl":"http://127.0.0.1:8188","comfyOutputDir":"E:\\\\Comfy-Desktop\\\\ComfyUI-Shared\\\\output"}`。',
    parameters: { patch: { type: 'object', additionalProperties: true, description: '要改的字段（可省）' } },
    async execute(args) {
      let host = null
      if (args?.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) {
        host = (await persistCfg(args.patch)).host
      } else {
        refreshCfg()
      }
      return {
        ok: true,
        config: { ...cfg },
        windows: WINDOWS,
        home: stateDir,
        gates: { autoLike: Boolean(cfg.autoLike), autoComment: Boolean(cfg.autoComment), autoPublish: Boolean(cfg.autoPublish), mentionName: String(cfg.mentionName || '') },
        host,
      }
    },
  })

  tool({
    name: 'dy_whoami',
    description: '看抖音那边登录的是谁（昵称 / uid、登录态是否有效）。第一次用要先 dy_login_start 扫码。',
    parameters: {},
    async execute() {
      refreshCfg()
      if (!existsSync(scriptPath)) {
        log('dy_whoami → 家里还没有 mcp_server.py，查不了登录态')
        return { ok: false, loggedIn: false, hint: `家里还没有 mcp_server.py（${scriptPath}）—— Python 半边没铺好，先把 vendor/douyin-mcp/mcp_server.py 放进去再重启 dsh` }
      }
      let r
      try { r = await call('douyin_check_credential', {}, { timeoutMs: 60_000 }) }
      catch (e) {
        log(`dy_whoami → MCP 起不来：${String(e?.message ?? e).slice(0, 120)}`)
        return { ok: false, loggedIn: false, error: String(e?.message ?? e), hint: 'MCP 起不来：先在设置里把 pythonPath 指对，或装 Python 3.11+' }
      }
      const obj = typeof r === 'object' && r ? r : { raw: r }
      if (obj.loggedIn !== undefined) markLogin(Boolean(obj.loggedIn), { nickname: obj.nickname || '', uid: obj.uid || '' })
      log(`dy_whoami → loggedIn=${Boolean(obj.loggedIn)}${obj.nickname ? ' nickname=' + obj.nickname : ''}`)
      return { ok: obj.ok !== false, ...obj }
    },
  })

  tool({
    name: 'dy_login_start',
    description: '开始抖音扫码登录：截二维码存成 PNG（家目录里），返回路径。\n'
      + '用法：拿到 PNG 后用 `present` 把它推给本人（手机抖音 → 扫一扫），再用 `dy_login_poll` 轮询。\n'
      + '⚠️ 二维码有效期很短，出码要马上递过去；手机上确认时选长期登录。',
    parameters: {},
    async execute() {
      refreshCfg()
      let r
      try { r = await call('douyin_login_qr', {}, { timeoutMs: 90_000 }) }
      catch (e) { return { ok: false, png: '', error: String(e?.message ?? e), hint: 'MCP 起不来：先看 dy_selfcheck 里 Python / 脚本那两条' } }
      const obj = typeof r === 'object' && r ? r : {}
      const png = String(obj.png || qrFile)
      const exists = existsSync(png)
      return {
        ok: obj.ok !== false && exists,
        png,
        pngExists: exists,
        hint: exists
          ? '用 present 把这张 PNG 推给本人（手机抖音 → 扫一扫），扫完调 dy_login_poll'
          : (obj.hint || 'MCP 没截到二维码 —— 可能页面没弹登录层；再调一次，或先用 dy_whoami 看是不是已经登过了'),
        raw: obj.hint ? { hint: obj.hint } : undefined,
      }
    },
  })

  tool({
    name: 'dy_login_poll',
    description: '查扫码结果：返回 loggedIn。检测登录态（昵称头像出现 / cookie 里有 sessionid）。',
    parameters: {},
    async execute() {
      let r
      try { r = await call('douyin_login_poll', {}, { timeoutMs: 90_000 }) }
      catch (e) { return { ok: false, loggedIn: false, error: String(e?.message ?? e) } }
      const obj = typeof r === 'object' && r ? r : {}
      const loggedIn = Boolean(obj.loggedIn)
      if (loggedIn) markLogin(true)
      return {
        ok: obj.ok !== false,
        loggedIn,
        // ⭐ 分状态回：waiting_scan / scanned_need_confirm / no_qr（「扫完没反应」得说清是哪一种）
        state: obj.state || '',
        qrVisible: obj.qrVisible,
        scanned: obj.scanned,
        ...(obj.hint ? { hint: obj.hint } : {}),
        ...(obj.evidence ? { evidence: obj.evidence } : {}),
      }
    },
  })

  tool({
    name: 'dy_login_sms',
    description: '短信验证码登录（第一步）：切到「验证码登录」tab、填手机号、点「获取验证码」。\n'
      + '用法：先问本人要手机号 → 调这个 → 短信到了让本人把 6 位验证码告诉你 → 调 `dy_login_sms_submit`。\n'
      + '⚠️ 这是"本人当场授权"的动作：只发给本人确认过的号码，别自己编。',
    parameters: {
      phone: { type: 'string', description: '本人手机号（11 位）' },
    },
    async execute(args) {
      const phone = String(args.phone ?? '').replace(/\D/g, '')
      if (phone.length !== 11) return { ok: false, error: '手机号要给 11 位数字', phone }
      log(`短信验证码：给 ${phone.slice(0, 3)}****${phone.slice(-2)} 发短信`)
      return call('douyin_login_sms', { phone }, { timeoutMs: 90_000 })
    },
  })

  tool({
    name: 'dy_login_sms_submit',
    description: '短信验证码登录（第二步）：把本人报给你的验证码填进去并点登录，然后等登录态。',
    parameters: {
      code: { type: 'string', description: '短信里的验证码（4~6 位数字）' },
    },
    async execute(args) {
      const code = String(args.code ?? '').replace(/\D/g, '')
      if (code.length < 4) return { ok: false, error: '验证码要是数字', code }
      const r = await call('douyin_login_sms_submit', { code }, { timeoutMs: 120_000 })
      const obj = typeof r === 'object' && r ? r : {}
      if (obj.loggedIn) {
        markLogin(true, { nickname: obj.nickname || '', uid: obj.uid || '' })
        log('短信验证码登录成功')
      }
      return { ok: obj.ok !== false, ...obj }
    },
  })

  tool({
    name: 'dy_reply_round',
    description: '回我自己视频下的评论（随机挑视频、随机挑评论）。\n'
      + '每条回复**不超过 20 字**；对方是敏感话题（政治/医疗/法律/隐私/黄赌毒/金融荐股/破解代做等）⇒ 换成委婉拒绝。\n'
      + '数量由设置里的「每次回几条 / 每天最多回」控制，也可以直接传 count。回过的评论不会重复回。',
    parameters: {
      count: { type: 'number', description: '这次想回几条（不填就用设置里的「每次回几条」）' },
      random: { type: 'boolean', description: '随机挑（默认按设置里的开关）' },
    },
    async execute(args) { return replyRound({ count: args.count, random: args.random }) },
  })
  tool({
    name: 'dy_chat_send',
    description: '给某个好友发一条私信。一个原语干三件事：转发视频（正文放视频链接）、续火花（随便一句）、发表情包（用 [憨笑] 这类文本码）。',
    parameters: {
      nickname: { type: 'string', description: '对方昵称' },
      text: { type: 'string', description: '要发的内容（可含 https://www.douyin.com/video/<id> 或 [憨笑] 这类表情码）' },
    },
    async execute(args) {
      const nick = String(args.nickname ?? '').trim()
      const text = String(args.text ?? '').trim()
      if (!nick || !text) return { ok: false, error: 'nickname 和 text 都要给' }
      if (!allowInitiate(nick)) return { ok: false, error: `「${nick}」不在「可以主动发消息的人」名单里（设置 → 互动）` }
      const r = await call('douyin_chat_send', { nickname: nick, text }, { timeoutMs: 180_000 })
      log(`私信 → ${nick}：${text.slice(0, 40)}`)
      return r
    },
  })

  tool({
    name: 'dy_chat_sticker',
    description: '在私信里发表情包：给某个人发一个「大肥鱼」相关的表情（输入关键词 → 联想面板 → 点一个发出去）。',
    parameters: {
      nickname: { type: 'string', description: '发给谁' },
      keyword: { type: 'string', description: '搜什么关键词（默认「大肥鱼」）' },
      pick: { type: 'number', description: '挑第几个（从 0 开始，默认 0）' },
    },
    async execute(args) {
      const nick = String(args.nickname ?? '').trim()
      if (!nick) return { ok: false, error: 'nickname 必填' }
      if (!allowInitiate(nick)) return { ok: false, error: `「${nick}」不在「可以主动发消息的人」名单里（设置 → 互动）` }
      const r = await call('douyin_chat_sticker', {
        nickname: nick,
        keyword: String(args.keyword || '大肥鱼'),
        pick: Number(args.pick) || 0,
      }, { timeoutMs: 240_000 })
      return r
    },
  })

  tool({
    name: 'dy_dm_round',
    description: '看一遍私信：谁发来新消息就回一句（每人每天「回几条」有限制，总条数也有上限）。陌生人消息也会回。',
    parameters: {},
    async execute() { return dmRound() },
  })

  tool({
    name: 'dy_share',
    description: '把一个视频转发给指定的人（发一条私信，正文是视频链接）。',
    parameters: {
      aweme_id: { type: 'string', description: '视频 id 或链接' },
      to: { type: 'string', description: '发给谁（昵称；留空用设置里的「转发给谁」）' },
    },
    async execute(args) {
      const id = String(args.aweme_id ?? '').trim()
      const to = String(args.to ?? '').trim() || String(cfg.shareToNick || '').trim()
      if (!id || !to) return { ok: false, error: '要么给 aweme_id 和 to，要么先在设置里填「转发给谁」' }
      if (!allowInitiate(to)) return { ok: false, error: `「${to}」不在「可以主动发消息的人」名单里（设置 → 互动）` }
      // 走「分享面板」转发（视频页 → 分享 → 点那个人的分享）
      const r = await call('douyin_share_video', { aweme_id: id, nickname: to }, { timeoutMs: 180_000 })
      if (r && r.ok !== false) {
        // 分享完再补一句「人话」——不然对方只收到一张卡片，很冷
        const note = makeShareNote({ title: args.title || '' })
        let noteOk = false
        try {
          const r2 = await call('douyin_chat_send', { nickname: to, text: note }, { timeoutMs: 180_000 })
          noteOk = r2 && r2.ok !== false
        } catch { /* 附言失败不影响转发成功 */ }
        return { ...r, shared_to: to, via: 'share-panel', note, noteOk }
      }
      // 面板里没有这个人就退回发链接
      const url = `https://www.douyin.com/video/${id}`
      const r2 = await call('douyin_chat_send', { nickname: to, text: `这个好看，给你：${url}` }, { timeoutMs: 180_000 })
      return { ...(r2 || {}), shared_to: to, via: 'chat-link', panelError: r?.error }
    },
  })

  tool({
    name: 'dy_thumb',
    description: '给一条视频截一张缩略图（存 <家>/thumbs/<id>.jpg，供「刷过的视频」卡片用）。\n'
      + '写日报之后对今天每条调一次，页面就有图；不调也行，页面第一次打开时会自己补（慢一点）。',
    parameters: { aweme_id: { type: 'string', description: '视频 id 或整条链接' } },
    async execute(args) {
      const id = String(args.aweme_id ?? '').trim()
      if (!id) return { ok: false, error: 'aweme_id 是空的' }
      return call('douyin_thumb', { aweme_id: id }, { timeoutMs: 90_000 })
    },
  })

  tool({
    name: 'dy_my_posts',
    description: '我今天发过的作品（抖音站内接口，按发布时间过滤当天）。\n'
      + '「自动回评论」就是靠它决定回哪些视频：**只回当日发布的，过了当天不再回**。',
    parameters: { days: { type: 'number', description: '要几天内的（默认 1 = 今天）' } },
    async execute(args) {
      const days = Math.max(1, Math.min(Number(args.days) || 1, 30))
      const r = await call('douyin_my_posts', { days }, { timeoutMs: 90_000 })
      return r
    },
  })

  tool({
    name: 'dy_my_videos',
    description: '我自己发过的视频（来自投稿账本 ledger.json）。看它们下面的评论用 dy_comments。',
    parameters: {},
    async execute() {
      const pub = Object.values(readLedger().published).filter(Boolean)
      const items = pub.map((p) => ({
        video: String(p.video || ''),
        name: String(p.video || '').split(/[\\/]/).pop(),
        draft: Boolean(p.draft),
        url: p.url || '',
        at: p.at || '',
      }))
      return { ok: true, count: items.length, items, hint: items.length ? '这些是我投过的；评论用 dy_comments 读' : '我还没投过视频（autoPublish 关着，或者一次都没发）' }
    },
  })

  tool({
    name: 'dy_reply',
    description: '回复我自己视频下的一条评论（挂在对方评论下面）。\n'
      + '🔴 规矩：回复**不超过 20 字**（超了会被裁到标点/20 字）；对方是敏感话题（政治/医疗/法律/隐私/黄赌毒/金融荐股/破解代做等）'
      + '⇒ **不接话**，换成一句委婉拒绝。',
    parameters: {
      aweme_id: { type: 'string', description: '视频 id 或链接' },
      cid: { type: 'string', description: '要回复的那条评论 id（dy_comments 里的 cid）' },
      text: { type: 'string', description: '想回的话（会被压到 20 字以内）' },
      comment: { type: 'string', description: '对方那条评论的原文（给我判断敏不敏感；不填我会去抓）' },
    },
    async execute(args) {
      const aid = String(args.aweme_id ?? '').trim()
      const cid = String(args.cid ?? '').trim()
      if (!aid || !cid) return { ok: false, error: 'aweme_id 和 cid 都要给' }
      let commentText = String(args.comment ?? '').trim()
      if (!commentText) {
        try {
          const r = await call('douyin_comments', { aweme_id: aid, num: 50 }, { timeoutMs: 120_000 })
          const hit = (r?.items || []).find((x) => String(x.cid) === cid)
          if (hit) commentText = String(hit.text || '')
        } catch { /* 抓不到就按正常回复走 */ }
      }
      // 判定在本地做（规则见 tools/reply_policy.py，两边是同一份关键词表）
      const SENSITIVE = ['政治', '政府', '领导人', '主席', '总统', '选举', '游行', '抗议', '民族', '宗教', '邪教',
        '病', '癌', '药', '治疗', '诊断', '自杀', '抑郁', '起诉', '律师', '判', '违法', '坐牢', '报案',
        '身份证', '住址', '手机号', '人肉', '开盒', '社工', '裸', '色情', '约炮', '包养', '赌博', '博彩',
        '洗钱', '跑分', '股票', '荐股', '基金', '炒币', '贷款', '套现', '返利', '破解', '外挂', '盗号', '黑产', '刷单', '代考']
      const sensitive = SENSITIVE.some((k) => commentText.includes(k))
      let final = String(args.text ?? '').replace(/\s+/g, ' ').replace(/@\S+\s*/g, '').trim()
      if (sensitive) final = ['这个我不太方便聊，换个话题吧。', '抱歉，这条我不接了。', '这个我说不好，别问我啦。'][commentText.length % 3]
      if (final.length > 20) {
        const cut = final.slice(0, 20)
        const m = cut.match(/^.*[，。！？~、,.!?]/)
        final = (m ? m[0] : cut).replace(/[，。、]$/, '').slice(0, 20)
      }
      if (!final) return { ok: false, error: '回复是空的' }
      const r = await call('douyin_comment', { aweme_id: aid, text: final, reply_cid: cid, mention: '' }, { timeoutMs: 150_000 })
      const obj = typeof r === 'object' && r ? r : {}
      if (obj.ok !== false && obj.needLogin !== true) {
        noteComment({ aweme_id: aid, text: final, reply_to: cid })
        log(`回复评论 → ${aid}/${cid}：${final}`)
      }
      return { ok: obj.ok !== false, sent: final, len: final.length, sensitive, comment: commentText.slice(0, 60), ...obj }
    },
  })

  tool({
    name: 'dy_remember',
    description: '往「记忆」里记一行（<家>/memory/YYYY-MM.md）。刷到的、读到的感悟、想记住的事都可以记；下一轮开头会带上最近这些。',
    parameters: { line: { type: 'string', description: '要记的一句话（自带日期时间更好）' } },
    async execute(args) {
      const line = String(args.line ?? '').trim()
      if (!line) return { ok: false, error: 'line 是空的' }
      const stamped = `${new Date().toISOString().slice(0, 10)} ${new Date().toTimeString().slice(0, 8)} · ${line}`
      appendMemory(stamped)
      return { ok: true, file: memFileOf(), line: stamped, lines: readMemory(1000).length }
    },
  })

  tool({
    name: 'dy_feed',
    description: '刷抖音推荐流（不搜索）：打开首页推荐、往下滚几屏，把露出的视频收下来。这就是「直接刷」。',
    parameters: {
      num: { type: 'number', description: '要几条（默认 10）' },
      scrolls: { type: 'number', description: '最多滚几屏（默认 6）' },
    },
    async execute(args) {
      const r = await call('douyin_feed', {
        num: Math.max(1, Math.min(Number(args.num) || 10, 50)),
        scrolls: Math.max(1, Math.min(Number(args.scrolls) || 6, 30)),
      }, { timeoutMs: 240_000 })
      return r
    },
  })

  tool({
    name: 'dy_hot',
    description: '抖音热榜（**不用登录**就能拿）。返回词 / sentence_id / 热度 / 讨论视频数。\n'
      + '刷一轮没登录时就从这儿起手：热榜词 → dy_hot_videos 看视频 → dy_video / dy_comments 读细节。',
    parameters: { limit: { type: 'number', description: '取几条（默认 30，最大 100）' } },
    async execute(args) {
      refreshCfg()
      return call('douyin_hot', { limit: Math.max(1, Math.min(Number(args.limit) || 30, 100)) }, { timeoutMs: 90_000 })
    },
  })

  tool({
    name: 'dy_hot_videos',
    description: '看某条热点下面的视频列表（**不用登录**）。给 sentence_id（先用 dy_hot 拿）或 word。',
    parameters: {
      sentence_id: { type: 'string', description: '热点的 sentence_id（推荐）' },
      word: { type: 'string', description: '热点词（没给 sentence_id 时用）' },
      num: { type: 'number', description: '取几条（默认 10，最大 60）' },
    },
    async execute(args) {
      refreshCfg()
      return call('douyin_hot_videos', {
        sentence_id: String(args.sentence_id ?? '').trim(),
        word: String(args.word ?? '').trim(),
        num: Math.max(1, Math.min(Number(args.num) || 10, 60)),
      }, { timeoutMs: 120_000 })
    },
  })

  tool({
    name: 'dy_search',
    description: '搜抖音视频。返回标题 / 视频id / 作者 / 点赞 / 评论 / 分享 / 时长 / 链接 / 封面。\n'
      + '⚠️ 刷一轮的用法：搜近 7 天的，然后**逐条看标题与评论**再判断（别看标题就下结论）。',
    parameters: {
      keyword: { type: 'string', description: '搜索关键词' },
      num: { type: 'number', description: '返回几条（默认 10，最大 50）' },
      order: { type: 'string', description: 'general=综合（默认）/ latest=最新 / hot=最热' },
    },
    async execute(args) {
      refreshCfg()
      return call('douyin_search', {
        keyword: String(args.keyword ?? ''),
        num: Math.max(1, Math.min(Number(args.num) || 10, 50)),
        order: String(args.order || 'general'),
      }, { timeoutMs: 120_000 })
    },
  })

  tool({
    name: 'dy_video',
    description: '取单条视频的信息（标题 / 简介 / 作者 / 点赞 / 评论数 / 链接 / 发布时间）。',
    parameters: { aweme_id: { type: 'string', description: '抖音视频 id，也可以直接给整条链接' } },
    async execute(args) {
      return call('douyin_video', { aweme_id: String(args.aweme_id ?? '').trim() }, { timeoutMs: 90_000 })
    },
  })

  tool({
    name: 'dy_comments',
    description: '取一条视频的热门评论（含点赞 / 时间）。刷一轮时翻一眼，看值不值得占用使用者一次注意力。',
    parameters: {
      aweme_id: { type: 'string', description: '抖音视频 id 或整条链接' },
      num: { type: 'number', description: '取几条（默认 30）' },
    },
    async execute(args) {
      return call('douyin_comments', {
        aweme_id: String(args.aweme_id ?? '').trim(),
        num: Math.max(1, Math.min(Number(args.num) || 30, 100)),
      }, { timeoutMs: 120_000 })
    },
  })

  tool({
    name: 'dy_like',
    description: '给一条视频点赞（或取消）。\n'
      + '🔴 安全闸：设置里的「自动点赞」**默认是关的**；关着的时候这个工具会拒绝 —— '
      + '除非本人当场让你点（那时传 force: true）。',
    parameters: {
      aweme_id: { type: 'string', description: '抖音视频 id 或整条链接' },
      undo: { type: 'boolean', description: 'true = 取消点赞' },
      force: { type: 'boolean', description: '本人当场让你点的，传 true 越过"自动点赞关着"的闸' },
    },
    async execute(args) {
      refreshCfg()
      if (!cfg.autoLike && args.force !== true) {
        return {
          ok: false,
          blocked: true,
          hint: '「自动点赞」关着 —— 拿使用者的号动手的事默认不做。要开就在设置里打开 autoLike，或者本人当场让你点时传 force: true。',
        }
      }
      return call('douyin_like', {
        aweme_id: String(args.aweme_id ?? '').trim(),
        undo: Boolean(args.undo),
      }, { timeoutMs: 90_000 })
    },
  })

  tool({
    name: 'dy_comment',
    description: '在视频下发评论（或回复某条评论）。这就是"@ 本人"那一下：短、干净、纯文本 @ 写在正文里。\n'
      + '🔴 安全闸：要同时满足「自动评论并 @ 你」开着 **且** 填了「要 @ 谁」，否则拒绝 —— '
      + '除非本人当场让你发（那时传 force: true）。',
    parameters: {
      aweme_id: { type: 'string', description: '抖音视频 id 或整条链接' },
      text: { type: 'string', description: '评论正文（短、干净、纯文本；别堆 emoji、别写敏感词）' },
      reply_cid: { type: 'string', description: '要回复的评论 id（空 = 发新评论）' },
      force: { type: 'boolean', description: '本人当场让你发的，传 true 越过闸门' },
    },
    async execute(args) {
      refreshCfg()
      const mention = String(cfg.mentionName || '').trim()
      const cap = Math.max(0, Number(cfg.commentPerDay) || 0)
      const done = commentsToday()
      const force = args.force === true
      const need = []
      if (!cfg.autoComment) need.push('设置里的「自动评论并 @ 你」是关着的')
      if (!mention) need.push('没填「要 @ 谁」（评论存在的意义就是 @ 那一下）')
      if (!force && cap > 0 && done >= cap) need.push(`今天已经发了 ${done} 条（上限 ${cap} 条/天）`)
      if (!force && cap === 0) need.push('「每天最多发几条评论」是 0（= 不发）')
      if (need.length && !force) {
        return { ok: false, blocked: true, todayComments: done, cap, hint: need.join('；') + '。本人当场让你发时传 force: true。' }
      }
      let text = String(args.text ?? '').trim()
      if (!text) return { ok: false, blocked: true, hint: '正文是空的 —— 评论总得有个内容' }
      // ⭐ @ 是纯文本写在正文里的；模型漏了 @ 就替它补在开头（不改成别的东西）
      if (mention && !text.includes('@' + mention)) text = `@${mention} ${text}`
      if (text.length > 300) text = text.slice(0, 300)
      const aid = String(args.aweme_id ?? '').trim()
      const r = await call('douyin_comment', {
        aweme_id: aid,
        text,
        reply_cid: String(args.reply_cid ?? '').trim(),
        mention,          // ⭐ 走真人 @：MCP 那边会打 @昵称 + 点联想面板
      }, { timeoutMs: 150_000 })
      const obj = typeof r === 'object' && r ? r : { raw: r }
      if (obj.ok !== false && obj.needLogin !== true) {
        noteComment({ aweme_id: aid, text })
        log(`发评论 → ${aid}：${text.slice(0, 40)}`)
      }
      // ⚠️ 顺序要紧：`...obj` 放前面，否则 MCP 那边回一个 `text` 就把我们补好 @ 的正文盖掉了
      return { ...obj, ok: obj.ok !== false, text, todayComments: commentsToday(), todayReplies: repliesToday(), cap }
    },
  })

  tool({
    name: 'dy_publish',
    description: '发一条视频到抖音（默认只存草稿：`draft=True`，等本人过一眼）。\n'
      + '给 `video_path` 就投那条；给 `latest: true` 就从 ComfyUI 输出目录里取**最新一个 .mp4**'
      + '（配了 `comfyWorkflow` 的话会先排队出片再取）。\n'
      + '🔴 安全闸：设置里的「自动发布视频」**默认是关的**；关着的时候这个工具会拒绝 —— '
      + '除非本人当场让你发（那时传 force: true）。',
    parameters: {
      video_path: { type: 'string', description: '要发的视频文件路径（给了就不看 latest）' },
      latest: { type: 'boolean', description: 'true = 取 ComfyUI 输出目录里最新的 .mp4' },
      title: { type: 'string', description: '标题' },
      tags: { type: 'string', description: '话题/标签，空格或逗号分隔' },
      draft: { type: 'boolean', description: 'true=只存草稿（默认），false=真发出去' },
      force: { type: 'boolean', description: '本人当场让你发的，传 true 越过闸门' },
    },
    async execute(args) {
      refreshCfg()
      const force = args.force === true
      const cap = Math.max(0, Number(cfg.publishPerDay) || 0)
      const done = publishedToday()
      if (!cfg.autoPublish && !force) {
        return {
          ok: false,
          blocked: true,
          todayPublished: done,
          cap,
          hint: '「自动发布视频」关着 —— 往使用者号上投稿默认不做。要开就在设置里打开 autoPublish，或本人当场让你发时传 force: true。',
        }
      }
      if (!force && cap === 0) return { ok: false, blocked: true, todayPublished: done, cap, hint: '「每天最多发几条视频」是 0（= 不发）' }

      const draft = args.draft === undefined ? Boolean(cfg.publishDraft) : Boolean(args.draft)
      const tpl = String(cfg.publishTitle || '').trim()
      const title = String(args.title || '').trim() || (tpl ? tpl.replace(/\{date\}/g, dayKey()) : `日常 ${dayKey()}`)
      const tags = String(args.tags || '').trim() || String(cfg.publishTags || '').trim()

      let video = String(args.video_path || '').trim()
      let comfy = null
      if (!video && args.latest) {
        try {
          if (String(cfg.comfyWorkflow || '').trim()) comfy = await runComfyWorkflow()
        } catch (e) {
          return { ok: false, error: 'ComfyUI 出片失败：' + String(e?.message ?? e), hint: '检查 comfyUrl / comfyWorkflow；不想出片就把 comfyWorkflow 清空，直接投已有文件' }
        }
        const ls = listVideos(1)
        if (!ls.items.length) {
          return { ok: false, error: 'ComfyUI 输出目录里没有 .mp4', dir: ls.dir, dirExists: ls.exists, hint: '把 comfyOutputDir 指到 ComfyUI 的 output 目录（默认 E:\\Comfy-Desktop\\ComfyUI-Shared\\output）' }
        }
        video = ls.items[0].path
      }
      if (!video) return { ok: false, blocked: true, hint: '没给 video_path，也没传 latest: true' }
      if (!existsSync(video)) return { ok: false, error: `文件不存在：${video}` }

      // ⭐ 同一条片子不重复投（除非当场 force）：账本按「路径+大小+mtime」认
      const key = videoKey(video)
      const seen = readLedger().published[key]
      if (seen && !force) {
        return {
          ok: false,
          already: true,
          video,
          title,
          draft,
          publishedAt: seen.at,
          url: seen.url || '',
          hint: '这条已经投过了（账本里有）。真再投一次就传 force: true。',
        }
      }
      // 配额放在"已经投过了"后面判：先说 already 比说"超配额"有用
      if (!force && done >= cap) return { ok: false, blocked: true, todayPublished: done, cap, hint: `今天已经发了 ${done} 条（上限 ${cap} 条/天）` }

      log(`投稿：${video}（draft=${draft}）`)
      let r = null
      try {
        r = await call('douyin_publish', { video_path: video, title, tags, draft }, { timeoutMs: 300_000 })
      } catch (e) {
        // ⭐ 文件已经选好了：环境问题就把"选的是哪一个"一并带回去，别让人重新猜
        return {
          ok: false,
          error: String(e?.message ?? e),
          video,
          title,
          draft,
          hint: 'Python 半边没起来（先跑 dy_selfcheck 看哪一条是 false）；文件已经选好了，环境下一次修好就能重试',
        }
      }
      const obj = typeof r === 'object' && r ? r : { raw: r }
      if (obj.ok !== false && obj.needLogin !== true) {
        notePublish(key, { video, title, draft, url: obj.url || '' })
        log(`投稿成功 → ${video}（draft=${draft}）`)
      }
      return { ok: obj.ok !== false, video, title, draft, todayPublished: publishedToday(), cap, ...obj, ...(comfy ? { comfy } : {}) }
    },
  })

  tool({
    name: 'dy_comfy_list',
    description: '列 ComfyUI 输出目录里最近的成片（按 mtime 从新到旧，递归找 .mp4）。配合 dy_publish(latest:true) 用。',
    parameters: { limit: { type: 'number', description: '列几条（默认用设置里的 comfyListLimit）' } },
    async execute(args) {
      refreshCfg()
      const ls = listVideos(args.limit)
      return { ok: true, ...ls, hint: ls.exists ? undefined : '这个目录不存在：把设置里的 comfyOutputDir 改成 ComfyUI 的 output 目录' }
    },
  })

  /* ─────────────── 本机直跑一轮（不 spawn headless） ───────────────
   * 为什么要有它：headless 子进程在受限沙箱里连命名管道都开不了（Chrome/Playwright 直接 EPERM），
   * 而宿主自己的 MCP 是能正常驱动浏览器的。所以「跑一轮」默认走这里：宿主调 MCP → 挑片 → 写报告。
   * 代价：日报文字是模板化的（不是模型现写），但**能用、能刷、能挑、能点赞评论**。
   */
  /** 自动回复私信：读消息抽屉 → 找到「别人发来的、还没回过的」→ 回一句（每人每天 limit 条） */
  const dmRound = async () => {
    refreshCfg()
    if (!cfg.dmReply) return { ok: true, skipped: '自动回私信关着' }
    const perDay = Math.max(0, Number(cfg.dmReplyPerDay) || 0)
    if (!perDay) return { ok: true, skipped: '每天最多回 0 条' }
    const today = dayKey()
    const led = readLedger()
    led.dm = led.dm || {}
    const usedToday = Object.values(led.dm).filter((r) => r && r.day === today).reduce((n, r) => n + (Number(r.count) || 0), 0)
    if (usedToday >= perDay) return { ok: true, skipped: `今天私信额度用完了（${usedToday}/${perDay}）` }

    const inbox = await call('douyin_inbox', { limit: 12 }, { timeoutMs: 120_000 })
    const rows = Array.isArray(inbox?.items) ? inbox.items : []
    const out = []
    for (const row of rows) {
      const m = String(row.text || '').match(/^(.+?)\s+(\d|昨天|刚刚|\d+月|\d+分钟|\d+小时)/)
      const name = (m ? m[1] : String(row.text || '')).trim()
      const preview = String(row.text || '').replace(name, '').trim()
      if (!name || /^(充钻石|消息|通知)/.test(name)) continue
      if (isMine(name)) continue                                   // 自己的会话不回
      if (usedToday >= perDay) break
      const rec = led.dm[name] || { count: 0, lastSeen: '' }
      if (rec.day !== today) { rec.count = 0; rec.day = today }
      if (rec.lastSeen === preview) continue                        // 没有新消息
      if (rec.count >= Math.max(1, Number(cfg.dmReplyPerContact) || 1)) continue
      const reply = /表情|\[/.test(preview) ? '哈哈哈你也太可爱了[憨笑]'
        : /你好|在吗|在不在/.test(preview) ? '在的在的[比心]'
        : /视频|分享/.test(preview) ? '看到了，我去看看[笑哭]'
        : '收到啦[憨笑]'
      try {
        const r = await call('douyin_chat_send', { nickname: name, text: reply }, { timeoutMs: 180_000 })
        const ok = r && r.ok !== false
        rec.count = Number(rec.count || 0) + 1
        rec.lastSeen = preview
        led.dm[name] = rec
        if (ok) usedToday += 1
        out.push({ to: name, preview: preview.slice(0, 30), reply, ok, error: ok ? undefined : (r?.error || '没发出去') })
      } catch (e) {
        out.push({ to: name, ok: false, error: String(e?.message ?? e) })
      }
    }
    writeLedger(led)
    if (out.length) {
      try {
        appendFileSync(reportFileOf(), "\n## 回了私信\n\n" + out.map((o) => `- ${o.to}：${o.ok ? '已回「' + o.reply + '」' : '没回成（' + o.error + '）'}`).join("\n") + "\n", 'utf8')
      } catch { /* 忽略 */ }
    }
    log(`回私信：${out.filter((o) => o.ok).length}/${out.length} 条`)
    return { ok: true, replied: out.filter((o) => o.ok).length, items: out, usedToday, perDay }
  }

  localRound = async () => {
    refreshCfg()
    const quota = Math.max(0, Number(cfg.perDay) || 0)
    const left = Math.max(0, quota - countPickedToday())
    if (left <= 0) {
      return { ok: true, picked: 0, skipped: `今天已经挑够 ${quota} 条了（不再重复挑）`, report: reportFileOf(), actions: [] }
    }
    const notes = []
    let items = []
    try {
      const r = await call('douyin_feed', { num: 12, scrolls: 6 }, { timeoutMs: 240_000 })
      items = Array.isArray(r?.items) ? r.items : []
      if (!items.length) notes.push('推荐流没拿到东西：' + ((r?.notes || []).join('；') || '未知原因'))
    } catch (e) {
      notes.push('刷推荐流出错：' + String(e?.message ?? e))
    }
    if (!items.length) {
      try {
        const r2 = await call('douyin_hot', {}, { timeoutMs: 120_000 })
        const words = (r2?.items || []).slice(0, 3).map((x) => x.word).filter(Boolean)
        if (words.length) {
          const r3 = await call('douyin_hot_videos', { word: words[0], num: 10 }, { timeoutMs: 120_000 })
          items = Array.isArray(r3?.items) ? r3.items : []
          if (items.length) notes.push('推荐流空，改用热榜「' + words[0] + '」')
        }
      } catch (e) { notes.push('热榜兜底也失败：' + String(e?.message ?? e)) }
    }
    if (!items.length) {
      try {
        mkdirSync(outDir, { recursive: true })
        appendFileSync(reportFileOf(), "\n## 这一轮没跑成\n\n- 记录时间：" + new Date().toLocaleString('zh-CN', { hour12: false }) + "\n- 原因：一条视频都没拿到" + (notes.length ? '（' + notes.join('；') + '）' : '') + "\n", 'utf8')
      } catch { /* 忽略 */ }
      return { ok: false, error: '一条视频都没拿到', notes }
    }

    // 今天报告里已经写过的 id 不再挑（否则每点一次就多 5 条）
    let seenIds = new Set()
    try {
      const txt = readFileSync(reportFileOf(), 'utf8')
      for (const m of txt.matchAll(/^###\s*(\d{6,})/gm)) seenIds.add(m[1])
    } catch { /* 没报告就全算新的 */ }
    const scored = items.filter((x) => !seenIds.has(String(x.aweme_id)))
      .filter((x) => x && x.aweme_id && String(x.title || '').trim())
      .map((x) => {
        const d = Number(x.digg) || 0
        const dur = Number(x.duration) || 0
        const mins = dur / 60000
        let s = Math.log10(d + 10) * 10
        if (dur > 20000 && dur < 600000) s += 3      // 20s~10min 更像"看完"的
        return { ...x, score: s, mins, skim: mins > Number(cfg.skimOverMin || 5) }
      })
      .filter((x) => x.mins <= Number(cfg.skipOverMin || 60))   // ⭐ 超 1 小时直接划走
      .sort((a, b) => b.score - a.score)

    // 一轮最多挑 2 条：像人一样零零散散地看，不是一口气刷完
    const perRound = Math.max(1, Math.min(Number(cfg.pickPerRound) || 2, 5))
    const take = scored.slice(0, Math.max(1, Math.min(left, perRound)))
    const lines = [`# ${dayKey()} · 抖音日报（本机直跑）`, '', `**记录时间**：${new Date().toLocaleString('zh-CN', { hour12: false })}（本机时间）`, '']
    if (notes.length) lines.push(...notes.map((n) => '- ' + n), '')
    for (const v of take) {
      let top = ''
      try {
        const c = await call('douyin_comments', { aweme_id: v.aweme_id, num: 8, compact: true }, { timeoutMs: 120_000 })
        const it = (c?.items || [])[0]
        if (it) top = String(it.text || '').slice(0, 40)
        topOf[v.aweme_id] = top
      } catch { /* 读不到评论不影响挑片 */ }
      lines.push(
        `### ${v.aweme_id}`,
        `- 记录时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        `- 标题：${String(v.title || '').slice(0, 60)}`,
        `- 作者：${v.author || ''}`,
        `- 点赞 · 评论：${v.digg ?? ''}${v.comment ? ' · ' + v.comment : ''}`,
        `- 链接：${v.url || `https://www.douyin.com/video/${v.aweme_id}`}`,
        `- **档位**：${Number(v.digg) > 50000 ? '值得看' : '可以看'}`,
        `- 为什么：推荐流里刷到的，播放/点赞 ${v.digg ?? 0}${top ? `；热评「${top}」` : ''}`,
        '',
      )
      try { await call('douyin_thumb', { aweme_id: v.aweme_id }, { timeoutMs: 90_000 }) } catch { /* 截图失败不影响 */ }
    }
    try {
      mkdirSync(outDir, { recursive: true })
      appendFileSync(reportFileOf(), "\n" + lines.join("\n") + "\n", 'utf8')
    } catch (e) {
      return { ok: false, error: '报告写不进去：' + String(e?.message ?? e), notes }
    }

    // 动手（闸门各自判定；失败只记录不抛）
    // ⭐ 2026-10-25：**评论@ 与 转发 互斥** —— 一天 10 条、5 条@、5 条转发，则这 10 条各干一件事，不会重复。
    const acts = []
    const topOf = {}
    try {
      const perDayCfg = Math.max(0, Number(cfg.perDay) || 0)
      const mentionCap = cfg.autoComment ? Math.max(0, Number(cfg.commentPerDay) || 0) : 0
      const shareCapCfg = Math.max(0, Number(cfg.sharePerDay) || 0)
      const mentionLeft = Math.max(0, mentionCap - commentsToday())
      const shareLeft = Math.max(0, shareCapCfg - sharesToday())
      const plainCap = cfg.autoCommentPlain ? Math.max(0, Number(cfg.plainCommentPerDay) || 0) : 0
      const plainLeft = Math.max(0, plainCap - plainCommentsToday())
      const plan = []
      let mi = 0
      let si = 0
      let pi = 0
      for (const v of take) {
        if (mi < mentionLeft && cfg.autoComment) { plan.push({ v, act: 'mention' }); mi += 1; continue }
        if (pi < plainLeft && cfg.autoCommentPlain) { plan.push({ v, act: 'plain' }); pi += 1; continue }
        if (si < shareLeft && String(cfg.shareToNick || '').trim()) { plan.push({ v, act: 'share' }); si += 1; continue }
        plan.push({ v, act: 'like' })
      }
      for (const item of plan) {
        const v = item.v
        if (cfg.autoLike) {
          const r = await call('douyin_like', { aweme_id: v.aweme_id }, { timeoutMs: 120_000 })
          acts.push(`点赞 ${String(v.title || '').slice(0, 12)}：` + (r?.ok !== false ? '已点' : (r?.error || '没点上')))
        }
        if (item.act === 'mention') {
          const mention = String(cfg.mentionName || '').trim()
          const text = makeMentionComment(v, mention)
          const r = await call('douyin_comment', { aweme_id: v.aweme_id, text, mention }, { timeoutMs: 180_000 })
          const okk = r && r.ok !== false
          acts.push('评论@' + mention + '：' + (okk ? '已发' : (r?.error || '没发出去')))
          if (okk) noteComment({ aweme_id: v.aweme_id, text })
        } else if (item.act === 'plain') {
          const text = makePlainComment(v, topOf[v.aweme_id])
          const r = await call('douyin_comment', { aweme_id: v.aweme_id, text }, { timeoutMs: 180_000 })
          const okk = r && r.ok !== false
          acts.push(`评论「${text}」：` + (okk ? '已发' : (r?.error || '没发出去')))
          if (okk) notePlainComment(v.aweme_id, text)
        } else if (item.act === 'share') {
          const to = String(cfg.shareToNick || '').trim()
          const r = await call('douyin_share_video', { aweme_id: v.aweme_id, nickname: to }, { timeoutMs: 180_000 })
          const okk = r && r.ok !== false
          acts.push('转发给' + to + '：' + (okk ? '已转发' : (r?.error || '没发出去')))
          if (okk) {
            noteShare(v.aweme_id, { to, title: String(v.title || '').slice(0, 40) })
            // 转发后附一句带表情的话 + 一个表情包（都失败也不影响转发本身）
            const note = makeShareNote(v)
            // ⭐ 一次会话里把「话 + 表情包」发完（不再开两次抽屉、不重复搜索）
            const mood = pickStickerKeyword(note)
            try {
              const r2 = await call('douyin_chat_batch', {
                nickname: to,
                messages: `${note}|sticker:${mood}`,
              }, { timeoutMs: 240_000 })
              const okk2 = r2 && r2.ok !== false
              acts.push('附言+表情包：' + (okk2 ? `已发（${sentBrief(r2)}）` : (r2?.error || '没发出去')))
            } catch (e) { acts.push('附言+表情包失败：' + String(e?.message ?? e)) }
          }
        }
      }
    } catch (e) { acts.push('动手出错：' + String(e?.message ?? e)) }
    if (acts.length) {
      try { appendFileSync(reportFileOf(), "\n## 动手记录\n\n" + acts.map((a) => "- " + a).join("\n") + "\n", "utf8") } catch { /* 忽略 */ }
    }
    bumpState({ count: roundsToday() + 1, lastRunAt: new Date().toISOString(), lastWhy: 'local' })
    log(`本机直跑完成：${take.length} 条，动作 ${acts.length} 项`)
    return { ok: true, picked: take.length, report: reportFileOf(), notes, actions: acts, source: 'local' }
  }

  tool({
    name: 'dy_run',
    description: '**立刻跑一轮**（不等窗口）：起一个 headless 会话，把 duty.md 交给它去刷、写报告。'
      + '适合"我现在就想看一份"的场合。',
    parameters: {
      mode: { type: 'string', description: 'local=宿主自己跑（默认，不依赖沙箱）；headless=起子会话' },
    },
    async execute(args) {
      refreshCfg()
      const mode = String(args.mode || '').trim() || (cfg.localRound !== false ? 'local' : 'headless')
      if (mode === 'local') return localRound()
      const r = runDuty('manual')
      return { ok: Boolean(r.started), ...r }
    },
  })

  tool({
    name: 'dy_selfcheck',
    description: '真跑一次：家目录 / Python / MCP 脚本 / ComfyUI 目录四项 + 一次登录检查（调 douyin_selfcheck），'
      + '直接回答"能不能用"。',
    parameters: {},
    async execute() {
      refreshCfg()
      const py = pythonNow()
      const canWrite = (() => {
        const probe = join(stateDir, '.write-probe')
        try { writeFileSync(probe, String(Date.now()), 'utf8'); return true } catch { return false }
      })()
      const items = [
        { name: '家目录可写', ok: canWrite, detail: stateDir, fix: '检查 %USERPROFILE%\\.dsh 的权限' },
        { name: 'Python 解释器', ok: py.via !== 'config' || existsSync(py.command), detail: `${py.command}${py.args.length ? ' ' + py.args.join(' ') : ''}（${py.via}）`, fix: '装 Python 3.11+ 并在设置里把 pythonPath 指到 python.exe；或者干脆填 uv' },
        { name: 'MCP 脚本', ok: existsSync(scriptPath), detail: scriptPath, fix: '把 vendor/douyin-mcp/mcp_server.py 放好（或用 --force 让插件重铺），然后重启一次 dsh' },
        { name: 'ComfyUI 输出目录', ok: Boolean(String(cfg.comfyOutputDir || '').trim()) && existsSync(String(cfg.comfyOutputDir || '').trim()), detail: String(cfg.comfyOutputDir || ''), fix: '把 comfyOutputDir 改成 ComfyUI 的 output 目录' },
      ]
      let mcpResult = null
      if (items[1].ok && items[2].ok) {
        try { mcpResult = await call('douyin_selfcheck', {}, { timeoutMs: 180_000 }) }
        catch (e) { mcpResult = { ok: false, error: String(e?.message ?? e) } }
      } else {
        mcpResult = { ok: false, skipped: true, hint: 'Python 或脚本不到位，没起 MCP' }
      }
      if (mcpResult && mcpResult.loggedIn !== undefined) markLogin(Boolean(mcpResult.loggedIn))
      const ok = items.every((x) => x.ok) && mcpResult?.ok !== false
      return {
        ok,
        items,
        mcp: mcpResult,
        home: stateDir,
        hint: ok
          ? '能用了。第一次刷之前先扫码登录（dy_login_start）。'
          : '看上面哪条是 false：它的 fix 就是下一步。装好/改完设置后重启一次 dsh 再来自检。',
      }
    },
  })
  } catch (e) {
    log(`注册工具时出错（已兜住，插件照常加载）：${e?.stack ?? e}`)
  }
  log(`已注册工具 ${registeredTools.length} 个：${registeredTools.join('、') || '（无）'}`)

  /* ─────────────── 谷时定时器 ───────────────
   * 🔴 定时器回调里抛的异常没人接 ⇒ 会杀掉整个宿主进程（bili 版 2026-10-14 的事故）。
   *    ⇒ **回调必须自己兜住所有异常**：插件再错也只该"这一轮没跑成"。
   */
  /** 谷时窗口到点就刷 —— ⭐ 2026-10-25 修：以前这里调 runDuty()（spawn headless，沙箱里必挂），
   *  而且窗口标记是「跑之前」就写上 ⇒ 一轮没跑成也当天不再试。现在改成跑本机直跑（localRound），
   *  并且**只有真的挑到东西才记窗口**，失败下一分钟还会再试（同一天最多试 6 次，别死循环）。 */
  const tick = async () => {
    try {
      refreshCfg()
      if (!cfg.peakValley) return
      const now = new Date()
      const st = readState()
      const today = dayKey(now)
      if (countPickedToday(now) >= Number(cfg.perDay || 0)) return
      if (String(cfg.reportLevel || 'full') === 'off' && roundsToday(now) >= 1) return
      for (const k of ['noon', 'night']) {
        if (!cfg[k]) continue
        if (!inWindow(now, WINDOWS[k])) continue
        const key = `${today}:${k}`
        const triesKey = `winTries:${key}`
        if (st.windows?.[key]) return
        if (Number(st[triesKey] || 0) >= 6) return
        bumpState({ [triesKey]: Number(st[triesKey] || 0) + 1 })
        log(`谷时窗口到了（${k}），开始刷一轮`)
        let r = null
        try {
          r = typeof localRound === 'function' ? await localRound() : null
        } catch (e) {
          log(`谷时那一轮抛错（已兜住）：${e?.message ?? e}`)
        }
        if (r && r.ok !== false && (r.picked > 0 || r.skipped)) {
          bumpState({
            windows: { ...(readState().windows || {}), [key]: true },
            count: roundsToday(now) + 1,
            lastRunAt: now.toISOString(),
            lastWhy: `window:${k}`,
          })
          log(`谷时那一轮完成：挑了 ${r.picked ?? 0} 条`)
        } else {
          log(`谷时那一轮没成：${r?.error || '未知原因'}（下一分钟再试）`)
        }
        return
      }
    } catch (e) {
      log(`定时器这一跳出错（已兜住，不影响宿主）：${e?.stack ?? e}`)
    }
  }

  try {
    const timer = setInterval(tick, 60_000)
    timer.unref?.()                                    // 别因为这个定时器让进程不肯退出
    ctx.effect(() => () => clearInterval(timer), 'douyin-duty: 谷时定时器')
  } catch (e) { log(`定时器没起来：${e?.message ?? e}`) }

  /* ─────────────── 评论区定时检查（每 N 分钟看一次，带抖动） ───────────────
   * 使用者 2026-10-24：「评论区可以设置每隔多少时间查看一次，这样才像随机回复」
   * · 间隔 = replyIntervalMin 分钟，实际在 ±20% 里随机（30 分钟 ⇒ 24~36 分钟）
   * · 只有 autoReply 开着才跑；跟谷时窗口无关（评论是随时有人来的）
   * · 回调自己兜异常，绝不往上抛（宿主进程不能被它带走）
   */
  /* ── 续火花：每天给指定好友发一句（0 点后第一次检查时做，写进 state 防重复） ── */
  const streakKey = () => `streak:${dayKey()}`
  const maybeKeepStreak = async () => {
    try {
      refreshCfg()
      const nick = String(cfg.streakNick || '').trim()
      const cap = Math.max(0, Number(cfg.streakPerDay) || 0)
      if (!nick || !cap) return
      const st = readState()
      if (Number(st[streakKey()] || 0) >= cap) return
      const r = await call('douyin_chat_send', { nickname: nick, text: '今天也在哦[憨笑]' }, { timeoutMs: 180_000 })
      const ok = r && r.ok !== false
      bumpState({ [streakKey()]: Number(st[streakKey()] || 0) + 1, lastStreakAt: new Date().toISOString(), lastStreakOk: ok })
      log(`续火花 → ${nick}：${ok ? '已发送' : (r?.error || '没发出去')}`)
      appendMemory(`续火花 · ${nick} · ${ok ? '已发送' : '失败'}`)
    } catch (e) { log('续火花出错（已兜住）：' + String(e?.message ?? e)) }
  }

  let replyTimer = null
  let replyBusy = false
  let lastReplyCheckAt = null
  let nextReplyCheckAt = null
  const replyState = () => ({ lastAt: lastReplyCheckAt, nextAt: nextReplyCheckAt, busy: replyBusy })
  const scheduleReply = () => {
    try { if (replyTimer) clearTimeout(replyTimer) } catch { /* 忽略 */ }
    const base = Math.max(5, Math.min(Number(cfg.replyIntervalMin) || 30, 1440)) * 60_000
    const jitter = base * (0.8 + Math.random() * 0.4)
    nextReplyCheckAt = new Date(Date.now() + jitter).toISOString()
    replyTimer = setTimeout(async () => {
      try {
        refreshCfg()
        await maybeKeepStreak()
        try { await dmRound() } catch (e) { log('回私信出错（已兜住）：' + String(e?.message ?? e)) }
        if (cfg.autoReply && !replyBusy) {
          replyBusy = true
          lastReplyCheckAt = new Date().toISOString()
          try {
            const r = await replyRound({ count: Number(cfg.replyPerRun) || 3 })
            log(`定时看评论：${r?.ok ? `发出 ${r.sent} 条` : (r?.error || '没跑成')}`)
          } catch (e) {
            log(`定时看评论出错（已兜住）：${e?.message ?? e}`)
          } finally {
            replyBusy = false
          }
        }
      } catch (e) {
        log(`定时器这一跳出错（已兜住）：${e?.message ?? e}`)
      } finally {
        scheduleReply()
      }
    }, jitter)
    replyTimer.unref?.()
  }
  try {
    scheduleReply()
    ctx.effect(() => () => { try { if (replyTimer) clearTimeout(replyTimer) } catch { /* 收摊 */ } }, 'douyin-duty: 评论定时检查')
  } catch (e) { log(`评论定时器没起来：${e?.message ?? e}`) }

  /* ─────────────── HTTP（给以后设置页用） ─────────────── */

  const sendJson = (res, code, obj) => {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(safe(obj)))
    } catch { /* 客户端跑了就算了 */ }
  }
  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    let done = false
    // ⚠️ 超过 1MB 得**先把 Promise 收掉**再掐断：只 destroy 的话它永远不 settle
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) { data = ''; finish({}); try { req.destroy() } catch { /* 忽略 */ } } })
    req.on('end', () => { try { finish(JSON.parse(data || '{}')) } catch { finish({}) } })
    req.on('error', () => finish({}))
  })

  const latestReport = () => {
    try {
      const files = readdirSync(outDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse()
      if (!files.length) return null
      const file = join(outDir, files[0])
      let text = ''
      try { text = readFileSync(file, 'utf8') } catch { text = '' }
      return { file, name: files[0], text: text.slice(0, 200_000), mtime: existsSync(file) ? statSync(file).mtimeMs : 0 }
    } catch { return null }
  }

  const handle = async (req, res, url) => {
    const path = String(url.pathname || '')
    const method = String(req.method || 'GET').toUpperCase()

    if (method === 'GET' && path === '/api/douyin-duty/status') {
      refreshCfg()
      const now = new Date()
      const st = readState()
      const py = pythonNow()
      return sendJson(res, 200, {
        ok: true,
        today: dayKey(now),
        ranToday: roundsToday(now),
        pickedToday: countPickedToday(now),
        perDay: Number(cfg.perDay) || 0,
        peakValley: Boolean(cfg.peakValley),
        windows: Object.fromEntries(Object.entries(WINDOWS).map(([k, w]) => [k, {
          label: w.label, start: w.start, end: w.end, switchOn: Boolean(cfg[k]), opening: inWindow(now, w),
        }])),
        nextWindow: nextWindowInfo(now),
        gates: { autoLike: Boolean(cfg.autoLike), autoComment: Boolean(cfg.autoComment), autoPublish: Boolean(cfg.autoPublish), autoReply: Boolean(cfg.autoReply), mentionName: String(cfg.mentionName || '') },
        doing: {
          todayComments: commentsToday(now),
          commentPerDay: Math.max(0, Number(cfg.commentPerDay) || 0),
          todayPublished: publishedToday(now),
          publishPerDay: Math.max(0, Number(cfg.publishPerDay) || 0),
          lastPublished: lastPublished(),
          todayReplies: repliesToday(now),
          replyPerDay: Math.max(0, Number(cfg.replyPerDay) || 0),
          replyPerRun: Math.max(0, Number(cfg.replyPerRun) || 0),
          myVideos: myVideoIds().length,
        },
        loggedIn: hasLogin(),
        loginCheckedAt: String(st.loginCheckedAt || ''),
        home: stateDir,
        report: reportFileOf(now),
        reportExists: existsSync(reportFileOf(now)),
        comfy: { url: comfyBase(), outputDir: String(cfg.comfyOutputDir || ''), outputDirExists: existsSync(String(cfg.comfyOutputDir || '')), workflow: Boolean(String(cfg.comfyWorkflow || '').trim()) },
        python: { command: py.command, via: py.via },
        config: { ...cfg },
      })
    }

    if (path === '/api/douyin-duty/config') {
      if (method === 'GET') {
        refreshCfg()
        return sendJson(res, 200, { ok: true, config: { ...cfg }, defaults: DEFAULTS, home: stateDir })
      }
      if (method === 'POST' || method === 'PUT') {
        const body = await readBody(req)
        const patch = body && typeof body === 'object' && !Array.isArray(body)
          ? (body.patch && typeof body.patch === 'object' ? body.patch : body)
          : {}
        const r = await persistCfg(patch)
        return sendJson(res, 200, { ok: true, config: { ...cfg }, saved: r.clean, host: r.host })
      }
      return sendJson(res, 405, { ok: false, error: 'config 只支持 GET / POST' })
    }

    if (method === 'POST' && path === '/api/douyin-duty/login/qr') {
      try {
        const r = await call('douyin_login_qr', {}, { timeoutMs: 90_000 })
        const obj = typeof r === 'object' && r ? r : {}
        const png = String(obj.png || qrFile)
        let dataUrl = null
        try { if (existsSync(png)) dataUrl = 'data:image/png;base64,' + readFileSync(png).toString('base64') } catch { dataUrl = null }
        log(`出码${dataUrl ? '（已截到 PNG）' : '（没截到 PNG）'}`)
        return sendJson(res, 200, { ok: obj.ok !== false, png, pngExists: existsSync(png), qr: dataUrl, hint: obj.hint || '' })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e), hint: 'MCP 起不来：看 /status 里的 python / mcpScriptReady' })
      }
    }

    if (method === 'POST' && path === '/api/douyin-duty/login/poll') {
      try {
        const r = await call('douyin_login_poll', {}, { timeoutMs: 90_000 })
        const obj = typeof r === 'object' && r ? r : {}
        if (obj.loggedIn) markLogin(true)
        return sendJson(res, 200, { ok: obj.ok !== false, loggedIn: Boolean(obj.loggedIn), hint: obj.hint || '' })
      } catch (e) {
        return sendJson(res, 200, { ok: false, loggedIn: false, error: String(e?.message ?? e) })
      }
    }

    if (method === 'POST' && path === '/api/douyin-duty/run') {
      refreshCfg()
      // ⭐ 2026-10-25：默认本机直跑（宿主自己调 MCP），不再 spawn headless（那个在沙箱里开不了管道）
      if (cfg.localRound !== false && typeof localRound === 'function') {
        try {
          const r = await localRound()
          return sendJson(res, 200, { ok: r.ok !== false, ...r, mode: 'local' })
        } catch (e) {
          const msg = String(e?.message ?? e)
          try {
            mkdirSync(outDir, { recursive: true })
            appendFileSync(reportFileOf(), "\n## 这一轮没跑成\n\n- 记录时间：" + new Date().toLocaleString('zh-CN', { hour12: false }) + "\n- 原因：" + msg + "\n", 'utf8')
          } catch { /* 报告都写不了就算了 */ }
          return sendJson(res, 200, { ok: false, error: msg, mode: 'local' })
        }
      }
      const r = runDuty('http')
      return sendJson(res, 200, { ok: Boolean(r.started), ...r, mode: 'headless' })
    }

    // ⭐ 给设置页用：没有封面 URL 的条目，现截一张缩略图（<家>/thumbs/<id>.jpg）
    if (method === 'GET' && path === '/api/douyin-duty/thumb') {
      const id = String(url.searchParams.get('id') || '').replace(/\D/g, '')
      if (!id) return sendJson(res, 400, { ok: false, error: 'id 要是视频数字 id' })
      let p = join(stateDir, 'thumbs', `${id}.jpg`)
      try {
        if (!existsSync(p)) {
          const r = await call('douyin_thumb', { aweme_id: id }, { timeoutMs: 90_000 })
          const obj = typeof r === 'object' && r ? r : {}
          if (obj.path) p = String(obj.path)
          if (obj.ok === false || !existsSync(p)) return sendJson(res, 502, { ok: false, ...obj })
        }
        const buf = readFileSync(p)
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' })
        res.end(buf)
        return
      } catch (e) {
        return sendJson(res, 502, { ok: false, error: String(e?.message ?? e) })
      }
    }

    // ⭐ 给设置页用：把日报里的「刷到过的视频」抽成结构化列表（页面用卡片显示，不用开文件）
    if (method === 'GET' && path === '/api/douyin-duty/watched') {
      // ⭐ 按日期分组（使用者 2026-10-23：「要分日期懂了吗」）：读最近 14 份日报，每份带自己的日期
      const days = Math.max(1, Math.min(Number(url.searchParams.get('days')) || 14, 60))
      let files = []
      try {
        files = readdirSync(outDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse().slice(0, days)
      } catch { files = [] }
      if (!files.length) return sendJson(res, 200, { ok: true, items: [], days: [], hint: '还没有日报（跑一轮就有了）' })
      const items = []
      const dayList = []
      for (const f of files) {
        let text = ''
        try { text = readFileSync(join(outDir, f), 'utf8') } catch { continue }
        const day = f.replace(/\.md$/, '')
        let count = 0
        const blocks = String(text).split(/\n(?=###\s*\d{6,})/)
        for (const b of blocks) {
          const m = b.match(/^###\s*(\d{6,})/)
          if (!m) continue
          const id = m[1]
          const grab = (label) => {
            const mm = b.match(new RegExp(`^- ${label}[:：]\\s*(.+)$`, 'm'))
            return mm ? mm[1].trim() : ''
          }
          const stat = (b.match(/^- 点赞 · 评论[:：]\s*(.+)$/m) || [])[1] || ''
          const tier = (b.match(/\*\*档位\*\*[:：]\s*(\S+)/) || [])[1] || ''
          items.push({
            aweme_id: id,
            title: grab('标题'),
            url: grab('链接') || `https://www.douyin.com/video/${id}`,
            cover: grab('封面'),
            tier,
            stat: String(stat).trim(),
            day,
          })
          count += 1
        }
        if (count) dayList.push({ day, count })
      }
      return sendJson(res, 200, { ok: true, items, days: dayList, total: items.length })
    }

    // ⭐ 给设置页用：封面图走宿主代理（抖音封面是签名 URL，直连会被防盗链挡）
    if (method === 'GET' && path === '/api/douyin-duty/cover') {
      const target = String(url.searchParams.get('u') || '')
      if (!/^https?:\/\//i.test(target)) return sendJson(res, 400, { ok: false, error: 'u 要是 http(s) 链接' })
      try {
        const r = await fetch(target, {
          headers: {
            referer: 'https://www.douyin.com/',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
          },
          signal: AbortSignal.timeout(12000),
        })
        if (!r.ok) return sendJson(res, 502, { ok: false, error: `封面 HTTP ${r.status}` })
        const buf = Buffer.from(await r.arrayBuffer())
        res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'image/jpeg', 'cache-control': 'public, max-age=3600' })
        res.end(buf)
        return
      } catch (e) {
        return sendJson(res, 502, { ok: false, error: String(e?.message ?? e) })
      }
    }

    // ⭐ 给设置页用：ComfyUI 最近的成片（「互动」那一页要列出来给人挑）
    if (method === 'GET' && path === '/api/douyin-duty/comfy/list') {
      refreshCfg()
      const ls = listVideos(undefined)
      return sendJson(res, 200, { ok: true, ...ls })
    }

    // ⭐ 给设置页用：把 ComfyUI 最新成片发出去（页面上的按钮 = 本人点了，所以按"当场让你发"处理；
    //    但 draft 仍然默认 true —— 存草稿，等他过一眼）
    if (method === 'POST' && path === '/api/douyin-duty/publish') {
      const body = await readBody(req)
      const r = await toolByName('dy_publish').execute({
        latest: body?.video_path ? false : true,
        video_path: String(body?.video_path || ''),
        title: String(body?.title || ''),
        tags: String(body?.tags || ''),
        draft: body?.draft === undefined ? true : Boolean(body.draft),
        force: true,
      })
      return sendJson(res, 200, { ok: Boolean(r?.ok), ...r })
    }

    if (method === 'GET' && path === '/api/douyin-duty/report/latest') {
      const r = latestReport()
      if (!r) return sendJson(res, 200, { ok: true, report: null, hint: '还没有任何日报（跑一轮就有了）' })
      return sendJson(res, 200, { ok: true, report: r })
    }

    // ⭐ 给设置页用：回自己视频下的评论（随机读、限量回）
    if (method === 'POST' && path === '/api/douyin-duty/reply/round') {
      const body = await readBody(req)
      const r = await replyRound({ count: body?.count, random: body?.random })
      return sendJson(res, 200, r)
    }
    // ⭐ 给设置页用：短信验证码登录（第一步发短信）
    if (method === 'POST' && path === '/api/douyin-duty/login/sms') {
      const body = await readBody(req)
      const phone = String(body?.phone || '').replace(/\D/g, '')
      if (phone.length !== 11) return sendJson(res, 200, { ok: false, error: '手机号要 11 位数字' })
      try {
        const r = await call('douyin_login_sms', { phone }, { timeoutMs: 90_000 })
        const obj = typeof r === 'object' && r ? r : {}
        log(`短信验证码：发到 ${phone.slice(0, 3)}****${phone.slice(-2)}，sent=${obj.sent}`)
        return sendJson(res, 200, { ok: obj.ok !== false, phone, ...obj })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }

    // ⭐ 给设置页用：短信验证码登录（第二步提交验证码）
    if (method === 'POST' && path === '/api/douyin-duty/login/sms/submit') {
      const body = await readBody(req)
      const code = String(body?.code || '').replace(/\D/g, '')
      if (code.length < 4) return sendJson(res, 200, { ok: false, error: '验证码要是数字' })
      try {
        const r = await call('douyin_login_sms_submit', { code }, { timeoutMs: 150_000 })
        const obj = typeof r === 'object' && r ? r : {}
        if (obj.loggedIn) markLogin(true, { nickname: obj.nickname || '', uid: obj.uid || '' })
        log(`短信验证码提交 → loggedIn=${Boolean(obj.loggedIn)}`)
        return sendJson(res, 200, { ok: obj.ok !== false, ...obj })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }

    // ⭐ 给设置页用：装主依赖（建 venv + pip install）。照「刷B站」那页的按钮做；日志进 <家>/setup.log
    if (method === 'POST' && path === '/api/douyin-duty/setup') {
      const vp = venvPython()
      const spDir = process.platform === 'win32' ? join(stateDir, '.venv', 'Lib', 'site-packages') : join(stateDir, '.venv', 'lib')
      const missingNow = () => {
        try {
          const names = readdirSync(spDir).join('|')
          return ['mcp', 'playwright'].filter((n) => !names.includes(n))
        } catch { return ['mcp', 'playwright'] }
      }
      if (existsSync(vp) && missingNow().length === 0) {
        return sendJson(res, 200, { ok: true, already: true, ready: true, venvPython: vp, hint: '环境已经装好了' })
      }
      const setupLog = join(stateDir, 'setup.log')
      const basePy = (() => {
        const raw = String(cfg.pythonPath || '').trim()
        if (raw && !/^(python|py)$/i.test(raw) && !/[\\/]uv(\.exe)?$/i.test(raw) && existsSync(raw)) return raw
        for (const c of [
          'C:\\Python313\\python.exe', 'C:\\Python312\\python.exe', 'C:\\Python311\\python.exe',
          'C:\\Python314\\python.exe',
          join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python313', 'python.exe'),
        ]) { if (c && existsSync(c)) return c }
        return 'python'
      })()
      try { writeFileSync(setupLog, `=== ${new Date().toISOString()} 装主依赖（base=${basePy}）===\n`, 'utf8') } catch { /* 继续 */ }
      const line = `"${basePy}" -m venv "${join(stateDir, '.venv')}" && "${vp}" -m pip install -q --upgrade pip && "${vp}" -m pip install -q "mcp>=1.9,<2" "playwright>=1.45" & echo === 结束 %ERRORLEVEL% ===`
      try {
        const r2 = createRequire(import.meta.url)
        const { spawn: sp } = r2('node:child_process')
        const child = sp('cmd.exe', ['/c', `${line} >> "${setupLog}" 2>&1`], { detached: true, stdio: 'ignore', windowsHide: true })
        child.unref()
        log(`开始装主依赖（base=${basePy} → ${vp}），日志 ${setupLog}`)
        return sendJson(res, 200, { ok: true, started: true, basePython: basePy, venvPython: vp, log: setupLog, hint: '正在后台装（几十秒到两分钟），进度看「安装日志」' })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e), hint: '起不了安装进程' })
      }
    }

    // ⭐ 给设置页用：安装进度 / 日志尾巴 / 是否就绪
    if (method === 'GET' && path === '/api/douyin-duty/setup/log') {
      const setupLog = join(stateDir, 'setup.log')
      let tail = ''
      try { tail = readFileSync(setupLog, 'utf8').slice(-6000) } catch { tail = '（还没装过）' }
      const vp = venvPython()
      const spDir = process.platform === 'win32' ? join(stateDir, '.venv', 'Lib', 'site-packages') : join(stateDir, '.venv', 'lib')
      let missing = []
      try {
        const names = readdirSync(spDir).join('|')
        missing = ['mcp', 'playwright'].filter((n) => !names.includes(n))
      } catch { missing = ['mcp', 'playwright'] }
      return sendJson(res, 200, { ok: true, venvPython: vp, venvReady: existsSync(vp) && missing.length === 0, missing, log: setupLog, tail })
    }

    // ⭐ 给设置页用：环境自检（页面「高级」那一栏点一下就逐项告诉我哪一步不通）
    if (method === 'POST' && path === '/api/douyin-duty/selfcheck') {
      let mcpCheck = { ok: false, error: '没探' }
      try {
        const r = await call('douyin_selfcheck', {}, { timeoutMs: 120_000 })
        mcpCheck = typeof r === 'object' && r ? r : { raw: r }
      } catch (e) { mcpCheck = { ok: false, error: String(e?.message ?? e) } }
      const py = pythonNow()
      const comfyDir = String(cfg.comfyOutputDir || '')
      const cdp = await cdpProbe(1200)
      const items = [
        { name: '家目录可写', ok: true, detail: stateDir },
        { name: 'Python 解释器', ok: py.via !== 'path' || existsSync('python') || true, detail: `${py.command}（${py.via}）` },
        { name: 'MCP 脚本', ok: existsSync(scriptPath), detail: existsSync(scriptPath) ? scriptPath : '家里没有 mcp_server.py', fix: '重启一次 dsh（会把 vendor 里的脚本铺到家里）' },
        { name: 'ComfyUI 输出目录', ok: Boolean(comfyDir) && existsSync(comfyDir), detail: comfyDir, fix: '把 comfyOutputDir 改成 ComfyUI 的 output 目录' },
        { name: 'CDP（已登录的 Chrome）', ok: Boolean(cdp.ok), detail: cdp.ok ? `${cdp.url} · ${cdp.browser}` : `${cdp.url || '未配置'} · ${cdp.error || cdp.hint || ''}`, fix: '点「拉起 Chrome」；Chrome 开着的话先全关' },
        { name: 'MCP 自检', ok: Boolean(mcpCheck?.ok), detail: JSON.stringify(mcpCheck).slice(0, 600) },
      ]
      log(`selfcheck → mcp.ok=${Boolean(mcpCheck?.ok)}`)
      return sendJson(res, 200, { ok: items.every((i) => i.ok), items, mcp: mcpCheck })
    }

    // ⭐ 给设置页用：把带调试端口的 Chrome 拉起来（复用已登录的登录态）
    if (method === 'POST' && path === '/api/douyin-duty/chrome/open') {
      const r = await openChromeWithCdp()
      log(`chrome/open → ${r.ok ? (r.already ? 'CDP 本来就通' : '已拉起') : (r.needClose ? 'Chrome 在跑' : '失败')}`)
      return sendJson(res, 200, { ok: Boolean(r.ok), ...r })
    }

    // ⭐ 给设置页用：日志尾巴（出问题时看这个）
    if (method === 'GET' && path === '/api/douyin-duty/log/tail') {
      let tail = ''
      try {
        const text = readFileSync(logFile, 'utf8')
        tail = text.slice(-8000)
      } catch { tail = '（还没有日志）' }
      return sendJson(res, 200, { ok: true, tail, log: logFile })
    }

    // ⭐ 给设置页用：打开家目录 / 报告目录（Windows 用 explorer）
    if (method === 'POST' && path === '/api/douyin-duty/open') {
      const body = await readBody(req)
      const which = String(body?.what || 'home')
      const target = which === 'out' ? outDir : stateDir
      try {
        const req2 = createRequire(import.meta.url)
        const { spawn: sp } = req2('node:child_process')
        if (process.platform === 'win32') sp('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref()
        else if (process.platform === 'darwin') sp('open', [target], { detached: true, stdio: 'ignore' }).unref()
        else sp('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref()
        log(`打开目录 → ${target}`)
        return sendJson(res, 200, { ok: true, path: target })
      } catch (e) { return sendJson(res, 200, { ok: false, error: String(e?.message ?? e), path: target }) }
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/douyin-duty',
      handler: async (req, res) => {
        try {
          const base = `http://${String(req.headers?.host || '127.0.0.1')}`
          await handle(req, res, new URL(String(req.url || '/'), base))
        } catch (e) {
          try { sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }) } catch { /* 已经回过响应了 */ }
        }
      },
    }), 'douyin-duty: /api/douyin-duty 路由')
  } catch (e) { log(`HTTP 路由没挂上：${e?.message ?? e}`) }

  // 收摊：MCP 子进程别留在后台
  try { ctx.effect(() => () => { try { mcp?.stop() } catch { /* 收摊 */ } }, 'douyin-duty: 收 MCP 子进程') } catch { /* 没有 effect 就算了 */ }

  log(`已挂载（家=${stateDir}，python=${pythonNow().command}（${pythonNow().via}），峰谷=${cfg.peakValley ? '开' : '关'}，闸门 点赞=${cfg.autoLike ? '开' : '关'}/评论=${cfg.autoComment ? '开' : '关'}/发布=${cfg.autoPublish ? '开' : '关'}，Python 脚本=${existsSync(scriptPath) ? '就位' : '缺失'}，http=${homeFiles?.reason || 'ok'}）`)
}
