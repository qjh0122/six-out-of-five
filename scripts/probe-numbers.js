#!/usr/bin/env node
/**
 * 数字阶梯探针（数字三档收口 · v138）真浏览器 / CDP
 *
 * 跑法：node scripts/probe-numbers.js [宽] [高]
 *          node scripts/probe-numbers.js 390 844
 *      DUMP=1 打印"这屏每个数字实际多大"的明细表（诊断用，也是写施工单的依据）
 *
 * ── 它守的是什么 ──────────────────────────────────────────────────────
 * 一屏里出现几个不同大小的数字，静态读 CSS 是数不准的：媒体查询、`.compact-v`、
 * `.wide-stage`、`.ls`、`:nth-child(-n+3)` 这些修饰类会让**同一个元素**在不同条件下
 * 拿到不同的 font-size（`.ach-count b` 就有 84 / 68 / 62 三个值）。所以判据只能在
 * 渲染之后取 computed style。
 *
 * 规则不是"一屏最多几档"，而是**阶梯封闭**：
 *   数值元素   font-size ∈ {88, 48, 32, 24}
 *   单位元素   font-size ∈ {28, 20}        且必须严格小于它所属的数字
 *
 * 为什么是"封闭"不是"计数"：计数（≤3）挡不住 88/48/32/24 这种"四档但都合理"的屏，
 * 而 40 / 34 / 30 / 62 / 68 / 84 这种阶梯外的值恰恰是一个一个长出来的 ——
 * 它们的共同点不是"多了"，是"不在梯子上"。判"在不在梯子上"比判"几个"稳。
 *
 * ── 三条假绿反例（刻意避开） ───────────────────────────────────────────
 *   ① 不数 CSS 文本里的 font-size：那数的是"声明"，不是"这一屏玩家看到的"。
 *   ② 不查 `#rp-net` 这类 id 的绝对字号：钉住实现细节的断言，改档位就假红、
 *      实现退化成"另一个阶梯外的值"却可能不红。这里查的是**全集 ⊆ 阶梯**。
 *   ③ 不过滤可见性就统计：`.settle-pos` 的「—」、隐藏态里的数字都会混进来。
 *      `checkVisibility()` + 有效矩形两个条件都满足才算"看得见"。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { findBrowser } = require('./lib/browser');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
const PORT = 3072;
const CDP_PORT = 9372;
const ROOT = path.join(__dirname, '..', 'pwa');
const DUMP = !!process.env.DUMP;
const SHOTS = !!process.env.ZOOM;

/* 阶梯：数值 88/48/32/24，单位 28/20。改这里等于改规范 —— 要改就一起改文档。 */
const NUM_TIERS = [88, 48, 32, 24];
const UNIT_TIERS = [28, 20];
const T1 = 88;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json', '.json': 'application/json'
};

const NOW = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ==================== 假服务端 ====================
 * 只用 `?mode=ws` 跑（不连 WS），所以不需要 ws 应答器：
 * 没有 socket 就没有"断开→退避重连→toast"的循环，页面能安静地停在要测的屏上。
 * HTTP 接口照常实现 —— 战绩/榜单/成就都要读它们。 */
