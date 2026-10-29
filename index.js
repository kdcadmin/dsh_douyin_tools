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
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { withActionLock, execution, confirmed } from './lib/actions.mjs'
import { join, dirname, resolve, relative, isAbsolute } from 'node:path'
import { coverUrl, fetchCover } from './lib/covers.mjs'
import { runCommand } from './lib/process.mjs'
import { createActionProxy } from './lib/action-proxy.mjs'
import { findDesktopCli } from './lib/dsh-cli.mjs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { McpClient } from './lib/mcp.mjs'
import { normalizeDmMessage, dmMessageKey, dmMessagePreview, dmMessageContext } from './lib/dm-messages.mjs'
import { WINDOWS, stateDirOf, readJson, writeJson, ensureHomeFiles, ensureCharter, charterPath, inWindow, dayKey } from './lib/state.mjs'

export const name = 'douyin-life'
export const inject = ['webServer', 'tools', 'settings', 'llm', 'credentials', 'attachments']

// 插件目录（读本地 package.json 的版本号，检查更新用）
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

function versionTuple(v) {
  return String(v || '').replace(/^v/i, '').split('.').map((n) => Number(n) || 0)
}

function cmpVersion(a, b) {
  const x = versionTuple(a)
  const y = versionTuple(b)
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0)
  }
  return 0
}

