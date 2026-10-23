// 「自己做」那两件事的账本逻辑自检：配额 / 防重复 / 闸门 / needLogin 不记账。
// 只碰 DSH_DOUYIN_HOME 指向的临时家目录；Python 用真实家目录那份 venv（不然 MCP 起不来）。
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = join(mkdtempSync(join(tmpdir(), 'dy-doing-')), 'douyin-duty')
mkdirSync(join(home, 'out'), { recursive: true })
process.env.DSH_DOUYIN_HOME = home

const mod = await import('file:///D:/jev-decision-kit/plugins/dsh-douyin-life/index.js')
const tools = new Map()
const ctx = {
  tools: { register(t) { tools.set(t.name, t); return t } },
  webServer: { register() { return () => {} } },
  settings: { describe: () => [], update: async () => {} },
  effect(fn) { fn(); return () => {} },
  logger: { info() {}, warn() {} },
  get() { return undefined },
}
mod.apply(ctx, {})

let pass = 0
let fail = 0
const ck = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('PASS  ' + name + (detail ? '  --- ' + detail : '')) }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  --- ' + detail : '')) }
}

const cfg = (patch) => tools.get('dy_config').execute({ patch })
const PY = join(process.env.USERPROFILE, '.dsh', 'douyin-duty', '.venv', 'Scripts', 'python.exe')
await cfg({ pythonPath: PY })

// 捂热 Python MCP（冷启动第一次调用容易超时，那是测试脚本的事）
const warm = await tools.get('dy_whoami').execute({})
console.log('warm  ---', JSON.stringify(warm).slice(0, 90))

/* 1 闸门默认关 */
let r = await tools.get('dy_comment').execute({ aweme_id: '7683311350021508390', text: '好看' })
ck('评论：autoComment 关着 => 挡住', r?.blocked === true, String(r?.hint || '').slice(0, 40))
r = await tools.get('dy_publish').execute({ latest: true })
ck('投稿：autoPublish 关着 => 挡住', r?.blocked === true, String(r?.hint || '').slice(0, 40))

/* 2 打开闸门 + 填 @谁，但配额 0 */
await cfg({ autoComment: true, mentionName: '测试人', commentPerDay: 0 })
r = await tools.get('dy_comment').execute({ aweme_id: '7683311350021508390', text: '好看' })
ck('评论：每天上限 0 => 挡住', r?.blocked === true && r?.cap === 0, String(r?.hint || '').slice(0, 40))

/* 3 @ 自动补在正文开头 */
await cfg({ commentPerDay: 3 })
r = await tools.get('dy_comment').execute({ aweme_id: '7683311350021508390', text: '这段不错', force: true })
ck('评论：漏了 @ 会补在开头', String(r?.text || '').startsWith('@测试人'), String(r?.text || JSON.stringify(r)).slice(0, 50))
ck('评论：没登录时不记账（今天仍 0 条）', Number(r?.todayComments ?? 0) === 0, `todayComments=${r?.todayComments} needLogin=${r?.needLogin}`)

/* 4 投稿：配额 0 */
await cfg({ autoPublish: true, publishDraft: true, publishPerDay: 0 })
r = await tools.get('dy_publish').execute({ latest: true })
ck('投稿：每天上限 0 => 挡住', r?.blocked === true && r?.cap === 0, String(r?.hint || '').slice(0, 40))
await cfg({ publishPerDay: 1 })
const ledgerFile = join(home, 'ledger.json')
writeFileSync(ledgerFile, JSON.stringify({ published: {}, comments: [] }), 'utf8')

/* 5 真投一次（未登录 => 不记成功账） */
r = await tools.get('dy_publish').execute({ latest: true, force: true })
const picked = String(r?.video || '')
ck('投稿：会挑到 ComfyUI 最新那条 mp4', /\.mp4$/i.test(picked), picked)
ck('投稿：未登录 => 不记成功账', r?.needLogin === true || r?.ok === false, `ok=${r?.ok} needLogin=${r?.needLogin}`)

/* 6 防重复 */
if (picked) {
  const st = statSync(picked)
  const key = `${picked}|${st.size}|${Math.round(st.mtimeMs)}`
  writeFileSync(ledgerFile, JSON.stringify({
    published: { [key]: { day: new Date().toISOString().slice(0, 10), at: new Date().toISOString(), video: picked, draft: true } },
    comments: [],
  }), 'utf8')
  r = await tools.get('dy_publish').execute({ latest: true })
  ck('投稿：同一条片子不重复投（already）', r?.already === true, r?.publishedAt || '')
  r = await tools.get('dy_publish').execute({ latest: true, force: true })
  ck('投稿：force 才允许再投一次', r?.already !== true, `ok=${r?.ok}`)
}

/* 7 日志 */
const log = readFileSync(join(home, 'duty.log'), 'utf8')
ck('duty.log 记下了这两件事', /dy_comment/.test(log) && /dy_publish/.test(log))

console.log(`\n--- 共 ${pass + fail} 条：通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
