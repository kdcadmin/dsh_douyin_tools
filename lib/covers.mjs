import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'
const domains = ['douyinpic.com', 'douyin.com', 'byteimg.com', 'pstatp.com', 'ibytedtos.com', 'imagex.bytedanceapi.com']
export function coverUrl(input) {
  const u = new URL(input), host = u.hostname.toLowerCase()
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !domains.some(d => host === d || host.endsWith('.' + d))) throw new Error('封面仅支持可信图片 CDN 的 HTTPS 地址')
  return u
}
export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a,b] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)))
  }
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address)
}
export function imageType(b) {
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg'
  if (b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if (/^GIF8[79]a/.test(b.subarray(0,6).toString('ascii'))) return 'image/gif'
  if (b.subarray(0,4).toString() === 'RIFF' && b.subarray(8,12).toString() === 'WEBP') return 'image/webp'
  throw new Error('响应不是受支持的图片')
}
export async function fetchCover(input) {
  let url = coverUrl(input)
  const deadline = Date.now() + 12000
  for (let redirects=0; redirects<4; redirects++) {
    const addresses = await lookup(url.hostname, { all: true })
    if (!addresses.length || addresses.some(x => !publicAddress(x.address))) throw new Error('封面域名解析到非公开地址')
    const r = await new Promise((resolve,reject) => {
      const req = request(url, { signal: AbortSignal.timeout(Math.max(1,deadline-Date.now())), headers: { referer: 'https://www.douyin.com/' }, lookup(host,options,cb) {
        if (host !== url.hostname) return cb(new Error('主机不匹配'))
        if (options.all) cb(null,addresses); else cb(null,addresses[0].address,addresses[0].family)
      } }, res => {
        if ([301,302,303,307,308].includes(res.statusCode)) { res.resume(); resolve({ redirect: res.headers.location }); return }
        if (res.statusCode !== 200 || !/^image\/(jpeg|png|gif|webp)(;|$)/i.test(res.headers['content-type']||'')) { res.resume(); reject(new Error('封面状态或类型无效')); return }
        const chunks=[]; let size=0
        res.on('data',b=>{ size+=b.length; if(size>8*1024*1024) res.destroy(new Error('封面超过8MB')); else chunks.push(b) })
        res.on('error',reject)
        res.on('end',()=>{try{const buffer=Buffer.concat(chunks);resolve({buffer,type:imageType(buffer)})}catch(e){reject(e)}})
      })
      req.on('error',reject);req.end()
    })
    if(!r.redirect) return r
    url=coverUrl(new URL(r.redirect,url).href)
  }
  throw new Error('封面重定向过多')
}