function profile(games) {
  return {
    games: games, wins: Math.ceil(games * 0.55), losses: games - Math.ceil(games * 0.55), draws: 0,
    winRate: 55, totalNet: games * 3, bestNet: 12, currentStreak: 2, longestStreak: 4,
    longestLoseStreak: 3, achCount: 6, aiRecent: [], aiGames: 0,
    recent: [{ roomId: 'R1', net: 5, endedAt: NOW - 60000, playerCount: 3, endReason: 'handLimit' }]
  };
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/api/auth/me') {
    return sendJson(res, 200, { ok: true, me: { playerId: 'p1', nickname: '玩家A', account: { name: 'probe_numbers', createdAt: NOW } } });
  }
  if (url === '/api/me/records') {
    return sendJson(res, 200, { ok: true, profile: profile(19), serverTime: Date.now() });
  }
  if (url === '/api/leaderboard') {
    /* 12 行：既要有 top3（奖牌 + 加粗），也要有第 4 名之后（纯数字名次），
     * 还要有「我」在榜内 —— 三种行在 CSS 里字号可能不一样，只造 3 行就测不到。 */
    const list = [];
    for (let i = 1; i <= 12; i += 1) {
      list.push({
        playerId: i === 4 ? 'p1' : 'x' + i,
        nickname: i === 4 ? '玩家A' : '玩家' + i,
        games: 20 - i, winRate: 80 - i * 2, totalNet: 60 - i * 7
      });
    }
    return sendJson(res, 200, { ok: true, list: list, me: { rank: 4, totalNet: 32 } });
  }
  if (url === '/api/players/alive') return sendJson(res, 200, { ok: true, dead: [], checked: 0 });
  if (url === '/api/client-error') return sendJson(res, 200, { ok: true });
  if (url === '/__nonce') return sendJson(res, 200, { nonce: NONCE });

  let p = url === '/' ? '/index.html' : url;
  const abs = path.join(ROOT, p);
  if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(abs, (e, buf) => {
    if (e) { res.writeHead(404); res.end('404'); return; }
    if (p === '/index.html') {
      /* nonce：确认这个文档确实是本进程服务的。残留浏览器占着 CDP 端口时
       * 后面每条断言都会变成假失败，而那种失败最难查（踩过）。 */
      const html = buf.toString('utf8').replace('<head>', '<head><script>window.__n=' + JSON.stringify(NONCE) + ';</script>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
  });
});

const NONCE = 'num' + Date.now() + crypto.randomBytes(3).toString('hex');

/* ── 最小 WebSocket 应答器 ──
 * 成就页在 `?mode=ws` 下直接说「本地演示模式看不了成就」，而它恰恰是
 * 本次最脏的一屏（同一个数字有 84 / 68 / 62 三个值），必须真的渲染出来才量得到。
 * 所以走 ws 模式 —— 代价是必须应 socket，否则 RoomStore 会「断开→退避重连→
 * flash('网络波动，正在重连…')」不停地刷 toast。这里只应 pong、其余回 ack：
 * 这个探针不验联机，只要 socket 别断。 */
function wsFrame(str) {
  const buf = Buffer.from(str, 'utf8');
  let head;
  if (buf.length < 126) head = Buffer.from([0x81, buf.length]);
  else if (buf.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81; head[1] = 126; head.writeUInt16BE(buf.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81; head[1] = 127;
    head.writeUInt32BE(0, 2); head.writeUInt32BE(buf.length, 6);
  }
  return Buffer.concat([head, buf]);
}
function wsRead(buf) {
  const out = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const op = buf[i] & 0x0f;
    const masked = (buf[i + 1] & 0x80) !== 0;
    let len = buf[i + 1] & 0x7f;
    let off = i + 2;
    if (len === 126) { if (off + 2 > buf.length) break; len = buf.readUInt16BE(off); off += 2; }
    else if (len === 127) { if (off + 8 > buf.length) break; len = buf.readUInt32BE(off + 4); off += 8; }
    const maskLen = masked ? 4 : 0;
    if (off + maskLen + len > buf.length) break;
    const mask = masked ? buf.slice(off, off + 4) : null;
    off += maskLen;
    const data = Buffer.from(buf.slice(off, off + len));
    if (mask) for (let k = 0; k < data.length; k += 1) data[k] ^= mask[k % 4];
    out.push({ op, text: data.toString('utf8') });
    i = off + len;
  }
  return { frames: out, rest: buf.slice(i) };
}
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + 'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.on('error', () => { /* 探针结束时对端直接掐断 */ });
  let acc = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    acc = Buffer.concat([acc, chunk]);
    const r = wsRead(acc);
    acc = r.rest;
    r.frames.forEach((f) => {
      if (f.op === 0x8) { socket.end(); return; }
      if (f.op !== 0x1) return;
      let msg = null;
      try { msg = JSON.parse(f.text); } catch (e) { msg = null; }
      if (!msg) return;
      if (msg.type === 'ping') { try { socket.write(wsFrame(JSON.stringify({ type: 'pong' }))); } catch (e) {} return; }
      try {
        socket.write(wsFrame(JSON.stringify({ type: 'ack', ok: true, id: msg.id || null, re: msg.type || null })));
      } catch (e) { /* 对端已断 */ }
    });
  });
});

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const waiting = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && waiting.has(msg.id)) {
        const w = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
        else w.resolve(msg.result);
      }
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => {
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            id += 1;
            waiting.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params: params || {} }));
          });
        },
        close() { try { ws.close(); } catch (e) {} }
      });
    });
  });
}

