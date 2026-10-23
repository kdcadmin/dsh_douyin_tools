// client 半端冒烟：模拟 window.__ModuleLoader__ + 极简 React，验证 factory/apply/槽位注册
import { readFileSync } from 'node:fs'
const src = readFileSync('D:/jev-decision-kit/plugins/dsh-douyin-life/client.js', 'utf8')
const registered = []
const styles = []
const FakeReact = {
  createElement: (t, p, ...kids) => ({ type: t, props: p || {}, kids }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
}
let mod = null
globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => { mod = { id, factory } },
  },
}
globalThis.document = {
  createElement: () => ({ setAttribute() {}, textContent: '', remove() {} }),
  head: { appendChild: (x) => styles.push(x) },
}
const doc = globalThis.document
const req = (name) => { if (name === 'react') return FakeReact; throw new Error('unexpected require ' + name) }
// 执行 bundle
new Function('window', 'document', src)(globalThis.window, doc)
if (!mod) { console.log('FAIL no module'); process.exit(1) }
console.log('module id', mod.id)
const m = mod.factory(req)
console.log('inject', JSON.stringify(m.inject))
const slots = {
  register: (meta, comp) => { registered.push({ meta, comp }); return () => {} },
  inject: (name, fn) => { console.log('inject slot', name); fn() },
}
const ctx = { get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => { fn(); return () => {} } }
m.apply(ctx)
console.log('registered', registered.length, JSON.stringify(registered.map((r) => r.meta)))
console.log('css injected bytes', styles[0]?.textContent?.length || 0)
const hasSettings = registered.some((r) => r.meta.name === 'settings.section' && r.meta.label === '刷抖音')
const hasView = registered.some((r) => r.meta.name === 'conversation.view' && r.meta.label === '抖音刷过的视频')
if (hasSettings && hasView) {
  console.log('PASS client registers 设置 → 刷抖音 + 会话头 → 抖音刷过的视频')
} else { console.log('FAIL registration'); process.exit(1) }
