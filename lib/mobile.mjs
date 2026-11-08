// dsh-fish-world mobile entry —— 电脑开着时，手机在同一 Wi-Fi 打开鱼世界的轻量页面。
// 不走反向代理：DSH Web 自己有认证，手机没有那个 cookie；这里直接提供鱼世界的
// 状态与聊天 API（chat 回调由 index.js 接 chatApi，未配置就如实说）。
import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

function lanAddresses() {
  const out = []
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const item of list || []) {
        if (!item || item.internal) continue
        if (item.family !== 'IPv4' && item.family !== 4) continue
        out.push(item.address)
      }
    }
  } catch {}
  const score = (ip) => {
    const n = ip.split('.').map(Number)
    if (n[0] === 10) return 100
    if (n[0] === 192 && n[1] === 168) return 90
    if (n[0] === 172 && n[1] >= 16 && n[1] <= 31) return 80
    if (n[0] === 169 && n[1] === 254) return -10
    return 10
  }
  return [...new Set(out)].sort((a, b) => score(b) - score(a))
}

function tokenOf(home) {
  const file = path.join(home, 'mobile-token.txt')
  try {
    const old = fs.readFileSync(file, 'utf8').trim()
    if (old) return old
  } catch {}
  const token = crypto.randomBytes(18).toString('hex')
  try { fs.writeFileSync(file, token, { mode: 0o600 }) } catch {}
  return token
}

function cookieToken(req) {
  const raw = String(req.headers.cookie || '')
  const hit = raw.split(';').map((x) => x.trim()).find((x) => x.startsWith('fw_mobile='))
  return hit ? decodeURIComponent(hit.slice('fw_mobile='.length)) : ''
}

