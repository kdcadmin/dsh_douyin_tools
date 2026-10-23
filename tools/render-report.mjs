// 真渲染 + 点「看今天的报告」→ 断言报告正文直接出现在页面里（不用打开文件）
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:50600/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
try { Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true }) } catch {}

const React = (await import('react')).default
const ReactDOM = (await import('react-dom/client')).default

const REPORT = '# 2026-10-23 · 抖音 日报\n\n### 7695306080221498643\n\n- 标题：大肥鱼怎么弄教程\n- **档位**：值得看\n'
const STATUS = {
  ok: true, today: '2026-10-23', ranToday: 1, pickedToday: 3, perDay: 5, peakValley: false,
  windows: {}, nextWindow: { window: 'night', label: '夜间谷时', opening: false },
  gates: { autoLike: false, autoComment: false, autoPublish: false, mentionName: '' },
  doing: { todayComments: 0, commentPerDay: 3, todayPublished: 0, publishPerDay: 1, lastPublished: null },
  loggedIn: true, home: 'C:\\Users\\x\\.dsh\\douyin-duty', report: 'C:\\x\\out\\2026-10-23.md', reportExists: true,
  comfy: { url: 'http://127.0.0.1:8188', outputDir: 'E:\\out', outputDirExists: true, workflow: false },
  python: { command: 'python', via: 'venv' },
  cdp: { url: '', ok: false, browser: '' },
  config: {
    perDay: 5, peakValley: false, noon: true, night: true, autoLike: false, autoComment: false, autoPublish: false,
    publishDraft: true, mentionName: '', commentPerRound: 1, keywords: [], reportLevel: 'full', personaPrompt: '',
    pythonPath: '', dshBin: '', comfyUrl: 'http://127.0.0.1:8188', comfyOutputDir: 'E:\\out', comfyWorkflow: '',
    cdpUrl: '', cdpPort: 9222, commentPerDay: 3, publishPerDay: 1, publishTitle: '', publishTags: '',
  },
}
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.endsWith('/status')) return { ok: true, json: async () => STATUS }
  if (u.includes('/report/latest')) return { ok: true, json: async () => ({ ok: true, report: { name: '2026-10-23.md', text: REPORT, mtime: 0 } }) }
  return { ok: true, json: async () => ({ ok: true }) }
}
dom.window.fetch = globalThis.fetch

let mod = null
dom.window.__ModuleLoader__ = { load: ({ id, factory }) => { mod = { id, factory } } }
document.head.appendChild = () => {}
const src = readFileSync('D:/jev-decision-kit/plugins/dsh-douyin-life/client.js', 'utf8')
new Function('window', 'document', 'fetch', src)(dom.window, document, globalThis.fetch)

const req = (n) => (n === 'react' ? React : n === 'react-dom/client' ? ReactDOM : (() => { throw new Error('require ' + n) })())
const m = mod.factory(req)
let Panel = null
m.apply({ get: (k) => (k === 'slots' ? { register: (meta, comp) => { Panel = comp; return () => {} }, inject: (n, fn) => fn() } : undefined), effect: (fn) => { fn(); return () => {} } })

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Panel))
await new Promise((r) => setTimeout(r, 300))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clickByText = async (text) => {
  const btns = Array.from(document.querySelectorAll('button'))
  const b = btns.find((x) => x.textContent.trim() === text)
  if (!b) return false
  b.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await sleep(250)
  return true
}

const okTabs = ['日常', '偏好', '互动', '高级'].every((t) => document.body.innerHTML.includes(t))
await clickByText('高级')
const clicked = await clickByText('看今天的报告')
await sleep(250)
const html = document.body.innerHTML
const hasReport = html.includes('### 7695306080221498643') && html.includes('档位')
const hasPre = !!document.querySelector('pre[data-dy-pre]')

console.log('tabs_ok=' + okTabs, 'clicked=' + clicked, 'report_inline=' + hasReport, 'pre=' + hasPre)
console.log(okTabs && clicked && hasReport && hasPre ? 'PASS 报告能直接显示在设置页里' : 'FAIL')
process.exit(okTabs && clicked && hasReport && hasPre ? 0 : 1)
