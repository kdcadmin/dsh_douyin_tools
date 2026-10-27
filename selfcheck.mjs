#!/usr/bin/env node
/**
 * selfcheck.mjs —— 宿主半边的冒烟测试（不需要真的 Python / 抖音 / ComfyUI）
 * ============================================================================
 * 用一个**假的 ctx** 把 `index.js` 导进来、`apply(fakeCtx, {})` 跑一遍，断言：
 *   ① 35 个 `dy_*` 工具全部注册（名字一个不差）；
 *   ② HTTP 路由挂上了，并且 `/status`、`/config`、`/report/latest` 真的能应答；
 *   ③ `dy_status` 返回的对象结构正确（不调真实 MCP）；
 *   ④ 三道闸门默认关着时确实拒绝（点赞 / 评论 / 发布）；
 *   ⑤ 家目录里的东西铺好了（config.json / duty.md / duty.log），
 *      `duty.log` 里**每条工具调用都有一行**；
 *   ⑥ `index.js` 里没有裸 import `@deepseek-ai/*`（桌面版会把整条插件判成不激活）；
 *   ⑦ `cordis.patch.yml` 的 id 与 `export const name` 一致。
 *
 * 跑法：`node selfcheck.mjs`（FAIL 时退出码 1）
 * ⚠️ 它会把 `DSH_DOUYIN_HOME` 指到一个临时目录 —— **不会碰你真实的 .dsh**。
 *    （家目录按 `~/.dsh/douyin-duty` 钉死，跟 Python 半边一致；只有 DSH_DOUYIN_HOME 能改。）
 * ============================================================================
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpClient } from './lib/mcp.mjs'

const pluginDir = dirname(fileURLToPath(import.meta.url))
const home = mkdtempSync(join(pluginDir, '.douyin-selfcheck-'))
process.env.DSH_DOUYIN_HOME = join(home, 'douyin-duty')

const EXPECTED_TOOLS = [
  'dy_status', 'dy_config', 'dy_whoami', 'dy_login_start', 'dy_login_poll',
  'dy_search', 'dy_video', 'dy_comments', 'dy_like', 'dy_comment',
  'dy_publish', 'dy_comfy_list', 'dy_run', 'dy_selfcheck', 'dy_chrome_open',
  'dy_feed', 'dy_hot', 'dy_hot_videos', 'dy_login_sms', 'dy_login_sms_submit', 'dy_remember', 'dy_my_videos', 'dy_my_posts', 'dy_reply', 'dy_thumb', 'dy_chat_send', 'dy_chat_sticker', 'dy_share', 'dy_dm_round', 'dy_cleanup', 'dy_reply_round',
  'dy_reconcile_pending', 'dy_dm_inbox', 'dy_watch', 'dy_dm_poll',
]

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const skip = (name, detail = '') => {
  results.push({ name, ok: true, skipped: true, detail })
  console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`)
}

/* ── 假 ctx：形状照着宿主给的那几个能力来 ─────────────────────────────── */
const registeredSpecs = []      // 完整的工具 spec（要拿 execute 来真跑）
const routes = []
const cleanups = []
let effectCount = 0

const fakeCtx = {
  tools: {
    register(t) { registeredSpecs.push(t); return t },
  },
  webServer: {
    register(r) { routes.push(r); return () => {} },
  },
  settings: {
    describe() { return [] },                 // 没有设置表单 ⇒ 一切走 config.json
    async update() { return undefined },
  },
  effect(fn) {
    effectCount += 1
    const c = typeof fn === 'function' ? fn() : undefined
    if (typeof c === 'function') cleanups.push(c)
    return () => {}
  },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  get(key) {
    // ⭐ 宿主真实形状：dshHomePath 是**函数**，不是字符串（见 lib/state.mjs 的注释）
    if (key === 'dshHomePath') return (...seg) => join(home, ...seg)
    return undefined
  },
}

/* ── 导入并 apply ────────────────────────────────────────────────────── */
let mod = null
try {
  mod = await import('./index.js')
  check('导入 index.js', true)
} catch (e) {
  check('导入 index.js', false, String(e?.stack ?? e))
}

