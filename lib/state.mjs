/**
 * lib/state.mjs —— 插件的"家"、谷时窗口、配置读写
 * ============================================================================
 * 规矩：**配置、凭证、报告、日志都放插件自己的家** ——
 * `%USERPROFILE%\.dsh\douyin-duty\`（或 `$DSH_HOME/douyin-duty/`），
 * **绝不写进插件包目录**（装进 node_modules 后可能只读、升级也会被覆盖）。
 *
 * 还有一件小事但很要紧：vendored 的 `mcp_server.py` 里，Playwright 浏览器 profile、
 * 登录二维码存盘路径都按 `Path(__file__).parent` 算 —— 所以**运行时要把脚本铺到家目录里再跑**，
 * 这样登录态、二维码才会落在家里，而不是插件包里。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 家里那层目录名（`<dsh home>/douyin-duty`）—— 只有这一处写 */
const HOME_DIR_NAME = 'douyin-duty'

/**
 * 谷时窗口（北京时间，本地时区）—— 想改就改这一处。
 * ⭐ 口径（SPEC 3.5）：**工作日 9:00–12:00、14:00–18:00 是高峰不跑**；
 *    中午 12:00–14:00、夜间 00:30–08:30 是谷时。
 * ⚠️ `night` 跨零点（00:30 → 08:30 是同一天内的区间，不跨界；02:00–23:00 那种才跨界，
 *    `inWindow` 两种都支持）。
 */
export const WINDOWS = {
  noon: { label: '中午谷时', start: '12:00', end: '14:00' },
  night: { label: '夜间谷时', start: '00:30', end: '08:30' },
}

/**
 * ⭐ dsh 真机上的坑（bili 版踩过，原样保留这段注释）：`ctx.get('dshHomePath')` 返回的是
 *   **函数**，不是字符串：`dshHomePath(...segments) => join(resolveDshHome(), ...segments)`。
 *   当字符串用（`String(p)`）⇒ 路径里塞进函数源码 ⇒ mkdir ENOENT ⇒ apply 抛错 ⇒ 插件不激活。
 *   所以这里是"函数形态 → 传目录名；字符串形态 → join；都没有 → 环境变量/家目录兜底"。
 */
export function stateDirOf(ctx) {
  let dir = ''
  // ⭐ 家目录必须和 Python 半边**同一个**：`vendor/douyin-mcp/mcp_server.py` 固定用
  //    `%USERPROFILE%\.dsh\douyin-duty`（`Path.home()/'.dsh'/'douyin-duty'`），本机 `DSH_HOME=<DSH_HOME>`，
  //    一旦这里跟着 DSH_HOME 走，宿主算到 <DSH_HOME>\douyin-duty、Python 却写 ~/.dsh/douyin-duty
  //    ⇒ 二维码扫在 A，profile 在 B，登录态永远对不上（2026-10-23 实测踩到）。
  //    ⇒ 一律按"用户家目录 + .dsh"，只有 `DSH_DOUYIN_HOME` 能覆盖（宿主和 Python 都认这一个）。
  const envHome = String(process.env.DSH_DOUYIN_HOME || '').trim()
  if (envHome) dir = envHome
  if (!dir) dir = join(homedir(), '.dsh', HOME_DIR_NAME)
  try { mkdirSync(dir, { recursive: true }) } catch { /* 建不出来也别在 apply 里抛 */ }
  return dir
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJson(file, value) {
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, file)
  } finally { try { unlinkSync(temp) } catch {} }
}

/**
 * 把 vendored 的 `mcp_server.py` 铺进家里。
 *
 * 规矩（SPEC 1 / 关键约束）：
 *   · 家里没有 ⇒ 铺一份 ✓
 *   · 家里有、内容一样 ⇒ 什么都不做 ✓
 *   · 家里有、内容不一样 ⇒ **不覆盖**（可能是队友/用户手工改过的），新版落到 `mcp_server.py.new` ✓
 *   · 传了 `--force`（`opts.force`）⇒ 一律覆盖（我们自己升级 Python 半边时用）✓
 */