function page() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>鱼的世界 · 手机</title>
<style>
:root{color-scheme:dark;--bg:#0c1018;--card:#151b26;--line:#273244;--ink:#e8edf6;--dim:#9aa8bc;--accent:#6ea6ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;padding-bottom:84px}
header{position:sticky;top:0;z-index:2;background:rgba(12,16,24,.92);backdrop-filter:blur(12px);padding:14px 16px 10px;border-bottom:1px solid var(--line)}
h1{font-size:18px;margin:0}small{color:var(--dim)}.wrap{padding:14px 14px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 13px;margin-bottom:10px}.k{font-size:11px;color:var(--dim)}.v{font-size:20px;font-weight:700;margin-top:2px}
#log{min-height:120px}#log .msg{max-width:88%;margin:10px 0;padding:10px 12px;border-radius:14px;white-space:pre-wrap;word-break:break-word}
#log .user{margin-left:auto;background:#1d3557;color:#dcecff}#log .bot{background:var(--card);border:1px solid var(--line)}#log .meta{font-size:10px;color:var(--dim);margin-top:3px}
form{position:fixed;left:0;right:0;bottom:0;display:flex;gap:8px;padding:10px 12px;background:rgba(12,16,24,.94);border-top:1px solid var(--line)}
input{flex:1;min-width:0;background:var(--card);border:1px solid var(--line);border-radius:12px;color:var(--ink);padding:11px 12px;font-size:15px}button{border:0;border-radius:12px;background:var(--accent);color:#08111f;font-weight:700;padding:0 16px;font-size:15px}
</style></head><body>
<header><h1>🐋 鱼的世界</h1><small id="status">正在连接电脑…</small></header>
<div class="wrap"><div class="grid" id="cards"></div><div class="card"><div class="k">和她说两句</div><div id="log"><div class="bot">电脑开着，手机也能找到我。<br>发一句话试试。</div></div></div></div>
<form id="f"><input id="text" placeholder="和鱼说点什么…" autocomplete="off"><button>发送</button></form>
<script>
const token = new URLSearchParams(location.search).get('t') || '';
const api = (p) => p + (token ? (p.indexOf('?')>=0?'&':'?') + 't=' + encodeURIComponent(token) : '');
async function state(){try{const r=await fetch(api('/api/state'),{cache:'no-store'});const j=await r.json();if(!j.ok)throw new Error(j.error||'读取失败');document.getElementById('status').textContent='在线 · '+(j.time||'');const w=j.world||{};const rows=[['日记',w.diaryCount??'—'],['记忆',w.memoryCount??'—'],['成长',w.growthCount??'—'],['请求',w.wishCount??'—']];document.getElementById('cards').innerHTML=rows.map(([k,v])=>'<div class="card"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>').join('')}catch(e){document.getElementById('status').textContent='没连上：'+e.message}}
function add(text,who){const log=document.getElementById('log');const d=document.createElement('div');d.className='msg '+who;d.textContent=text;log.appendChild(d);log.scrollTop=log.scrollHeight}
document.getElementById('f').addEventListener('submit',async(e)=>{e.preventDefault();const el=document.getElementById('text');const text=el.value.trim();if(!text)return;el.value='';add(text,'user');const r=await fetch(api('/api/chat'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});const j=await r.json();add(j.ok?j.text:('没说出来：'+(j.error||'未知')),'bot');});
state();
</script></body></html>`
}

export function createMobile({ home, getConfig, getState, chat, logger } = {}) {
  const cfg = () => {
    try { const c = typeof getConfig === 'function' ? getConfig() : (getConfig || {}); return (c && c.mobile && typeof c.mobile === 'object') ? c.mobile : {} } catch { return {} }
  }
  const token = tokenOf(home)
  let server = null
  let port = 0
  let running = false

  function status() {
    const urls = lanAddresses().map((ip) => 'http://' + ip + ':' + port + '/?t=' + encodeURIComponent(token))
    return { ok: true, running, port, token, urls, url: urls[0] || '', note: running ? '手机与电脑连同一个 Wi-Fi，打开 url 即可' : '手机入口还没启动' }
  }
  function pass(req) { const u = new URL(req.url || '/', 'http://local'); return u.searchParams.get('t') === token || cookieToken(req) === token }
  function deny(res) { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); res.end('鱼的世界：需要手机入口 token（从电脑端打开）') }
  function json(res, code, value) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
  async function body(req, limit = 64 * 1024) { let n = 0; const chunks = []; for await (const c of req) { n += c.length; if (n > limit) throw new Error('请求体太大'); chunks.push(c) } const s = Buffer.concat(chunks).toString('utf8'); return s ? JSON.parse(s) : {} }

  async function start() {
    if (running) return status()
    if (cfg().enabled === false) return { ok: false, running: false, error: '手机入口已在配置里关闭' }
    const desired = Math.max(1024, Math.min(65535, Number(cfg().port) || Number(process.env.FISH_WORLD_MOBILE_PORT) || 3388))
    for (let p = desired; p < desired + 12; p++) {
      const attempt = http.createServer(async (req, res) => {
        if (!pass(req)) return deny(res)
        if (req.url === '/' || req.url.startsWith('/?')) res.setHeader('Set-Cookie', 'fw_mobile=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Lax')
        const u = new URL(req.url || '/', 'http://local')
        if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(page())
        }
        if (req.method === 'GET' && u.pathname === '/api/state') {
          try { const s = await getState(); return json(res, 200, { ok: true, time: new Date().toLocaleString('zh-CN'), world: s || {} }) } catch (e) { return json(res, 200, { ok: false, error: String(e?.message || e) }) }
        }
        if (req.method === 'POST' && u.pathname === '/api/chat') {
          try { const b = await body(req); const text = String(b.text || '').trim(); if (!text) return json(res, 400, { ok: false, error: '空消息' }); const r = await chat(text); return json(res, r && r.ok ? 200 : 200, r || { ok: false, error: '没有回复' }) } catch (e) { return json(res, 500, { ok: false, error: String(e?.message || e) }) }
        }
        json(res, 404, { ok: false, error: 'not found' })
      })
      const ok = await new Promise((resolve) => { attempt.once('error', () => resolve(false)); attempt.listen(p, '0.0.0.0', () => resolve(true)) })
      if (!ok) { try { attempt.close() } catch {} ; continue }
      server = attempt; port = p; running = true
      logger?.info?.('fish-world: 手机入口 http://<本机IP>:' + p + '/?t=' + token)
      return status()
    }
    return { ok: false, running: false, error: '端口被占用（3388..3399）' }
  }

  function stop() { running = false; if (server) { const srv = server; server = null; try { srv.closeAllConnections?.() ; srv.close() } catch {} } return { ok: true, running: false } }
  return { start, stop, status, token, get port() { return port } }
}