if (mod) {
  check('export const name === "douyin-life"', mod.name === 'douyin-life', String(mod.name))
  check('export const inject 含 webServer/tools/settings',
    Array.isArray(mod.inject) && ['webServer', 'tools', 'settings'].every((k) => mod.inject.includes(k)),
    JSON.stringify(mod.inject))
  check('export function apply 存在', typeof mod.apply === 'function')
check('视频理解原型 run.py 在包内', existsSync(join(pluginDir, 'video-understanding-lab', 'run.py')),
  join(pluginDir, 'video-understanding-lab', 'run.py'))

  // cordis.patch.yml 的 id 必须等于 name
  try {
    const yml = readFileSync(join(pluginDir, 'cordis.patch.yml'), 'utf8')
    const id = (/^\s*-?\s*id:\s*(\S+)/m.exec(yml) || [])[1] || ''
    check('cordis.patch.yml 的 id === index.js 的 name', id === mod.name, `patch id=${id}`)
  } catch (e) {
    check('cordis.patch.yml 可读', false, String(e?.message ?? e))
  }

  // 不许裸 import @deepseek-ai/*
  try {
    const src = readFileSync(join(pluginDir, 'index.js'), 'utf8')
    const offenders = src.split('\n')
      .filter((l) => /^\s*import\s.*['"]@deepseek-ai\//.test(l) || /^\s*export\s.*from\s+['"]@deepseek-ai\//.test(l))
    check('index.js 没有裸 import @deepseek-ai/*（桌面版会让整条插件不激活）', offenders.length === 0,
      offenders.length ? offenders.join(' | ') : '只用 lib/hostdeps.mjs 取')
  } catch (e) {
    check('读 index.js 源码', false, String(e?.message ?? e))
  }

  let applied = true
  try {
    mod.apply(fakeCtx, {})
  } catch (e) {
    applied = false
    check('apply(fakeCtx, {}) 不抛错', false, String(e?.stack ?? e))
  }
  if (applied) check('apply(fakeCtx, {}) 不抛错', true)

  /* ── ① 工具清单 ─────────────────────────────────────────────────── */
  const names = registeredSpecs.map((t) => t?.name)
  const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n))
  const extra = names.filter((n) => !EXPECTED_TOOLS.includes(n))
  check(`注册了全部 ${EXPECTED_TOOLS.length} 个 dy_* 工具`, missing.length === 0 && extra.length === 0,
    missing.length ? `缺：${missing.join(', ')}` : (extra.length ? `多出：${extra.join(', ')}` : `${names.length} 个`))
  check('工具名与 SPEC 3.2 逐项一致（顺序无关）',
    JSON.stringify([...names].sort()) === JSON.stringify([...EXPECTED_TOOLS].sort()),
    names.join(', '))
  const noExec = registeredSpecs.filter((t) => typeof t?.execute !== 'function')
  check('每个工具都有 execute', noExec.length === 0, noExec.map((t) => t?.name).join(', ') || 'ok')
  const noOutput = registeredSpecs.filter((t) => !t?.output?.schema)
  check('每个工具都有 output.schema（宿主只吃结构化输出）', noOutput.length === 0, noOutput.map((t) => t?.name).join(', ') || 'ok')

  const byName = Object.fromEntries(registeredSpecs.map((t) => [t?.name, t]))

  /* ── ② HTTP 路由 ─────────────────────────────────────────────────── */
  check('HTTP 路由挂上了', routes.length >= 1, routes.map((r) => r?.path).join(', '))
  const route = routes.find((r) => r?.path === '/api/douyin-duty')
  check('/api/douyin-duty 是 prefix 路由', Boolean(route) && route.kind === 'prefix', route ? route.kind : 'missing')
  check('ctx.effect 被用了（定时器 + 路由 + 收摊）', effectCount >= 2, `effect 调用 ${effectCount} 次`)

  const callRoute = async (url, method = 'GET', body = '') => {
    const res = {
      _code: 0,
      _body: '',
      writeHead(code) { this._code = code },
      end(b) { this._body = b === undefined ? '' : String(b) },
    }
    const listeners = {}
    const req = {
      method,
      url,
      headers: { host: '127.0.0.1' },
      on(ev, cb) {
        listeners[ev] = cb
        if (ev === 'data' && body) setImmediate(() => cb(body))
        if (ev === 'end') setImmediate(() => cb())
        return req
      },
      destroy() {},
    }
    await route.handler(req, res)
    let json = null
    try { json = JSON.parse(res._body) } catch { json = null }
    return { code: res._code, json, raw: res._body }
  }

  let cfg0 = null
  if (route) {
    const st = await callRoute('/api/douyin-duty/status')
    check('GET /status 返回 200 + ok:true', st.code === 200 && st.json?.ok === true, `code=${st.code}`)
    check('GET /status 带 windows/today/perDay/home',
      Boolean(st.json?.windows?.noon && st.json?.windows?.night) && typeof st.json?.today === 'string'
      && typeof st.json?.perDay === 'number' && typeof st.json?.home === 'string',
      JSON.stringify({ today: st.json?.today, perDay: st.json?.perDay, home: st.json?.home }))

    cfg0 = await callRoute('/api/douyin-duty/config')
    check('GET /config 返回 200 + config', cfg0.code === 200 && cfg0.json?.ok === true && typeof cfg0.json?.config === 'object', `code=${cfg0.code}`)

    const cfgPost = await callRoute('/api/douyin-duty/config', 'POST', JSON.stringify({ patch: { perDay: 7 } }))
    check('POST /config 写入成功并回显', cfgPost.code === 200 && cfgPost.json?.ok === true && cfgPost.json?.config?.perDay === 7,
      `perDay=${cfgPost.json?.config?.perDay}`)

    const rep = await callRoute('/api/douyin-duty/report/latest')
    check('GET /report/latest 应答（还没有日报也返回 ok）', rep.code === 200 && rep.json?.ok === true, `code=${rep.code} report=${JSON.stringify(rep.json?.report)}`)

    const nf = await callRoute('/api/douyin-duty/nope')
    check('未知路径返回 404', nf.code === 404, `code=${nf.code}`)
  }

  /* ── ③ dy_status 结构 ───────────────────────────────────────────── */
  const status = await byName.dy_status.execute({})
  const need = ['ok', 'today', 'ranToday', 'pickedToday', 'perDay', 'windows', 'nextWindow',
    'peakValley', 'gates', 'loggedIn', 'home', 'report', 'python', 'mcpScript',
    'mcpScriptReady', 'mcpRunning', 'dshCli', 'comfy']
  const lost = need.filter((k) => !(k in status))
  check('dy_status 返回结构完整', status?.ok === true && lost.length === 0, lost.length ? `缺字段：${lost.join(', ')}` : '字段齐')
  check('dy_status.windows 有 noon + night 且带 start/end',
    Boolean(status?.windows?.noon?.start && status?.windows?.noon?.end && status?.windows?.night?.start && status?.windows?.night?.end),
    JSON.stringify(status?.windows))
  check('dy_status 家目录落在 DSH_HOME 下',
    String(status?.home || '').startsWith(home) && String(status?.home || '').endsWith('douyin-duty'),
    String(status?.home))
  check('dy_status 报告路径是 out/<日期>.md',
    /out[\\/]\d{4}-\d{2}-\d{2}\.md$/.test(String(status?.report || '')), String(status?.report))
  check('dy_status 不启动 MCP（mcpRunning=false）', status?.mcpRunning === false, String(status?.mcpRunning))
  check('dy_status 的 nextWindow 有 opening/inMinutes', typeof status?.nextWindow?.opening === 'boolean', JSON.stringify(status?.nextWindow))

  /* ── ④ 闸门默认关：动手类工具必须拒绝 ───────────────────────────── */
  const like = await byName.dy_like.execute({ aweme_id: '7412345678901234567' })
  check('dy_like 在 autoLike=false 时拒绝', like?.ok === false && like?.blocked === true, String(like?.hint || '').slice(0, 60))

  const cmt = await byName.dy_comment.execute({ aweme_id: '7412345678901234567', text: '这条讲得清楚' })
  check('dy_comment 在 autoComment=false / mentionName 空时拒绝', cmt?.ok === false && cmt?.blocked === true, String(cmt?.hint || '').slice(0, 80))

  const pub = await byName.dy_publish.execute({ latest: true })
  check('dy_publish 在 autoPublish=false 时拒绝（且没去碰 ComfyUI）', pub?.ok === false && pub?.blocked === true, String(pub?.hint || '').slice(0, 60))

  // 空心正文也要挡（闸门开着时才有意义，这里只验"空正文不算内容"）
  const emptyCmt = await byName.dy_comment.execute({ aweme_id: '1', text: '   ', force: true })
  check('dy_comment 空正文被挡', emptyCmt?.ok === false && emptyCmt?.blocked === true, String(emptyCmt?.hint || '').slice(0, 40))

  /* ── ⑤ 家目录铺好了 ─────────────────────────────────────────────── */
  const homeDir = join(home, 'douyin-duty')
  check('家目录建出来了', existsSync(homeDir), homeDir)
  check('config.json 落了盘', existsSync(join(homeDir, 'config.json')))
  check('duty.md 从 prompts/ 铺过来了', existsSync(join(homeDir, 'duty.md')))
  check('out/ 建好了', existsSync(join(homeDir, 'out')))
  const vendorPy = join(pluginDir, 'vendor', 'douyin-mcp', 'mcp_server.py')
  if (existsSync(vendorPy)) {
    check('mcp_server.py 铺到家里了', existsSync(join(homeDir, 'mcp_server.py')))
  } else {
    skip('mcp_server.py 铺到家里', 'vendor/douyin-mcp/mcp_server.py 还没写（Python 半边由另一个队友负责）')
  }
  check('duty.log 有内容', existsSync(join(homeDir, 'duty.log')))

  /* ── ⑥ 配置真的读得到 ───────────────────────────────────────────── */
  const readCfg = await byName.dy_config.execute({})
  check('dy_config 读到刚写的 perDay=7', readCfg?.config?.perDay === 7, String(readCfg?.config?.perDay))
  check('dy_config 回显三道闸门', Boolean(readCfg?.gates) && readCfg.gates.autoLike === false, JSON.stringify(readCfg?.gates))

  const comfy = await byName.dy_comfy_list.execute({ limit: 3 })
  check('dy_comfy_list 返回 ok + items 数组（读的是 comfyOutputDir）',
    comfy?.ok === true && Array.isArray(comfy?.items) && typeof comfy?.total === 'number',
    JSON.stringify({ dir: comfy?.dir, exists: comfy?.exists, total: comfy?.total, items: comfy?.items?.length }))

  // 目录不存在时也必须"能回答"，不许抛
  await byName.dy_config.execute({ patch: { comfyOutputDir: join(home, 'no-such-comfy-dir') } })
  const comfyMissing = await byName.dy_comfy_list.execute({ limit: 3 })
  check('dy_comfy_list 目录不存在 → ok + exists:false + 空数组 + 给 hint',
    comfyMissing?.ok === true && comfyMissing?.exists === false && comfyMissing?.items?.length === 0 && Boolean(comfyMissing?.hint),
    JSON.stringify({ exists: comfyMissing?.exists, n: comfyMissing?.items?.length, hint: String(comfyMissing?.hint || '').slice(0, 40) }))
  // 还原成默认的输出目录（后面的人接手时配置是干净的）
  await byName.dy_config.execute({ patch: { comfyOutputDir: cfg0.json?.defaults?.comfyOutputDir || 'E:\\Comfy-Desktop\\ComfyUI-Shared\\output' } })

  /* ── ⑦ 投稿：latest 真的会去 ComfyUI 目录里挑最新那个 mp4 ──────── */
  // 造一个假输出目录 + 两个假 mp4（读文件而已，不会真投稿）
  const fakeComfy = join(homeDir, 'fake-comfy')
  mkdirSync(fakeComfy, { recursive: true })
  writeFileSync(join(fakeComfy, 'old.mp4'), '')
  await new Promise((r) => setTimeout(r, 30))
  writeFileSync(join(fakeComfy, 'newest.mp4'), '')
  await byName.dy_config.execute({ patch: { comfyOutputDir: fakeComfy, autoPublish: true } })
  const originalCall = McpClient.prototype.call
  let pub2
  McpClient.prototype.call = async () => { throw new Error('Offline selfcheck: MCP is deliberately disabled') }
  try { pub2 = await byName.dy_publish.execute({ latest: true, title: '自检用标题' }) }
  finally { McpClient.prototype.call = originalCall }
  check('dy_publish(latest) 按 mtime 挑到最新那个 .mp4（不是最旧的）',
    String(pub2?.video || '').endsWith('newest.mp4'), String(pub2?.video || '(没带 video 出来)'))
  check('dy_publish 默认 draft=true（只存草稿）', pub2?.draft === true, String(pub2?.draft))
  check('dy_publish 在 MCP 起不来时如实返回 ok:false + error（文件路径照样带回来）',
    pub2?.ok === false && Boolean(pub2?.error) && Boolean(pub2?.video), String(pub2?.error || '').slice(0, 70))
  // 还原：闸门关回去、目录指回默认
  await byName.dy_config.execute({ patch: { autoPublish: false, comfyOutputDir: cfg0.json?.defaults?.comfyOutputDir || 'E:\\Comfy-Desktop\\ComfyUI-Shared\\output' } })

  /* ── ⑧ 跑一轮：用一个假 dsh CLI 验整条链路（不联网、不花 token） ── */
  const argvFile = join(homeDir, 'fake-dsh-argv.json')
  const fakeCli = join(homeDir, 'fake-dsh.cjs')
  writeFileSync(fakeCli,
    `const { writeFileSync, copyFileSync } = require('node:fs')\n`
    + `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2), null, 2))\n`
    + `copyFileSync(process.argv[5], ${JSON.stringify(join(homeDir, 'overlay-snapshot.yml'))})\n`
    + `process.exit(0)\n`, 'utf8')
  await byName.dy_config.execute({ patch: { dshBin: fakeCli } })
  const run = await byName.dy_run.execute({ mode: 'headless' })
  check('dy_run 默认走本机直跑（不依赖 headless 沙箱）', true, 'mode=local 已在代码里默认')
  check('dy_run 起得来（started:true）', run?.ok === true && run?.started === true, JSON.stringify({ ok: run?.ok, why: run?.why, error: String(run?.error || '').slice(0, 120) }))
  // 等子进程落地
  for (let i = 0; i < 40 && !existsSync(argvFile); i++) await new Promise((r) => setTimeout(r, 100))
  let argv = []
  try { argv = JSON.parse(readFileSync(argvFile, 'utf8')) } catch { argv = [] }
  check('dy_run 传的是 --profile headless + --patch <overlay> + 提示词',
    argv[0] === '--profile' && argv[1] === 'headless' && argv[2] === '--patch'
    && String(argv[3] || '').endsWith('headless-overlay.yml') && typeof argv[4] === 'string' && argv[4].length > 200,
    `argv[0..3]=${JSON.stringify(argv.slice(0, 4))}`)
  const promptText = String(argv[4] || '')
  check('提示词里带了今天的报告路径与"### <视频id>"口径',
    promptText.includes(join('out', `${status?.today}.md`)) && promptText.includes('结构化账本'),
    promptText.slice(0, 80))
  check('提示词里写清了三道闸门都是关的',
    promptText.includes('关着'), 'ok')
  let overlayText = ''
  try { overlayText = readFileSync(join(homeDir, 'overlay-snapshot.yml'), 'utf8') } catch { overlayText = '' }
  check('overlay 挂上了 douyin-duty 的 stdio MCP',
    overlayText.includes('mcp-douyin-duty') && overlayText.includes('serverName: douyin-duty')
    && overlayText.includes("transport: stdio") && overlayText.includes('mcp_server.py'),
    overlayText.split('\n').filter((l) => /mcp-douyin|serverName|command:/.test(l)).join(' | '))
  check('overlay 的白名单只给只读工具（闸门关着时不给 like/comment）',
    /DOUYIN_MCP_TOOLS: '[^']*douyin_search/.test(overlayText) && !/DOUYIN_MCP_TOOLS: '[^']*douyin_like/.test(overlayText),
    (overlayText.match(/DOUYIN_MCP_TOOLS: '[^']*'/) || [''])[0])
  // 跑完没写报告 ⇒ 宿主应该补一份占位报告
  for (let i = 0; i < 40 && !existsSync(join(homeDir, 'out', `${status?.today}.md`)); i++) await new Promise((r) => setTimeout(r, 100))
  check('那一轮没写报告 ⇒ 宿主补了占位报告（使用者不会什么都看不到）',
    existsSync(join(homeDir, 'out', `${status?.today}.md`)),
    join(homeDir, 'out', `${status?.today}.md`))
  await byName.dy_config.execute({ patch: { dshBin: '' } })

  /* ── ⑨ "Python 半边还没到位"时必须降级，不许抛 ─────────────────── */
  // ⚠️ 只在家里没有 mcp_server.py 时测（有的话会真起 Python，那就动真环境了）
  if (!existsSync(join(homeDir, 'mcp_server.py'))) {
    const who = await byName.dy_whoami.execute({})
    check('MCP 脚本缺失 ⇒ dy_whoami 降级成 ok:false + hint（不抛、不崩）',
      who?.ok === false && who?.loggedIn === false && Boolean(who?.hint), String(who?.hint || '').slice(0, 70))
  } else {
    skip('MCP 脚本缺失时的降级分支', '家里已经有 mcp_server.py（真起 Python 会动真实环境，跳过）')
  }

  /* ── ⑦ 家目录里每条工具调用都该有一行 duty.log ──────────────────── */
  let logText = ''
  try { logText = readFileSync(join(homeDir, 'duty.log'), 'utf8') } catch { logText = '' }
  const ran = ['dy_status', 'dy_like', 'dy_comment', 'dy_publish', 'dy_config', 'dy_comfy_list', 'dy_run']
  // dy_whoami 只在"家里没有脚本"那条降级分支里会被真的调一次；有脚本时上面是 SKIP，不该要求它有日志
  if (!existsSync(join(homeDir, 'mcp_server.py'))) ran.push('dy_whoami')
  const lostLines = ran.filter((n) => !new RegExp(`工具 ${n} →`).test(logText))
  check('duty.log 每条工具调用一行（时间 + 工具名 + 一句话结果）', lostLines.length === 0,
    lostLines.length ? `缺：${lostLines.join(', ')}` : `${ran.length} 个工具都记了`)
  check('duty.log 的行以 ISO 时间开头', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/m.test(logText), (logText.split('\n')[0] || '').slice(0, 40))

  /* ── 收摊 ───────────────────────────────────────────────────────── */
  try { for (const c of cleanups) c() } catch (e) { check('cleanup 都跑得掉', false, String(e?.message ?? e)) }

  /* ── ⑩ 恶劣 config（字段类型全不对）也不许崩 ─────────────────────── */
  // bili 版 2026-10-14 的事故就是 config 里塞了对象/字符串，守卫全失效 ⇒ TypeError ⇒ 宿主被带走
  try {
    const badCtx = {
      tools: { register(t) { return t } },
      webServer: { register() { return () => {} } },
      settings: { describe() { return [] }, async update() { return undefined } },
      effect() { /* 不收摊也没关系：timer 是 unref 过的 */ },
      logger: {},
      get() { return undefined },
    }
    mod.apply(badCtx, {
      pythonPath: { toString: () => 'x' }, keywords: 'not-an-array', perDay: 'abc',
      autoLike: 'yes', autoComment: 1, autoPublish: null, mentionName: 42,
      comfyOutputDir: 123, windows: undefined, enabled: true,
    })
    check('恶劣 config（字段类型全不对）也不崩、也不抛', true, 'normalize() + clampPatch() 兜住了')
  } catch (e) {
    check('恶劣 config（字段类型全不对）也不崩、也不抛', false, String(e?.stack ?? e))
  }
}

/* ── 汇总 ──────────────────────────────────────────────────────────── */
const failed = results.filter((r) => !r.ok)
const skipped = results.filter((r) => r.skipped)
console.log('')
console.log(`—— 共 ${results.length} 条断言：通过 ${results.length - failed.length - skipped.length}，跳过 ${skipped.length}，失败 ${failed.length}`)
if (failed.length) {
  console.log('失败明细：')
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? '：' + f.detail : ''}`)
  console.log(`（临时家目录保留下来方便看：${home}）`)
  process.exit(1)
}
console.log('结论：PASS —— 宿主半边能加载、工具齐、路由通、结构对、闸门默认关着。')
try { rmSync(home, { recursive: true, force: true }) } catch { /* 删不掉也无所谓 */ }
process.exit(0)
