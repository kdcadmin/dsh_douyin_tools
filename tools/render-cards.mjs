// 断言：① 底部那行重复的「家目录…python…」没了 ② 点「看它刷过的视频」出卡片（封面走代理 + 超链接）
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:63154/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
try { Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true }) } catch {}

const React = (await import('react')).default
const ReactDOM = (await import('react-dom/client')).default

const STATUS = {
  ok: true, today: '2026-10-23', ranToday: 1, pickedToday: 5, perDay: 5, peakValley: false,
  windows: {}, nextWindow: { window: 'night', label: '夜间谷时', opening: false },
  gates: { autoLike: false, autoComment: true, autoPublish: false, mentionName: '月亮硬糖🌇' },
  doing: { todayComments: 1, commentPerDay: 5, todayPublished: 0, publishPerDay: 1, lastPublished: null },
  loggedIn: true, home: 'C:\\Users\\33053\\.dsh\\douyin-duty', report: 'C:\\x\\out\\2026-10-23.md', reportExists: true,
  comfy: { url: '', outputDir: 'E:\\out', outputDirExists: true, workflow: false },
  python: { command: 'python', via: 'venv' },
  cdp: { url: '', ok: false, browser: '' },
  config: {
    perDay: 5, peakValley: false, noon: true, night: true, autoLike: false, autoComment: true, autoPublish: false,
    publishDraft: true, mentionName: '月亮硬糖🌇', commentPerRound: 5, keywords: [], reportLevel: 'full', personaPrompt: '',
    pythonPath: '', dshBin: '', comfyUrl: '', comfyOutputDir: 'E:\\out', comfyWorkflow: '',
    cdpUrl: '', cdpPort: 9222, commentPerDay: 5, publishPerDay: 1, publishTitle: '', publishTags: '',
  },
}
const WATCHED = {
  ok: true, total: 2, report: '2026-10-23.md',
  items: [
    { aweme_id: '7695306080221498643', title: '大肥鱼怎么弄教程', url: 'https://www.douyin.com/video/7695306080221498643', cover: 'https://p3-pc-sign.douyinpic.com/a.jpeg?x=1', tier: '值得看', stat: '15554 · 431', day: '2026-10-23' },
    { aweme_id: '7691417996299914531', title: '桌面端皮肤', url: 'https://www.douyin.com/video/7691417996299914531', cover: '', tier: '不值当', stat: '4574 · 209', day: '2026-10-23' },
  ],
}
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.endsWith('/status')) return { ok: true, json: async () => STATUS }
  if (u.includes('/watched')) return { ok: true, json: async () => WATCHED }
  if (u.includes('/report')) return { ok: true, json: async () => ({ ok: true, report: null }) }
  return { ok: true, json: async () => ({ ok: true }) }
}
dom.window.fetch = globalThis.fetch

let mod = null
dom.window.__ModuleLoader__ = { load: ({ id, factory }) => { mod = { id, factory } } }
document.head.appendChild = () => {}
new Function('window', 'document', 'fetch', readFileSync('D:/jev-decision-kit/plugins/dsh-douyin-life/client.js', 'utf8'))(dom.window, document, globalThis.fetch)

const req = (n) => (n === 'react' ? React : n === 'react-dom/client' ? ReactDOM : (() => { throw new Error(n) })())
let Panel = null
mod.factory(req).apply({ get: (k) => (k === 'slots' ? { register: (m, c) => { Panel = c; return () => {} }, inject: (n, f) => f() } : undefined), effect: (f) => { f(); return () => {} } })
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Panel))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(300)

const html0 = document.body.innerHTML
const dupGone = !html0.includes('家目录：C:\\Users\\33053\\.dsh\\douyin-duty　│　python')

const click = async (text) => {
  const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === text)
  if (!b) return false
  b.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await sleep(300)
  return true
}
const clicked = await click('看它刷过的视频')
await sleep(200)
const cards = Array.from(document.querySelectorAll('a[data-dy-card]'))
const hrefOk = cards[0]?.getAttribute('href')?.startsWith('https://www.douyin.com/video/')
const imgOk = (cards[0]?.querySelector('img')?.getAttribute('src') || '').includes('/api/douyin-duty/cover?u=')
const nocover = !!cards[1]?.querySelector('[data-dy-nocover]')

console.log('dupGone=' + dupGone, 'clicked=' + clicked, 'cards=' + cards.length, 'href=' + hrefOk, 'cover=' + imgOk, 'nocoverFallback=' + nocover)
const pass = dupGone && clicked && cards.length === 2 && hrefOk && imgOk && nocover
console.log(pass ? 'PASS 卡片列表 + 封面代理 + 超链接都对，重复的家目录行已去掉' : 'FAIL')
process.exit(pass ? 0 : 1)