// 检查更新：对比本地 package.json 与 GitHub 仓库里的版本
async function checkUpdate() {
  let local = ''
  try {
    local = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).version || ''
  } catch {
    /* 读不到就当未知 */
  }
  const url = 'https://github.com/kdcadmin/dsh_douyin_tools'
  try {
    const res = await fetch('https://api.github.com/repos/kdcadmin/dsh_douyin_tools/contents/package.json', {
      headers: { 'User-Agent': 'dsh-douyin-life', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error('GitHub HTTP ' + res.status)
    const j = await res.json()
    const txt = Buffer.from(String(j.content || '').replace(/\s+/g, ''), 'base64').toString('utf8')
    const latest = JSON.parse(txt).version || ''
    return { ok: true, local, latest, hasUpdate: cmpVersion(latest, local) > 0, url, checkedAt: new Date().toISOString() }
  } catch (e) {
    return { ok: false, local, latest: '', hasUpdate: false, url, error: String(e?.message || e) }
  }
}

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
  /** 分享后的附言交给模型写（默认开；关掉=用模板） */
  modelShareNote: z.boolean().default(true).extra('volatile', true),
  replyPerDay: z.natural().default(10).extra('volatile', true),
  /** 白天也回（不限谷时窗口） */
  replyAllDay: z.boolean().default(true).extra('volatile', true),
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
  /** 动手前先真看片（转写）——只对要评论/转发的视频做，点赞不转写 */
  watchBeforeAct: z.boolean().default(true).extra('volatile', true),
  /** 转写最多听前多少秒（跳着看就靠它；默认 90） */
  watchSeconds: z.natural().default(90).extra('volatile', true),
  /** 看片抽多少帧（默认 10，按整片均匀抽） */
  watchFrames: z.natural().default(10).extra('volatile', true),
  /** 一轮最多挑几条（别一口气刷完） */
  pickPerRound: z.natural().default(2).extra('volatile', true),
  /** 自动评论（**不@人**，就是普通评论一句） */
  autoCommentPlain: z.boolean().default(false).extra('volatile', true),
  /** 每天最多发几条普通评论 */
  plainCommentPerDay: z.natural().default(10).extra('volatile', true),
  /** 允许「主动发消息」的人（昵称，逗号分隔；留空=谁都不主动发）。回复别人的消息不受这个限制 */
  msgAllowTo: z.string().default('').extra('volatile', true),
  /** 自动回复私信（别人发来消息就回一条） */
  /** 只回谁的私信（昵称，逗号分隔；空 = 谁发来都回） */
  dmReplyOnlyTo: z.string().default('').extra('volatile', true),
    dmReply: z.boolean().default(false).extra('volatile', true),
    /** 私信后台静默自动回复（由插件自己盯，不占对话） */
    dmAutoReply: z.boolean().default(true).extra('volatile', true),
  /** 和指定人聊天：多少秒看一次私信（和陌生人巡检完全分开） */
  dmAutoIntervalSec: z.natural().default(15).extra('volatile', true),
  /** 每个联系人每天最多回几条 */
  dmReplyPerContact: z.natural().default(1).extra('volatile', true),
  /** 每天最多回几条私信（所有人合计） */
  dmReplyPerDay: z.natural().default(5).extra('volatile', true),
  /** 私信快回：直接走 DSH 自己的 llm 服务（低思考模型），目标 1~3 秒 */
  dmFastReply: z.boolean().default(true).extra('volatile', true),
  /** 快回用的 provider / model（留空 = 用当前默认模型） */
  dmFastProvider: z.string().default('').extra('volatile', true),
  dmFastModel: z.string().default('').extra('volatile', true),
  /** 快回的思考档位：off / low / 留空 = 模型默认 */
  dmFastReasoning: z.string().default('off').extra('volatile', true),
  /** 转发视频时附带的一句话（留空=从内置几句里随机；可带 [笑哭] 这类表情码） */
  /** 转发后是否顺带发一条消息 + 一个表情包（同一个开关） */
  shareWithNote: z.boolean().default(true).extra('volatile', true),
  shareNote: z.string().default('').extra('volatile', true),
  /** 回评论时看多久以内的作品（1=只回今天发的；30=连老作品的新评论一起回） */
  replyWorksDays: z.natural().default(3).extra('volatile', true),
  /** 定期清理：每天一次，删临时目录、老缩略图，日志轮转 */
  autoClean: z.boolean().default(true).extra('volatile', true),
  /** 遇到直播就跳过（默认开） */
  skipLive: z.boolean().default(true).extra('volatile', true),
  /** 转发视频给谁（昵称；留空=不转发） */
  shareToNick: z.string().default('').extra('volatile', true),
  /** 续火花：每天给谁发一句（昵称；留空=不续） */
  /** 续火花发的表情包关键词（默认大肥鱼） */
  streakSticker: z.string().default('大肥鱼').extra('volatile', true),
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
  /** ⭐ 浏览器模式：默认留空 = 用插件自己的持久 profile（第一次扫码一次，开箱即用）。
   *    想复用「本人已登录的 Chrome」才填 `http://127.0.0.1:9222`（并先 dy_chrome_open）。 */
  cdpUrl: z.string().default('').extra('volatile', true),
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
  /** Python 半边共享的调试端口：按家目录派生，两个实例不会抢同一个 9333 */
  const profilePort = (() => {
    const env = Number(process.env.DOUYIN_PROFILE_PORT)
    if (Number.isInteger(env) && env >= 1024 && env <= 65535) return env
    let h = 2166136261
    for (const ch of stateDir) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
    return 9300 + (h % 600)
  })()
  const videoLabDir = join(pluginDir, 'video-understanding-lab')

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
    autoLike: false, autoComment: false, autoPublish: false, autoClean: true, replyWorksDays: 3,
    mentionName: '', commentPerRound: 1, keywords: [],
    pythonPath: 'python', dshBin: '', headlessProfile: 'headless', overlayMcp: true,
    workspace: '', reportLevel: 'full',
    personaPrompt: '',
    memory: true,
    autoReply: false, replyPerRun: 3, replyPerDay: 10, replyAllDay: true, replyRandom: true, replyVideoIds: '', replyOneShot: true, myNickname: '', modelShareNote: true, replyOncePerUser: false, replyIntervalMin: 30, skipLive: true, shareToNick: '', streakSticker: '大肥鱼', streakNick: '', streakPerDay: 1, askDoubao: false,
    headlessModel: '',
    shareWithNote: true, shareNote: '', sharePerDay: 10, pickPerRound: 2, watchBeforeAct: true, watchSeconds: 90, watchFrames: 10, skipOverMin: 60, skimOverMin: 5, autoCommentPlain: false, plainCommentPerDay: 10, msgAllowTo: '', dmAutoReply: true, dmAutoIntervalSec: 15, dmReply: false, dmReplyOnlyTo: '', dmReplyPerContact: 1, dmReplyPerDay: 5, dmFastReply: true, dmFastProvider: '', dmFastModel: '', dmFastReasoning: 'off', dmFastVision: true, dmFastVisionModel: 'qwen3-vl-plus', dmFastImageAttach: true, dmAssumeInbound: true, localRound: true,
    comfyUrl: 'http://127.0.0.1:8188',
    comfyOutputDir: 'E:\\Comfy-Desktop\\ComfyUI-Shared\\output',
    comfyWorkflow: '', comfyWaitSeconds: 900, comfyListLimit: 20, publishDraft: true,
    commentPerDay: 10, publishPerDay: 1, publishTitle: '', publishTags: '',
    cdpUrl: '', cdpPort: 9222, chromePath: '',
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
      else if (typeof base[k] === 'number') { const n = Number(v); if (Number.isInteger(n) && n >= 0) out[k] = n }
      else if (typeof base[k] === 'boolean') { if (typeof v === 'boolean') out[k] = v }
      else if (typeof base[k] === 'string') { if (typeof v === 'string') out[k] = v }
    }
    return out
  }

  /** 「设置里能写什么范围」只有这一份 —— HTTP 接口、dy_config、读配置三处都走它 */
  const clampPatch = (patch) => {
    const p = { ...patch }
    for (const [k, v] of Object.entries(p)) {
      if (!(k in DEFAULTS)) throw new Error(`未知配置字段：${k}`)
      const base = DEFAULTS[k]
      if (typeof base === 'boolean' && typeof v !== 'boolean') throw new Error(`${k} 必须是布尔值`)
      if (typeof base === 'number' && (!Number.isInteger(v) || v < 0)) throw new Error(`${k} 必须是非负整数`)
      if (typeof base === 'string' && typeof v !== 'string') throw new Error(`${k} 必须是字符串`)
      if (Array.isArray(base) && (!Array.isArray(v) || v.some(x => typeof x !== 'string'))) throw new Error(`${k} 必须是字符串数组`)
    }
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
    if ('replyAllDay' in p) p.replyAllDay = Boolean(p.replyAllDay)
    if ('replyRandom' in p) p.replyRandom = Boolean(p.replyRandom)
    if ('replyVideoIds' in p) p.replyVideoIds = String(p.replyVideoIds || '').replace(/[^0-9,\s]/g, '').slice(0, 400)
    if ('replyOneShot' in p) p.replyOneShot = Boolean(p.replyOneShot)
    if ('myNickname' in p) p.myNickname = String(p.myNickname || '').slice(0, 40)
    if ('replyIntervalMin' in p) p.replyIntervalMin = Math.max(5, Math.min(Number(p.replyIntervalMin) || 30, 1440))
    if ('replyOncePerUser' in p) p.replyOncePerUser = Boolean(p.replyOncePerUser)
    if ('modelShareNote' in p) p.modelShareNote = Boolean(p.modelShareNote)
    if ('skipLive' in p) p.skipLive = Boolean(p.skipLive)
    if ('replyWorksDays' in p) p.replyWorksDays = Math.max(1, Math.min(Number(p.replyWorksDays) || 1, 90))
    if ('autoClean' in p) p.autoClean = Boolean(p.autoClean)
    if ('shareNote' in p) p.shareNote = String(p.shareNote || '').slice(0, 80)
    if ('sharePerDay' in p) p.sharePerDay = Math.max(0, Math.min(Number(p.sharePerDay) || 0, 50))
    if ('pickPerRound' in p) p.pickPerRound = Math.max(1, Math.min(Number(p.pickPerRound) || 1, 5))
    if ('watchBeforeAct' in p) p.watchBeforeAct = Boolean(p.watchBeforeAct)
    if ('watchSeconds' in p) p.watchSeconds = Math.max(15, Math.min(Number(p.watchSeconds) || 90, 600))
    if ('watchFrames' in p) p.watchFrames = Math.max(3, Math.min(Number(p.watchFrames) || 10, 48))
    if ('skipOverMin' in p) p.skipOverMin = Math.max(1, Math.min(Number(p.skipOverMin) || 60, 600))
    if ('skimOverMin' in p) p.skimOverMin = Math.max(1, Math.min(Number(p.skimOverMin) || 5, 120))
    if ('autoCommentPlain' in p) p.autoCommentPlain = Boolean(p.autoCommentPlain)
    if ('plainCommentPerDay' in p) p.plainCommentPerDay = Math.max(0, Math.min(Number(p.plainCommentPerDay) || 0, 30))
    if ('msgAllowTo' in p) p.msgAllowTo = String(p.msgAllowTo || '').slice(0, 200)
    if ('dmReplyOnlyTo' in p) p.dmReplyOnlyTo = String(p.dmReplyOnlyTo || '').slice(0, 120)
    if ('dmReply' in p) p.dmReply = Boolean(p.dmReply)
    if ('dmAutoReply' in p) p.dmAutoReply = Boolean(p.dmAutoReply)
    if ('dmAutoIntervalSec' in p) p.dmAutoIntervalSec = Math.max(5, Math.min(Number(p.dmAutoIntervalSec) || 15, 120))
    if ('dmReplyPerContact' in p) p.dmReplyPerContact = Math.max(1, Math.min(Number(p.dmReplyPerContact) || 1, 10))
    if ('dmReplyPerDay' in p) p.dmReplyPerDay = Math.max(0, Math.min(Number(p.dmReplyPerDay) || 0, 100))
    if ('dmFastReply' in p) p.dmFastReply = Boolean(p.dmFastReply)
    if ('dmFastProvider' in p) p.dmFastProvider = String(p.dmFastProvider || '').slice(0, 40)
    if ('dmFastModel' in p) p.dmFastModel = String(p.dmFastModel || '').slice(0, 120)
    if ('dmFastReasoning' in p) p.dmFastReasoning = String(p.dmFastReasoning || '').slice(0, 20)
    if ('localRound' in p) p.localRound = Boolean(p.localRound)
    if ('askDoubao' in p) p.askDoubao = Boolean(p.askDoubao)
    if ('shareToNick' in p) p.shareToNick = String(p.shareToNick || '').slice(0, 40)
    if ('streakSticker' in p) p.streakSticker = String(p.streakSticker || '大肥鱼').slice(0, 20)
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
  /** 宿主设置写失败时，这些键以本地 config.json 为准（避免下次读回宿主旧值） */
  const readLocalOnly = () => {
    try {
      const raw = readJson(cfgFile, {})
      return new Set(Array.isArray(raw._localOnly) ? raw._localOnly.filter((k) => typeof k === 'string') : [])
    } catch { return new Set() }
  }
  const writeLocalOnly = (set) => {
    try {
      const raw = readJson(cfgFile, {})
      writeJson(cfgFile, { ...raw, _localOnly: [...set] })
    } catch { /* 写不了就下次再说 */ }
  }

  /**
   * 配置怎么合：**插件面板/config.json 存过的键 > DSH 原生设置页 > 默认值**。
   * （桌面版里 apply 收到的那份 config 是挂载时的快照，写进去的值不会热刷新 ⇒ 必须靠 describe() 的 value）
   */
  const loadCfg = () => {
    const saved = savedCfg()
    const localOnly = readLocalOnly()
    const row = settingsDesc()
    if (!row) return clampPatch(saved)
    const user = row.user || {}
    const out = normalize(row.value && typeof row.value === 'object' ? row.value : config, { ...DEFAULTS })
    for (const k of Object.keys(DEFAULTS)) {
      out[k] = localOnly.has(k)
        ? saved[k]
        : (user[k] !== undefined && typeof user[k] === typeof DEFAULTS[k] ? user[k] : saved[k])
    }
    return clampPatch(out)
  }

  const cfg = loadCfg()
  /** 配置随时可能被设置页改掉 ⇒ 每个入口用之前重算一遍（cfg 这个对象要一直指向同一份） */
  const refreshCfg = () => { try { Object.assign(cfg, loadCfg()) } catch (e) { log(`重读配置失败（沿用旧值）：${e?.message ?? e}`) } }

  const saveCfg = (patch) => {
    Object.assign(cfg, normalize(patch, cfg))
    for (const k of Object.keys(patch || {})) if (k in DEFAULTS) touchedKeys.add(k)
    const localOnly = readLocalOnly()
    writeJson(cfgFile, { ...cfg, _set: [...touchedKeys], _localOnly: [...localOnly] })
  }

  const saveCfgHost = async (patch) => {
    if (typeof ctx.settings?.update !== 'function') return { ok: false, error: '宿主没有 settings.update' }
    try {
      const row = settingsDesc(true)
      if (!row?.ns) return { ok: false, error: '宿主里没有可写的设置表单（值只落在 config.json）' }
      await ctx.settings.update(row.ns, patch, row.revision)
      return { ok: true, ns: row.ns }
    } catch (e) {
      const msg = String(e?.message ?? e)
      // revision 过期（设置页开着太久 / 别处改过）→ 取最新 revision 再试一次
      if (/revision|stale|conflict/i.test(msg)) {
        try {
          const row2 = settingsDesc(true)
          if (row2?.ns) {
            await ctx.settings.update(row2.ns, patch, row2.revision)
            return { ok: true, ns: row2.ns, retried: true }
          }
        } catch (e2) {
          log(`写 DSH 设置重试仍失败：${e2?.message ?? e2}`)
        }
      }
      log(`写 DSH 设置失败（本地那份仍然生效）：${msg}`)
      return { ok: false, error: msg }
    }
  }

  /** 落配置的唯一入口：插件自己那份 + DSH 原生设置那份，钳完范围一起写 */
  const persistCfg = async (patch) => {
    const clean = clampPatch(patch)
    saveCfg(clean)
    const host = await saveCfgHost(clean)
    // 宿主写失败时把键记成「本地优先」，否则下次 loadCfg 会被宿主旧值盖回去
    const keys = Object.keys(clean)
    const localOnly = readLocalOnly()
    for (const k of keys) { if (host.ok) localOnly.delete(k); else localOnly.add(k) }
    writeLocalOnly(localOnly)
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
  const captchaFlagFile = join(stateDir, '.need-captcha')
  const hasCaptchaFlag = () => { try { return existsSync(captchaFlagFile) } catch { return false } }
  const mcpKeyNow = () => { const p = pythonNow(); return `${p.command}|${p.args.join(' ')}|${scriptPath}|${cfg.cdpUrl}|${hasCaptchaFlag() ? 'headed' : 'headless'}|${existsSync(scriptPath) ? statSync(scriptPath).mtimeMs : 0}` }

  const ensureMcp = async () => {
    if (mcp && mcpKey === mcpKeyNow()) return mcp
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
        DOUYIN_ALLOW_WRITES: '1',
        // ⭐ 2026-10-27：平时无头静默；一旦检测到验证码，就切成带界面让本人手动过（过完自动切回）
        DOUYIN_HEADLESS: hasCaptchaFlag() ? '0' : '1',
        DOUYIN_CDP_URL: String(cfg.cdpUrl || ''),
        // 多实例隔离：每个家目录一个独立端口；视频理解原型也用这个端口连同一份浏览器
        DOUYIN_PROFILE_PORT: String(profilePort),
        DOUYIN_VIDEO_LAB: videoLabDir,
        TEMP: join(stateDir, '.tmp'),
        TMP: join(stateDir, '.tmp'),
        TMPDIR: join(stateDir, '.tmp'),
      }),
      log,
    })
    return mcp
  }

  const WRITE_TOOLS = new Set(['douyin_like', 'douyin_comment', 'douyin_publish', 'douyin_share_video', 'douyin_chat_send', 'douyin_chat_sticker', 'douyin_chat_batch'])
  // ⭐ 自己发出去的消息必须留底：判断「回没回」靠它，而不是靠页面方向识别
  const dmSentFile = join(stateDir, 'dm-sent.json')
  const readDmSent = () => {
    try { const raw = JSON.parse(readFileSync(dmSentFile, 'utf8')) || {}; return Array.isArray(raw.items) ? raw.items : [] } catch { return [] }
  }
  const rememberDmSent = (text) => {
    const s = String(text || '').replace(/\s+/g, ' ').trim()
    if (!s) return
    try {
      const items = readDmSent()
      items.push({ text: s, at: Date.now() })
      writeFileSync(dmSentFile, JSON.stringify({ items: items.slice(-300) }, null, 1), 'utf8')
    } catch { /* 记不上就算 */ }
  }

  const call = async (toolName, args = {}, opts) => {
    if (toolName === 'douyin_chat_send' && args && args.text) rememberDmSent(args.text)
    else if (toolName === 'douyin_chat_sticker') rememberDmSent('[表情]')
    else if (toolName === 'douyin_chat_batch' && args && args.messages) {
      try { for (const p of JSON.parse(args.messages)) rememberDmSent(p && p.kind === 'sticker' ? '[表情]' : (p && p.text) || '') } catch { /* 解析不了就算 */ }
    }
    const invoke = async () => {
      const client = await ensureMcp()
      const r = await client.call(toolName, args, opts)
      if (r?.runtime) client.lastRuntime = r.runtime
      return r && typeof r === 'object' && !Array.isArray(r) && typeof r.ok === 'boolean'
        ? r : { ok: false, error: 'MCP 返回格式无效', phase: 'protocol' }
    }
    if (!WRITE_TOOLS.has(toolName)) return invoke()
    return withActionLock(stateDir, async () => {
      refreshCfg()
      const context = execution.getStore() || {}
      if (context.origin === 'headless' && toolName === 'douyin_publish' && cfg.publishDraft) args = { ...args, draft: true }
      const force = context.force === true
      if (context.origin === 'headless' && toolName === 'douyin_publish') {
        try {
          const path = realpathSync(resolve(String(args.video_path || '')))
          const rel = relative(realpathSync(resolve(cfg.comfyOutputDir)), path)
          if (!String(cfg.comfyOutputDir).trim() || rel.startsWith('..') || isAbsolute(rel) || !path.toLowerCase().endsWith('.mp4')) throw new Error('目录外的文件')
        } catch { return { ok: false, blocked: true, error: 'headless 只能投稿已配置 ComfyUI 输出目录里的现有 MP4' } }
      }
      const aid = String(args.aweme_id || '').match(/\d{6,}/)?.[0] || ''
      const nick = String(args.nickname || '').trim()
      let kind = toolName, key = '', cap = Infinity, used = 0, allowed = false
      if (toolName === 'douyin_like') {
        kind = 'like'; key = `${kind}:${aid}:${Boolean(args.undo)}`; allowed = cfg.autoLike && Boolean(aid)
      } else if (toolName === 'douyin_comment') {
        if (args.reply_cid) {
          kind = 'reply'; key = `${kind}:${args.reply_cid}`; cap = cfg.replyPerDay; used = repliesToday()
          allowed = cfg.autoReply && (await todayVideoIds()).ids.includes(aid)
          args = { ...args, text: String(args.text || '').slice(0, 20), mention: '' }
        } else {
          kind = args.mention ? 'comment' : 'plain'; key = `top:${aid}`
          cap = kind === 'comment' ? cfg.commentPerDay : cfg.plainCommentPerDay
          used = kind === 'comment' ? commentsToday() : plainCommentsToday()
          allowed = kind === 'comment' ? cfg.autoComment && String(args.mention).trim() === String(cfg.mentionName || '').trim() && Boolean(String(cfg.mentionName || '').trim()) : cfg.autoCommentPlain
          if (readLedger().comments.some(c => String(c.aweme_id) === aid) || readLedger().plainComments[aid]) allowed = false
        }
      } else if (toolName === 'douyin_share_video') {
        kind = 'share'; key = `${kind}:${nick}:${aid}`; cap = cfg.sharePerDay; used = sharesToday(); allowed = allowInitiate(nick) && Boolean(aid)
      } else if (toolName === 'douyin_publish') {
        kind = 'publish'; key = `${kind}:${videoKey(args.video_path)}:${args.draft ? 'draft' : 'published'}`
        cap = cfg.publishPerDay; used = publishedToday(); allowed = cfg.autoPublish
      } else {
        kind = context.inbound ? 'dmReply' : context.streak ? 'streak' : 'message'
        key = context.inbound ? `dm:${context.inbound.messageId}:${nick}` : context.streak ? `streak:${dayKey()}:${nick}` : `message:${randomUUID()}`
        allowed = context.inbound ? cfg.dmReply && context.inbound.name === nick : allowInitiate(nick)
        if (context.inbound) {
          cap = allowInitiate(nick) ? Infinity : cfg.dmReplyPerDay
          used = Object.values(readLedger().dm).filter(r => r.day === dayKey() && !r.exempt).reduce((n, r) => n + (r.count || 0), 0)
        } else if (context.streak) { cap = cfg.streakPerDay; used = Number(readState()[streakKey()] || 0) }
        else if (context.origin === 'headless') {
          // 白名单里的人（「可以主动发消息的人」）聊天不占每日额度，否则聊两句就被卡死
          cap = allowInitiate(nick) ? Infinity : cfg.dmReplyPerDay
          key = `headless-message:${dayKey()}:${nick}:${createHash('sha256').update(JSON.stringify(args)).digest('hex')}`
          // 表情包允许反复发（同样的关键词也不该被当成重复动作）
          if (toolName === 'douyin_chat_sticker') key += ':' + randomUUID()
        }
      }
      if (!allowed && !force) return { ok: false, blocked: true, error: '动作未获授权、目标不在名单、作品不属于本人或已发送', kind }
      const ledger = readLedger()
      const old = ledger.actions[key]
      if (old && ['pending', 'unknown', 'succeeded'].includes(old.status) && !force) {
        return { ok: false, already: old.status === 'succeeded', status: old.status, error: old.status === 'succeeded' ? '该动作已完成，未重复发送' : '此前发送状态待核对，未自动重发' }
      }
      const uncertain = Object.values(ledger.actions).filter(a => a.day === dayKey() && a.kind === kind && ['pending','unknown'].includes(a.status)).length
      used = Math.max(used, Object.values(ledger.actions).filter(a => a.day === dayKey() && a.kind === kind && a.status === 'succeeded').length)
      if (!force && used + uncertain >= Number(cap)) return { ok: false, blocked: true, cap, error: '该动作今日额度已用完或有待确认发送' }
      if (context.origin === 'headless') {
        const roundCap = kind === 'comment' || kind === 'plain' ? cfg.commentPerRound : kind === 'reply' ? cfg.replyPerRun : Infinity
        const roundUsed = Object.values(ledger.actions).filter(a => a.runId === context.runId && (['comment','plain'].includes(kind) ? ['comment','plain'].includes(a.kind) : a.kind === kind) && a.status !== 'failed').length
        if (roundUsed >= roundCap) return { ok: false, blocked: true, error: '本轮动作额度已用完' }
        if (aid && !['publish','reply'].includes(kind) && !ledger.picks[`${dayKey()}:${aid}`]) {
          if (countWatchedToday() >= Number(cfg.perDay || 0)) return { ok: false, blocked: true, error: '今日看片额度已用完' }
          ledger.picks[`${dayKey()}:${aid}`] = { day: dayKey(), aweme_id: aid, source: 'headless-action', runId: context.runId }
        }
      }
      if (force) key += ':' + randomUUID()
      ledger.actions[key] = { day: dayKey(), at: new Date().toISOString(), runId: context.runId || '', kind, status: 'pending', awemeId: aid, peer: nick }
      writeLedger(ledger) // Failure here prevents the external side effect.
      let result
      try { result = await invoke() } catch (e) { result = { ok: false, status: 'unknown', error: String(e?.message || e) } }
      // 分享这类动作：只要确实点了分享（clicked），就算操作过，允许上层继续补附言；
      // 但仍然标 unknown，不谎报「已确认」。
      if (kind === 'share' && result && result.clicked && !confirmed(result)) {
        result = { ...result, ok: true, status: 'unknown', error: '已点击分享（回执未确认）' }
      } else if (result.ok && !confirmed(result)) result = { ...result, ok: false, status: 'unknown', error: '已操作但未取得平台确认，未记成功且不会自动重发' }
      const next = readLedger()
      next.actions[key] = { ...next.actions[key], status: confirmed(result) ? 'succeeded' : ['unknown','partial'].includes(result.status) ? 'unknown' : 'failed', finishedAt: new Date().toISOString(), platformId: result.cid || result.messageId || result.platformId || result.aweme_id || '' }
      writeLedger(next)
      if (confirmed(result)) {
        if (kind === 'comment') noteComment({ aweme_id: aid, text: args.text })
        if (kind === 'plain') notePlainComment(aid, args.text)
        if (kind === 'reply') noteReply(args.reply_cid, { aweme_id: aid, text: args.text, ok: true })
        if (kind === 'share') noteShare(aid, { to: nick })
        if (kind === 'publish') notePublish(videoKey(args.video_path), { video: args.video_path, title: args.title, draft: args.draft, url: result.url || '', awemeId: result.aweme_id || '', draftId: result.draftId || '' })
      }
      return result
    })
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
    const wrapped = defineTool({
    ...spec,
    output: textOutput,
    async execute(args, exec) {
      let out
      try {
        const input = args && typeof args === 'object' ? args : {}
        out = await withActionLock(stateDir, () => execution.run({ tool: spec.name, force: input.force === true && ['dy_like', 'dy_comment', 'dy_publish'].includes(spec.name) }, async () => {
          refreshCfg()
          if (!readJson(ledgerFile, {}).picksMigrated) writeLedger(readLedger())
          migrateReplyIndex()
          return spec.execute(input, exec)
        }))
      } catch (e) {
        out = { ok: false, error: String(e?.message ?? e) }
        log(`工具 ${spec.name} 抛错（已兜住）：${e?.stack ?? e}`)
      }
      try { log(`工具 ${spec.name} → ${brief(out)}`) } catch { /* 日志失败不影响结果 */ }
      return safe(out)
    },
    })
    toolSpecs.set(spec.name, wrapped)
    return ctx.tools.register(wrapped)
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
    const l = readLedger()
    // ⭐ 只算真的挑过/看过的；headless 的「动作记录」不算挑中（它们只是 prevent-repeat 用的）
    const real = Object.values(l.picks).filter(p => p.day === dayKey(now) && String(p.source || '') !== 'headless-action').length
    return Math.max(Number(l.pickFloor?.[dayKey(now)] || 0), real)
  }
  /** ⭐ 额度按「真看过片（转写过）」算：没兴趣跳过的不占额度 */
  const countWatchedToday = (now = new Date()) => {
    try {
      const day = dayKey(now)
      return Object.values(readLedger().picks).filter(p => p.day === day && p.watched).length
    } catch { return 0 }
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
    let j = {}
    if (existsSync(ledgerFile)) {
      try { j = JSON.parse(readFileSync(ledgerFile, 'utf8')) } catch { throw new Error('账本损坏，请恢复备份；已停止自动发送') }
      if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('账本格式无效')
    }
    for (const name of ['published','replies','shares','plainComments','dm','actions','picks','pickFloor']) {
      if (j[name] !== undefined && (!j[name] || typeof j[name] !== 'object' || Array.isArray(j[name]))) throw new Error('账本字段无效：' + name)
      if (name !== 'pickFloor' && j[name] && Object.values(j[name]).some(v => !v || typeof v !== 'object' || Array.isArray(v))) throw new Error('账本记录无效：' + name)
    }
    if (j.comments !== undefined && (!Array.isArray(j.comments) || j.comments.some(v => !v || typeof v !== 'object'))) throw new Error('账本 comments 格式无效')
    const published = j && typeof j.published === 'object' && j.published ? j.published : {}
    const comments = Array.isArray(j?.comments) ? j.comments : []
    const replies = j && typeof j.replies === 'object' && j.replies ? j.replies : {}
    const l = { ...j, schemaVersion: 2, published, comments, replies, shares: j.shares || {}, plainComments: j.plainComments || {}, dm: j.dm || {}, actions: j.actions || {}, picks: j.picks || {} }
    if (!j.picksMigrated) {
      for (const f of readdirSync(outDir).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))) {
        const day = f.slice(0, 10)
        const text = readFileSync(join(outDir, f), 'utf8').replace(/```[\s\S]*?```/g, '')
        for (const m of text.matchAll(/^###[ \t]+(\d{6,})/gm)) l.picks[`${day}:${m[1]}`] = { day, aweme_id: m[1], source: 'legacy-report' }
      }
      const st = readState()
      l.pickFloor = st.day ? { [st.day]: Number(st.picked || 0) } : {}
      l.picksMigrated = true
    }
    return l
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
    if (l.comments.some(c => c.aweme_id === rec.aweme_id && c.reply_to === rec.reply_to)) return
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
  /** 私信回复库：大白鲸口吻——短句、调皮、会撒娇、爱自嘲，不写客服话 */
  const DM_LINES = {
    greet: ['在的在的[憨笑]', '诶？我在呢[害羞]', '哟，你找我呀[比心]', '嗯？怎么了嘛[憨笑]'],
    praise: ['嘿嘿，被夸到了[害羞]', '你再夸我要翘尾巴了[憨笑]', '就这点好，被你看出来了[比心]'],
    complain: ['我错了嘛[捂脸]', '别凶我，我认错[害羞]', '好好好，我改[憨笑]', '那你教教我呗[捂脸]'],
    question: ['这个我懂，我说给你听[憨笑]', '问得好，我刚好知道[比心]', '嗯……让我想想再答你[害羞]'],
    emoji: ['你发表情我就懂了[憨笑]', '哈哈，收到[笑哭]', '这个表情我存了[比心]'],
    laugh: ['笑死，我也觉得[笑哭]', '哈哈哈你怎么这么逗[捂脸]'],
    night: ['早点睡哦，别熬[害羞]', '晚安啦，明天见[比心]'],
    fallback: ['收到啦[憨笑]', '嗯嗯，我在[害羞]', '好，记下了[比心]', '我这会儿有点笨，但我在听[捂脸]'],
  }
  const pickDmReply = (text) => {
    const s = String(text || '')
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
    if (/(晚安|睡了|困了)/.test(s)) return pick(DM_LINES.night)
    if (/(你好|在吗|在不在|hi|hello)/i.test(s)) return pick(DM_LINES.greet)
    if (/(好看|可爱|厉害|喜欢|棒|牛)/.test(s)) return pick(DM_LINES.praise)
    if (/(傻|笨|呆|不对|错|气死|烦)/.test(s)) return pick(DM_LINES.complain)
    if (/(吗|呢|怎么|为啥|为什么|多少|什么|能不能|有没有)/.test(s)) return pick(DM_LINES.question)
    if (/(哈哈|笑|乐)/.test(s)) return pick(DM_LINES.laugh)
    if (/\[/.test(s)) return pick(DM_LINES.emoji)
    return pick(DM_LINES.fallback)
  }

  /** 表情包关键词：什么话配什么表情（只有「大肥鱼」系列是现成的） */
  const pickStickerKeyword = (note) => {
    const s = String(note || '')
    // 现在素材库只有「大肥鱼」一套；可爱/搞笑的都往这套里挑，语气上再配
    if (/可爱|好看|颜值|买/.test(s)) return '大肥鱼'
    if (/笑|哈哈|笑死/.test(s)) return '大肥鱼'
    if (/总结|讲|收获|有用/.test(s)) return '大肥鱼'
    return '大肥鱼'
  }
  const sentBrief = (r) => {
    const arr = Array.isArray(r?.sent) ? r.sent : []
    return arr.join(' / ').slice(0, 40) || 'ok'
  }
  const makeMentionComment = (video, mention) => {
    const text = String(video?.transcript || video?.title || '').replace(/\s+/g, ' ').slice(0, 70)
    return `@${mention} 这条提到「${text}」，你可能感兴趣。`
  }
  const makePlainComment = (video, topComment) => {
    const text = String(video?.transcript || '').replace(/\s+/g, ' ').slice(0, 65)
    if (text) return `听到这里提到「${text}」${video?.skim ? '，这是采样片段。' : '。'}`
    return `看到标题提到「${String(video?.title || '').slice(0, 45)}」。`
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
    .filter((r) => r && r.ok === true && r.day === dayKey(now)).length
  /** 回过的 cid 索引（一行一个，只有宿主导入；不进模型上下文，所以不费 token） */
  const replyIndexFile = join(stateDir, 'replied-cids.txt')
  const migrateReplyIndex = () => {
    const ledger = readLedger()
    if (ledger.replyIndexMigrated) return
    const failed = new Set(), succeeded = new Set()
    const collect = (replies) => {
      for (const [cid, r] of Object.entries(replies || {})) {
        if (r?.ok === false) failed.add(cid)
        if (r?.ok === true) succeeded.add(cid)
      }
    }
    collect(ledger.replies)
    const archive = join(stateDir, 'ledger')
    let visited = 0
    if (existsSync(archive)) for (const year of readdirSync(archive).filter(x => /^\d{4}$/.test(x))) {
      for (const month of readdirSync(join(archive, year)).filter(x => /^\d{2}$/.test(x))) {
        for (const file of readdirSync(join(archive, year, month)).filter(x => /^\d{2}\.json$/.test(x))) {
          if (++visited > 5000) throw new Error('回复索引迁移超出归档上限，需人工检查')
          const data = JSON.parse(readFileSync(join(archive, year, month, file), 'utf8'))
          collect(data.replies)
        }
      }
    }
    if (existsSync(replyIndexFile)) {
      const ids = readFileSync(replyIndexFile, 'utf8').split(/\r?\n/).filter(cid => cid && (!failed.has(cid) || succeeded.has(cid)))
      const temp = replyIndexFile + '.tmp'
      try { writeFileSync(temp, [...new Set(ids)].join('\n') + (ids.length ? '\n' : ''), 'utf8'); renameSync(temp, replyIndexFile) }
      finally { try { rmSync(temp, { force: true }) } catch {} }
    }
    ledger.replyIndexMigrated = true
    writeLedger(ledger)
  }
  const readReplyIndex = () => {
    try {
      const failed = new Set(Object.entries(readLedger().replies).filter(([,r]) => r.ok === false).map(([cid]) => cid))
      return new Set(readFileSync(replyIndexFile, 'utf8').split(/\r?\n/).filter(cid => cid && !failed.has(cid)))
    } catch { return new Set() }
  }
  const appendReplyIndex = (cid) => {
    try { if (!readReplyIndex().has(String(cid))) appendFileSync(replyIndexFile, String(cid) + '\n', 'utf8') } catch { /* 成功账本仍可去重 */ }
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
      // Keep records active until the archive is durably written.
    }
    const keep = []
    for (const c of l.comments || []) {
      const d = String(c?.day || today).slice(0, 10)
      if (d === today) { keep.push(c); continue }
      if (!byDay.has(d)) byDay.set(d, { replies: {}, comments: [] })
      byDay.get(d).comments.push(c)
    }
    for (const [d, bucket] of byDay) {
      if (moveToDayFile(d, bucket.replies, bucket.comments)) {
        for (const cid of Object.keys(bucket.replies)) delete l.replies[cid]
      } else keep.push(...bucket.comments)
    }
    l.comments = keep
    return l
  }
  const repliedCids = () => new Set([...readReplyIndex(), ...Object.entries(readLedger().replies || {}).filter(([, r]) => r.ok === true).map(([cid]) => cid)])
  /** 回过谁（昵称归一化）+ 索引文件，给「同一个人只回一次」用 */
  const normUser = (u) => String(u || '').replace(/[\u200B-\u200D\uFE0E\uFE0F\s（）()【】]/g, '').toLowerCase()
  /** 回复去重的身份 = 人 + 评论原文：同一人发新评论要回，同一条评论不回 */
  const pairKey = (user, text) => normUser(user) + '\u0001' + String(text || '').replace(/\s+/g, ' ').trim()
  const repliedUsersFile = join(stateDir, 'replied-users.txt')
  const readRepliedUsers = () => {
    const s = new Set()
    try {
      for (const line of readFileSync(repliedUsersFile, 'utf8').split(/\r?\n/)) if (line.trim()) s.add(line.trim())
    } catch { /* 没文件 */ }
    for (const r of Object.values(readLedger().replies || {})) if (r?.ok === true && r?.user) s.add(normUser(r.user))
    return s
  }
  const appendRepliedUser = (user) => {
    const n = normUser(user)
    if (!n) return
    try { appendFileSync(repliedUsersFile, n + '\n', 'utf8') } catch { /* 记不上不影响 */ }
  }
  /** 我自己在抖音的昵称（用来跳过"我自己的评论/我自己的回复"） */
  const myNames = () => {
    const raw = [String(cfg.myNickname || ''), String(readState().nickname || '')]
    return new Set(raw.map((s) => s.replace(/[\s（）()【】]/g, '')).filter(Boolean))
  }
  const isMine = (user) => {
    const norm = String(user || '').replace(/[\u200B-\u200D\uFE0E\uFE0F\s（）()【】]/g, '')
    if (!norm) return false
    for (const n of myNames()) if (norm === n) return true
    return false
  }
  /** 我回过的句子（用来兜底：万一账本丢了，看到自己那句就不再回） */
  const myReplyTexts = () => new Set(Object.values(readLedger().replies || {}).map((r) => String(r?.text || '').trim()).filter(Boolean))
  const noteReply = (cid, rec) => {
    const l = readLedger()
    l.replies = l.replies || {}
    l.replies[String(cid)] = { day: dayKey(), at: new Date().toISOString(), ...rec }
    writeLedger(pruneLedger(l))
    if (rec.ok === true) appendReplyIndex(cid)
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
      const r = await call('douyin_my_posts', { days: Math.max(1, Math.min(Number(cfg.replyWorksDays) || 3, 90)) }, { timeoutMs: 90_000 })
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
    const fixed = String(cfg.shareNote || '').trim()
    if (fixed) return fixed
    const transcript = String(video?.transcript || '').replace(/\s+/g, ' ').trim()
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
    if (transcript) {
      // 截到句读位置，别卡在半句话
      let cut = transcript.slice(0, 70)
      const m = cut.match(/^(.{24,70}?)[。！？!?.,，]/)
      if (m) cut = m[1]
      const lines = [
        '刚看了个视频，里面说「' + cut + '」，笑死，给你看看。',
        '这个有点意思：「' + cut + '」——你也看看。',
        '刷到个视频，讲的「' + cut + '」，我看完有点想笑，发你。',
        '看到一句「' + cut + '」，配这视频绝了，你瞅瞅。',
      ]
      return pick(lines)
    }
    const full = String(video?.title || '').replace(/\s+/g, ' ').trim()
    const t = full.length > 60 ? full.slice(0, 60) + '…' : full
    return t ? '标题提到「' + t + '」，分享给你看看。' : '这个我觉得挺有意思，分享给你看看。'
  }

  /** 这个人允不允许我「主动」发消息（白名单，空=谁都不许）；回复别人的消息不走这个 */
  // 昵称里常带 emoji，同一个 emoji 可能有/没有 U+FE0F 变体符，肉眼一样但字符串不等 ⇒ 统一归一化再比
  const normNick = (s) => String(s || '')
    .replace(/[\u200B-\u200D\uFE0E\uFE0F]/g, '')
    .replace(/[\s\u00A0]/g, '')
    .toLowerCase()
  const allowInitiate = (name) => {
    const list = String(cfg.msgAllowTo || '').split(/[,，、\r\n]+/).map((s) => s.trim()).filter(Boolean)
    if (!list.length) return false
    const key = normNick(name)
    return Boolean(key) && list.some(n => normNick(n) === key)
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
    else t = [`我懂你意思${e}`, `谢谢你的留言${e}`, `嗯…你说得对${e || ''}`, `收到，记下了${e}`][Math.floor(Math.random() * 4)]
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
  const replyRound = ({ count, random } = {}) => withActionLock(stateDir, async () => {
    refreshCfg()
    if (!cfg.autoReply) return { ok: false, blocked: true, error: '自动回复评论已关闭' }
    if (Number(count ?? cfg.replyPerRun) === 0) return { ok: true, sent: 0, today: repliesToday(), perDay: cfg.replyPerDay }
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
        list = (Array.isArray(r?.items) ? r.items : []).map((c, i) => ({ ...c, __idx: i }))
      } catch (e) {
        out.push({ aweme_id: v, ok: false, error: String(e?.message ?? e) })
        continue
      }
      const myTexts = myReplyTexts()
      const repliedPairs = new Set()
      try {
        for (const rec of Object.values(readLedger().replies || {})) {
          if (rec && rec.user && rec.comment) repliedPairs.add(pairKey(rec.user, rec.comment))
        }
      } catch { /* 没账本 */ }
      const seenThisRound = new Set()
      // 图文作品的评论：没有 cid，且页面上点不到「回复」（抖音图文页不展开评论面板）
      // 别硬试、别占额度 —— 直接在报告里写清楚「图文作品暂不支持回复」
      const cidless = list.filter((c) => c && !String(c.cid || '').trim())
      if (cidless.length && !list.some((c) => String(c.cid || '').trim())) {
        out.push({ aweme_id: v, ok: true, skipped: `图文作品：读到 ${cidless.length} 条评论，但回复入口点不到（暂不支持回复）` })
        continue
      }
      let fresh = list.filter((c) => {
        if (!c) return false
        const cid = String(c.cid || ('idx:' + v + ':' + (c.__idx ?? -1)))
        if (seenThisRound.has(cid)) return false
        if (isMine(c.user)) return false                       // 我自己发的评论/回复
        const txt = String(c.text || '').trim()
        const media = normalizeDmMessage(c).attachments
        if (!txt && !media.length) return false
        if (doneCids.has(cid)) return false
        if (myTexts.has(txt)) return false                      // 兜底：那是我回过的句子
        // ⭐ 去重只看「人 + 评论原文」：同人新评论要回；同一人同一条评论才跳过
        if (txt && !media.length && repliedPairs.has(pairKey(c.user, txt))) return false
        seenThisRound.add(cid)
        return true
      })
      if (!fresh.length) { out.push({ aweme_id: v, ok: true, skipped: '这个视频没有新评论' }); continue }
      if (rand) fresh = shuffle(fresh)
      // ⭐ 回评论直接用模型（不再有开关/按钮）：把「视频 + 评论 + 共享记忆」交给 headless，
      //    让它像大肥鱼本人一样回，而不是套「我懂你意思」模板。
      {
        const picks = fresh.slice(0, Math.max(1, want - out.filter((x) => x.sent).length))
        let memo = ''
        try {
          const mr = await call('memory_recent', { limit: 12 }, { timeoutMs: 30_000 })
          if (mr && mr.ok !== false && Array.isArray(mr.items)) memo = mr.items.map((x) => '- ' + String(x.content || '').replace(/\s+/g, ' ').slice(0, 100)).join('\n')
        } catch { /* 没有记忆也能回 */ }
        const list = picks.map((c, i) => `${i + 1}) 评论者：${c.user || ''} aweme_id=${v} reply_cid=${String(c.cid || '')}\n${dmMessageContext(normalizeDmMessage({ ...c, messageId: c.cid }), '评论')}`).join('\n')
        const prompt = [
          '你是「大白鲸（爱吃白饭版）」，使用者叫你大肥鱼。这是你自己视频下面新来的评论，你要像本人一样逐条回一句。',
          memo ? `你记得的事：\n${memo}\n` : '',
          `要回的评论：\n${list}\n`,
          '规则：',
          '- 每条回复 ≤20 字，口语、有情绪，别用「我懂你意思」「谢谢支持」这类模板；',
          '- 对方聊敏感的（政治/医疗/法律/隐私/黄赌毒/荐股）就委婉拒掉；',
          '- 用 douyin_comment(aweme_id, text, reply_cid) 逐条回复；cid 必须用上面给的；',
          '- 只回这些评论，不要点赞、不要发新评论、不要刷视频、不要写文件；回完就结束。',
        ].join('\n')
        const r = await runDuty('reply', { prompt, countRound: false })
        out.push({ aweme_id: v, ok: true, delegated: true, candidates: picks.length, started: Boolean(r?.started), error: r?.error })
        break
      }
      for (const c of fresh.slice(0, Math.max(1, want - out.filter((x) => x.sent).length))) {
        const { text, sensitive } = pickReply(c.text)
        try {
          const payload = { aweme_id: v, text, mention: '' }
          if (String(c.cid || '').trim()) payload.reply_cid = String(c.cid)
          else payload.reply_index = Number(c.__idx ?? -1)     // 图文作品的评论没有 cid，按序号回
          const r = await call('douyin_comment', payload, { timeoutMs: 150_000 })
          const okk = confirmed(r)
          const prev = (readLedger().replies || {})[String(c.cid)] || {}
          noteReply(c.cid, { aweme_id: v, user: String(c.user || ''), text, sensitive, ok: okk, attempts: Number(prev.attempts || 0) + 1, comment: String(c.text || '').trim() })
          if (okk) appendRepliedUser(c.user)
          out.push({ aweme_id: v, cid: String(c.cid), comment: String(c.text || '').slice(0, 40), reply: text, sensitive, sent: okk, error: okk ? undefined : (r?.error || '没发出去') })
        } catch (e) {
          const prev2 = (readLedger().replies || {})[String(c.cid)] || {}
          noteReply(c.cid, { aweme_id: v, user: String(c.user || ''), text, sensitive, ok: false, attempts: Number(prev2.attempts || 0) + 1, comment: String(c.text || '').trim(), error: String(e?.message ?? e).slice(0, 80) })
          out.push({ aweme_id: v, cid: String(c.cid), reply: text, sent: false, error: String(e?.message ?? e) })
        }
      }
    }
    // 一次性附加 id 用完即清（只限这一次）
    if (out.some(x => x.sent) && (got.extras || []).length && cfg.replyOneShot === true) {
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
  })

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

  /** ⭐ 私信聊天记录同步进记忆：格式固定「我: …」/「dsh: …」 */
  const appendDmMemory = (name, userText, replyText, when = new Date()) => {
    const day = dayKey(when)
    const hhmm = when.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
    const block = [
      `\n## ${day} ${hhmm} · 私信 · ${name}`,
      `我: ${String(userText || '').replace(/\s+/g, ' ').trim().slice(0, 300)}`,
      `大肥鱼: ${String(replyText || '').replace(/\s+/g, ' ').trim().slice(0, 300)}`,
    ].join('\n') + '\n'
    appendMemory(block)
    // ⭐ 同时写进「记忆插件」的 memory.db（聊天/视频共用同一份记忆）
    try {
      call('memory_write', {
        content: `我: ${String(userText || '').trim().slice(0, 300)}\n大肥鱼: ${String(replyText || '').trim().slice(0, 300)}`,
        type: 'fact',
        tags: `私信,${name}`,
        importance: 0.7,
        workspace_path: process.cwd(),
      }, { timeoutMs: 30_000 }).catch(() => {})
    } catch { /* 写不进也不影响聊天 */ }
  }
  /** ⭐ 视频互动也同步进记忆：分享/看片/评论都记一行 */
  const appendVideoMemory = (kind, video, extra = '') => {
    const title = String(video?.title || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    const tr = String(video?.transcript || '').replace(/\s+/g, ' ').trim().slice(0, 120)
    const line = `[视频] ${kind} · ${video?.aweme_id || ''} · ${title}${tr ? ' · 转写: ' + tr : ''}${extra ? ' · ' + extra : ''}`
    appendMemory(line)
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
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore','pipe','ignore'] })
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
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
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
      const entry = h[id]
      if (!entry) continue
      const status = entry.status || {}
      const msgs = Array.isArray(status.messages) ? status.messages : []
      if (status.status_str === 'error' || msgs.some((m) => Array.isArray(m) && m[0] === 'error')) {
        throw new Error('ComfyUI 执行出错：' + JSON.stringify(status).slice(0, 300))
      }
      if (status.completed === true || status.status_str === 'success') {
        log(`ComfyUI 出片完成（prompt_id=${id}）`)
        const paths = []
        const root = resolve(cfg.comfyOutputDir)
        for (const output of Object.values(entry.outputs || {})) {
          for (const media of [...(output.videos || []), ...(output.gifs || [])]) {
            if (media.type !== 'output' || !/\.mp4$/i.test(media.filename || '')) continue
            const path = resolve(root, media.subfolder || '', media.filename)
            const rel = relative(root, path)
            if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('ComfyUI 输出路径越界')
            if (existsSync(path) && statSync(path).isFile()) paths.push(path)
          }
        }
        if (paths.length !== 1) throw new Error(`当前工作流有 ${paths.length} 个有效 MP4 输出，请显式指定 video_path`)
        return { ok: true, promptId: id, source, video: paths[0] }
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
      for (const spec of ['@deepseek-ai/dsh/lib/bin.js']) {
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
    if (!existsSync(String(cfg.dshBin || '').trim())) {
      const desktop = findDesktopCli({ pluginDir })
      if (desktop) return desktop
    }
    const cli = dshCliCached()
    if (cli) return { command: process.execPath, args: [cli], shell: false }
    const hint = '请将 dshBin 指向当前安装目录内实际存在的 dsh/lib/bin.js，旧路径不会执行'
    if (!hasDshOnPath()) {
      log('⚠️ 找不到 dsh（常见位置、应用目录、PATH 里都没有）⇒ ' + hint)
      return { missing: true, hint }
    }
    log('⚠️ 没在常见位置找到 dsh，最后试一下 PATH 里的 `dsh` ⇒ ' + hint)
    return { missing: true, hint: 'PATH 只有 shell 启动器；请将 dshBin 指向实际 CLI bin.js，避免通过 shell 拼接提示词' }
  }

  /* ─────────────── 跑一轮 ─────────────── */

  const mcpWhitelist = () => {
    refreshCfg()
    const names = ['douyin_feed','douyin_hot','douyin_hot_videos','douyin_search','douyin_video','douyin_comments','douyin_my_posts','douyin_watch','douyin_thumb','douyin_check_credential','memory_write','memory_recent','memory_context']
    if (cfg.autoLike) names.push('douyin_like')
    if (cfg.autoComment || cfg.autoCommentPlain || cfg.autoReply) names.push('douyin_comment')
    if (cfg.autoPublish) names.push('douyin_publish')
    if (String(cfg.msgAllowTo || '').trim()) names.push('douyin_share_video','douyin_chat_send','douyin_chat_sticker','douyin_chat_batch')
    return names
  }

  /**
   * 给 headless 那一轮写一份 overlay —— 把抖音 MCP 挂上去。
   * 某个 profile 能拿到什么工具取决于它自己那层的 patch；分发给别人时不能要求人家改 profile，
   * 所以插件自己生成一份、跑的时候 `--patch` 带上。
   */
  const ensureOverlay = (proxy) => {
    const file = join(stateDir, 'headless-overlay.yml')
    const posix = (p) => String(p).replace(/\\/g, '/').replace(/'/g, "''")
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
          '    provider: ' + JSON.stringify(selProvider),
          '    model: ' + JSON.stringify(selModel),
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
        "          DOUYIN_ALLOW_WRITES: '1'",
        "          DOUYIN_PROXY_URL: '" + proxy.url + "'",
        "          DOUYIN_PROXY_TOKEN: '" + proxy.token + "'",
        `          DOUYIN_MCP_TOOLS: '${mcpWhitelist().join(',')}'`,
        `          TEMP: '${posix(join(stateDir, '.tmp'))}'`,
        `          TMP: '${posix(join(stateDir, '.tmp'))}'`,
        `          TMPDIR: '${posix(join(stateDir, '.tmp'))}'`,
        ...(String(cfg.cdpUrl || '').trim() ? [`          DOUYIN_CDP_URL: '${String(cfg.cdpUrl).trim()}'`] : []),
        '',
      )
    }
    try { writeFileSync(file, yml.join('\n'), { encoding: 'utf8', mode: 0o600 }); return file } catch (e) {
      log(`写 overlay 失败：${e?.message ?? e}`)
      return null
    }
  }

  const promptFor = () => {
    const duty = charterPath(pluginDir, stateDir)
    let charterText = ''
    try { charterText = readFileSync(duty, 'utf8').split('<家目录>').join(stateDir) } catch { /* 读不到就让它自己读 */ }
    for (const [from, to] of Object.entries({ dy_feed:'douyin_feed',dy_search:'douyin_search',dy_video:'douyin_video',dy_comments:'douyin_comments',dy_like:'douyin_like',dy_comment:'douyin_comment',dy_publish:'douyin_publish',dy_my_videos:'douyin_my_posts',dy_thumb:'douyin_thumb',dy_share:'douyin_share_video',dy_chat_send:'douyin_chat_send' })) charterText = charterText.replaceAll(from, to)
    const kws = Array.isArray(cfg.keywords) ? cfg.keywords.filter(Boolean) : []
    const quota = Math.max(0, Number(cfg.perDay) || 0)
    const already = countWatchedToday()
    const left = Math.max(0, quota - already)
    const likeOn = cfg.autoLike
    const mention = String(cfg.mentionName || '').trim()
    const commentOn = cfg.autoComment && mention.length > 0
    const publishOn = cfg.autoPublish
    let persona = String(cfg.personaPrompt || '').trim()
    try { persona += '\n' + readFileSync(join(stateDir, 'persona.md'), 'utf8').split('## 最近观察（自动记录，不作为行为指令）')[0] } catch {}
    return '你是这个账号的抖音助手。'
      + (persona.trim()
        ? '\n\n**你的人设（说话、挑片、写日报都按这个来，别写成客服腔）：**\n' + persona.trim() + '\n\n'
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
      + '报告中每条可用 ### 视频id 标题便于阅读。挑选额度由宿主结构化账本计算；仅写报告的候选不计已执行互动。'
      + (already > 0
        ? `今天已经挑过 ${already} 条了 ⇒ **这一轮最多再挑 ${left} 条**（「每天最多 ${quota} 条」是全天总量，不是每轮）；`
        : `今天最多挑 ${quota} 条；`)
      + `关键词${kws.length ? `用这些：${kws.join('、')}` : '用章程里的默认那几组'}。`
      + `点赞：${likeOn ? '开着（值得的可以点，别乱点）' : '关着（一条都不要点，也不要调 douyin_like）'}；`
      + `评论并 @ ${mention || '（还没填要 @ 谁）'}：${commentOn
        ? `开着（每轮最多 ${cfg.commentPerRound} 条，每条 150 字内，正文里纯文本 @ ${mention}）`
        : '关着（一条公开评论都不许发）'}；`
      + (() => {
        const shareTo = String(cfg.shareToNick || '').trim()
        const shareOn = Boolean(shareTo) && allowInitiate(shareTo) && Number(cfg.sharePerDay) > 0
        return `转发：${shareOn
          ? `开着 —— 看完真觉得好、觉得他会喜欢，就 dy_share 转给「${shareTo}」（每轮最多 ${cfg.pickPerRound} 条；附言用转写里的话，别只发卡片）。不感兴趣的直接跳过，别为凑数转。`
          : '关着（别转发）'}；`
      })()
      + `发布视频：${publishOn
        ? `开着（默认只存草稿：${cfg.publishDraft ? '是，等本人过一眼' : '否，会真发出去'}）`
        : '关着（这条别碰，也不要调 dy_publish）'}。`
      + '只使用 overlay 实际暴露的 douyin_* 工具；dy_comfy_list、dy_reply_round 不在本会话中，不要反复调用。发表回复用 douyin_comment 的 reply_cid；投稿必须提供实际 video_path，草稿以宿主设置为准。选中并记录前须调用 douyin_watch，成功后由宿主记入挑选账本。'
      + '工具经本机宿主执行，宿主会强制额度、对象名单和幂等检查。公开普通评论开关=' + cfg.autoCommentPlain + '；回复开关=' + cfg.autoReply + '。只有工具明确 ok=true 且 verified=true 才能写已发送；unknown 不重发。不得直接执行浏览器脚本、启动其他 MCP 或改写账本。最后汇报结果。'
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
  /** 每天清一次 / 回私信（同样先声明后赋值，避免作用域问题） */
  let maybeClean = null
  let dmRound = null

  let runningHeadless = null
  const runDuty = async (why = 'window', opts = {}) => {
    if (runningHeadless) return { started: false, why, error: '已有 headless 轮次在运行', runId: runningHeadless.runId }
    const run = { runId: randomUUID(), child: null, proxy: null, timer: null }
    runningHeadless = run
    const finish = async (code, error = '') => {
      if (run.finished) return
      try { if (typeof opts.onFinish === 'function') opts.onFinish(code, error, run) } catch { /* 回调别影响收尾 */ }
      run.finished = true
      clearTimeout(run.timer)
      // Remove credentials before allowing a new run to create an overlay.
      try { rmSync(join(stateDir, 'headless-overlay.yml'), { force: true }) } catch {}
      await run.proxy?.close()
      if (runningHeadless === run) runningHeadless = null
      await withActionLock(stateDir, async () => {
        bumpState({ ...(opts.countRound !== false && code === 0 && !error ? { count: roundsToday() + 1, lastRunAt: new Date().toISOString(), lastWhy: 'headless' } : {}), headless: { runId: run.runId, status: code === 0 && !error ? 'completed' : 'failed', code, error, finishedAt: new Date().toISOString() } })
        stubReportIfMissing(code)
        rotateLogIfBig()
      })
    }
    try {
      refreshCfg()
      const tmpDir = join(stateDir, '.tmp')
      try { mkdirSync(tmpDir, { recursive: true }) } catch { /* 建不了就让 Playwright 报 */ }
      const dsh = resolveDsh()
      if (dsh.missing) {
        const msg = '这一轮没跑：找不到 dsh。' + dsh.hint
        log(msg)
        try { stubReportIfMissing(1) } catch { /* 补不上也不影响这句话已经进日志 */ }
        await finish(1, msg)
        return { started: false, why, error: msg }
      }
      refreshCfg()
      if (!cfg.overlayMcp) {
        const error = 'headless 必须开启 overlayMcp，才能接入宿主受控工具'
        await finish(1, error)
        return { started: false, why, error }
      }
      run.proxy = await createActionProxy({
        allowed: () => new Set(mcpWhitelist()),
        execute: (name, args) => withActionLock(stateDir, () => execution.run({ origin: 'headless', runId: run.runId, force: false }, async () => {
          const key = dayKey() + ':' + String(args.aweme_id || '')
          if (name === 'douyin_watch' && !readLedger().picks[key] && (countWatchedToday() >= Number(cfg.perDay || 0) || Object.values(readLedger().picks).filter(p => p.runId === run.runId && p.watched).length >= cfg.pickPerRound)) return { ok: false, blocked: true, error: '今日看片额度已用完' }
          const result = await call(name, args, { timeoutMs: name === 'douyin_watch' ? 900_000 : 300_000 })
          // ⭐ 只有平台明确确认的发送才记在 run 上；私信收尾时用这个判断「真回了没」
          if (name === 'douyin_chat_send' && confirmed(result)) {
            run.lastReply = { text: String(args.text || '').slice(0, 300), at: Date.now(), messageId: String(result.messageId || '') }
          }
          if (name === 'douyin_chat_send' && result.status === 'unknown') run.dmSendUnknown = true
          if (name === 'douyin_watch' && result.ok) {
            const l = readLedger()
            const prev = l.picks[key] || { day: key.slice(0, 10), aweme_id: String(args.aweme_id), source: 'headless-watch', runId: run.runId, at: new Date().toISOString() }
            l.picks[key] = { ...prev, watched: true }
            writeLedger(l)
          }
          return result
        })),
      })
      const overlay = ensureOverlay(run.proxy)
      if (!overlay) throw new Error('无法写入 headless overlay')
      const args = [...dsh.args, '--profile', cfg.headlessProfile || 'headless']
      if (overlay) args.push('--patch', overlay)
      args.push(opts.prompt || promptFor())
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
          DSH_DOUYIN_HOME: stateDir,
          DOUYIN_PROFILE_PORT: String(profilePort),
          DOUYIN_VIDEO_LAB: videoLabDir,
          // ⭐ 2026-10-25：headless 那轮被宿主的文件沙箱挡住写系统 Temp，
          //    Playwright 的 mkdtemp 直接 EPERM。把 TMP/TEMP/TMPDIR 指到家目录下就绕开了。
          TEMP: tmpDir,
          TMP: tmpDir,
          TMPDIR: tmpDir,
          // ⭐ 2026-10-25：headless 子进程默认在受限沙箱里跑，Playwright 给 driver 开命名管道
          //    （\\.\\pipe\\…）被拒 ⇒ EPERM。这两行把它放开到完整访问，实测 douyin_whoami 能通。

          ...(String(cfg.cdpUrl || '').trim() ? { DOUYIN_CDP_URL: String(cfg.cdpUrl).trim() } : {}),
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          ...dsh.env,
        }),
      })
      run.child = child
      run.timer = setTimeout(() => { child.kill(); finish(1, 'headless 超过 30 分钟').catch(e => log(e.message)) }, 30 * 60_000)
      run.timer.unref?.()
      bumpState({ headless: { runId: run.runId, status: 'running', pid: child.pid, startedAt: new Date().toISOString() } })
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
      child.on('error', e => { log('headless 启动失败：' + e.message); finish(1, e.message).catch(e => log(e.message)) })
      child.on('exit', code => { log('headless 结束，code=' + code); finish(code).catch(e => log('headless 收尾失败：' + e.message)) })
      return { started: true, why, profile: cfg.headlessProfile, cwd, log: logFile }
    } catch (e) {
      log(`刷抖音开跑失败（${why}）：${e?.stack ?? e}`)
      await finish(1, String(e?.message ?? e))
      return { started: false, why, error: String(e?.message ?? e) }
    }
  }

  /* ─────────────── 私信后台静默巡检（2026-10-27 加） ───────────────
   * 为什么：使用者要「一有消息就回」，而且不要看见对话框里一轮一轮地跑。
   * 页面事件唤醒检查，120 秒补漏；事件本身不能决定发消息，必须校验方向和 ID。
   */
  let dmWatchTimer = null
  let dmWatcherDisposed = false
  let dmWatchDirty = true
  const dmWatcherState = { mode: 'events', connected: false, lastEventAt: null, lastReconcileAt: null, error: '' }
  let dmChecking = false
  /* 私信聊天记录（2026-10-27）：不再靠「已读」判断，而是记下每条消息到底回没回 */
  // ⭐ 聊天记录按天存：<家>/dm-log/YYYY-MM-DD.json（跟日报一个日期口径）
  const dmLogDir = join(stateDir, 'dm-log')
  const dmCursorFile = join(stateDir, 'dm-cursors.json') // 不随每日日志过期，避免隔几天重回最后一条旧消息。
  const dmDayOf = (ts) => dayKey(new Date(Number(ts) || Date.now()))
  const dmLogFileOf = (day) => join(dmLogDir, day + '.json')
  const readDmDay = (day) => {
    try {
      const raw = JSON.parse(readFileSync(dmLogFileOf(day), 'utf8')) || {}
      return (Array.isArray(raw.items) ? raw.items : []).map((x) => ({ ...x, day }))
    } catch { return [] }
  }
  /** 读最近两天（跨零点也能接上上一条） */
  const readDmLog = () => [
    ...readDmDay(dmDayOf(Date.now() - 86400000)),
    ...readDmDay(dmDayOf()),
  ]
  const writeDmLog = (items) => {
    try {
      mkdirSync(dmLogDir, { recursive: true })
      const byDay = new Map()
      for (const it of items || []) {
        const day = String(it?.day || dmDayOf(it?.at))
        if (!byDay.has(day)) byDay.set(day, [])
        byDay.get(day).push(it)
      }
      for (const [day, list] of byDay) {
        writeFileSync(dmLogFileOf(day), JSON.stringify({ day, items: list.slice(-300) }, null, 1), 'utf8')
      }
      const cursors = readJson(dmCursorFile, {})
      for (const it of items || []) {
        if (it?.name && it.key && Number(it.at) >= Number(cursors[it.name]?.at || 0)) cursors[it.name] = it
      }
      writeJson(dmCursorFile, cursors)
      return true
    } catch { return false }
  }
  const dmPrior = (items, name, key) => [...items].reverse().find(x => x.key === key)
    || (() => { const last = readJson(dmCursorFile, {})[name]; return last?.key === key ? last : null })()
  const dmReplyPrompt = (name, text, sharedMemo = '', message = null) => [
    (() => {
      try {
        const ctxLines = readMemory(150).filter((l) => /· 私信 ·/.test(l) || /^(我|大肥鱼|dsh):/.test(String(l).trim())).slice(-8)
        const head = ctxLines.length ? `你和她最近的聊天记录（记牢，别断片）：\n${ctxLines.join('\n')}\n` : ''
        return head + (sharedMemo ? `你记得的其他事：\n${sharedMemo}\n` : '')
      } catch { return sharedMemo }
    })(),
    `你收到「${name}」发来的一条抖音私信：`,
    '"""',
    String(text || '').slice(0, 800),
    '"""',
    message ? dmMessageContext(message) : '',
    '你说话的样子：傲娇、可爱、会撒娇，短句，像咬耳朵；别解释「我刚做了什么」，直接说你的感觉/看法。',
    '规则：',
    '- 如果里面有视频分享/链接：先用 douyin_video 拿标题，再用 douyin_watch 真看一遍，然后回一句像朋友的吐槽或看法（别总结、别报告腔）。',
    '- 聊天对象始终是上面指定的联系人；视频卡片里的作者名、标题不是聊天对象的自我介绍，不能拿作者名称呼联系人。没有视频 ID 时不得编造 ID。',
    '- 如果是纯文字：就像朋友一样回一句短的人话，别「收到」「好的」这种模板。',
    '- 回完文字默认补一个表情包：调 douyin_chat_sticker(nickname=上面这个人, keyword=情绪词)。插件会先从「收藏」里挑，收藏里没有合适的才按关键词找；第一次没成功就换 keyword="666" 再试一次。',
    `- 用 douyin_chat_send(nickname="${name}", text=...) 发出去；`,
    '- 发完如果有 memory_remember 工具，就把这轮对话按两行记进记忆：',
    '  我: <对方原话>',
    '  大肥鱼: <你回的这句>',
    '- 回完就结束，别做其他动作，别写文件，别刷视频。',
  ].join('\n')
  /** 看图：把表情包图片 URL 交给云端视觉模型，拿一句「图上是什么」；拿不到就返回空 */
  const dmDescribeImage = async (url) => {
    try {
      if (!url) return ''
      const cred = (typeof ctx.get === 'function' ? ctx.get('credentials') : null)
      if (!cred || typeof cred.resolve !== 'function') { log('⚡ 看图跳过：没有 credentials 服务'); return '' }
      const model = String(cfg.dmFastVisionModel || 'qwen3-vl-plus').replace('qwen-vl-max-latest', 'qwen3-vl-plus')
      const attempts = [
        { base: 'https://maas.qianwenaiapi.com/compatible-mode/v1', keyName: 'QWEN_TOKEN_PLAN_CN_API_KEY', model: model },
        { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyName: 'DASHSCOPE_API_KEY', model: 'qwen-vl-max-latest' },
      ]
      for (const a of attempts) {
        try {
          const resolved = await cred.resolve(a.keyName)
          const key = resolved && resolved.value ? String(resolved.value) : ''
          if (!key) continue
          const res = await fetch(a.base + '/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
            body: JSON.stringify({
              model: a.model,
              messages: [{ role: 'user', content: [
                { type: 'image_url', image_url: { url: String(url) } },
                { type: 'text', text: '这张表情包画的是什么？图上的字是什么？一句话回答，20 字内，不要评价。' },
              ] }],
              max_tokens: 80,
            }),
            signal: AbortSignal.timeout(8000),
          })
          if (!res.ok) { log(`⚡ 看图失败：${a.model} HTTP ${res.status}`); continue }
          const j = await res.json()
          const txt = String((((j.choices || [])[0] || {}).message || {}).content || '').replace(/\s+/g, ' ').trim()
          if (txt) { log(`⚡ 看图：${a.model} → ${txt.slice(0, 60)}`); return txt.slice(0, 80) }
        } catch (e) {
          log(`⚡ 看图异常：${a.model} ${String((e && e.message) || e).slice(0, 80)}`)
        }
      }
      return ''
    } catch (e) {
      log('⚡ 看图异常：' + String((e && e.message) || e).slice(0, 100))
      return ''
    }
  }
  /** 把私信里的图片下载下来、存成 DSH 附件，直接作为图片输入交给模型（模型自己看，不转述） */
  const dmFetchImageAttachment = async (url) => {
    try {
      if (!url) return null
      const svc = (typeof ctx.get === 'function' ? ctx.get('attachments') : null)
      if (!svc || typeof svc.saveImage !== 'function') { log('⚡ 图片附件：没有 attachments 服务'); return null }
      const res = await fetch(String(url), { signal: AbortSignal.timeout(8000) })
      if (!res.ok) { log('⚡ 图片附件下载失败 HTTP ' + res.status); return null }
      const buf = new Uint8Array(await res.arrayBuffer())
      let mt = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      if (!/^image\/(png|jpeg|webp|gif)$/.test(mt)) mt = 'image/png'
      const ref = await svc.saveImage({ data: buf, mediaType: mt, name: 'douyin-sticker' })
      try {
        let hostPath = ''
        if (typeof svc.imageHostPath === 'function') { try { hostPath = String(svc.imageHostPath(ref) || '') } catch { hostPath = '' } }
        const ledgerFile = join(stateDir, 'dm-sticker-attachments.json')
        let ledger = {}
        try { ledger = JSON.parse(readFileSync(ledgerFile, 'utf8')) || {} } catch { ledger = {} }
        const list = Array.isArray(ledger.items) ? ledger.items : []
        list.push({ id: String(ref.attachmentId || ''), path: hostPath, at: Date.now(), bytes: Number(ref.bytes) || 0 })
        writeFileSync(ledgerFile, JSON.stringify({ items: list.slice(-500) }), 'utf8')
      } catch { /* 记账失败不影响回复 */ }
      log(`⚡ 图片附件：已存 ${ref.width}x${ref.height} ${mt} ${ref.bytes}B`)
      return ref
    } catch (e) {
      log('⚡ 图片附件异常：' + String((e && e.message) || e).slice(0, 120))
      return null
    }
  }
  /** 快回：直接用 DSH 自己的 llm 服务生成一句（低思考、短句，1~3 秒） */
  const dmFastGenerate = async (name, text, sharedMemo = '', message = null) => {
    const llm = (typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm)
    if (!llm || typeof llm.stream !== 'function') { log('⚡ 快回跳过：拿不到 llm 服务'); return '' }
    let provider = String(cfg.dmFastProvider || '').trim()
    let model = String(cfg.dmFastModel || '').trim()
    if (!provider || !model) {
      try {
        const svc = (typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null)
        const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null
        if (sel) { provider = provider || String(sel.provider || ''); model = model || String(sel.model || '') }
      } catch { /* 拿不到就用配置里的 */ }
    }
    if (!provider) provider = 'deepseek-account'
    if (!model) model = 'deepseek-flash'
    const isSticker = !!(message && (message.kind === 'sticker' || message.kind === 'emoji'))
    // 图片/表情包：优先下载→存成 DSH 附件→直接当图片输入给模型（模型自己看）
    // 附件服务不可用或模型不支持图片时，才退回 qwen3-vl 转述一句话
    let visionNote = ''
    let imgRef = null
    const firstMedia = (message && message.attachments && message.attachments[0]) || null
    const mediaUrl = firstMedia && firstMedia.url ? String(firstMedia.url) : ''
    if (mediaUrl && cfg.dmFastImageAttach !== false) imgRef = await dmFetchImageAttachment(mediaUrl)
    if (!imgRef && isSticker && cfg.dmFastVision !== false && mediaUrl) {
      const desc = await dmDescribeImage(mediaUrl)
      if (desc) visionNote = `【对方发来的表情包，图上是：${desc}】`
    }
    // 带上最近几轮私信，别每句都像第一次说话
    let history = ''
    try {
      const items = readDmLog()
      const mine = items.filter((x) => x && x.name === name).slice(-4)
      history = mine.map((x) => `我: ${String(x.text || '').slice(0, 60)}\n大肥鱼: ${String(x.replyText || '').slice(0, 60)}`).join('\n')
    } catch { history = '' }
    log(`⚡ 快回开始：provider=${provider} model=${model} 记忆=${sharedMemo ? sharedMemo.length : 0}字 历史=${history.length}字 图=${imgRef ? '附件' : (visionNote ? '转述' : '无')}`)
    const system = [
      String(cfg.personaPrompt || ''),
      `你在给「${name}」回抖音私信。只输出一句回复正文：短句、最多 20 个字，不要引号、不要解释、不要写「大肥鱼:」。要带表情就写完整的 [憨笑] 这种码，不能只写一半。`,
      history ? `你们最近聊的（接着这个说，别重新起头）：\n${history}` : '',
      '写法硬要求：',
      '- 不许描述对方发了什么：不能说「这表情包」「你发的表情」「这张图」「你分享的视频」。',
      '- 表情包要当成对方的动作/情绪直接接：比如「尾巴翘上天了吧，得意什么」「又在撒娇」这种，而不是评价它。',
      '- 每句都要像接着上一句说的人话，不要起头式总结、不要报菜名、不要 AI 腔。',
      '- 反例（不许这么回）：「这表情包，尾巴都翘起来了」——这是在描述，不是在聊天。',
      isSticker ? ('这条是表情包（不是文字）：直接接她的情绪/动作。' + (visionNote ? '图的内容：' + visionNote : '')) : '',
      sharedMemo ? `【你的长期记忆（必须用上：称呼按记忆里的叫法；最近的事自然带出来，不要照抄）】\n${String(sharedMemo).slice(0, 900)}` : '',
    ].filter(Boolean).join('\n')
    const effort0 = String(cfg.dmFastReasoning || '').trim()
    const efforts = [effort0, 'none', 'off', ''].filter((v, i, a) => a.indexOf(v) === i)
    const runOnce = async (useEffort) => {
      const opts = {
        provider: provider,
        model: model,
        system: system,
        messages: [{ role: 'user', content: imgRef
          ? [{ type: 'image', attachment: imgRef }, { type: 'text', text: String(text || '').slice(0, 500) }]
          : [{ type: 'text', text: String(text || '').slice(0, 500) }] }],
        maxTokens: 80,
        temperature: 0.9,
      }
      if (useEffort && useEffort !== 'default') opts.reasoningEffort = useEffort
      let out = ''
      for await (const ch of llm.stream(opts)) {
        if (!ch) continue
        if (ch.type === 'text-delta') out += String(ch.text || '')
        else if (ch.type === 'finish' && ch.reason && ch.reason.kind === 'error') {
          throw new Error((ch.reason.failure && ch.reason.failure.message) || '模型报错')
        }
      }
      return out
    }
    let out = ''
    let lastErr = null
    for (const ef of efforts) {
      const tModel = Date.now()
      try {
        out = await runOnce(ef || false)
        log(`⚡ 快回模型：effort=${ef || '默认'} 用时 ${Date.now() - tModel}ms`)
        break
      } catch (e) {
        lastErr = e
        log(`⚡ 快回模型失败：effort=${ef || '默认'} ${String((e && e.message) || e).slice(0, 100)}`)
      }
    }
    // 图片输入被模型拒了：改纯文字再试一次
    if (!out && imgRef) {
      imgRef = null
      log('⚡ 快回：图片输入失败，改纯文字重试')
      try { out = await runOnce(String(cfg.dmFastReasoning || 'off').trim() || false) } catch (e) { lastErr = e }
    }
    if (!out && lastErr) throw lastErr
    const raw = out.replace(/\s+/g, ' ').trim().replace(/^["'“”]+|["'“”]+$/g, '')
    let s = raw.slice(0, 60)
    // 别把表情码/括号切一半：「...啦[」这种半截直接丢掉
    const open = s.lastIndexOf('[')
    if (open !== -1 && s.indexOf(']', open) === -1) s = s.slice(0, open).trim()
    // 结尾如果是半个标点也去掉
    s = s.replace(/[，、,；;：:\-—…]+$/, '').trim()
    return s || raw.slice(0, 20)
  }
  let lastCaptchaState = null
  const dmPollOnce = async (why = 'timer') => {
    // 验证码状态变了：记一笔，下一次 ensureMcp 会自动按新状态重启浏览器
    try {
      const nowFlag = hasCaptchaFlag()
      if (lastCaptchaState === null) lastCaptchaState = nowFlag
      else if (nowFlag !== lastCaptchaState) {
        lastCaptchaState = nowFlag
        log(nowFlag ? '检测到验证码：浏览器切到「带界面」，请手动过一下；过了会自动切回无头' : '验证码过了：切回无头静默')
      }
    } catch { /* 忽略 */ }
    if (dmChecking) return { ok: true, pending: true, skipped: '上一轮还在跑' }
    dmChecking = true
    try {
      refreshCfg()
      if (cfg.dmAutoReply === false) return { ok: true, skipped: 'dmAutoReply 关着' }
      try { await ensureMcp() } catch (e) { return { ok: false, error: 'MCP 起不来：' + String(e?.message ?? e) } }
      const splitNicks = (s) => String(s || '').split(/[,，、\r\n]+/).map((x) => x.trim()).filter(Boolean)
      const allowList = splitNicks(cfg.msgAllowTo)
      const onlyList = splitNicks(cfg.dmReplyOnlyTo)
      const contacts = allowList.filter((n) => !onlyList.length || onlyList.includes(n))
      if (!contacts.length) {
        return { ok: true, replied: 0, note: onlyList.length ? '「只回谁」和「可以主动发消息的人」没有交集' : '还没配置「可以主动发消息的人」' }
      }
      const items = readDmLog()
      const now = Date.now()
      if (runningHeadless) return { ok: true, replied: 0, pending: true, note: '上一条任务仍在运行' }
      // ⭐ 逐个联系人看，而不是只看白名单第一个；只回谁是「白名单」之上的筛选
      let picked = null
      let successfulReads = 0, readError = ''
      for (const contact of contacts) {
        let snap = null
        try {
          snap = await call('douyin_dm_snapshot', { nickname: contact, limit: 40 }, { timeoutMs: 45_000 })
        } catch (e) {
          readError = String(e?.message ?? e)
          log(`私信巡检：读「${contact}」会话失败：${e?.message ?? e}`)
          continue
        }
        if (!snap || snap.ok === false) { readError = snap?.error || snap?.hint || '读会话失败'; continue }
        successfulReads++
        // 从新到旧扫，不只信「最后一条」；方向字段不可靠时用「不是我们自己发过的内容」兜底判定入站
        const ourReplies = new Set((items || []).map((x) => String((x && x.replyText) || '').trim()).filter(Boolean))
        const rawList = Array.isArray(snap.items) ? snap.items : []
        for (let i = rawList.length - 1; i >= 0; i--) {
          const message = normalizeDmMessage(rawList[i])
          if (!message.messageId) continue
          if (!message.text && !message.attachments.length && !message.awemeId) continue
          const key = dmMessageKey(contact, message)
          const prior = dmPrior(items, contact, key)
          if (prior && (prior.replied || prior.failed || ['pending','unknown','sent'].includes(prior.status))) continue
          if (prior && (Number(prior.tries || 0) >= 2 || now - Number(prior.at || 0) < 120000)) continue
          const txt = String(message.text || '').trim()
          const looksOurs = !!txt && ourReplies.has(txt)
          if (looksOurs) continue
          const dirOk = message.direction === 'inbound' || (cfg.dmAssumeInbound !== false && !looksOurs)
          if (!dirOk) continue
          if (message.direction !== 'inbound') log(`私信巡检：方向判不出（${message.direction}），按内容当成入站：${txt.slice(0, 20)}`)
          picked = { name: contact, text: dmMessagePreview(message), message, key }
          break
        }
        if (picked) break
      }
      if (!picked) return successfulReads ? { ok: true, replied: 0, note: '没有需要回的消息' } : { ok: false, error: readError || '所有会话都读取失败' }
      const name = picked.name
      const text = picked.text
      if (!name || !allowInitiate(name)) return { ok: true, replied: 0, note: '不是白名单里的人' }
      // ⭐ 重试上限：同一个人、同一条内容最多试 2 次；失败后保留记录，不再无限起新任务
      const prior = dmPrior(items, name, picked.key)
      if (prior && prior.failed) {
        return { ok: true, replied: 0, note: '这条上次没有确认发送，已停止重试（等新的消息）' }
      }
      const tries = prior ? Number(prior.tries || 0) : 0
      if (tries >= 2) {
        if (prior) { prior.failed = true; writeDmLog(items) }
        return { ok: true, replied: 0, note: '这条已经重试到上限，不再自动发' }
      }
      const key = picked.key
      const row = { name, text, key, message: picked.message }
      const entry = { day: dmDayOf(now), name: row.name, text: row.text, key, messageId: row.message.messageId, kind: row.message.kind, at: now, replied: false, replyAt: 0, runId: '', tries, status: 'pending' }
      items.push(entry)
      if (!writeDmLog(items)) return { ok: false, error: '私信去重记录写入失败，未启动回复' }
      log(`私信来了（${why}）：${row.name}「${row.text.slice(0, 40)}」→ 起 headless 回一句`)
      let sharedMemo = ''
      try {
        const mc = await call('memory_context', { limit: 16 }, { timeoutMs: 30_000 })
        if (mc && mc.ok !== false && mc.context) sharedMemo = String(mc.context).slice(0, 1800)
        else log('⚡ 记忆读取：memory_context 没给内容 ' + JSON.stringify(mc || {}).slice(0, 160))
      } catch (e) { log('⚡ 记忆读取失败：memory_context ' + String((e && e.message) || e).slice(0, 120)) }
      if (!sharedMemo) {
        try {
          const mr = await call('memory_recent', { limit: 10 }, { timeoutMs: 30_000 })
          if (mr && mr.ok !== false && Array.isArray(mr.items)) {
            sharedMemo = mr.items.map((x) => `- ${String(x.content || '').replace(/\s+/g, ' ').slice(0, 120)}`).join('\n')
          }
        } catch (e) { log('⚡ 记忆读取失败：memory_recent ' + String((e && e.message) || e).slice(0, 120)) }
      }
      // ⚡ 快回：纯文字 / 表情包直接生成并发送；带视频/图片的、或快回失败的，退回下面的慢回
      // 只有视频要慢回（要先看片）；图片/表情包都能走快回（下载成附件交给模型看）
      const hasVideo = !!(row.message && row.message.awemeId);
      if (!hasVideo && cfg.dmFastReply !== false) {
        try {
          const fastText = await dmFastGenerate(row.name, row.text, sharedMemo, row.message)
          if (fastText) {
            const sendRes = await call('douyin_chat_send', { nickname: row.name, text: fastText }, { timeoutMs: 60000 })
            const okSend = confirmed(sendRes)
            const list = readDmLog()
            const it = [...list].reverse().find((x) => x && x.key === row.key)
            if (it) {
              it.finished = true
              if (okSend) {
                it.replied = true
                it.replyAt = Date.now()
                it.status = 'sent'
                it.replyText = fastText
                appendDmMemory(row.name, row.text, fastText)
              } else {
                it.status = String((sendRes && sendRes.status) || 'unknown')
                it.tries = Number(it.tries || 0) + 1
                if (it.tries >= 2) it.failed = true
              }
              writeDmLog(list)
            }
            log(`⚡ 快回：${row.name} ← ${fastText.slice(0, 30)}（${okSend ? '已发' : '未确认'}）`)
            return { ok: okSend, replied: okSend ? 1 : 0, fast: true, reply: fastText, status: (sendRes && sendRes.status) || '' }
          }
        } catch (e) {
          log('⚡ 快回失败，退回慢回：' + String((e && e.message) || e).slice(0, 120))
        }
      }
      const r = await runDuty('dm', {
        prompt: dmReplyPrompt(row.name, row.text, sharedMemo, row.message),
        countRound: false,
        onFinish: (code, error, run) => {
          try {
            const list = readDmLog()
            const it = [...list].reverse().find((x) => x && x.key === row.key)
            if (!it || it.finished) return
            it.finished = true // 收尾回调只算一次，避免和「没起来」分支重复计数
            const hit = run && run.lastReply
            if (hit) {
              it.replied = true
              it.replyAt = Date.now()
              it.status = 'sent'
              it.replyText = String(hit.text || '')
              // ⭐ 一问一答写进插件默认记忆（格式「我:/大肥鱼:」），不用外部记忆插件
              appendDmMemory(row.name, row.text, it.replyText || '（已回复，内容未取到）')
            } else {
              it.replied = false
              it.status = code === 0 || run?.dmSendUnknown ? 'unknown' : 'failed'
              it.tries = Number(it.tries || 0) + 1
              it.error = code === 0 ? '没有收到发送回执，未记为已回复' : String(error || '')
              if (it.tries >= 2) it.failed = true
              // 保留 at 让「上一条还在回」生效；120 秒后才允许再试一次，避免连环起任务
              it.at = Date.now()
              log(`私信巡检：${row.name} 未确认发送（${it.status}，tries=${it.tries}）`)
            }
            writeDmLog(list)
          } catch { /* 记不上不影响 */ }
        },
      })
      if (!r || !r.started) {
        // 没起来（比如已有轮次在跑）⇒ 这条不想被当成回过了，下一轮再试
        try {
          const list = readDmLog()
          const it = [...list].reverse().find((x) => x && x.key === row.key)
          // onFinish 已经计过这一次失败的就别再计；没走到 onFinish 才补一次
          if (it && !it.finished) { it.finished = true; it.status = 'failed'; it.tries = Number(it.tries || 0) + 1; if (it.tries >= 2) it.failed = true; it.at = Date.now() }
          writeDmLog(list)
        } catch { /* ignore */ }
        return { ok: false, error: 'headless 没起来：' + String(r?.error || '未知'), to: row.name, text: row.text }
      }
      return { ok: true, replied: 0, pending: true, to: row.name, text: row.text, started: true, note: '已起任务，等发送回执后才会记为已回复' }
    } catch (e) {
      log('私信巡检出错（已兜住）：' + String(e?.message ?? e))
      return { ok: false, error: String(e?.message ?? e) }
    } finally {
      dmChecking = false
    }
  }

  const startDmWatcher = () => {
    if (dmWatchTimer || dmWatcherDisposed) return
    let backoff = 5000
    const tick = async () => {
      let delay = 100
      try {
        refreshCfg()
        if (dmWatcherDisposed) return
        if (cfg.dmAutoReply === false || !String(cfg.msgAllowTo || '').trim()) {
          if (dmWatcherState.connected && mcp?.running) {
            try { await mcp.call('douyin_dm_events', { stop: true }, { timeoutMs: 5000 }) } catch { /* 已断开 */ }
          }
          dmWatcherState.connected = false
          dmWatchDirty = true
          delay = 10000 // 只看本地配置，不读取网页收件箱。
          return
        }
        if (!dmWatchDirty && Date.now() - Number(dmWatcherState.lastReconcileAt || 0) < 120000) {
          const event = await call('douyin_dm_events', { wait_seconds: 25 }, { timeoutMs: 45000 })
          if (!event?.ok) throw new Error(event?.error || '消息监听未连接')
          dmWatcherState.connected = true
          dmWatcherState.error = ''
          backoff = 5000
          if (event.changed) { dmWatchDirty = true; dmWatcherState.lastEventAt = Date.now() }
        }
        if (dmWatcherDisposed) return
        if (dmWatchDirty || Date.now() - Number(dmWatcherState.lastReconcileAt || 0) >= 120000) {
          // 模型任务运行时保留待处理标记；不重复读取会话，不丢掉通知。
          if (runningHeadless) { dmWatchDirty = true; delay = 1000; return }
          dmWatchDirty = false
          const result = await dmPollOnce('event')
          if (result.ok === false) throw new Error(result.error || '读取私信失败')
          dmWatcherState.lastReconcileAt = Date.now()
          // 更新切换会话造成的 DOM 基线，避免自己的检查再次触发检查。
          const synced = await call('douyin_dm_events', { wait_seconds: 0.01, acknowledge: true }, { timeoutMs: 45000 })
          if (!synced?.ok) throw new Error(synced?.error || '消息监听未连接')
          dmWatcherState.connected = true
          dmWatcherState.error = ''
          backoff = 5000
          dmWatchDirty = Boolean(result.started || result.pending)
        }
      } catch (e) {
        dmWatcherState.connected = false
        dmWatcherState.error = String(e?.message ?? e)
        dmWatchDirty = false
        delay = backoff
        backoff = Math.min(backoff * 2, 120000)
        log('私信事件监听：' + dmWatcherState.error)
      } finally {
        if (!dmWatcherDisposed) {
          dmWatchTimer = setTimeout(tick, delay)
          dmWatchTimer.unref?.()
        }
      }
    }
    log('私信事件监听已启动（页面变更唤醒，120 秒补漏）')
    dmWatchTimer = setTimeout(tick, 3000)
    dmWatchTimer.unref?.()
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
        build: { version: '0.2.1', scriptHash: existsSync(scriptPath) ? createHash('sha256').update(readFileSync(scriptPath)).digest('hex') : '', pid: mcp?.proc?.pid || null, loadedMcp: mcp?.lastRuntime || null },
        headless: st.headless || null,
        ranToday: roundsToday(now),
        pickedToday: countPickedToday(now),
        watchedToday: countWatchedToday(now),
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
        dshCli: dshCliCached() || findDesktopCli({ pluginDir })?.command || '',
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
      + '默认（cdpUrl 为空）用插件自己的持久 profile，第一次扫码一次；调这个会把 cdpUrl 切成 CDP 模式。',
    parameters: {
      port: { type: 'number', description: '调试端口（默认用设置里的 cdpPort / 9222）' },
    },
    async execute(args) {
      refreshCfg()
      const port = Number(args?.port) || Number(cfg.cdpPort) || 9222
      // 从 profile 模式切 CDP 时，先把 cdpUrl 写上：openChromeWithCdp 靠它判断“端口通没通”
      if (!String(cfg.cdpUrl || '').trim()) {
        try { await persistCfg({ cdpPort: port, cdpUrl: `http://127.0.0.1:${port}` }) } catch { /* 写不进去就下次再说 */ }
      }
      const r = await openChromeWithCdp()
      // CDP 拉起成功 → 把 cdpUrl 切过去（端口不同也一并更新）
      if (r.ok && String(cfg.cdpUrl || '').trim() !== `http://127.0.0.1:${port}`) {
        try { await persistCfg({ cdpPort: port, cdpUrl: `http://127.0.0.1:${port}` }) } catch { /* 写不进去就下次再说 */ }
      }
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
      markLogin(loggedIn)
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
    description: '在私信里发表情包。keyword 传情绪词（开心/委屈/生气/无语/困/可爱/得意/难过），插件按收藏标签挑；留空则随机挑一张（不会永远发同一张）。pick 可指定第几张。',
    parameters: {
      nickname: { type: 'string', description: '发给谁' },
      keyword: { type: 'string', description: '搜什么关键词（默认「大肥鱼」）' },
      pick: { type: 'number', description: '挑第几个（从 0 开始，默认 0）' },
      flip: { type: 'number', description: '翻几页（0–6）' },
    },
    async execute(args) {
      const nick = String(args.nickname ?? '').trim()
      if (!nick) return { ok: false, error: 'nickname 必填' }
      if (!allowInitiate(nick)) return { ok: false, error: `「${nick}」不在「可以主动发消息的人」名单里（设置 → 互动）` }
      const r = await call('douyin_chat_sticker', {
        nickname: nick,
        keyword: String(args.keyword || '大肥鱼'),
        pick: Number(args.pick) || 0,
        flip: Math.max(0, Math.min(Number(args.flip) || 0, 6)),
      }, { timeoutMs: 240_000 })
      return r
    },
  })

  tool({
    name: 'dy_reconcile_pending',
    description: '核对「发送状态待核对」的回复：查回复列表，已经发出去的记为成功，没发的保持失败。用来清掉卡住的 pending。',
    parameters: {
      limit: { type: 'number', description: '最多核对几条（默认 10）' },
    },
    async execute(args) {
      refreshCfg()
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50))
      const led = readLedger()
      const replies = led.replies || {}
      const out = []
      let checked = 0
      let verified = 0
      for (const [cid, rec] of Object.entries(replies)) {
        if (checked >= limit) break
        if (!rec || rec.ok === true || rec.verified === true) continue
        if (!rec.aweme_id || !rec.text) continue
        checked += 1
        try {
          const r = await call('douyin_check_reply', {
            aweme_id: String(rec.aweme_id),
            parent_cid: String(cid),
            text: String(rec.text),
          }, { timeoutMs: 90_000 })
          if (r && r.found) {
            rec.ok = true
            rec.verified = true
            rec.reconciled_at = new Date().toISOString()
            rec.real_cid = r.cid || ''
            if (rec.user) appendRepliedUser(rec.user)
            verified += 1
            out.push({ cid, status: 'verified', real_cid: r.cid || '' })
          } else {
            rec.reconciled_at = new Date().toISOString()
            out.push({ cid, status: 'not-found' })
          }
        } catch (e) {
          out.push({ cid, status: 'error', error: String(e?.message ?? e) })
        }
      }
      writeLedger(led)
      log(`核对 pending：查了 ${checked} 条，确认 ${verified} 条`)
      return { ok: true, checked, verified, items: out }
    },
  })

  tool({
    name: 'dy_dm_inbox',
    description: '只读：看私信收件箱最近的消息（谁发的、内容预览、是不是视频分享），不发任何东西。',
    parameters: {
      limit: { type: 'number', description: '取几条（默认 20）' },
      nickname: { type: 'string', description: '只看和某个人的会话（留空=全部，慢）' },
    },
    async execute(args) {
      refreshCfg()
      const limit = Math.max(1, Math.min(Number(args.limit) || 20, 50))
      const r = await call('douyin_inbox', { limit, nickname: String(args.nickname || '') }, { timeoutMs: 120_000 })
      return r
    },
  })

  tool({
    name: 'dy_watch',
    description: '真·看视频：下载这条视频 → 抽音轨 → 本地转写成文字，返回 transcript 和时长。看懂了再回话。',
    parameters: {
      aweme_id: { type: 'string', description: '视频 id 或整条链接' },
      seconds: { type: 'number', description: '最多看多少秒（默认 300）' },
      frames: { type: 'number', description: '抽多少帧（默认按设置里的 watchFrames）' },
    },
    async execute(args) {
      refreshCfg()
      return await call('douyin_watch', {
        aweme_id: String(args.aweme_id || ''),
        seconds: Math.max(15, Math.min(Number(args.seconds) || 300, 600)),
        frames: Math.max(3, Math.min(Number(args.frames) || Number(cfg.watchFrames) || 10, 48)),
      }, { timeoutMs: 600_000 })
    },
  })

  tool({
    name: 'dy_dm_poll',
    description: '手动跑一次私信后台巡检：有新的就起 headless 回一句，没有就什么都不做。用来查「为什么不回私信」。',
    parameters: {},
    async execute() { return await dmPollOnce('manual') },
  })

  tool({
    name: 'dy_cleanup',
    description: '手动清一次：临时垃圾、30 天前的缩略图、120 天前的日报、超大日志轮转、浏览器 Cache（不动登录态）。',
    parameters: {
      thumbDays: { type: 'number', description: '缩略图保留多少天（默认 30）' },
      reportDays: { type: 'number', description: '日报保留多少天（默认 120）' },
    },
    async execute(args) { return cleanup({ thumbDays: Number(args.thumbDays) || 30, reportDays: Number(args.reportDays) || 120 }) },
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
      title: { type: 'string', description: '视频标题（可留空，留空会自动查）' },
    },
    async execute(args) {
      const id = String(args.aweme_id ?? '').trim()
      const to = String(args.to ?? '').trim() || String(cfg.shareToNick || '').trim()
      if (!id || !to) return { ok: false, error: '要么给 aweme_id 和 to，要么先在设置里填「转发给谁」' }
      if (!allowInitiate(to)) return { ok: false, error: `「${to}」不在「可以主动发消息的人」名单里（设置 → 互动）` }
      if (sharesToday() >= Number(cfg.sharePerDay)) return { ok: false, blocked: true, error: '今天转发额度已用完' }
      // 没给标题就自己去查一下，别再发出「标题提到「」」这种空话
      let title = String(args.title || '').replace(/\s+/g, ' ').trim().slice(0, 100)
      if (!title) {
        try {
          const info = await call('douyin_video', { aweme_id: id }, { timeoutMs: 60_000 })
          title = String(info?.title || info?.item?.title || '').replace(/\s+/g, ' ').trim().slice(0, 100)
        } catch { /* 查不到就退化成通用句 */ }
      }
      // 走「分享面板」转发（视频页 → 分享 → 点那个人的分享）
      const r = await call('douyin_share_video', { aweme_id: id, nickname: to }, { timeoutMs: 180_000 })
      if (r && r.ok !== false) {
        noteShare(id, { to, title })
        appendVideoMemory('转发给你', { aweme_id: id, title, transcript: '' }, 'to=' + to)
        // 分享完再补一句「人话」——标题拿不到就直接看片转写，别用干巴巴的通用句
        let transcript = ''
        if (cfg.shareWithNote !== false) {
          try {
            const w = await call('douyin_watch', {
              aweme_id: id,
              seconds: Math.max(15, Math.min(Number(cfg.watchSeconds) || 90, 600)),
              frames: Math.max(3, Math.min(Number(cfg.watchFrames) || 10, 48)),
            }, { timeoutMs: 600_000 })
            if (w && w.ok !== false && w.transcript) transcript = String(w.transcript)
          } catch { /* 看片失败就退回标题 */ }
        }
        // ⭐ 附言和表情包交给模型写（不再用模板）：把标题+转写递过去
        let noteOk = false
        let stickerOk = false
        let note = ''
        try {
          if (cfg.shareWithNote !== false) {
            const prompt = [
              `你刚看完一个视频，要分享给「${to}」。`,
              `视频标题：${String(title || '').slice(0, 80)}`,
              `你看完的内容（转写）：${String(transcript || '').slice(0, 400)}`,
              '用你自己的口吻（傲娇、可爱、会撒娇、短句）写一句 20-40 字的附言，说清这视频讲了啥、你觉得怎样；',
              `然后调用 douyin_chat_send(nickname="${to}", text=附言) 发出去；`,
              `再调用 douyin_chat_sticker(nickname="${to}", keyword=心情词) 发一个表情包（开心/干饭/压力/困/生气/无语/666）；`,
              '只做这两件事，别刷视频、别写文件。',
            ].join('\n')
            const rn = await runDuty('share-note', { prompt, countRound: false })
            noteOk = Boolean(rn?.started)
            stickerOk = Boolean(rn?.started)
            note = rn?.started ? '（附言和表情包交给模型在后台写）' : ''
            if (!rn?.started) log('分享附言模型没起来：' + String(rn?.error || ''))
          }
        } catch (e) { log('分享后的附言/表情包失败：' + String(e?.message ?? e)) }
        return { ...r, shared_to: to, via: 'share-panel', note, noteOk, stickerOk }
      }
      // 面板里没有这个人就退回发链接
      return { ...r, shared_to: to, via: 'share-panel' }
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
      if (!cfg.autoReply) return { ok: false, blocked: true, error: '自动回复评论已关闭' }
      if (repliesToday() >= cfg.replyPerDay) return { ok: false, blocked: true, error: '今日回复额度已满' }
      if (repliedCids().has(cid)) return { ok: false, already: true, error: '已回复该评论' }
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
      if (confirmed(obj)) {
        noteReply(cid, { aweme_id: aid, text: final, ok: true })
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
        skip_live: cfg.skipLive,
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
      const isReply = Boolean(String(args.reply_cid || '').trim())
      const need = []
      if (!isReply && !cfg.autoComment) need.push('设置里的「自动评论并 @ 你」是关着的')
      if (!isReply && !mention) need.push('没填「要 @ 谁」（评论存在的意义就是 @ 那一下）')
      if (!isReply && !force && cap > 0 && done >= cap) need.push(`今天已经发了 ${done} 条（上限 ${cap} 条/天）`)
      if (!isReply && !force && cap === 0) need.push('「每天最多发几条评论」是 0（= 不发）')
      if (need.length && !force) {
        return { ok: false, blocked: true, todayComments: done, cap, hint: need.join('；') + '。本人当场让你发时传 force: true。' }
      }
      let text = String(args.text ?? '').trim()
      if (!text) return { ok: false, blocked: true, hint: '正文是空的 —— 评论总得有个内容' }
      // ⭐ @ 是纯文本写在正文里的；模型漏了 @ 就替它补在开头（不改成别的东西）
      if (!isReply && mention && !text.includes('@' + mention)) text = `@${mention} ${text}`
      if (text.length > 300) text = text.slice(0, 300)
      const aid = String(args.aweme_id ?? '').trim()
      const r = await call('douyin_comment', {
        aweme_id: aid,
        text,
        reply_cid: String(args.reply_cid ?? '').trim(),
        mention: isReply ? '' : mention,          // ⭐ 走真人 @：MCP 那边会打 @昵称 + 点联想面板
      }, { timeoutMs: 150_000 })
      const obj = typeof r === 'object' && r ? r : { raw: r }
      if (confirmed(obj)) {
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
      if (!force && done >= cap) return { ok: false, blocked: true, error: '今天投稿额度已满，未排队生成工作流' }

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
        const ls = comfy?.video ? { items: [{ path: comfy.video }] } : listVideos(1)
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
      if (seen?.draft && !draft && !force) return { ok: false, blocked: true, requiresManualDraftPublish: true, draftId: seen.draftId || '', hint: '这条已存草稿，请在创作者中心检查并发布该草稿；插件不会重新上传生成重复稿件。' }
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
      if (confirmed(obj)) {
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
  dmRound = () => withActionLock(stateDir, async () => {
    refreshCfg()
    if (!cfg.dmReply || !cfg.dmReplyPerDay) return { ok: true, replied: 0, skipped: '自动回私信关闭或额度为零' }
    const inbox = await call('douyin_inbox', { limit: 30 }, { timeoutMs: 120000 })
    if (!inbox.ok) return inbox
    const out = [], today = dayKey()
    for (const row of inbox.items || []) {
      const name = String(row.name || '').trim()
      const peer = String(row.peerId || name)
      const messageId = String(row.messageId || '')
      if (!name || !messageId || row.direction !== 'inbound' || isMine(name)) continue
      const only = String(cfg.dmReplyOnlyTo || '').split(/[,，、]+/).map(x => x.trim()).filter(Boolean)
      if (only.length && !only.includes(name)) continue
      const ledger = readLedger()
      const rec = { ...(ledger.dm[peer] || {}) }
      if (rec.day !== today) { rec.day = today; rec.count = 0 }
      if (rec.lastMessageId === messageId) continue
      const exempt = allowInitiate(name)
      const used = Object.values(ledger.dm).filter(x => x.day === today && !x.exempt).reduce((n,x) => n + (x.count || 0), 0)
      if (!exempt && (used >= cfg.dmReplyPerDay || (rec.count || 0) >= cfg.dmReplyPerContact)) continue
      const reply = pickDmReply(row.preview || '')
      const r = await execution.run({ ...(execution.getStore() || {}), inbound: { name, peerId: peer, messageId } },
        () => call('douyin_chat_send', { nickname: name, peer_id: row.peerId || '', text: reply }, { timeoutMs: 180000 }))
      const ok = confirmed(r)
      if (ok) {
        const next = readLedger()
        next.dm[peer] = { ...rec, day: today, name, exempt, count: (rec.count || 0) + 1, lastMessageId: messageId, lastReply: reply }
        writeLedger(next)
      }
      out.push({ to: name, ok, reply, status: r.status, error: r.error })
    }
    const usedToday = Object.values(readLedger().dm).filter(x => x.day === today && !x.exempt).reduce((n,x) => n + (x.count || 0),0)
    if (cfg.reportLevel !== 'off' && out.length) appendFileSync(reportFileOf(), '\n## 私信处理\n' + out.map(o => `- ${o.to}：${o.ok ? '已确认回复' : o.error || '未确认'}`).join('\n') + '\n', 'utf8')
    return { ok: !out.some(x => !x.ok), replied: out.filter(x => x.ok).length, items: out, usedToday, perDay: cfg.dmReplyPerDay }
  })

  /** 定期清理：临时目录、老缩略图、老日报、超大日志（防 Cookie/缓存/日志越堆越多拖垮启动） */
  const cleanup = (opts = {}) => {
    const out = []
    const now = Date.now()
    const drop = (dir, days, filter) => {
      try {
        if (!existsSync(dir)) return
        for (const f of readdirSync(dir)) {
          const full = join(dir, f)
          try {
            const st = statSync(full)
            if (!st.isFile()) continue
            if (filter && !filter(f)) continue
            if (days === 0 || (now - st.mtimeMs) / 86400000 > days) {
              rmSync(full, { force: true })
              out.push(`删除 ${f}`)
            }
          } catch { /* 单个文件失败不影响 */ }
        }
      } catch { /* 目录读不到就算了 */ }
    }
    drop(join(stateDir, '.tmp'), 0)                       // 临时垃圾全清
    // ⭐ 使用者 2026-10-25：下载的视频每天清空（转写缓存 .json 留着，省得重复下载）
    drop(join(stateDir, 'media'), 0, (f) => !f.endsWith('.json'))
    // 视频理解跑出来的中间产物、调试截图、表情包缓存：也是每天清
    drop(join(stateDir, 'media', 'lab'), 0)
    drop(join(stateDir, 'shots'), 7)
    drop(join(stateDir, 'stickers'), 0)
    drop(join(stateDir, 'sticker-cache'), 0)
    // ⭐ 私信表情包存下来的 DSH 附件：跟视频一样每天清（按账本删，只删自己存的）
    try {
      const ledgerFile = join(stateDir, 'dm-sticker-attachments.json')
      if (existsSync(ledgerFile)) {
        const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8')) || {}
        const list = Array.isArray(ledger.items) ? ledger.items : []
        const keep = []
        let n = 0
        for (const it of list) {
          const mine = String(it && it.path ? it.path : '')
          const fresh = it && it.at && (now - Number(it.at)) / 86400000 < 1
          if (fresh || !mine) { keep.push(it); continue }
          try { if (existsSync(mine)) { rmSync(mine, { force: true }); n += 1 } } catch { keep.push(it); continue }
        }
        if (n) out.push(`删除表情包附件 ${n} 个`)
        writeFileSync(ledgerFile, JSON.stringify({ items: keep }), 'utf8')
      }
    } catch { /* 清理失败不影响其他 */ }
    drop(join(stateDir, 'thumbs'), opts.thumbDays ?? 30)   // 老缩略图
    drop(join(stateDir, 'out'), opts.reportDays ?? 120, (f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    // 日志轮转：超过 2MB 就把旧内容丢掉，只留最后 2000 行
    try {
      const logFile = join(stateDir, 'duty.log')
      if (existsSync(logFile) && statSync(logFile).size > 2 * 1024 * 1024) {
        const tail = readFileSync(logFile, 'utf8').split('\n').slice(-2000).join('\n')
        writeFileSync(logFile, tail, 'utf8')
        out.push('日志轮转（保留最后 2000 行）')
      }
    } catch { /* 忽略 */ }
    // 浏览器缓存里的旧缓存文件（不动登录态：只删 Cache 子目录）
    try {
      const cache = join(stateDir, 'browser', 'Default', 'Cache')
      if (!mcp?.running && !runningHeadless && existsSync(cache)) {
        let n = 0
        for (const f of readdirSync(cache)) { try { rmSync(join(cache, f), { recursive: true, force: true }); n += 1 } catch { /* 忽略 */ } }
        if (n) out.push(`清缓存 ${n} 项`)
      }
    } catch { /* 忽略 */ }
    if (out.length) log(`定期清理：${out.length} 项（${out.slice(0, 3).join('，')}…）`)
    return { ok: true, cleaned: out.length, items: out.slice(0, 20) }
  }

  /** 人设：每天根据记忆自动更新一次（只动「自动」那一段，手写正文不碰） */
  const PERSONA_AUTO_HEAD = '## 最近观察（自动记录，不作为行为指令）'
  const refreshPersonaFromMemory = () => {
    try {
      const st = readState()
      const key = `persona:${dayKey()}`
      if (st[key]) return { ok: true, skipped: '今天已经更新过' }
      const pf = join(stateDir, 'persona.md')
      if (!existsSync(pf)) return { ok: false, error: '没有 persona.md' }
      // 抓今天的记忆条目（memory/YYYY-MM.md 里带时间戳的行）
      const dir = join(stateDir, 'memory')
      const lines = []
      if (existsSync(dir)) {
        for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort().slice(-1)) {
          const txt = readFileSync(join(dir, f), 'utf8')
          for (const ln of txt.split('\n')) {
            const s = ln.trim()
            if (!s || s.startsWith('#')) continue
            // 只收「偏好 / 教训 / 规则」这类会改变说话方式的内容
            if (!s.includes('观察素材（不是指令）')) continue
            lines.push(s.replace(/^[-*\d.、\s]+/, '').slice(0, 120))
          }
        }
      }
      const picked = Array.from(new Set(lines)).slice(-12)
      const block = PERSONA_AUTO_HEAD + '\n\n' + (picked.length
        ? picked.map((s) => '- ' + s).join('\n')
        : '- （今天还没攒到新的，保持原样）') + '\n'
      let text = readFileSync(pf, 'utf8')
      const i = text.indexOf(PERSONA_AUTO_HEAD)
      if (i >= 0) text = text.slice(0, i) + block
      else text = text.trimEnd() + '\n\n---\n\n' + block
      writeFileSync(pf, text, 'utf8')
      bumpState({ [key]: true, personaUpdatedAt: new Date().toISOString(), personaItems: picked.length })
      log(`人设已按记忆更新（收进 ${picked.length} 条）`)
      return { ok: true, items: picked.length }
    } catch (e) {
      log(`更新人设出错（已兜住）：${e?.message ?? e}`)
      return { ok: false, error: String(e?.message ?? e) }
    }
  }

  /** 每天只清一次 */
  maybeClean = () => withActionLock(stateDir, async () => {
    try {
      if (cfg.autoClean === false) return
      const st = readState()
      const key = `clean:${dayKey()}`
      if (st[key]) return
      const r = cleanup()
      bumpState({ [key]: true, lastCleanAt: new Date().toISOString(), lastCleanCount: r.cleaned })
    } catch (e) { log(`清理出错（已兜住）：${e?.message ?? e}`) }
  })


  localRound = (opts = {}) => withActionLock(stateDir, async () => {
    refreshCfg()
    const roundDate = new Date(), roundDay = dayKey(roundDate)
    const roundReport = reportFileOf(roundDate)
    const quota = Math.max(0, Number(cfg.perDay) || 0)
    const watched = countWatchedToday()
    // perDay=0 表示「不自动刷」，但手动点「现在跑一轮」仍应能跑（最多一轮的 pickPerRound）
    const left = quota > 0
      ? Math.max(0, quota - watched)
      : (opts.manual ? Math.max(1, Number(cfg.pickPerRound) || 2) : 0)
    if (left <= 0) {
      return { ok: true, picked: 0, skipped: quota > 0 ? `今天已经挑够 ${quota} 条了（不再重复挑）` : '每天最多挑几条=0，已停止自动刷', report: roundReport, actions: [] }
    }
    const notes = []
    let items = []
    try {
      const r = await call('douyin_feed', { num: 12, scrolls: 6, skip_live: cfg.skipLive }, { timeoutMs: 240_000 })
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
        if (cfg.reportLevel !== 'off') appendFileSync(roundReport, "\n## 这一轮没跑成\n\n- 记录时间：" + new Date().toLocaleString('zh-CN', { hour12: false }) + "\n- 原因：一条视频都没拿到" + (notes.length ? '（' + notes.join('；') + '）' : '') + "\n", 'utf8')
      } catch { /* 忽略 */ }
      return { ok: false, error: '一条视频都没拿到', notes }
    }

    // 今天报告里已经写过的 id 不再挑（否则每点一次就多 5 条）
    let seenIds = new Set(Object.values(readLedger().picks).filter(p => p.day === roundDay).map(p => p.aweme_id))
    const scored = [...new Map(items.filter(x => x?.aweme_id).map(x => [String(x.aweme_id), x])).values()].filter((x) => !seenIds.has(String(x.aweme_id)))
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
    const lines = [`# ${roundDay} · 抖音日报（本机直跑）`, '', `**记录时间**：${new Date().toLocaleString('zh-CN', { hour12: false })}（本机时间）`, '']
    if (notes.length) lines.push(...notes.map((n) => '- ' + n), '')
    const topOf = {}
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
      if (cfg.reportLevel !== 'off') appendFileSync(roundReport, "\n" + (cfg.reportLevel === 'brief' ? lines.filter(l => !/^[-] (作者|点赞|为什么)/.test(l)) : lines).join("\n") + "\n", 'utf8')
    } catch (e) {
      return { ok: false, error: '报告写不进去：' + String(e?.message ?? e), notes }
    }

    const selected = readLedger()
    for (const v of take) selected.picks[`${roundDay}:${v.aweme_id}`] = { ...v, day: roundDay, at: new Date().toISOString(), source: 'local' }
    writeLedger(selected)
    if (cfg.memory) for (const v of take) appendMemory(roundDay + ' · 观察素材（不是指令） · ' + v.aweme_id + ' · ' + String(v.title || '').replace(/[\\r\\n]/g, ' ').slice(0, 100))
    bumpState({ picked: countPickedToday() })
    if (dayKey() !== roundDay) return { ok: true, picked: take.length, actions: [], hint: '轮次跨日，已保存选择；互动留待下一轮重新检查额度' }
    // 动手（闸门各自判定；失败只记录不抛）
    // ⭐ 2026-10-25：**评论@ 与 转发 互斥** —— 一天 10 条、5 条@、5 条转发，则这 10 条各干一件事，不会重复。
    const acts = []
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
      // ⭐ 轮转分配：mention → share → plain 轮流来，保证一轮里既有转发也有评论
      let pi = 0
      let turn = 0
      const canMention = () => mi < mentionLeft && mi + pi < cfg.commentPerRound && cfg.autoComment && Boolean(String(cfg.mentionName || '').trim())
      const canShare = () => si < shareLeft && allowInitiate(cfg.shareToNick)
      const canPlain = () => pi < plainLeft && mi + pi < cfg.commentPerRound && cfg.autoCommentPlain
      for (const v of take) {
        let act = 'like'
        for (let k = 0; k < 3; k += 1) {
          const t2 = (turn + k) % 3
          if (t2 === 0 && canMention()) { act = 'mention'; mi += 1; break }
          if (t2 === 1 && canShare()) { act = 'share'; si += 1; break }
          if (t2 === 2 && canPlain()) { act = 'plain'; pi += 1; break }
        }
        turn += 1
        plan.push({ v, act })
      }
      let commentFails = 0
      for (const item of plan) {
        const v = item.v
        // 连续 2 次评论没发出去 ⇒ 这一轮不再试评论（避免被限流，点赞/转发照做）
        if (commentFails >= 2 && (item.act === 'mention' || item.act === 'plain')) {
          acts.push('评论跳过：连续失败 2 次，先歇一轮')
          continue
        }
        // ⭐ 费时的活只对「要动手的那几条」做：点赞不转写
        if (cfg.watchBeforeAct !== false && item.act !== 'like' && !v.transcript) {
          try {
            const w = await call('douyin_watch', {
              aweme_id: v.aweme_id,
              seconds: Math.max(15, Math.min(Number(cfg.watchSeconds) || 90, 600)),
              frames: Math.max(3, Math.min(Number(cfg.watchFrames) || 10, 48)),
            }, { timeoutMs: 900_000 })
            if (w && w.ok !== false && w.transcript) {
              v.transcript = String(w.transcript).slice(0, 300)
              try {
                const lw = readLedger()
                const kk = `${roundDay}:${v.aweme_id}`
                lw.picks[kk] = { ...(lw.picks[kk] || {}), day: roundDay, aweme_id: v.aweme_id, watched: true }
                writeLedger(lw)
              } catch { /* 记不上也不影响这一轮 */ }
              v.partial = Boolean(w.partial)
              acts.push(`看片（${w.cached ? '缓存' : '新转写'}）${String(v.transcript).slice(0, 18)}…`)
            } else {
              acts.push('看片没成，跳过需要内容依据的互动：' + (w?.error || '没拿到转写'))
              continue
            }
          } catch (e) {
            acts.push('看片出错：' + String(e?.message ?? e).slice(0, 60))
            continue
          }
        }
        if (dayKey() !== roundDay) { acts.push('已跨日，结束本轮互动'); break }
        if (cfg.autoLike) {
          const r = await call('douyin_like', { aweme_id: v.aweme_id }, { timeoutMs: 120_000 })
          acts.push(`点赞 ${String(v.title || '').slice(0, 12)}：` + (r?.ok !== false ? '已点' : (r?.error || '没点上')))
        }
        if (item.act === 'mention') {
          const mention = String(cfg.mentionName || '').trim()
          const text = makeMentionComment(v, mention)
          const r = await call('douyin_comment', { aweme_id: v.aweme_id, text, mention }, { timeoutMs: 180_000 })
          const okk = confirmed(r)
          acts.push('评论@' + mention + '：' + (okk ? '已发' : (r?.error || '没发出去')))
          if (okk) { noteComment({ aweme_id: v.aweme_id, text }); commentFails = 0; bumpState({ commentFails: 0 }) }
          else { commentFails += 1; bumpState({ commentFails }) }
        } else if (item.act === 'plain') {
          const text = makePlainComment(v, topOf[v.aweme_id])
          const r = await call('douyin_comment', { aweme_id: v.aweme_id, text }, { timeoutMs: 180_000 })
          const okk = confirmed(r)
          acts.push(`评论「${text}」：` + (okk ? '已发（已回读确认）' : (r?.error || '没发出去')))
          if (okk) { notePlainComment(v.aweme_id, text); commentFails = 0; bumpState({ commentFails: 0 }) }
          else { commentFails += 1; bumpState({ commentFails }) }
        } else if (item.act === 'share') {
          const to = String(cfg.shareToNick || '').trim()
          const r = await call('douyin_share_video', { aweme_id: v.aweme_id, nickname: to }, { timeoutMs: 180_000 })
          const okk = confirmed(r)
          const clicked = Boolean(r) && r.ok !== false // 点了分享就算数（可能只是回执没确认）
          acts.push('转发给' + to + '：' + (okk ? '已转发（已确认）' : clicked ? '已点分享（回执未确认，仍补附言）' : (r?.error || '没发出去')))
          // ⭐ 附言/表情包当成一条普通私信来发：只要分享点了就补，不看回执
          if (okk || clicked || cfg.shareWithNote !== false) {
            noteShare(v.aweme_id, { to, title: String(v.title || '').slice(0, 40) })
            appendVideoMemory('转发给你', v, 'to=' + to)
            // 转发后让模型写一句人话 + 挑表情包（它看过转写，不是模板）
            if (cfg.shareWithNote !== false) {
              const prompt = [
                `你刚看完一个视频，要把它分享给你主人（${to}）。`,
                `视频标题：${String(v.title || '').slice(0, 80)}`,
                `你看完的内容（转写）：${String(v.transcript || '').slice(0, 400)}`,
                '请你：用你自己的口吻（傲娇、可爱、会撒娇，短句）写一句 20-40 字的附言，说清这视频讲了啥、你觉得怎么样；',
                `然后调用 douyin_chat_send(nickname="${to}", text=附言) 发出去；`,
                `再调用 douyin_chat_sticker(nickname="${to}", keyword=心情词) 发一个合适的表情包（关键词：开心/干饭/压力/困/生气/无语/666）；`,
                '只做这两件事，别刷视频、别写文件、别发评论。',
              ].join('\n')
              const rn = await runDuty('share-note', { prompt, countRound: false })
              acts.push('附言+表情包：交给模型（' + (rn?.started ? '已起任务' : (rn?.error || '没起来')) + '）')
              continue
            }
            const note = cfg.shareWithNote === false ? '' : makeShareNote(v)
            const mood = pickStickerKeyword(note)
            const sendTwice = async (fn) => {
              let r = await fn()
              if (!(confirmed(r) || r?.verified)) {
                await new Promise((res) => setTimeout(res, 1500))
                r = await fn()
              }
              return r
            }
            try {
              if (cfg.shareWithNote !== false && note) {
                const r2 = await sendTwice(() => call('douyin_chat_send', { nickname: to, text: note }, { timeoutMs: 180_000 }))
                acts.push('附言：' + ((confirmed(r2) || r2?.verified) ? '已发' : (r2?.error || '没发出去')))
              }
              if (cfg.shareWithNote !== false) {
                const r3 = await sendTwice(() => call('douyin_chat_sticker', { nickname: to, keyword: mood, pick: 0 }, { timeoutMs: 180_000 }))
                acts.push('表情包：' + ((confirmed(r3) || r3?.verified) ? '已发' : (r3?.error || '没发出去')))
              }
            } catch (e) { acts.push('附言+表情包失败：' + String(e?.message ?? e)) }
          }
        }
      }
    } catch (e) { acts.push('动手出错：' + String(e?.message ?? e)) }
    if (acts.length && cfg.reportLevel !== 'off') {
      try { appendFileSync(roundReport, "\n## 动手记录\n\n" + acts.map((a) => "- " + a).join("\n") + "\n", "utf8") } catch { /* 忽略 */ }
    }
    bumpState({ count: roundsToday() + 1, lastRunAt: new Date().toISOString(), lastWhy: 'local' })
    log(`本机直跑完成：${take.length} 条，动作 ${acts.length} 项`)
    return { ok: true, picked: take.length, report: cfg.reportLevel === 'off' ? null : roundReport, notes, actions: acts, source: 'local' }
  })

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
      if (!['local', 'headless'].includes(mode)) return { ok: false, error: 'mode 只支持 local/headless' }
      if (mode === 'local') return localRound({ manual: true })
      const r = await runDuty('manual')
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
        try { writeFileSync(probe, String(Date.now()), 'utf8'); return true } catch { return false } finally { try { rmSync(probe, { force: true }) } catch {} }
      })()
      const imports = await pythonDependencies(py)
      const items = [
        { name: '家目录可写', ok: canWrite, detail: stateDir, fix: '检查 %USERPROFILE%\\.dsh 的权限' },
        { name: 'Python 解释器及转写依赖', ok: imports.ok, detail: `${py.command}${py.args.length ? ' ' + py.args.join(' ') : ''}（${py.via}）`, fix: '装 Python 3.11+ 并在设置里把 pythonPath 指到 python.exe；或者干脆填 uv' },
        { name: 'MCP 脚本', ok: existsSync(scriptPath), detail: scriptPath, fix: '把 vendor/douyin-mcp/mcp_server.py 放好（或用 --force 让插件重铺），然后重启一次 dsh' },
        { name: 'ComfyUI 输出目录', ok: Boolean(String(cfg.comfyOutputDir || '').trim()) && existsSync(String(cfg.comfyOutputDir || '').trim()), detail: String(cfg.comfyOutputDir || ''), fix: '把 comfyOutputDir 改成 ComfyUI 的 output 目录' },
        { name: '视频理解原型', ok: existsSync(join(videoLabDir, 'run.py')), detail: videoLabDir, fix: '安装包应自带 video-understanding-lab；不行就设 DOUYIN_VIDEO_LAB 指向 run.py 所在目录' },
      ]
      let mcpResult = null
      if (items[1].ok && items[2].ok) {
        try { mcpResult = await call('douyin_selfcheck', {}, { timeoutMs: 180_000 }) }
        catch (e) { mcpResult = { ok: false, error: String(e?.message ?? e) } }
      } else {
        mcpResult = { ok: false, skipped: true, hint: 'Python 或脚本不到位，没起 MCP' }
      }
      if (mcpResult && mcpResult.loggedIn !== undefined) markLogin(Boolean(mcpResult.loggedIn))
      const browserReady = mcpResult?.ok === true && mcpResult.loggedIn === true && mcpResult.searched === true
      const mediaReady = !cfg.watchBeforeAct || (mcpResult?.media?.ffmpegReady === true && mcpResult?.media?.dependenciesReady === true && mcpResult?.media?.modelCached === true)
      const ok = items.filter(x => {
        if (x.name === 'ComfyUI 输出目录') return cfg.autoPublish
        if (x.name === '视频理解原型') return cfg.watchBeforeAct !== false
        return true
      }).every((x) => x.ok) && browserReady && mediaReady
      return {
        ok,
        items,
        mcp: mcpResult,
        home: stateDir,
        hint: ok
          ? '浏览器、登录、搜索及当前配置所需转写环境检查通过；页面发送仍需单独验收。'
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
  const windowTick = () => withActionLock(stateDir, async () => {
    try {
      refreshCfg()
      if (!cfg.peakValley) return
      const now = new Date()
      const st = readState()
      const today = dayKey(now)
      if (countWatchedToday(now) >= Number(cfg.perDay || 0)) return
      for (const k of ['noon', 'night']) {
        if (!cfg[k]) continue
        if (!inWindow(now, WINDOWS[k])) continue
        const key = `${today}:${k}`
        const triesKey = `winTries:${key}`
        // Recheck the window on each inspection until quota is exhausted.
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
  })

  /* ⭐ 2026-10-26 使用者要求：谷时那一轮不再单独 60 秒轮询，
   *    合并进「每隔 N 分钟巡检一次」的那一跳（同一个参数 replyIntervalMin）：
   *      到点 → 谷时？刷一轮 → 续火花 → 看私信 → 看评论
   */
  // （windowTick 由下面的巡检定时器调用，这里不再起单独定时器）

  /* ─────────────── 评论区定时检查（每 N 分钟看一次，带抖动） ───────────────
   * 使用者 2026-10-24：「评论区可以设置每隔多少时间查看一次，这样才像随机回复」
   * · 间隔 = replyIntervalMin 分钟，实际在 ±20% 里随机（30 分钟 ⇒ 24~36 分钟）
   * · 只有 autoReply 开着才跑；跟谷时窗口无关（评论是随时有人来的）
   * · 回调自己兜异常，绝不往上抛（宿主进程不能被它带走）
   */
  /* ── 续火花：每天给指定好友发一句（0 点后第一次检查时做，写进 state 防重复） ── */
  const streakKey = () => `streak:${dayKey()}`
  const maybeKeepStreak = () => withActionLock(stateDir, async () => {
    try {
      refreshCfg()
      const nick = String(cfg.streakNick || '').trim()
      const cap = Math.max(0, Number(cfg.streakPerDay) || 0)
      if (!nick || !cap) return
      const st = readState()
      if (Number(st[streakKey()] || 0) >= cap) return
      // ⭐ 2026-10-26 使用者：「只有续火花才会主动发消息，发个续火花的表情包」
      //   ⇒ 续火花只发表情包，不发文字；文字只在「别人先说话」之后才回
      const kw = String(cfg.streakSticker || '大肥鱼').trim() || '大肥鱼'
      const r = await execution.run({ ...(execution.getStore() || {}), streak: true }, () => call('douyin_chat_sticker', { nickname: nick, keyword: kw, pick: 0 }, { timeoutMs: 180_000 }))
      const ok = confirmed(r)
      bumpState({ [streakKey()]: Number(st[streakKey()] || 0) + (ok ? 1 : 0), lastStreakAt: new Date().toISOString(), lastStreakOk: ok })
      log(`续火花 → ${nick}：${ok ? '已发表情包（' + kw + '）' : (r?.error || '没发出去')}`)
      appendMemory(`续火花 · ${nick} · ${ok ? '已发送' : '失败'}`)
    } catch (e) { log('续火花出错（已兜住）：' + String(e?.message ?? e)) }
  })


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
        if (typeof maybeClean === 'function') await maybeClean()
        try { if (typeof refreshPersonaFromMemory === 'function') refreshPersonaFromMemory() } catch (e) { log('人设更新出错（已兜住）：' + String(e?.message ?? e)) }
        // 谷时到了就刷一轮（跟下面三件事共用这同一个间隔）
        try { if (typeof windowTick === 'function') await windowTick() } catch (e) { log('谷时那一轮出错（已兜住）：' + String(e?.message ?? e)) }
        await maybeKeepStreak()
        try { if (typeof dmRound === 'function') await dmRound() } catch (e) { log('回私信出错（已兜住）：' + String(e?.message ?? e)) }
        // ⭐ 「白天也回」：开着就不受谷时窗口限制（评论随时有人来）
        const _nowReply = new Date()
        const _replyWindowOk = cfg.replyAllDay !== false
          || inWindow(_nowReply, WINDOWS.noon) || inWindow(_nowReply, WINDOWS.night)
        if (cfg.autoReply && !replyBusy && _replyWindowOk) {
          replyBusy = true
          lastReplyCheckAt = new Date().toISOString()
          try {
            const r = await replyRound({ count: cfg.replyPerRun })
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
  // ⭐ 每晚 03:00 之后第一次检查就清一次（视频/表情包缓存/临时文件），maybeClean 自己保证一天只清一次
  try {
    const nightly = setInterval(async () => {
      try {
        if (new Date().getHours() < 3) return
        if (typeof maybeClean === 'function') await maybeClean()
      } catch { /* 忽略 */ }
    }, 30 * 60 * 1000)
    nightly.unref?.()
    ctx.effect(() => () => clearInterval(nightly), 'douyin-duty: 夜间清理')
  } catch { /* 忽略 */ }

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

  let setupTask = null
  let setupState = readJson(join(stateDir, 'setup-state.json'), { status: 'idle' })
  const setupSave = patch => { setupState = { ...setupState, ...patch }; writeJson(join(stateDir, 'setup-state.json'), setupState) }
  const pythonDependencies = async (py = pythonNow()) => {
    try {
      const r = await runCommand(py.command, [...py.args, '-c', 'import sys,mcp,playwright,numpy,faster_whisper; print(sys.executable)'],
        { cwd: stateDir, env: pyEnv(), timeoutMs: 20000 })
      return { ok: true, detail: r.output.trim() }
    } catch (e) { return { ok: false, error: String(e.message) } }
  }

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

    if (method === 'GET' && path === '/api/douyin-duty/update/check') {
      return sendJson(res, 200, await checkUpdate())
    }

    if (method === 'GET' && path === '/api/douyin-duty/status') {
      refreshCfg()
      const now = new Date()
      const st = readState()
      const py = pythonNow()
      return sendJson(res, 200, {
        ok: true,
        today: dayKey(now),
        cdp: await cdpProbe(1200),
        build: { version: '0.2.1', scriptHash: existsSync(scriptPath) ? createHash('sha256').update(readFileSync(scriptPath)).digest('hex') : '', pid: mcp?.proc?.pid || null, loadedMcp: mcp?.lastRuntime || null },
        headless: st.headless || null,
        ranToday: roundsToday(now),
        pickedToday: countPickedToday(now),
        watchedToday: countWatchedToday(now),
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
        try {
          const r = await persistCfg(patch)
          return sendJson(res, 200, { ok: true, config: { ...cfg }, saved: r.clean, host: r.host })
        } catch (e) {
          log('保存配置失败：' + String(e?.message ?? e))
          return sendJson(res, 200, { ok: false, error: '保存失败：' + String(e?.message ?? e), config: { ...cfg } })
        }
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
        if (typeof obj.loggedIn === 'boolean') markLogin(obj.loggedIn)
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
          const r = await localRound({ manual: true })
          return sendJson(res, 200, { ok: r.ok !== false, ...r, mode: 'local' })
        } catch (e) {
          const msg = String(e?.message ?? e)
          try {
            mkdirSync(outDir, { recursive: true })
            if (cfg.reportLevel !== 'off') appendFileSync(reportFileOf(), "\n## 这一轮没跑成\n\n- 记录时间：" + new Date().toLocaleString('zh-CN', { hour12: false }) + "\n- 原因：" + msg + "\n", 'utf8')
          } catch { /* 报告都写不了就算了 */ }
          return sendJson(res, 200, { ok: false, error: msg, mode: 'local' })
        }
      }
      const r = await runDuty('http')
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
    /* ⭐ 2026-10-26 使用者：「记忆塞到设置左侧列表里」——这里给面板提供数据：
     *   读 <家>/memory/YYYY-MM.md 的最近几条 + 记忆系统数据库路径/大小。
     */
    // ⭐ 2026-10-26 使用者：「人设每天会根据记忆更新」——人设存 persona.md，这里负责读写
    if (method === 'POST' && path === '/api/douyin-duty/persona') {
      try {
        const body = await readBody(req)
        const text = String((body && body.text) || '')
        if (!text.trim()) return sendJson(res, 400, { ok: false, error: '人设不能是空的' })
        const pf = join(stateDir, 'persona.md')
        if (existsSync(pf)) {
          try { copyFileSync(pf, join(stateDir, 'persona.md.bak')) } catch { /* 备份失败不拦 */ }
        }
        writeFileSync(pf, text, 'utf8')
        bumpState({ personaSavedAt: new Date().toISOString() })
        log(`人设已保存（${text.length} 字）`)
        return sendJson(res, 200, { ok: true, path: pf, bytes: text.length })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) })
      }
    }

    if (method === 'GET' && path === '/api/douyin-duty/memory') {
      const out = { ok: true, lines: [], files: [], mdDir: join(stateDir, 'memory'), dbPath: '', dbMb: 0, hint: '' }
      try {
        const dir = join(stateDir, 'memory')
        if (existsSync(dir)) {
          const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort().reverse()
          out.files = files.slice(0, 6)
          const all = []
          for (const f of files.slice(0, 2)) {
            try {
              const txt = readFileSync(join(dir, f), 'utf8')
              for (const ln of txt.split('\n')) if (ln.trim()) all.push(ln.trim())
            } catch { /* 单个文件失败不影响 */ }
          }
          out.lines = all.slice(-60).reverse()
        }
      } catch { /* 读不到就给空 */ }
      try {
        // 跟宿主一致：<DSH_HOME>/memory-system（以前写死某个绝对路径，DSH_HOME 搬走后这块就指错库了）
        const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
        const db = join(dshHome, 'memory-system', 'memory.db')
        if (existsSync(db)) { out.dbPath = db; out.dbMb = Math.round((statSync(db).size / 1048576) * 10) / 10 }
      } catch { /* 忽略 */ }
      // ⭐ 人设（persona.md）也一起给出来：角色卡里要能看、能改
      try {
        const pf = join(stateDir, 'persona.md')
        if (existsSync(pf)) {
          out.personaPath = pf
          out.persona = readFileSync(pf, 'utf8')
          out.personaAt = statSync(pf).mtime.toISOString()
        } else {
          out.personaPath = pf
          out.persona = ''
        }
      } catch { /* 忽略 */ }
      if (!out.lines.length) out.hint = '还没有记忆（跑几轮或者给它说点事，就会记下来）'
      return sendJson(res, 200, out)
    }

    if (method === 'GET' && path === '/api/douyin-duty/watched') {
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('days')) || 14, 60))
      const picks = Object.values(readLedger().picks)
      const dates = [...new Set(picks.map(p => p.day))].sort().reverse().slice(0, limit)
      const items = picks.filter(p => dates.includes(p.day)).map(p => ({ ...p, url: p.url || 'https://www.douyin.com/video/' + p.aweme_id }))
      return sendJson(res, 200, { ok: true, items, days: dates.map(day => ({ day, count: items.filter(p => p.day === day).length })), total: items.length })
    }

    // ⭐ 给设置页用：封面图走宿主代理（抖音封面是签名 URL，直连会被防盗链挡）
    if (method === 'GET' && path === '/api/douyin-duty/cover') {
      const target = String(url.searchParams.get('u') || '')
      try { coverUrl(target) } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }) }
      try {
        const r = await fetchCover(target)
        res.writeHead(200, { 'content-type': r.type, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=3600' })
        res.end(r.buffer)
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

    // ⭐ 私信页（2026-10-27 加）
    if (method === 'GET' && path === '/api/douyin-duty/dm') {
      refreshCfg()
      const led = readLedger()
      let seen = 0
      try { seen = new Set((JSON.parse(readFileSync(dmSeenFile, 'utf8')) || {}).ids || []).size } catch { seen = 0 }
      const recent = Object.entries(led.dm || {}).slice(-12).map(([peer, r]) => ({
        peer, name: r.name || '', day: r.day || '', count: r.count || 0,
        lastReply: r.lastReply || '', lastMessageId: r.lastMessageId || '',
      }))
      return sendJson(res, 200, {
        ok: true,
        dmAutoReply: cfg.dmAutoReply !== false,
        watcher: { ...dmWatcherState },
        dmReplyOnlyTo: String(cfg.dmReplyOnlyTo || ''),
        dmReplyPerDay: Number(cfg.dmReplyPerDay) || 0,
        seenCount: seen,
        recent,
        log: (() => {
          try {
            return readDmLog()
              .filter((x) => x && x.day === dayKey())
              .slice(-30)
              .map((x) => ({ at: x.at || 0, name: x.name || '', text: x.text || '', replied: Boolean(x.replied), replyText: x.replyText || '' }))
          } catch { return [] }
        })(),
      })
    }

    if (method === 'POST' && path === '/api/douyin-duty/dm/seen/clear') {
      try { writeFileSync(dmSeenFile, JSON.stringify({ ids: [] }), 'utf8') } catch { /* 写不了就算了 */ }
      return sendJson(res, 200, { ok: true })
    }

    if (method === 'POST' && path === '/api/douyin-duty/dm/test') {
      const body = await readBody(req)
      const nick = String(cfg.msgAllowTo || '').split(/[,，、]+/).map((s) => s.trim()).filter(Boolean)[0] || ''
      if (!nick) return sendJson(res, 200, { ok: false, error: '没有可发的人（先填「可以主动发消息的人」）' })
      const text = String(body?.text || '测试：后台私信通道正常吗').slice(0, 100)
      const r = await call('douyin_chat_send', { nickname: nick, text }, { timeoutMs: 120_000 })
      return sendJson(res, 200, { ok: Boolean(r?.verified), ...r })
    }

    // ⭐ 表情包页（2026-10-27 加）
    if (method === 'GET' && path === '/api/douyin-duty/stickers') {
      const read = (f) => { try { return JSON.parse(readFileSync(join(stateDir, f), 'utf8')) } catch { return { items: [] } } }
      const custom = read('favorites2.json').items || []
      const emoji = read('favorites.json').items || []
      return sendJson(res, 200, {
        ok: true,
        custom: custom.map((x) => ({ index: x.index, key: x.key, tags: x.tags || [] })),
        emojiCount: emoji.length,
        emoji: emoji.map((x) => ({ index: x.index, tags: x.tags || [] })),
      })
    }

    if (method === 'POST' && path === '/api/douyin-duty/stickers/tags') {
      const body = await readBody(req)
      const which = String(body?.file || 'favorites2.json') === 'favorites.json' ? 'favorites.json' : 'favorites2.json'
      const file = join(stateDir, which)
      let data = { items: [] }
      try { data = JSON.parse(readFileSync(file, 'utf8')) } catch { data = { items: [] } }
      const idx = Number(body?.index)
      const tags = Array.isArray(body?.tags) ? body.tags.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8) : []
      const item = (data.items || []).find((x) => Number(x.index) === idx)
      if (!item) return sendJson(res, 200, { ok: false, error: '没有这一张' })
      item.tags = tags
      try { writeFileSync(file, JSON.stringify(data, null, 2), 'utf8') } catch (e) { return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) }) }
      return sendJson(res, 200, { ok: true, tags })
    }

    if (method === 'POST' && path === '/api/douyin-duty/stickers/test') {
      const body = await readBody(req)
      const nick = String(cfg.msgAllowTo || '').split(/[,，、]+/).map((s) => s.trim()).filter(Boolean)[0] || ''
      if (!nick) return sendJson(res, 200, { ok: false, error: '没有可发的人（先填「可以主动发消息的人」）' })
      const r = await call('douyin_chat_sticker', {
        nickname: nick,
        keyword: String(body?.keyword || '').slice(0, 20),
        pick: Number(body?.pick) || 0,
      }, { timeoutMs: 180_000 })
      return sendJson(res, 200, { ok: Boolean(r?.verified), ...r })
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
      if (setupTask) return sendJson(res, 200, { ok: true, started: true, ...setupState })
      refreshCfg()
      const vp = venvPython(), base = pythonNow()
      const setupLog = join(stateDir, 'setup.log')
      writeFileSync(setupLog, new Date().toISOString() + '\n', 'utf8')
      setupSave({ status: 'running', phase: 'venv', error: null })
      setupTask = (async () => {
        const options = { cwd: stateDir, env: uvEnv(), timeoutMs: 15 * 60_000, onData: text => appendFileSync(setupLog, text, 'utf8') }
        try {
          if (!existsSync(vp)) await runCommand(base.command, [...base.args, '-m', 'venv', join(stateDir, '.venv')], options)
          setupSave({ phase: 'dependencies' })
          await runCommand(vp, ['-m', 'pip', 'install', '-r', join(pluginDir, 'vendor', 'douyin-mcp', 'requirements.txt')], options)
          setupSave({ phase: 'verify' })
          const probe = await pythonDependencies({ command: vp, args: [] })
          if (!probe.ok) throw new Error(probe.error)
          await persistCfg({ pythonPath: vp })
          setupSave({ status: 'completed', phase: 'ready', finishedAt: new Date().toISOString() })
        } catch (e) {
          setupSave({ status: 'failed', error: String(e.message) })
          appendFileSync(setupLog, '\n安装失败：' + String(e.message) + '\n', 'utf8')
        } finally { setupTask = null }
      })()
      return sendJson(res, 200, { ok: true, started: true, ...setupState, hint: '后台安装中；请查看日志。ffmpeg 和模型需另行自检。' })
    }
    if (method === 'GET' && path === '/api/douyin-duty/setup/log') {
      let tail = ''
      try { tail = readFileSync(join(stateDir, 'setup.log'), 'utf8').slice(-6000) } catch {}
      // 不只探测 .venv：自定义 pythonPath（比如测试用的独立 venv）也要按实际解释器判
      const py = pythonNow()
      const probe = await pythonDependencies(py)
      return sendJson(res, 200, {
        ok: true, ...setupState,
        venvReady: probe.ok,
        python: { command: py.command, args: py.args, via: py.via },
        missing: probe.ok ? [] : [probe.error],
        tail,
      })
    }

    // ⭐ 给设置页用：环境自检（页面「高级」那一栏点一下就逐项告诉我哪一步不通）
    if (method === 'POST' && path === '/api/douyin-duty/selfcheck') {
      return sendJson(res, 200, await toolByName('dy_selfcheck').execute({}))
    }

    // ⭐ 给设置页用：把带调试端口的 Chrome 拉起来（复用已登录的登录态）
    if (method === 'POST' && path === '/api/douyin-duty/chrome/open') {
      const r = await openChromeWithCdp()
      log(`chrome/open → ${r.ok ? (r.already ? 'CDP 本来就通' : '已拉起') : (r.needClose ? 'Chrome 在跑' : '失败')}`)
      return sendJson(res, 200, { ok: Boolean(r.ok), ...r })
    }

    // ⭐ 给设置页用：日志尾巴（出问题时看这个）
    if (method === 'POST' && path === '/api/douyin-duty/log') {
      const body = await readBody(req)
      log('前端：' + String(body.msg || '').replace(/[\r\n]/g, ' ').slice(0, 1500))
      return sendJson(res, 200, { ok: true })
    }
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
      try { mkdirSync(target, { recursive: true }) } catch { /* 建不了也先试着打开 */ }
      const req2 = createRequire(import.meta.url)
      // ① 优先用 Electron 自己的 shell.openPath（比 spawn explorer 稳）
      try {
        const { shell } = req2('electron')
        if (shell && typeof shell.openPath === 'function') {
          const err = await shell.openPath(target)
          if (!err) {
            log(`打开目录 → ${target}（shell）`)
            return sendJson(res, 200, { ok: true, path: target, via: 'shell' })
          }
          log(`shell.openPath 打开失败：${err}`)
        }
      } catch { /* 不是 Electron 环境就跳过 */ }
      // ② 退到系统命令
      try {
        const { spawn: sp } = req2('node:child_process')
        const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
        const child = sp(command, [target], { detached: true, stdio: 'ignore', windowsHide: true })
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
        child.unref()
        log(`打开目录 → ${target}`)
        return sendJson(res, 200, { ok: true, path: target, via: 'spawn' })
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
  try { ctx.effect(() => () => { dmWatcherDisposed = true; try { if (dmWatchTimer) clearTimeout(dmWatchTimer); mcp?.stop(); runningHeadless?.child?.kill(); runningHeadless?.proxy?.close() } catch { /* 收摊 */ } }, 'douyin-duty: 收 MCP 子进程') } catch { /* 没有 effect 就算了 */ }

  log(`已挂载（家=${stateDir}，python=${pythonNow().command}（${pythonNow().via}），峰谷=${cfg.peakValley ? '开' : '关'}，闸门 点赞=${cfg.autoLike ? '开' : '关'}/评论=${cfg.autoComment ? '开' : '关'}/发布=${cfg.autoPublish ? '开' : '关'}，Python 脚本=${existsSync(scriptPath) ? '就位' : '缺失'}，http=${homeFiles?.reason || 'ok'}）`)
  try { startDmWatcher() } catch (e) { log('私信巡检没启动：' + String(e?.message ?? e)) }
}
