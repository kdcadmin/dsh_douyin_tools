import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
const home=mkdtempSync(join(import.meta.dirname,'.protocol-'))
const proc=spawn(process.argv[2]||process.env.DOUYIN_PYTHON||'python',[join(import.meta.dirname,'..','vendor','douyin-mcp','mcp_server.py')],{
  env:{...process.env,DSH_DOUYIN_HOME:home,PYTHONUTF8:'1',DOUYIN_ALLOW_WRITES:'0',DOUYIN_MCP_TOOLS:'douyin_video'},
  windowsHide:true,stdio:['pipe','pipe','pipe'],
})
let next=1,stderr=''
const pending=new Map()
const fail=e=>{for(const p of pending.values())p.reject(e);pending.clear()}
proc.on('error',fail)
proc.on('exit',code=>fail(new Error('MCP exited '+code+': '+stderr)))
proc.stderr.on('data',b=>{stderr=(stderr+b).slice(-2000)})
const lines=createInterface({input:proc.stdout})
lines.on('line',line=>{try{const m=JSON.parse(line),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}}catch{}})
function send(method,params,id){proc.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params,...(id?{id}:{})})+'\n')}
function request(method,params={}){
  const id=next++
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP timeout: '+method+' '+stderr))},20000)
    pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r)},reject:e=>{clearTimeout(timer);reject(e)}})
    send(method,params,id)
  })
}
try{
  await request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'offline-regression',version:'1'}})
  send('notifications/initialized',{})
  const result=await request('tools/list')
  assert.deepEqual(result.tools.map(t=>t.name),['douyin_video'])
  assert.ok(result.tools[0].inputSchema.properties.aweme_id)
  console.log('PASS actual FastMCP stdio handshake, tool list and schema')
  const denied=await request('tools/call',{name:'douyin_publish',arguments:{video_path:'does-not-exist'}})
  assert.equal(denied.isError,true)
  console.log('PASS actual FastMCP refuses disabled write tool without browser access')
}finally{
  lines.close()
  proc.kill()
  if(proc.exitCode===null)await new Promise(resolve=>proc.once('exit',resolve))
  rmSync(home,{recursive:true,force:true})
}

