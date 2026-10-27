import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'

// An ephemeral loopback endpoint for one headless run. All policy stays in host.
export async function createActionProxy({ allowed, execute }) {
  const token = randomBytes(32).toString('hex')
  let closed = false
  const server = createServer(async (req, res) => {
    const send = (code, value) => { if (!res.writableEnded) { res.writeHead(code, { 'content-type':'application/json', 'cache-control':'no-store' }); res.end(JSON.stringify(value)) } }
    const supplied = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''))
    const expected = Buffer.from(token)
    if (closed || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(403, { ok:false, error:'代理凭据无效' })
    if (req.method !== 'POST' || req.url !== '/action') return send(404, { ok:false, error:'没有该代理接口' })
    try {
      const chunks=[]; let bytes=0
      for await (const b of req) { bytes+=b.length; if(bytes>65536) return send(413,{ok:false,error:'请求过大'}); chunks.push(b) }
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (typeof body.name !== 'string' || !allowed().has(body.name)) return send(403,{ok:false,error:'工具未授权'})
      if (!body.args || typeof body.args !== 'object' || Array.isArray(body.args)) return send(400,{ok:false,error:'参数必须为对象'})
      const { force, __proto__: prototype, constructor, ...args }=body.args
      send(200,await execute(body.name,args))
    } catch(e) { send(500,{ok:false,status:'unknown',error:String(e.message)}) }
  })
  server.requestTimeout=30000
  server.headersTimeout=10000
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  server.unref()
  return { token, url:`http://127.0.0.1:${server.address().port}/action`, close() { closed=true;server.closeIdleConnections?.();return new Promise(resolve=>server.close(resolve)) } }
}
