import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// Follow the current desktop's installed command shim; run it without a shell.
export function findDesktopCli({ pluginDir, resourcesPath = process.resourcesPath, execPath = process.execPath, dshHome = process.env.DSH_HOME } = {}) {
  const roots = [resourcesPath, pluginDir && join(resolve(pluginDir, '..', '..'), 'resources'), dshHome && join(dshHome, 'resources'), join(dirname(execPath), 'resources')].filter(Boolean)
  for (const root of [...new Set(roots)]) {
    const executable = join(dirname(root), 'DeepSeek Harness.exe')
    const shim = join(root, 'runtime', 'cli', 'bin', 'dsh.cmd')
    if (!existsSync(executable) || !existsSync(join(root,'app.asar')) || !existsSync(shim)) continue
    const text = readFileSync(shim,'utf8')
    if (!text.includes('ELECTRON_RUN_AS_NODE=1') || !text.includes('@deepseek-ai\\dsh-desktop-host\\lib\\cli.js') || !text.includes('--expose-internals')) continue
    return { command:executable, args:['--expose-internals',join(root,'app.asar','dsh','node_modules','@deepseek-ai','dsh-desktop-host','lib','cli.js')], shell:false, env:{ELECTRON_RUN_AS_NODE:'1'}, source:'desktop-shim' }
  }
  return null
}

