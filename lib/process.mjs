import { spawn } from 'node:child_process'
export function runCommand(command, args, { cwd, env, timeoutMs = 30000, onData = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe'] })
    let finished = false
    const finish = (error, result) => {
      if (finished) return
      finished = true; clearTimeout(timer)
      if (error) reject(error); else resolve(result)
    }
    const timer = setTimeout(() => { proc.kill(); finish(new Error(`命令超时：${command}`)) }, timeoutMs)
    let output = ''
    for (const stream of [proc.stdout, proc.stderr]) stream.on('data', b => { const s=b.toString('utf8'); output=(output+s).slice(-10000); try { onData(s) } catch {} })
    proc.on('error', e => finish(e))
    proc.on('close', code => finish(code === 0 ? null : new Error(`${command} 退出码 ${code}：${output.slice(-1000)}`), { code, output }))
  })
}