/* ==================== 页面内的采集器 ====================
 * 「数值元素」判定：元素**自己的**文字（只看直接文本节点）长得像一个数 ——
 *   +5 / −9 / 19 / 53% / 25 分 / /50 / 3
 * 不含 "共 19 场 · 近 20 场" 这种句子（那是正文，不是"一屏的结论"）。
 * 单位元素：自己的文字是 分/场/%/位/名/局/次 这几个字，且前一个兄弟是数值元素。 */
const COLLECT = `(function(){
  /* 单位：单独一个字（"分"、"次"），或分母写法 "/ 35"。
   * 「胜/负/平」不是单位，是卡片标签（.rp-glabel），不算 —— 之前把标签算进单位，红得莫名其妙。 */
  var UNIT = /^(分|场|%|次|位|名|局)$/;
  /* 数值元素只认**纯数字与百分比**（+14 / 0 / 50%）。
   * 带量词的不算：「25 分」「5 次」「12 场」按设计 §③-b 自己的说法
   * 「读起来是一个词」，走正文层级，不进阶梯（本文件 §1-N3）。 */
  var NUM = /^[+\\u2212-]?\\s*\\d[\\d,]*\\s*%?$/;
  var DENOM = /^\\/\\s*\\d+$/;
  function ownText(el){
    var s = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3) s += n.nodeValue;
    }
    return s.replace(/\\s+/g, ' ').trim();
  }
  function visible(el){
    if (!el || el.closest('.hidden')) return false;
    if (el.checkVisibility && !el.checkVisibility()) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function label(el){
    if (el.id) return '#' + el.id;
    var c = (el.className || '').toString().trim().split(/\\s+/).filter(function(x){return x && x !== 'is-out';})[0];
    return el.tagName.toLowerCase() + (c ? '.' + c : '');
  }
  var nums = [], units = [];
  var all = document.querySelectorAll('#screen-records *, #screen-rank *, #screen-achievements *');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var t = ownText(el);
    if (!t || t.length > 10) continue;
    if (el.closest('svg')) continue;              // 插画里的 <text> 是图形，不是数字
    if (el.namespaceURI && el.namespaceURI.indexOf('svg') >= 0) continue;
    if (!visible(el)) continue;
    /* 角标豁免（施工单 §1-N4）：position:absolute 的胶囊里那个数字是图形，
     * 它的字号由胶囊直径决定（.settle-pos 是 24×24 的圆，16px 正好居中，
     * 顶到 24 会出血）。豁免写在代码里，不是默默跳过。 */
    if (getComputedStyle(el).position === 'absolute') continue;
    var size = parseFloat(getComputedStyle(el).fontSize);
    var screen = el.closest('section.screen');
    var sid = screen ? screen.id : '?';
    if (UNIT.test(t) || DENOM.test(t)) {
      /* 数字可能在**前一个兄弟**（.rp-best-v 里是 b 然后是 i），
       * 也可能在**自己肚子里**（.rp-meta-item 里单位是这个 span 的直接文本节点，
       * 数字是它的子元素 b）。两种都要认 —— 只认前一种会把
       * 「单位 24 / 数字 24」误报成"数字未知"，然后在 320 上假红。
       * 注意：这段字符串会被原样塞进浏览器执行，注释里不能出现反引号。 */
      var prev = el.previousElementSibling;
      var host = (prev && NUM.test(ownText(prev))) ? prev
        : (el.querySelector && el.querySelector('b,i,span'));
      var hostOk = host && NUM.test(ownText(host)) && visible(host);
      units.push({ screen: sid, sel: label(el), text: t, size: size,
                   prevSel: host ? label(host) : '', prevSize: hostOk ? parseFloat(getComputedStyle(host).fontSize) : null });
      continue;
    }
    if (NUM.test(t)) nums.push({ screen: sid, sel: label(el), text: t, size: size });
  }
  return JSON.stringify({ nums: nums, units: units });
})()`;

