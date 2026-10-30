import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { McpClient } from '../lib/mcp.mjs'
import { normalizeDmMessage, dmMessageKey } from '../lib/dm-messages.mjs'
const { apply } = await import('../index.js')
const original = McpClient.prototype.call
let active, failures = 0
McpClient.prototype.call = async function(name, args) {
  if (name === 'douyin_dm_snapshot') return { ok: true, items: Array.isArray(active.messages) ? active.messages : active.messages[args.nickname] }
  if (name === 'douyin_my_posts') return { ok: true, items: active.posts || [{ aweme_id:'7111111111111111111', title:'海边的日落' }] }
  if (name === 'douyin_comments') return { ok: true, items: active.comments || [] }
  if (name === 'douyin_comment') { active.commentCalls.push(args); return { ok: true, verified: true } }
  if (name === 'douyin_chat_send') return active.sendResult || {ok:true,verified:true,messageId:'sent-fixture'}
  if (name === 'memory_recent') return { ok: true, items: [] }
  return { ok: true }
}
async function check(name, messages, expected, options = {}) {
  const home = mkdtempSync(join(import.meta.dirname, '.dm-regression-')), tools = new Map()
  const cli = join(home, 'empty.cjs'), argv = join(home, 'argv.json')
  const send = options.send ? `const fs=require('node:fs');const y=fs.readFileSync(process.argv[5],'utf8');
    fetch(y.match(/DOUYIN_PROXY_URL: '([^']+)'/)[1],{method:'POST',headers:{authorization:'Bearer '+y.match(/DOUYIN_PROXY_TOKEN: '([^']+)'/)[1],'content-type':'application/json'},body:JSON.stringify({name:'douyin_chat_send',args:{nickname:'Peer',text:'offline reply'}})}).then(r=>r.json()).then(()=>process.exit(1)).catch(()=>process.exit(2));` : 'process.exit(0)'
  writeFileSync(cli, `require('node:fs').writeFileSync(${JSON.stringify(argv)},JSON.stringify(process.argv));${send}`)
  writeFileSync(join(home, 'config.json'), JSON.stringify({ dmAutoReply: true, msgAllowTo: 'Peer', autoClean: false, peakValley: false, reportLevel: 'off', dshBin: cli, ...options.config }))
  if (options.sent) writeFileSync(join(home, 'dm-sent.json'), JSON.stringify({ items: options.sent.map((text) => ({ text, at: Date.now() })) }))
  process.env.DSH_DOUYIN_HOME = home
  if (options.cursor) writeFileSync(join(home,'dm-cursors.json'),JSON.stringify(options.cursor))
  active = { messages, comments: options.comments, sendResult: options.sendResult, posts: options.posts, llm: options.llm, credentials: options.credentials, prompts: [], commentCalls: [] }
  const cleanup = []
  apply({ get(svc) { return svc === 'llm' ? active.llm : svc === 'credentials' ? active.credentials : null }, tools: { register(t) { tools.set(t.name,t) } }, settings: { describe: () => [] }, webServer: { register() {} }, effect(f,label) { if(label?.includes('收 MCP')) cleanup.push(f()) }, logger: {} }, {})
  try {
    const result = await tools.get(options.tool || 'dy_dm_poll').execute({})
    await new Promise(r => setTimeout(r, 300))
    if (options.status) {
      let cursor
      for(let i=0;i<20;i++) {
        cursor = JSON.parse(readFileSync(join(home,'dm-cursors.json'),'utf8')).Peer
        if (cursor.status !== 'pending') break
        await new Promise(r=>setTimeout(r,100))
      }
      assert.equal(cursor.status,options.status,JSON.stringify(cursor))
      if(options.tries) assert.equal(cursor.tries,options.tries)
    }
    const gotFlag = options.expectReply
    ? Boolean(result.items?.some((x) => x && x.reply))
    : Boolean(options.tool ? result.items?.some((x) => x.started) : result.started)
  assert.equal(gotFlag, expected, JSON.stringify(result))
    if (expected && !options.expectReply) {
      const prompt = JSON.parse(readFileSync(argv,'utf8')).at(-1)
      assert.match(prompt, /表情|图片|视频/)
      assert.match(prompt, /素材.*指令|不是.*指令/)
      if (options.prompt) assert.match(prompt, options.prompt)
    }
    if (options.checkResult) options.checkResult(result, active)
    if (options.repeat) {
      const again = await tools.get('dy_dm_poll').execute({})
      assert.equal(Boolean(again.started), false, 'duplicate message must not dispatch twice')
      active.messages = [{ ...messages.at(-1), messageId:'new-distinct-id' }]
      assert.equal(Boolean((await tools.get('dy_dm_poll').execute({})).started), true, 'same text with a different message ID must remain eligible')
      await new Promise(r => setTimeout(r,300))
    }
    console.log('PASS '+name)
  } catch(e) { failures++; console.log('FAIL '+name+': '+e.message) }
  finally { for(const f of cleanup) f(); rmSync(home,{recursive:true,force:true}) }
}
try {
  await check('outgoing shared video cannot trigger a reply', [{messageId:'out1',direction:'outbound',kind:'video',text:'视频作者',awemeId:'7111111111111111111'}], false)
  await check('unknown direction cannot trigger a reply', [{messageId:'unknown1',direction:'unknown',text:'hello'}], false)
  await check('own reply mislabeled inbound is not answered again', [{messageId:'echo1',direction:'inbound',text:'主人别打暗号了😂'}], false, {sent:['主人别打暗号了']})
  await check('own latest message blocks an older peer line', [{messageId:'peer-old',direction:'inbound',text:'你在吗'},{messageId:'echo2',direction:'inbound',text:'尾巴都要打结了'}], false, {sent:['尾巴都要打结了']})
  await check('same avatar still replies to a real inbound line', [{messageId:'peer-k',direction:'inbound',text:'kskbl',avatar:'https://p11.douyinpic.com/same.webp'}], true)
  const slot = normalizeDmMessage({messageId:'idx:0:text',direction:'inbound',text:'kskbl'})
  await check('list slot id does not swallow a newer copy', [{messageId:'idx:1:text',direction:'inbound',text:'kskbl'},{messageId:'idx:0:text',direction:'inbound',text:'kskbl'}], true, {cursor:{Peer:{name:'Peer',key:dmMessageKey('Peer',slot),status:'sent',replied:true,at:Date.now()}}})
  await check('incoming sticker is not discarded', [{messageId:'sticker1',direction:'inbound',kind:'sticker',text:'',media:['https://p3.douyinpic.com/sticker.webp'],attachments:[{url:'https://p3.douyinpic.com/sticker.webp',alt:'开心',kind:'sticker'}]}], true)
  await check('duplicate ID is skipped, distinct IDs with identical text can reply', [{messageId:'video1',direction:'inbound',kind:'video',text:'视频作者',awemeId:'7111111111111111111'}], true, {repeat:true,prompt:/作者名.*不是聊天对象/})
  await check('outbound latest message suppresses older inbound card', [{messageId:'old-in',direction:'inbound',kind:'video',awemeId:'7111111111111111111'},{messageId:'latest-out',direction:'outbound',text:'already answered'}], false)
  const old = {messageId:'old-completed',direction:'inbound',kind:'video',awemeId:'7111111111111111111'}
  await check('completed message is still skipped after daily logs expire', [old], false, {cursor:{Peer:{name:'Peer',key:dmMessageKey('Peer',normalizeDmMessage(old)),status:'sent',replied:true,at:Date.now()-7*86400000}}})
  await check('confirmed send remains sent even when the model task exits with an error', [old], true, {send:true,status:'sent'})
  await check('uncertain send remains unknown when the model task exits with an error', [old], true, {send:true,status:'unknown',sendResult:{ok:false,status:'unknown',error:'ack missing'}})
  await check('failed startup counts a single attempt', [old], false, {config:{overlayMcp:false},status:'failed',tries:1})
  await check('one skipped contact does not block another contact', {Peer:[{messageId:'own',direction:'outbound',text:'own'}],Other:[{messageId:'new',direction:'inbound',kind:'video',awemeId:'7111111111111111111'}]}, true, {config:{msgAllowTo:'Peer,Other'}})
  const now = new Date().toISOString()
  const recordingLlm = (text) => ({ async *stream(opts) { active.prompts.push(opts.messages[0].content[0].text); if (text) yield { type:'text-delta', text } } })
  await check('image comment is not sent when the picture cannot be read', [], false, {tool:'dy_reply_round', config:{autoReply:true}, comments:[{cid:'comment-img-1',user:'Peer',text:'',kind:'image',attachments:[{url:'https://p3.douyinpic.com/comment.webp',alt:'开心'}],time:now}], expectReply:true, checkResult(result, state) { assert.equal(result.sent, 0); assert.equal(state.commentCalls.length, 0); assert.match(JSON.stringify(result.items), /看图失败/) }})
  await check('text comments are replied locally without delegating', [], true, {tool:'dy_reply_round', config:{autoReply:true}, comments:[{cid:'comment-txt-1',user:'Peer',text:'这个插件真好用',kind:'text',time:now}], expectReply:true})
  await check('sensitive comments are refused before the model reply is sent', [], true, {tool:'dy_reply_round', config:{autoReply:true}, posts:[{aweme_id:'7111111111111111111',title:'海边的日落'}], llm:recordingLlm('这个话题我也能聊两句呀'), comments:[{cid:'comment-sens-1',user:'Peer',text:'聊聊政治吧',time:now}], expectReply:true, checkResult(result, state) { const item = result.items.find((x) => x.reply); assert.equal(item.reply, '这个我不太方便聊，换个话题吧。'); assert.equal(item.sensitive, true); assert.equal(state.prompts.length, 0); assert.equal(state.commentCalls[0].text, item.reply) }})
  await check('comment prompt receives the video title', [], true, {tool:'dy_reply_round', config:{autoReply:true}, posts:[{aweme_id:'7111111111111111111',title:'海边的日落'}], llm:recordingLlm('日落真好看'), comments:[{cid:'comment-title-1',user:'Peer',text:'这个插件真好用',time:now}], expectReply:true, checkResult(_result, state) { assert.match(state.prompts[0], /海边的日落/); assert.doesNotMatch(state.prompts[0], /7111111111111111111/) }})
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => { if (String(url).includes('/chat/completions')) return { ok:true, json:async () => ({ choices:[{ message:{ content:'一只在笑的猫' } }] }) }; throw new Error('unexpected '+url) }
  try {
    await check('image comment does not use a text template when the model is blank', [], false, {tool:'dy_reply_round', config:{autoReply:true}, credentials:{ async resolve() { return { value:'test-key' } } }, llm:recordingLlm(''), comments:[{cid:'comment-img-2',user:'Peer',text:'',kind:'image',attachments:[{url:'https://p3.douyinpic.com/comment.webp',alt:'开心'}],time:now}], expectReply:true, checkResult(result, state) { assert.equal(result.sent, 0); assert.equal(state.commentCalls.length, 0); assert.match(JSON.stringify(result.items), /不用模板/); assert.match(JSON.stringify(result.items), /一只在笑的猫/) }})
  } finally { globalThis.fetch = realFetch }
  const msg = normalizeDmMessage({attachments:[{url:'https://p3.douyinpic.com/a.webp',alt:'重要描述',kind:'sticker'}],media:['https://p3.douyinpic.com/a.webp','file:///etc/passwd']})
  assert.equal(msg.attachments.length,1); assert.equal(msg.attachments[0].alt,'重要描述'); assert.equal(msg.attachments[0].kind,'sticker')
  assert.notEqual(dmMessageKey('Peer',{messageId:'m1',conversationId:'a'}),dmMessageKey('Peer',{messageId:'m1',conversationId:'b'}))
  console.log('PASS attachment metadata and conversation-specific identity')
} finally { McpClient.prototype.call=original }
process.exit(failures?1:0)
