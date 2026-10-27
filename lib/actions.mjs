import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const held = new AsyncLocalStorage()
const queues = new Map()
export const execution = new AsyncLocalStorage()

// One account action/round at a time, including separate plugin instances.
// The lock is reentrant for a round calling the same guarded tool internally.
export async function withActionLock(home, fn) {
  const key = resolve(home)
  if (held.getStore()?.key === key && held.getStore().active) return fn()
  const previous = queues.get(key) || Promise.resolve()
  let release
  const tail = new Promise(r => { release = r })
  queues.set(key, tail)
  await previous
  const dir = join(key, '.action-lock'), owner = join(dir, 'owner.json')
  let acquired = false
  const token = { key, active: true }
  try {
    const deadline = Date.now() + 30000
    while (!acquired) {
      try {
        mkdirSync(dir)
        try { writeFileSync(owner, JSON.stringify({ pid: process.pid }), { mode: 0o600 }) }
        catch (e) { try { rmdirSync(dir) } catch {}; throw e }
        acquired = true
      } catch (e) {
        if (e.code !== 'EEXIST') throw e
        try {
          const pid = JSON.parse(readFileSync(owner, 'utf8')).pid
          if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid action lock owner')
          try { process.kill(pid, 0) } catch (err) {
            if (err.code === 'ESRCH') { unlinkSync(owner); rmdirSync(dir); continue }
          }
        } catch { /* An incomplete/live lock is never stolen on a time heuristic. */ }
        if (Date.now() > deadline) throw new Error('另一个账号任务正在运行，请稍后重试')
        await new Promise(r => setTimeout(r, 50))
      }
    }
    return await held.run(token, fn)
  } finally {
    token.active = false
    if (acquired) { try { unlinkSync(owner); rmdirSync(dir) } catch {} }
    release()
    if (queues.get(key) === tail) queues.delete(key)
  }
}

export const confirmed = r => Boolean(r && typeof r === 'object' && !Array.isArray(r) && r.ok === true && r.verified === true && !r.needLogin)