/* ==================== 断言小工具 ==================== */
const fails = [];
function ok(cond, name, extra) {
  const line = (cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  [' + extra + ']' : '');
  console.log(line);
  if (!cond) fails.push(name + (extra ? ' [' + extra + ']' : ''));
}
const ms = (v) => parseFloat(String(v).replace('px', '')) || 0;

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('视口 ' + W + '×' + H + (DUMP ? '   （明细模式）' : ''));

  const exe = findBrowser();
  const userDir = path.join(os.tmpdir(), 'lxw-probe-num-' + Date.now());
  const edge = spawn(exe, [
    '--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + userDir,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    let list = null;
    for (let i = 0; i < 80 && !list; i += 1) {
      try { list = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list'); } catch (e) { await sleep(250); }
    }
    if (!list || !list.length) throw new Error('浏览器没起来（' + exe + '）');
    const page = list.find((t) => t.type === 'page' && /^(about:|http:)/.test(t.url || ''));
    if (!page) throw new Error('找不到可用的页面 target');
    cdp = await cdpConnect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const evaluate = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error('页面内脚本报错：' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      }
      return r.result.value;
    };
    const waitFor = async (expr, t) => {
      const t0 = Date.now();
      while (Date.now() - t0 < (t || 4000)) {
        if (await evaluate(expr) === true) return true;
        await sleep(80);
      }
      return false;
    };
    const shot = async (name) => {
      if (!SHOTS) return;
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      /* SHOT_DIR 可指定：验收要看图时收进仓库（tmp-shots/ 是 .gitignore 的），
       * 默认仍进临时目录 —— CI 不需要产物，只需要红绿。 */
      const out = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : path.join(os.tmpdir(), 'lxw-num-probe');
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(r.data, 'base64'));
      console.log('    图：' + path.join(out, name + '.png'));
    };

    /* 会话 + 本机记录：两个数据源都给满，否则页面会走空态，
     * 那就只测到空态的字号（空态只有一个标题和一个 CTA，什么都验不到）。 */
    const seed = async () => {
      /* 本机记录必须给：`?mode=ws` 下云端档案根本不读（这是"本地优先"的设计，
       * 不是缺陷），没有本机记录页面就停在空态 —— 空态只有一个标题和一个 CTA，
       * 数字层级什么都验不到。六条记录刻意带上「胜/负/平」三个值和一个新高，
       * 让三卡与纪录条的每个数字都非零。 */
      const recs = [
        { id: 'R1-1', roomId: 'R1', playerId: 'p1', endedAt: NOW - 60000, playerCount: 3, myStartScore: 20, myEndScore: 28, myNet: 8, endReason: 'handLimit', rounds: 3 },
        { id: 'R2-1', roomId: 'R2', playerId: 'p1', endedAt: NOW - 3600000, playerCount: 4, myStartScore: 20, myEndScore: 14, myNet: -6, endReason: 'dissolve', rounds: 3 },
        { id: 'R3-1', roomId: 'R3', playerId: 'p1', endedAt: NOW - 7200000, playerCount: 3, myStartScore: 20, myEndScore: 20, myNet: 0, endReason: 'handLimit', rounds: 3 },
        { id: 'R4-1', roomId: 'R4', playerId: 'p1', endedAt: NOW - 9000000, playerCount: 2, myStartScore: 20, myEndScore: 32, myNet: 12, endReason: 'handLimit', rounds: 4 },
        { id: 'R5-1', roomId: 'R5', playerId: 'p1', endedAt: NOW - 12000000, playerCount: 4, myStartScore: 20, myEndScore: 17, myNet: -3, endReason: 'handLimit', rounds: 3 },
        { id: 'R6-1', roomId: 'R6', playerId: 'p1', endedAt: NOW - 15000000, playerCount: 3, myStartScore: 20, myEndScore: 23, myNet: 3, endReason: 'handLimit', rounds: 2 }
      ];
      const sess = { token: 'tk', playerId: 'p1', nickname: '玩家A', name: 'probe_numbers', joinedAt: NOW };
      await evaluate(`(function(){
        localStorage.setItem('lxw_session_v1', ${JSON.stringify(JSON.stringify(sess))});
        localStorage.setItem('lxw_records_v1', ${JSON.stringify(JSON.stringify(recs))});
        localStorage.setItem('lxw_guide_seen_v1', '1');
        localStorage.setItem('lxw_records_deduped_v2', '1');
        return 'ok';
      })()`);
    };

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?mode=ws' });
    await sleep(1200);
    const nonce = await evaluate('window.__n || ""');
    if (nonce !== NONCE) throw new Error('文档不是本进程服务的（nonce ' + nonce + '），先关掉残留浏览器');
    await seed();
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?mode=ws' });
    await sleep(1400);

    /* 换屏动画（.screen.enter 是 0.3s slideInRight）没落地时量到的是半帧：
     * 内容整体右移，位置断言全错。等 transform 回到 none 再往下走。 */
    const settle = async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 2500) {
        const busy = await evaluate(`(function(){
          var l = [].slice.call(document.querySelectorAll('.screen'));
          return l.some(function(s){ return !s.classList.contains('hidden') && getComputedStyle(s).transform !== 'none'; });
        })()`);
        if (!busy) { await sleep(120); return; }
        await sleep(60);
      }
    };

    const openScreen = async (btnId, screenId) => {
      await evaluate(`(function(){ var g=document.getElementById('guide-modal'); if(g) g.classList.add('hidden'); return 'ok'; })()`);
      const hit = await evaluate(`(function(){ var b=document.getElementById('${btnId}'); if(!b) return 'no-btn'; b.click(); return 'ok'; })()`);
      if (hit !== 'ok') throw new Error('找不到入口按钮 #' + btnId);
      await settle();
      const vis = await waitFor(`(function(){ var s=document.getElementById('${screenId}'); return !!(s && !s.classList.contains('hidden')); })()`, 5000);
      if (!vis) throw new Error('进不去 #' + screenId);
      await sleep(500);                                  // 数据渲染 + 云端回包
    };

    const report = async (label, expectedT1) => {
      const data = JSON.parse(await evaluate(COLLECT));
      const bySize = {};
      data.nums.forEach((n) => { (bySize[n.size] = bySize[n.size] || []).push(n); });
      if (DUMP) {
        console.log('\n  ── ' + label + ' 明细 ──');
        data.nums.forEach((n) => console.log('    ' + String(n.size).padStart(5) + 'px  ' + n.sel.padEnd(26) + ' ' + JSON.stringify(n.text)));
        data.units.forEach((u) => console.log('    ' + String(u.size).padStart(5) + 'px  ' + (u.sel + ' (单位)').padEnd(26) + ' ' + JSON.stringify(u.text)));
      }
      if (DUMP) {
        const dbg = await evaluate("(function(){ var s=document.querySelector('section.screen:not(.hidden)'); if(!s) return 'no-screen'; var t=(s.innerText||'').replace(/\\s+/g,' ').slice(0,120); return s.id + ' | rstate=' + (s.getAttribute('data-rstate')||'-') + ' | ' + t; })()");
        console.log('    状态：' + dbg);
      }
      const sizes = Object.keys(bySize).map(Number).sort((a, b) => b - a);
      console.log('\n  ' + label + '：数字字号 ' + (sizes.length ? sizes.join(' / ') : '（无）')
        + '   共 ' + data.nums.length + ' 个');
      return { data, sizes };
    };

    /* ---------- [1] 战绩页 ---------- */
    console.log('\n[1] 我的战绩');
    await openScreen('btn-records-home', 'screen-records');
    const rec = await report('战绩页');
    await shot('numbers-records');
    {
      const off = rec.data.nums.filter((n) => NUM_TIERS.indexOf(n.size) < 0);
      ok(off.length === 0, '★ 数值元素全部落在阶梯 {88/48/32/24} 上',
        off.map((n) => n.sel + '=' + n.size).join(', ') || ('共 ' + rec.data.nums.length + ' 个'));
      /* T1 不钉 88：横屏为了省高度会把 T1 换一档（88 → 48），这是允许的（§1-N5）。
       * 要守的是「这一屏最大的那个数只能有一个，而且必须是累计净胜」。 */
      const top = Math.max(...rec.data.nums.map((n) => n.size));
      const t1 = rec.data.nums.filter((n) => n.size === top);
      ok(t1.length === 1, '★ 最大那一档只有一个元素（两个都在喊 = 都没在喊）', '本屏最大 ' + top + 'px，' + t1.length + ' 个');
      ok(t1.length === 1 && t1[0].sel === '#rp-net', '★ 最大的那个数是「累计净胜」', t1.map((n) => n.sel).join(',') || '无');
      /* 单位：{28,20} 两档。**唯一例外**是 24 —— 设计 §③-b 原话
       * 「24 的辅助数字不配单位（'12 场'里'场'与数字同号 24，因为它读起来是一个词）」。
       * 所以「单位 24 且数字也 24」是规则允许的，不能算违规。 */
      const badUnit = rec.data.units.filter((u) => !(UNIT_TIERS.indexOf(u.size) >= 0 || (u.size === 24 && u.prevSize === 24)));
      ok(badUnit.length === 0, '★ 单位字号只用 {28/20}（或与 24 档数字同号的「一个词」）', badUnit.map((u) => u.sel + '=' + u.size + '/数字' + u.prevSize).join(', ') || ('共 ' + rec.data.units.length + ' 个'));
      /* 「24 的数字配 24 的单位」是设计 §③-b 明确允许的（读起来是一个词），
       * 两条断言必须用同一个例外，否则一条放行、一条判红 —— 之前就是这样假红的。 */
      const unitLt = rec.data.units.filter((u) => u.prevSize != null
        && !(u.size < u.prevSize) && !(u.size === 24 && u.prevSize === 24));
      ok(unitLt.length === 0, '★★ 单位严格小于它所属的数字', unitLt.map((u) => u.sel + ' ' + u.size + ' vs ' + u.prevSize).join(', ') || '全部成立');
    }

    /* ---------- [2] 排行榜 ---------- */
    console.log('\n[2] 排行榜');
    await evaluate(`(function(){ document.getElementById('btn-records-back').click(); return 'ok'; })()`);
    await settle();
    await openScreen('btn-rank-home', 'screen-rank');
    const rank = await report('排行榜');
    await shot('numbers-rank');
    {
      const off = rank.data.nums.filter((n) => NUM_TIERS.indexOf(n.size) < 0);
      ok(off.length === 0, '★ 榜单数值落在阶梯上',
        off.map((n) => n.sel + '=' + n.size).join(', ') || ('共 ' + rank.data.nums.length + ' 个'));
      /* 名次是"辅助"，净值是"行内主值"：两者必须差一档以上，
       * 否则一列 12 行里两个数字在互相喊。 */
      const ranks = rank.data.nums.filter((n) => /rank-no/.test(n.sel));
      const nets = rank.data.nums.filter((n) => /rank-net/.test(n.sel));
      const rSizes = [...new Set(ranks.map((n) => n.size))];
      const nSizes = [...new Set(nets.map((n) => n.size))];
      ok(rSizes.length === 1, '★★ 名次只有一号（top3 与其它行不允许不同号）', '实测 ' + (rSizes.join('/') || '无'));
      ok(nSizes.length === 1, '★★ 净值只有一号（top3 与其它行不允许不同号）', '实测 ' + (nSizes.join('/') || '无'));
      ok(nSizes.length === 1 && rSizes.length === 1 && nSizes[0] > rSizes[0], '★ 净值比名次大（主值 > 辅助）',
        nSizes[0] + ' vs ' + rSizes[0]);
      /* 上面那两条只看得见"数字"——而 top3 的名次是奖牌 emoji（🥇🥈🥉），
       * 没有数字文本，于是「给 top3 单独调字号」这种改动在数字采集里**完全隐形**。
       * 实测变异③正是这样漏掉的：加了 `:nth-child(-n+3) .rank-no { 32px }` 仍然全绿。
       * 所以这里不看文本、不看内容，直接量**每一行**这两个格子的字号。 */
      const rows = JSON.parse(await evaluate(`(function(){
        var out = [];
        var list = document.querySelectorAll('#rank-list .rank-row');
        for (var i = 0; i < list.length; i++) {
          var no = list[i].querySelector('.rank-no'), net = list[i].querySelector('.rank-net');
          if (!no || !net) continue;
          out.push({ no: parseFloat(getComputedStyle(no).fontSize), net: parseFloat(getComputedStyle(net).fontSize) });
        }
        return JSON.stringify(out);
      })()`));
      ok(rows.length >= 10, '量到了整张榜（' + rows.length + ' 行）');
      const rowNoSizes = [...new Set(rows.map((r) => r.no))];
      const rowNetSizes = [...new Set(rows.map((r) => r.net))];
      ok(rowNoSizes.length === 1, '★★ 逐行量：名次格子只有一号（奖牌行也算）', rowNoSizes.join('/'));
      ok(rowNetSizes.length === 1, '★★ 逐行量：净值格子只有一号', rowNetSizes.join('/'));
      ok(rowNoSizes.length === 1 && Math.abs(rowNoSizes[0] - 24) < 1, '★ 名次格子是 T3（24）', String(rowNoSizes[0]));
      ok(rowNetSizes.length === 1 && Math.abs(rowNetSizes[0] - 32) < 1, '★ 净值格子是 T2 密排（32）', String(rowNetSizes[0]));
    }

    /* ---------- [3] 成就页 ---------- */
    console.log('\n[3] 成就');
    await evaluate(`(function(){ document.getElementById('btn-rank-back').click(); return 'ok'; })()`);
    await settle();
    await openScreen('btn-records-home', 'screen-records');
    await openScreen('btn-ach-from-records', 'screen-achievements');
    /* 成就页的数据走 RoomStore.getProfile（WS 的 getProfile 请求），要一份真的
     * 服务端档案才能渲染。这里只回了 ack、不回 profile，页面就停在「正在加载…」。
     * 所以**数据是合成的、DOM 与 CSS 是真的**：直接调页面自己的 AV.pageHtml()
     * 往 #ach-body 里写一份真结构。这一条只验"数字长多大"，不验数据通路 ——
     * 本探针也不该验数据通路（那是 probe-states / journey 的活）。 */
    await evaluate(`(function(){
      var AV = window.LXW && window.LXW.achievementsView;
      if (!AV || !window.Ach) return 'no-module';
      var pr = { nickname: '玩家A', games: 12, wins: 7, losses: 4, draws: 1, totalNet: 20,
                 longestStreak: 3, longestLoseStreak: 2, bestNet: 12,
                 ach: { n: { tenhalf: 20, piaosanye: 12 }, t: { tenhalf: 9, piaosanye: 3 },
                        s1: 3, s2: 2, l1: 1, l2: 1, vs: 5, vsn: 9, smv: 4, r7: 1, r8: 1, r10: 2 } };
      document.getElementById('ach-body').innerHTML = AV.pageHtml(pr, window.Ach, { isMe: true });
      document.getElementById('ach-scroll').scrollTop = 0;
      return 'ok';
    })()`);
    const ach = await report('成就页');
    await shot('numbers-ach');
    {
      const off = ach.data.nums.filter((n) => NUM_TIERS.indexOf(n.size) < 0);
      ok(off.length === 0, '★ 成就页数值落在阶梯上',
        off.map((n) => n.sel + '=' + n.size).join(', ') || ('共 ' + ach.data.nums.length + ' 个'));
      const t1 = ach.data.nums.filter((n) => n.size === T1);
      ok(t1.length <= 1, '★ T1 至多 1 个（「已解锁 N」是本屏唯一结论）', '实测 ' + t1.length);
    }
  } finally {
    if (cdp) cdp.close();
    try { edge.kill(); } catch (e) {}
    server.close();
  }

  console.log('\n通过 ' + (fails.length ? '有失败' : '全部') + ' —— 失败 ' + fails.length + ' 项');
  if (fails.length) {
    fails.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => { console.error('探针失败：', e.message); process.exit(1); });