export function ensureHomeFiles(pluginDir, stateDir, log = () => {}, opts = {}) {
  const force = Boolean(opts.force)
  const from = join(pluginDir, 'vendor', 'douyin-mcp', 'mcp_server.py')
  const to = join(stateDir, 'mcp_server.py')
  const hashFile = join(stateDir, 'mcp.sha256')
  const sha = (s) => createHash('sha256').update(s).digest('hex')
  try {
    if (!existsSync(from)) { log(`缺文件：${from}（Python MCP 还没放进来，先跳过）`); return { copied: false, reason: 'missing-vendor' } }
    const incoming = readFileSync(from, 'utf8')
    if (!existsSync(to)) {
      copyFileSync(from, to)
      writeFileSync(hashFile, sha(incoming))
      log(`已铺好：${to}`)
      return { copied: true, reason: 'fresh' }
    }
    const onDisk = readFileSync(to, 'utf8')
    if (onDisk === incoming) { writeFileSync(hashFile, sha(incoming)); return { copied: false, reason: 'same' } }
    const previous = existsSync(hashFile) ? readFileSync(hashFile, 'utf8').trim() : ''
    const legacy = '3d54b0d8a92f49b6364045db22a55bec19145e559f70effc22c8a78c9966e8d0'
    if (force || sha(onDisk) === previous || sha(onDisk) === legacy) {
      copyFileSync(to, to + '.bak')
      writeFileSync(to, incoming, 'utf8')
      writeFileSync(hashFile, sha(incoming))
      log(`已备份并${force ? '强制更新' : '升级原版脚本'}：${to}`)
      return { copied: true, reason: force ? 'forced' : 'upgraded' }
    }
    const side = to + '.new'
    try { if (!existsSync(side) || readFileSync(side, 'utf8') !== incoming) writeFileSync(side, incoming, 'utf8') } catch { /* 写不了就算了 */ }
    log(`注意：${to} 和插件里那份不一样，这次没覆盖；新版放在 ${side}（确认要换再传 --force）`)
    return { copied: false, reason: 'kept', side }
  } catch (e) {
    log(`铺 ${to} 失败：${e?.message ?? e}`)
    return { copied: false, reason: 'error', error: String(e?.message ?? e) }
  }
}

/**
 * 值班章程（`prompts/duty.md`）怎么升级 —— 记账制（跟 bili 一致，别再退回"比 mtime"）：
 *   · 家里那份 === 我们上次铺的（`charter.sha256`）⇒ 他没动过 ⇒ 直接覆盖（升级 ✓）
 *   · 家里那份变过 ⇒ 他改过 ⇒ **一个字都不动**，新版另存 `duty.md.new` ✓
 *   · 没有账本 ⇒ 分不清"没改只是版本旧"和"改过" ⇒ 按"改过"处理（宁可让他手动合一次）
 */
export function ensureCharter(pluginDir, stateDir, log = () => {}) {
  const shipped = join(pluginDir, 'prompts', 'duty.md')
  const home = join(stateDir, 'duty.md')
  const ledger = join(stateDir, 'charter.sha256')
  const fresh = join(stateDir, 'duty.md.new')
  const readIf = (f) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
  try {
    if (!existsSync(shipped)) { log(`缺文件：${shipped}`); return }
    const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
    const newText = readFileSync(shipped, 'utf8')
    const hShip = sha(newText)
    const hLast = readIf(ledger).trim()
    if (!existsSync(home)) {
      writeFileSync(home, newText, 'utf8')
      writeFileSync(ledger, hShip, 'utf8')
      log('已铺好值班章程')
      return
    }
    const hHome = sha(readFileSync(home, 'utf8'))
    if (hHome === hShip) {                              // 家里那份就是最新版（他可能只是没动过）
      if (hLast !== hShip) writeFileSync(ledger, hShip, 'utf8')
      return
    }
    if (!hLast || hHome !== hLast) {                    // 他改过（或没账本、分不清）⇒ 只另存新版
      if (hShip !== hLast && readIf(fresh) !== newText) {
        writeFileSync(fresh, newText, 'utf8')
        log(`值班章程有新版、但家里那份你改过 ⇒ 新版另存为 ${fresh}，自己合一下`)
      }
      return
    }
    writeFileSync(home, newText, 'utf8')
    writeFileSync(ledger, hShip, 'utf8')                 // 他没动过 ⇒ 直接升级
    log('值班章程已更新到插件里这一版')
  } catch (e) { log(`铺值班章程失败：${e?.message ?? e}`) }
}

/** 值班章程取哪一份：家里那份优先，没有才用插件里那份 */
export function charterPath(pluginDir, stateDir) {
  const home = join(stateDir, 'duty.md')
  try { if (existsSync(home)) return home } catch { /* 兜底：用插件里那份 */ }
  return join(pluginDir, 'prompts', 'duty.md')
}

/** 'HH:MM' → 当天的分钟数 */
function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** 现在在不在这个窗口里（支持跨零点，比如 23:00–02:00） */
export function inWindow(now, win) {
  const start = minutesOf(win.start); const end = minutesOf(win.end)
  if (start === null || end === null) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  return start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end)
}

/** 本地日期 YYYY-MM-DD */
export function dayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}
