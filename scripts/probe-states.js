#!/usr/bin/env node
/**
 * 战绩页「四态 + 错误三级」探针（build-states v1）真浏览器 / CDP
 *
 * 跑法：node scripts/probe-states.js [宽] [高]        例：node scripts/probe-states.js 390 844
 *       node scripts/probe-states.js 800 360          ← 横屏最小档（S17 的极值）
 *      ZOOM=1 额外截图（默认落在系统临时目录）
 *      ZOOM=1 SHOT_DIR=tmp-shots/states 把截图收到仓库里（验收要看图时用）
 *
 * 两档都要跑：390×844 是竖屏主档，800×360 是"横屏最小 + 有断行风险"的极值档。
 * S17（主控件不溢出、不被页脚盖住）在这两档上的结论不一样，只跑一档等于没验。
 *
 * ── 为什么必须真浏览器 ────────────────────────────────────────────────
 * 这一批断言里有一半只有浏览器里才有真相：
 *   · 「哪几个载体同时可见」—— `checkVisibility()` + `getBoundingClientRect()`；
 *   · 「加载态零按钮」—— 容器里真的有 0 个 button，而不是代码里"应该没有"；
 *   · 「重试真的重发，且只发一次」—— 数的是 **CDP 网络层**的 requestWillBeSent，
 *     不是被测代码里的计数器（数桩的调用次数正好是要防的假绿）；
 *   · 「离线时不发请求」—— 增量必须为 0，这只能在网络层看。
 *
 * ── 三条反例（qa-states-v1.md §3），这个探针刻意都避开了 ──────────────
 *   ① 不断言"文案对不对"当主判据：加载态的主判据是**载体**（#records-loading 可见、
 *      空态三件套不可见、容器内 0 个按钮），文案只是辅助。
 *   ② 不打桩 `navigator.onLine`：离线走 CDP `Network.emulateNetworkConditions`，
 *      Chromium 会同时把 navigator.onLine 置 false —— 两条路一起断，是真实条件。
 *      也不调内部函数（`Records.xxx()`）：全程只从玩家入口走（点进战绩页、点按钮）。
 *   ③ 不用 `textContent` 判可见：失败原因是在**遍历 DOM + checkVisibility 过滤**后
 *      拼出来的可见文本里找的。这个仓库有一个现成缺陷就是"写对了位置、藏错了层级"。
 *
 * ── 覆盖的判据 ──────────────────────────────────────────────────────
 *   S1  四态载体同时可见 ≤1；稳定后 =1（rAF 连续采样，含状态转移帧）
 *   S3  加载态不与空态共壳：空态 / 其插画 / 其 CTA 全不可见
 *   S4  加载态有机器可观测的进行中证据；结束后不留残余
 *   S5  失败态有可点重试控件，命中区 ≥44×44 CSS px
 *   S6  点重试：/me/records 网络层计数 +1 且只 +1；300ms 内界面进入"重试中"
 *   S7  失败原因出现在**可见**文本里
 *   S8  离线不寄生 toast：等 #toast 自己进 .hidden 之后 #records-offline 仍可见
 *   S9  离线时 data-rstate ≠ loading，且 /me/records、/api/leaderboard 增量 = 0
 *   S12 L2（不可恢复）可见文案不含禁用词，且只有一条出路
 *   S15 静默类：上报 ≥1、可见 toast = 0、页面文本逐字不变
 *   S17 四态 × 390×844 / 800×360：主控件在视口内、不被页脚盖住、无横向滚动
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { findBrowser } = require('./lib/browser');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
const PORT = 3071;
const CDP_PORT = 9371;
const ROOT = path.join(__dirname, '..', 'pwa');
const SHOTS = !!process.env.ZOOM;
/* 截图落点可指定：验收要看图时收到仓库里（tmp-shots/ 是 .gitignore 的），
 * 默认仍进临时目录 —— CI 不需要产物，只需要红绿。 */
const OUT = process.env.SHOT_DIR
  ? path.resolve(process.env.SHOT_DIR)
  : path.join(os.tmpdir(), 'lxw-states-probe');
const NONCE = 'st' + Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json', '.json': 'application/json'
};

/* ==================== 可编程的假服务端 ====================
 * 只实现这个探针需要的那几个端点。它必须**可控**：把 /me/records 挂住 900ms、
 * 或者回 500 / 401，都是"真实条件"的一部分 —— 我们要验的正是这些条件下页面长什么样。
 * 注意：这里能改状态是因为它和探针同进程，改的是内存里的对象，不是给页面开钩子。 */
const NOW = Date.now();
/* achCount 可指定：M3 要能验「拿到确定值时才写数字」，
 * 所以既需要"未知"的场景（不给值），也需要"确定值 = 3"的场景。 */
function profile(games, achCount) {
  return {
    games: games, wins: games, losses: 0, draws: 0, winRate: 100,
    totalNet: games * 5, bestNet: games ? 5 : 0, currentStreak: games,
    longestStreak: games, longestLoseStreak: 0,
    achCount: typeof achCount === 'number' ? achCount : 0,
    recent: games ? [{ roomId: 'R1', net: 5, endedAt: NOW - 60000, playerCount: 3, endReason: 'handLimit' }] : [],
    aiRecent: [], aiGames: 0
  };
}
const API = {
  records: { status: 200, delay: 0, body: profile(1) },   // status !== 200 时回错误
  rank: { status: 200 },
  alive: { ok: true }
};
const hits = { clientError: 0 };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/api/auth/me') {
    return sendJson(res, 200, { ok: true, me: { playerId: 'p1', nickname: '玩家A', account: { name: 'probe_states', createdAt: NOW } } });
  }
  if (url === '/api/me/records') {
    const cfg = API.records;
    const reply = () => {
      if (cfg.status !== 200) return sendJson(res, cfg.status, { ok: false, error: 'probe-fail-' + cfg.status });
      return sendJson(res, 200, { ok: true, profile: cfg.body, serverTime: Date.now() });
    };
    if (cfg.delay) setTimeout(reply, cfg.delay); else reply();
    return;
  }
  if (url === '/api/leaderboard') {
    if (API.rank.status !== 200) return sendJson(res, API.rank.status, { ok: false, error: 'probe-rank' });
    return sendJson(res, 200, { ok: true, list: [], me: null });
  }
  if (url === '/api/players/alive') return sendJson(res, 200, { ok: true, dead: [], checked: 0 });
  if (url === '/api/me/reset-stats') return sendJson(res, 200, { ok: true, profile: profile(0) });
  if (url === '/api/client-error') { hits.clientError += 1; return sendJson(res, 200, { ok: true }); }
  if (url === '/__probe-nonce') return sendJson(res, 200, { nonce: NONCE });

  let p = url === '/' ? '/index.html' : url;
  const abs = path.join(ROOT, p);
  if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(abs, (e, buf) => {
    if (e) { res.writeHead(404); res.end('404'); return; }
    /* 给 index.html 打一个 nonce：用于确认"这个文档确实由**本进程**服务"。
     * 没有它的话，一个残留的旧浏览器实例占着 CDP 端口时，后面每一条断言
     * 都会变成假失败 —— 而那种失败最难查。 */
    if (p === '/index.html') {
      const html = buf.toString('utf8').replace('<head>', '<head><script>window.__probeNonce=' + JSON.stringify(NONCE) + ';</script>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
  });
});

/* ── 最小 WebSocket 应答器 ──
 * 为什么必须有：没有 upgrade 处理时 socket 建不起来，RoomStore 会走
 * "断开 → 退避重连 → flash('网络波动，正在重连…')"的循环，
 * 于是整个探针里持续有 toast —— 而 S8 / S15 里"可见 toast = 0"这两条就全废了。
 * 只做两件事：应 pong（否则 60 秒后心跳判死）、对其它消息回一个 ok。
 * 不实现任何业务逻辑 —— 这个探针不验联机。 */
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
    if (mask) for (let k = 0; k < data.length; k++) data[k] ^= mask[k % 4];
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
  socket.on('error', () => { /* 探针结束时对端会直接掐断 */ });
  let acc = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    acc = Buffer.concat([acc, chunk]);
    const r = wsRead(acc);
    acc = r.rest;
    r.frames.forEach((f) => {
      if (f.op === 0x8) { socket.end(); return; }
      if (f.op !== 0x1) return;                       // 只处理文本帧（本项目协议全是 JSON）
      let msg = null;
      try { msg = JSON.parse(f.text); } catch (e) { msg = null; }
      if (!msg) return;
      if (msg.type === 'ping') { try { socket.write(wsFrame(JSON.stringify({ type: 'pong' }))); } catch (e) {} return; }
      /* 其余一律回一个"收到了"。不回的话客户端等不到回执；回错格式也别让它判死 ——
       * 这个探针不验联机，只要 socket 别断。 */
      try {
        socket.write(wsFrame(JSON.stringify({ type: 'ack', ok: true, id: msg.id || null, re: msg.type || null })));
      } catch (e) { /* 对端已断 */ }
    });
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

/* CDP 连接：除了请求/响应，还要收**事件**（Network.requestWillBeSent 是本探针的计数器） */
function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const waiting = new Map();
    const events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && waiting.has(msg.id)) {
        const w = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
        else w.resolve(msg.result);
      } else if (msg.method) {
        events.push(msg);
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
        events,
        /** 数网络层请求：url 片段 → 条数 */
        count(frag) {
          return events.filter((e) => e.method === 'Network.requestWillBeSent'
            && e.params && e.params.request && String(e.params.request.url).indexOf(frag) >= 0).length;
        },
        reset() { events.length = 0; },
        close() { try { ws.close(); } catch (e) {} }
      });
    });
  });
}

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

/* 页面侧的读取器。整段在浏览器里跑，返回一份快照 —— 所有断言都对着快照做，
 * 免得每次都去 evaluate 一堆零散表达式（那样失败信息会碎成一片）。 */
const READ = `(function(){
  function el(id){ return document.getElementById(id); }
  function vis(e){
    if (!e) return false;
    if (e.classList.contains('hidden')) return false;
    if (e.checkVisibility && !e.checkVisibility()) return false;
    var r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function visId(id){ return vis(el(id)); }
  function rect(e){
    if (!e) return null;
    var b = e.getBoundingClientRect();
    return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom),
             w: Math.round(b.width), h: Math.round(b.height) };
  }
  /* 可见文本：遍历 DOM + checkVisibility 过滤后拼接（S7 用它，不信 textContent） */
  function visibleText(){
    var out = '';
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = w.nextNode())) {
      var p = n.parentNode;
      if (!p) continue;
      if (!n.nodeValue || !n.nodeValue.trim()) continue;
      if (p.checkVisibility && !p.checkVisibility()) continue;
      out += n.nodeValue.trim() + ' ';
    }
    return out;
  }
  function buttonsIn(id){
    var box = el(id);
    if (!box) return [];
    return [].slice.call(box.querySelectorAll('button')).filter(vis);
  }
  function titleOf(id){
    var t = document.querySelector('#' + id + ' [data-rstate-title]');
    return t ? t.textContent.trim() : '';
  }
  function subOf(id){
    var s = document.querySelector('#' + id + ' [data-rstate-sub]');
    return s ? s.textContent.trim() : '';
  }
  var scr = el('screen-records');
  var MUTEX = ['records-loading', 'records-fail', 'records-empty', 'records-scroll'].filter(visId);
  var off = el('records-offline');
  var art = document.querySelector('#records-empty .rp-empty-art');
  var scrollEl = el('records-scroll');
  return {
    rstate: scr ? scr.getAttribute('data-rstate') : null,
    mutex: MUTEX, mutexCount: MUTEX.length,
    loadingVis: visId('records-loading'),
    failVis: visId('records-fail'),
    emptyVis: visId('records-empty'),
    dataVis: visId('records-scroll'),
    artVis: vis(art),
    ctaVis: visId('btn-records-create'),
    footVis: visId('records-foot'),
    offVis: visId('records-offline'),
    offStrip: !!off && off.classList.contains('is-strip'),
    offPanel: !!off && off.classList.contains('is-panel'),
    offAlign: off ? getComputedStyle(off).textAlign : '',
    bannerVis: visId('net-banner'),
    toastVis: visId('toast'),
    /* F2 的另一半要用：横幅在"别的屏"上仍然可见 */
    homeVis: visId('screen-home'),
    loadTitle: titleOf('records-loading'),
    loadSub: subOf('records-loading'),
    failTitle: titleOf('records-fail'),
    failSub: subOf('records-fail'),
    offTitle: titleOf('records-offline'),
    offSub: subOf('records-offline'),
    /* M1/M2：页脚那一行 —— 文本 + **可见性**都要（写对了位置、藏错了层级是这个
     * 仓库的一个现成缺陷，只断言 textContent 的写法对它永远是绿的）。 */
    srcText: (function(){ var e = el('records-source'); return e ? e.textContent.trim() : ''; })(),
    srcVis: visId('records-source'),
    srcRetryVis: visId('records-source-retry'),
    /* M3：成就入口那个数字（右上角），未知时必须是 —/N */
    achText: (function(){ var e = el('ach-entry-num'); return e ? e.textContent.trim() : ''; })(),
    /* M4：#records-data 与 #records-scroll 是同一个载体，但"内容真的在"要看它俩 */
    dataInnerVis: visId('records-data'),
    rankFailVis: visId('rank-fail'),
    rankEmptyVis: visId('rank-empty'),
    loadBtns: buttonsIn('records-loading').length,
    failBtns: [].slice.call(document.querySelectorAll('#records-fail button:not(.hidden)')).length,
    failBtnRects: [].slice.call(document.querySelectorAll('#records-fail button:not(.hidden)'))
      .map(function(b){ var r = rect(b); return { w: r ? r.w : 0, h: r ? r.h : 0, label: b.textContent.trim() }; }),
    offBtns: buttonsIn('records-offline').length,
    retryRect: rect(el('btn-records-retry')),
    loadRect: rect(el('records-loading')),
    loadingAriaBusy: (function(){
      var host = el('screen-records');
      return !!(host && host.getAttribute('aria-busy') === 'true');
    })(),
    scrollText: scrollEl ? scrollEl.innerText : '',
    visibleText: visibleText(),
    docScrollX: (function(){
      var se = document.scrollingElement || document.documentElement;
      return se ? Math.max(0, se.scrollWidth - se.clientWidth) : 0;
    })(),
    vw: window.innerWidth, vh: window.innerHeight,
    emptyRect: rect(el('records-empty')),
    screenRect: rect(el('screen-records')),
    emptyParent: (function(){ var e = el('records-empty'); return e && e.parentNode ? (e.parentNode.id || e.parentNode.className) : null; })(),
    offRect: rect(off),
    footRect: rect(el('records-foot')),
    titleRect: (function(){
      var id = ['records-loading','records-fail','records-empty','records-offline'];
      for (var i = 0; i < id.length; i++) {
        var t = document.querySelector('#' + id[i] + ' [data-rstate-title]');
        if (t && vis(t)) return rect(t);
      }
      return null;
    })()
  };
})()`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  }).catch((e) => {
    console.error('端口 ' + PORT + ' 起不来（' + e.code + '）：可能上一个探针实例还没退。换个端口或先关掉残留浏览器。');
    process.exit(1);
  });

  const exe = findBrowser();
  const userDir = path.join(os.tmpdir(), 'lxw-states-edge-' + Date.now());
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDir,
    '--window-size=' + W + ',' + H,
    '--force-device-scale-factor=1',
    'about:blank'
  ], { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const list = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      page = (list || []).find((t) => t.type === 'page');
      if (page) break;
    } catch (e) { /* 还没起来 */ }
  }
  if (!page) { console.error('连不上浏览器 CDP'); edge.kill(); process.exit(1); }

  const cdp = await cdpConnect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __error: String(r.exceptionDetails.text) };
    return r.result && r.result.value;
  };
  const shot = async (name) => {
    if (!SHOTS) return null;
    await settleScreens();
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, name);
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  };
  const viewport = async (w, h) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  };
  const read = async () => evaluate(READ);
  /* 成就目录长度：M3 的期望值里的分母。它来自 achievements.js 的静态目录，
   * 不是被测的那段"该不该写数字"的逻辑 —— 分母本来就该是确定值。 */
  const achTotal = async () => Number(await evaluate('(function(){ return (window.Ach && window.Ach.TOTAL) || 0; })()')) || 0;
  const waitFor = async (expr, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 4000)) {
      if (await evaluate(expr) === true) return true;
      await sleep(80);
    }
    return false;
  };

  /* 会话：ws 模式（有云端）+ 一个真的 playerId。不写本机战绩 ——
   * 第一段要的就是"本机也没数据"的那个失败态。 */
  const seed = async (withLocalRecords) => {
    const sess = JSON.stringify({ token: 'probe-token', playerId: 'p1', nickname: '玩家A', name: 'probe_states', joinedAt: NOW });
    const recs = JSON.stringify([
      { id: 'R1-1', roomId: 'R1', playerId: 'p1', endedAt: NOW - 60000, playerCount: 3,
        myStartScore: 20, myEndScore: 25, myNet: 5, endReason: 'handLimit', rounds: 2 },
      { id: 'R2-1', roomId: 'R2', playerId: 'p1', endedAt: NOW - 3600000, playerCount: 4,
        myStartScore: 20, myEndScore: 14, myNet: -6, endReason: 'dissolve', rounds: 3 }
    ]);
    await evaluate(`(function(){
      localStorage.setItem('lxw_session_v1', ${JSON.stringify(sess)});
      localStorage.setItem('lxw_guide_seen_v1', '1');
      localStorage.setItem('lxw_records_deduped_v2', '1');
      ${withLocalRecords ? `localStorage.setItem('lxw_records_v1', ${JSON.stringify(recs)});` : "localStorage.removeItem('lxw_records_v1');"}
      return 'ok';
    })()`);
  };

  const goto = async (w, h) => {
    await viewport(w, h);
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?mode=ws' });
    await sleep(1200);
    const nonce = await evaluate('window.__probeNonce || ""');
    if (nonce !== NONCE) {
      /* 文档不是本进程服务的：后面每一条都会变成假失败，早点停 */
      console.error('当前文档不是本进程创建的（nonce ' + nonce + '）。多半是残留浏览器，先关掉再跑。');
      try { edge.kill(); } catch (e) {}
      server.close();
      process.exit(1);
    }
  };

  const openRecords = async () => {
    await waitFor(`(function(){ var h = document.getElementById('screen-home'); return !!(h && !h.classList.contains('hidden')); })()`);
    await evaluate(`(function(){ var g = document.getElementById('guide-modal'); if (g) g.classList.add('hidden'); return 'ok'; })()`);
    await evaluate(`document.getElementById('btn-records-home').click()`);
  };

  /* 等换屏动画落地（.screen.enter 是一个 0.3s 的 slideInRight）。
   * 不等的话，量到的是"滑到一半的那一帧"—— 内容整体右移几十像素，
   * 于是布局断言和截图都会指向一个根本不存在的缺陷。
   * 第一版就是在这里假红的：空态标题被量到 l=223 / r=412（视口 390）。 */
  const settleScreens = async (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 2500)) {
      const busy = await evaluate(`(function(){
        var list = [].slice.call(document.querySelectorAll('.screen'));
        return list.some(function(s){
          return !s.classList.contains('hidden') && getComputedStyle(s).transform !== 'none';
        });
      })()`);
      if (!busy) { await sleep(120); return true; }
      await sleep(60);
    }
    return false;
  };

  /* ==================== 采样器：S1 ==================== */
  const startSampler = () => evaluate(`(function(){
    window.__s1 = { frames: 0, bad: 0, worst: 0, max: 0 };
    function vis(e){
      if (!e) return false;
      if (e.classList.contains('hidden')) return false;
      if (e.checkVisibility && !e.checkVisibility()) return false;
      var r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    function loop(){
      var ids = ['records-loading','records-fail','records-empty','records-scroll'];
      var n = 0;
      for (var i = 0; i < ids.length; i++) if (vis(document.getElementById(ids[i]))) n++;
      window.__s1.frames++;
      if (n > window.__s1.max) window.__s1.max = n;
      if (n > 1) window.__s1.bad++;
      if (window.__s1.frames < 600) requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
    return 'ok';
  })()`);

  console.log('视口 ' + W + '×' + H + '  截图目录 ' + OUT);

  /* ==================== 第一段：本机无数据 → 加载 / 失败 / 重试 / L2 ==================== */
  console.log('\n[1] 加载态：不与空态共壳（S3）、有进行中证据（S4）、250ms 门槛');
  await goto(W, H);
  await seed(false);
  API.records = { status: 500, delay: 1000, body: profile(1) };   // 挂住 1 秒再回 500
  await goto(W, H);
  await openRecords();
  await sleep(120);                        // 门槛期内
  let st = await read();
  ok(st.rstate === 'loading', '★ 门槛期内 data-rstate 已经是 loading（真源先说实话）', String(st.rstate));
  ok(st.mutexCount === 0, '★★ 0–250ms 内一个载体都不显示（R2：这是合法的"零可见"）', JSON.stringify(st.mutex));

  await sleep(420);                        // 累计约 540ms：门槛已过，请求还没回
  st = await read();
  ok(st.loadingVis === true, '★★★ 加载态有自己的载体 #records-loading（不是空态换一句话）');
  ok(st.emptyVis === false, '★★★ #records-empty 不可见');
  ok(st.artVis === false, '★★★ 空态插画不可见（那张卡片里写着一个 0，用 0 冒充"未知"是事实性错误）');
  ok(st.ctaVis === false, '★★★ 空态的「创建房间」CTA 不可见（等待期间它是可点的，既是误导也是竞态）');
  ok(st.loadBtns === 0, '★★★★ 加载态容器内 button 数 = 0（零按钮是它和空态的分界）');
  ok(st.mutexCount === 1, '★ 稳定后互斥组恰有 1 个可见（S1）', String(st.mutexCount));
  ok(/正在读取战绩/.test(st.loadTitle), '★ 加载标题是「正在读取战绩…」', st.loadTitle);
  ok(!!st.loadRect && st.loadRect.h > 0 && st.loadTitle.length > 0, '★★ S4：加载块有尺寸且文本非空', JSON.stringify(st.loadRect));
  ok(/(^|\D)0(\D|$)/.test(st.loadTitle + st.loadSub) === false, '★ 加载态自己的文案里没有数字 0（不用"0"冒充未知）');
  /* ★ M3：右上角成就数字也一样。加载中我们**没问过账号**，写 0/35 是在说
   * "你一个成就都没有" —— 那是结论，而我们没有结论。分母可以写（确定值）。 */
  ok(/^—\/\d+$/.test(st.achText), '★★★★ M3：加载中成就数写「—/N」而不是 0/N（未知不许冒充零）', st.achText);
  const p1 = await shot('states-loading.png');
  if (p1) console.log('    图：' + p1);

  await sleep(700);                        // 累计约 1.2s：越过 1s 慢文案线
  st = await read();
  ok(/比平时慢一点/.test(st.loadSub), '★★ 超过 1 秒换成「比平时慢一点，再等等」（不加进度条）', st.loadSub);
  ok(st.loadBtns === 0, '★ 慢文案期间仍然零按钮');

  console.log('\n[2] 失败态：两个按钮、命中区够大、原因必须可见（S5 / S6 / S7）');
  await sleep(500);                        // 让那次 1s 的请求落地（回 500）
  await waitFor(`(function(){ return document.getElementById('screen-records').getAttribute('data-rstate') === 'fail'; })()`, 4000);
  st = await read();
  ok(st.rstate === 'fail', '★★ 请求有结论后落失败态（不会一直转圈）', String(st.rstate));
  ok(st.failVis === true, '★ #records-fail 可见');
  ok(st.loadingVis === false, '★★ 加载结束后不残留（"转圈永远收不掉"是同类缺陷里最难发现的一种）');
  ok(st.failBtnRects.length === 2, '★★★ 失败态两个按钮（可重试类）', JSON.stringify(st.failBtnRects));
  const big = st.failBtnRects.filter((r) => r.w >= 44 && r.h >= 44);
  ok(big.length >= 1, '★★★ S5：重试控件命中区 ≥44×44 CSS px（' + JSON.stringify(st.failBtnRects.map((r) => r.w + '×' + r.h)) + '）');
  ok(/读不到|没读上来|失败|未同步/.test(st.visibleText), '★★★ S7：失败原因出现在**可见**文本里（遍历 DOM + checkVisibility 过滤后拼接）');
  ok(st.failSub.length > 0, '★ 失败副文案非空', st.failSub);
  ok(!/操作失败|请稍后重试|网络异常|请求失败|系统繁忙/.test(st.visibleText), '★★ 全屏可见文本里没有禁用词');
  ok(st.mutexCount === 1, '★ 失败态时互斥组仍恰有 1 个可见');
  ok(/^—\/\d+$/.test(st.achText), '★★★★ M3：失败时成就数仍是「—/N」（读不到 ≠ 0 个）', st.achText);
  const p2 = await shot('states-fail.png');
  if (p2) console.log('    图：' + p2);

  console.log('\n[3] 点重试：网络层 +1 且只 +1（S6）');
  {
    const n0 = cdp.count('/api/me/records');
    const r0 = cdp.count('/api/leaderboard');
    /* 给这一单 400ms 的窗口：否则回包太快，"重试中"那一帧根本抓不到，
     * 而 S6 要的正是"300ms 内界面进入重试中"。 */
    API.records = { status: 200, delay: 400, body: profile(2, 3) };    // 这次让它成功（achCount=3 是**确定值**）
    await evaluate(`document.getElementById('btn-records-retry').click()`);
    await sleep(200);                       // 300ms 内必须进入"重试中"
    const mid = await read();
    ok(mid.rstate === 'loading' || mid.loadingVis === true, '★★ 300ms 内界面进入「重试中」', String(mid.rstate));
    await sleep(1400);
    const n1 = cdp.count('/api/me/records');
    const r1 = cdp.count('/api/leaderboard');
    ok(n1 === n0 + 1, '★★★ S6：点一次重试，/me/records 网络层 +1 且只 +1（' + n0 + ' → ' + n1 + '）');
    ok(r1 === r0, '★★ 重试没有顺手刷新别的接口（/api/leaderboard 增量 = 0）', r0 + ' → ' + r1);
    st = await read();
    ok(st.rstate === 'data' && st.dataVis === true, '★★ 重试之后数据真的回来了（不是原地不动）', String(st.rstate));
    /* ★ M3 的正向一半：拿到确定值时才写数字，而且 0 也是合法值。
     * 只断言"未知写 —"会让实现退化成"永远写 —"，这条把另一头钉住。 */
    const total = await achTotal();
    ok(total > 0 && st.achText === '3/' + total,
      '★★★★ M3：拿到确定值 3 时写「3/N」（N 是成就目录长度）', st.achText + '  want 3/' + total);
  }

  console.log('\n[4] 不可恢复类（L2）：只给一条出路，且不出现「再试一次」（S12 / S13）');
  {
    /* 401 = 身份失效。这是 L2 里最真实的一条入口，而且它**不可能**靠重试变好。
     * ★ 必须重开页面：上一段成功过一次，云端缓存（TTL 20s）还在，
     *   不重载的话 openRecords 会直接用缓存，401 根本发不出去 —— 这是探针自己
     *   的时序问题，不是产品缺陷（第一次跑就撞上了，记在这里）。 */
    API.records = { status: 401, delay: 0, body: profile(0) };
    await goto(W, H);
    await openRecords();
    await waitFor(`(function(){ return document.getElementById('screen-records').getAttribute('data-rstate') === 'fail'; })()`, 4000);
    st = await read();
    ok(st.failVis === true, '★ 401 落到失败态');
    ok(/登录/.test(st.failTitle), '★★ 文案说清是"登录"这一类问题（不是"网络不好"）', st.failTitle);
    const btns = st.failBtnRects.map((r) => r.label);
    ok(btns.length === 1, '★★★ L2 只有一条出路（实际 ' + JSON.stringify(btns) + ' 个）');
    ok(btns.every((b) => /重新登录|返回登录|去登录/.test(b)), '★★ 那条出路落在白名单内（' + JSON.stringify(btns) + '）');
    ok(!/再试一次|再试|重试|稍后再试|稍后重试/.test(st.visibleText),
      '★★★★ S12：L2 屏的可见文案不含禁用词（含"请重新登录"这种不误伤的情形）');
    ok(!/再试一次/.test(st.visibleText), '★★★ 一个字都不出现「再试一次」');
    const p3 = await shot('states-l2.png');
    if (p3) console.log('    图：' + p3);
  }

  /* ==================== 第二段：本机有数据 → 降级 + 静默 + 离线 ==================== */
  console.log('\n[5] 静默类：上报 ≥1、toast = 0、页面文本逐字不变（S15）');
  {
    await seed(true);                       // 这一轮给本机 2 条记录
    API.records = { status: 500, delay: 0, body: profile(1) };
    hits.clientError = 0;
    await goto(W, H);
    await openRecords();
    await waitFor(`(function(){ return document.getElementById('screen-records').getAttribute('data-rstate') === 'data'; })()`, 4000);
    await sleep(600);                       // 等失败回包落地并完成降级渲染
    const before = (await read()).scrollText;
    /* 再触发一次云端失败（点页脚那个降级出口 → 再失败一次），这是玩家真会做的动作 */
    const hasRetry = await evaluate(`(function(){ var b = document.getElementById('records-source-retry'); return !!(b && !b.classList.contains('hidden')); })()`);
    ok(hasRetry === true, '★★ 失败降级时不占满屏：页脚那一行右侧出现出口（内容照常显示）');
    await evaluate(`(function(){ var b = document.getElementById('records-source-retry'); if (b) b.click(); return 'ok'; })()`);
    await sleep(900);
    st = await read();
    ok(st.rstate === 'data', '★★★ 降级时 data-rstate 仍是 data（"失败"的载体没出现就不自称 fail）', String(st.rstate));
    ok(st.scrollText === before, '★★★★ S15：页面内容逐字不变（静默的唯一可执行定义）');
    ok(hits.clientError >= 1, '★★★★ S15：上报 ≥1（服务端确实收到 POST /api/client-error：' + hits.clientError + ' 条）');
    ok(st.toastVis === false, '★★★★ S15：可见 toast = 0（"顺手 flash 一句"就是这个变异要抓的东西）');
  }

  console.log('\n[6] 离线态：不寄生 toast（S8）、不发请求（S9）、不许邀请注定失败的动作（M1/M2）、内容必须留下（M4）');
  {
    /* ★ M1/M2 的**前提**先量一次：上一段刻意制造了云端 500 且本机有数据，
     * 此刻页脚右侧那个降级出口是可见的、说的是「账号数据暂时读不到」。
     * 没有这两条前提，后面"离线时不可见 / 换了一句话"会因为"本来就不可见"
     * 或"本来就长这样"而假绿 —— 那种绿的断言等于没写。 */
    st = await read();
    ok(st.srcRetryVis === true, '★ 前提：降级时页脚出口此刻可见（M1 的断言不许空过）');
    ok(/读不到/.test(st.srcText), '★ 前提：此刻页脚说的是「账号数据暂时读不到」（M1/M2 的对照）', st.srcText);

    cdp.reset();
    const n0 = { records: cdp.count('/api/me/records'), rank: cdp.count('/api/leaderboard') };
    await cdp.send('Network.emulateNetworkConditions', {
      offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1
    });
    await waitFor(`(function(){ return document.getElementById('screen-records').getAttribute('data-rstate') === 'offline'; })()`, 4000);
    st = await read();
    ok(st.rstate === 'offline', '★★ 断网后落离线态', String(st.rstate));
    ok(st.rstate !== 'loading', '★★★ S9：离线时 data-rstate ≠ loading（加载依赖网络，断网时说"加载中"是骗人）');
    ok(st.offVis === true, '★★ #records-offline 可见（有自己的载体，不寄生在任何临时提示上）');
    ok(st.offStrip === true && st.offPanel === false, '★★ S8：有内容时是 is-strip 横条');
    ok(st.dataVis === true, '★★★ 内容照常显示（这是全局唯一的双显豁免：不能因为没网就没收玩家能看的战绩）');
    ok(st.offAlign === 'left', '★★★ 离线块左对齐（结构差异，不是口味；改成居中就退化成第二个空态）', st.offAlign);
    ok(st.offBtns === 1, '★ 离线态只有 1 个按钮（重新载入）');
    ok(/现在没有网络/.test(st.offTitle), '★ 离线标题是「现在没有网络」', st.offTitle);
    /* ★★★ F1：strip 形态保持原句（本机确实有记录，"先给你看这台设备上的"是真的）。
     * 与 [8] 那条成对：只改 panel 那一档，不许把两档写成同一句，也不许反过来。 */
    ok(st.offSub === '先把这台设备上的记录给你看',
      '★★★ F1：strip 形态的副文案保持原句', st.offSub);

    /* ★★★★ M4（正向）：离线 + 本机有内容 → **内容必须可见**。
     * 这是本设计最怕退化的地方：把离线做成满屏态，等于用"你没有网"惩罚玩家。
     * 断言写成"两块都在 + 横条只有 strip 形态 + 其余三态一个都不露"，
     * 而不是只断言 offStrip —— 后者在"内容被藏起来"时仍然可能是绿的。 */
    ok(st.dataVis === true && st.dataInnerVis === true,
      '★★★★ M4：离线 + 本机有数据 → #records-scroll 与 #records-data 都必须可见');
    ok(st.offStrip === true && st.offPanel === false
      && st.emptyVis === false && st.failVis === false && st.loadingVis === false,
      '★★★★ M4：横条是 .is-strip 且不叠 .is-panel，空/失败/加载三个载体一个都不露',
      JSON.stringify({ strip: st.offStrip, panel: st.offPanel, empty: st.emptyVis, fail: st.failVis, loading: st.loadingVis }));

    /* ★★★★ M1：离线时页脚不邀请一个注定失败的动作。
     * `loadCloudRecords()` 第一行就 `if (isOfflineNow()) return;` —— 那个「再读一次」
     * 点下去什么都不会发生。QA S9 的原话：不该发注定失败的请求，也不该邀请玩家点它。 */
    ok(st.srcRetryVis === false, '★★★★ M1：离线时页脚不再挂「再读一次」（注定失败的动作不许邀请）');
    /* ★★★★ M2：离线时页脚换口径 ——「读不到」在离线语境下是结果误报（根本没发），
     * 而且不能与横条那句同义重复。 */
    ok(st.srcVis === true && st.srcText === '只在这台设备上，换设备会丢',
      '★★★★ M2：离线时页脚走「只在这台设备上」那一支', st.srcText);
    ok(st.srcText !== st.offSub,
      '★★★ M2：页脚不与横条同义（同一屏同一句话说两遍，玩家会以为漏了什么）',
      st.srcText + '  vs  ' + st.offSub);
    ok(/^—\/\d+$/.test(st.achText), '★★★★ M3：离线时成就数写「—/N」而不是 0/N（没网 = 不知道，不是 0 个）', st.achText);

    /* S8 的关键时序：等 toast 自己消失（它是 1.8/2.6 秒后自隐的），之后离线块必须仍在 */
    await waitFor(`(function(){ var t = document.getElementById('toast'); return !t || t.classList.contains('hidden'); })()`, 6000);
    st = await read();
    ok(st.toastVis === false, '★ toast 已经自己消失了（S8 的前提）');
    ok(st.offVis === true, '★★★★ S8：toast 消失之后离线态**仍在**（离线不寄生在一个 1.8 秒后就没有的东西上）');
    /* ★★★★ F2：战绩页上横幅**让位**。这一屏自己已经用横条说了同一件事，
     * 而横幅是 fixed 的全站层，压过来正好盖住 .rp-nav 的「我的战绩」
     * （截图里字从横幅两侧露出来）。让位 ≠ 删掉 —— 由下面那对断言钉住。 */
    ok(st.bannerVis === false,
      '★★★★ F2：战绩页可见时 #net-banner 必须带 .hidden（不许压住页标题）');

    const n1 = { records: cdp.count('/api/me/records'), rank: cdp.count('/api/leaderboard') };
    ok(n1.records === n0.records, '★★★★ S9：离线期间 /me/records 请求增量 = 0（' + n0.records + ' → ' + n1.records + '）');
    ok(n1.rank === n0.rank, '★★★ S9：离线期间 /api/leaderboard 请求增量 = 0');
    const p4 = await shot('states-offline-strip.png');
    if (p4) console.log('    图：' + p4);

    /* ★ F2 的另一半：让位只发生在这一屏。换到首页（仍然离线）横幅必须回来，
     * 再进战绩页必须又藏起来 —— 两条一起才说明"切屏会重算"，
     * 只断言前者会把"删掉横幅"当成合格实现。 */
    await evaluate(`document.getElementById('btn-records-back').click()`);
    await waitFor(`(function(){ var h = document.getElementById('screen-home'); return !!(h && !h.classList.contains('hidden')); })()`, 3000);
    st = await read();
    ok(st.homeVis === true && st.bannerVis === true,
      '★★★★ F2 反向：换到首页（仍离线）横幅仍然可见（让位 ≠ 彻底不显示）',
      JSON.stringify({ home: st.homeVis, banner: st.bannerVis }));
    await openRecords();
    await sleep(400);
    st = await read();
    ok(st.rstate === 'offline' && st.bannerVis === false,
      '★★★★ F2：再进战绩页横幅又让位（切屏会重算，不是一次性的）', String(st.rstate));

    /* 恢复：500ms 内收条 */
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await sleep(500);
    st = await read();
    ok(st.offVis === false, '★★★ 恢复网络后 500ms 内离线块自己收掉');
    ok(st.bannerVis === false, '★★ 横幅在战绩页上始终不带（在线时也不该冒出来）');
    ok(st.rstate !== 'offline', '★★ data-rstate 不再是 offline（' + st.rstate + '）');
    /* 恢复后页脚要退回"降级"那一句（诚实：这次真的是读不到，且出口又该有了）。
     * 再进这一屏时 openRecords 清过错误、online 事件又重取了一次（API 仍是 500），
     * 所以这里等的是那次失败落地。 */
    await waitFor(`(function(){ var b = document.getElementById('records-source-retry'); return !!(b && !b.classList.contains('hidden')); })()`, 4000);
    st = await read();
    ok(st.srcRetryVis === true && /读不到/.test(st.srcText),
      '★★ M1 反向：网络回来、云端仍失败 → 出口回到页脚（离线这一支不该赖着不走）', st.srcText);
  }

  console.log('\n[7] S1 采样：状态转移过程中两态同屏的帧数 = 0');
  {
    await startSampler();
    /* 制造几次状态转移：失败 → 加载 → 数据 */
    API.records = { status: 500, delay: 120, body: profile(1) };
    await evaluate(`(function(){ var b = document.getElementById('records-source-retry'); if (b) b.click(); return 'ok'; })()`);
    await sleep(700);
    API.records = { status: 200, delay: 120, body: profile(3) };
    await evaluate(`(function(){ var b = document.getElementById('records-source-retry'); if (b) b.click(); return 'ok'; })()`);
    await sleep(900);
    const s1 = await evaluate('window.__s1 || null');
    ok(!!s1 && s1.frames >= 30, '★ 采样器真的跑了（' + (s1 ? s1.frames : 0) + ' 帧）');
    ok(!!s1 && s1.bad === 0, '★★★★ S1：互斥组同时可见 >1 的帧数 = 0（含状态转移帧，最多看到 ' + (s1 ? s1.max : '?') + ' 个）');
  }

  console.log('\n[8] 离线 · 无内容（is-panel）：本机 0 局 + 登录中 + 没有网 ≠ 你账号 0 局（M4 反向）');
  {
    /* 这一段验的是"不许把未知说成零"的另一半：
     * 本机没有记录、账号状态**没问过**（离线发不出去），此时不能露出空态 ——
     * 那张 0 分插画读起来是"你这号一场没打"。真相是"没问过"。
     * 所以形态必须是 is-panel 独占，#records-empty 不许出现。 */
    await seed(false);                                   // 本机 0 局
    API.records = { status: 200, delay: 0, body: profile(0) };
    await goto(W, H);                                    // 先在线把页面起起来（离线起不来文档）
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await openRecords();
    await waitFor(`(function(){ return document.getElementById('screen-records').getAttribute('data-rstate') === 'offline'; })()`, 4000);
    await sleep(400);                                    // 越过 250ms 门槛
    st = await read();
    ok(st.rstate === 'offline' && st.offVis === true, '★ 落离线态', String(st.rstate));
    ok(st.offPanel === true && st.offStrip === false, '★★★★ M4 反向：本机 0 局 + 登录中 + 离线 → 必须是 is-panel 独占', JSON.stringify({ strip: st.offStrip, panel: st.offPanel }));
    ok(st.emptyVis === false, '★★★★ M4 反向：#records-empty 不可见（"本机没有"推不出"你账号没有"，0 分插画会读成"你这号没打过"）');
    ok(st.dataVis === false && st.failVis === false && st.loadingVis === false,
      '★★ 反向场景里其余载体也都不露（互斥组 0 个可见，只有离线块）', JSON.stringify(st.mutex));
    ok(/^—\/\d+$/.test(st.achText), '★★★ M3：这一屏的成就数同样是「—/N」（离线问不到账号）', st.achText);
    /* ★★★★ F1：panel 形态必须有**自己的**副文案。
     * 本机 0 局时还说「先把这台设备上的记录给你看」，而底下什么都没有 ——
     * 那不是措辞不好，是假话（制作人裁定 R8）。 */
    ok(st.offSub === '连上网就能看到账号里的记录',
      '★★★★ F1：panel 形态用自己的副文案', st.offSub);
    ok(st.offSub !== '先把这台设备上的记录给你看',
      '★★★ F1：panel 没有沿用 strip 那句（沿用 = 没修）', st.offSub);
    const p7 = await shot('states-offline-panel.png');
    if (p7) console.log('    图：' + p7);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await sleep(400);
  }

  /* ==================== 第三段：空态 ==================== */
  console.log('\n[9] 空态：插画 + 一个 CTA（S1 的另一端）');
  {
    await seed(false);
    API.records = { status: 200, delay: 0, body: profile(0) };    // 账号也是 0 局
    await goto(W, H);
    await openRecords();
    await waitFor(`(function(){ return document.getElementById('screen-records').getAttribute('data-rstate') === 'empty'; })()`, 4000);
    st = await read();
    ok(st.rstate === 'empty', '★★ 空态（一场没打）', String(st.rstate));
    ok(st.emptyVis === true && st.artVis === true, '★ 空态有插画（四态里唯一有插画的）');
    ok(st.ctaVis === true, '★ 空态有一个 CTA');
    ok(st.mutexCount === 1, '★ 互斥组恰有 1 个可见');
    const p5 = await shot('states-empty.png');
    if (p5) console.log('    图：' + p5);
  }

  /* ==================== 第四段：极值视口（S17） ==================== */
  console.log('\n[10] 极值视口：主控件在视口内、不被页脚盖住、无横向滚动（S17）');
  const layoutCheck = async (label) => {
    /* 先等换屏动画落地，再量 —— 否则量到的是"滑到一半"的那一帧 */
    await settleScreens();
    st = await read();
    const bad = [];
    if (!st) return bad;
    if (st.docScrollX > 0) bad.push('横向滚动 ' + st.docScrollX + 'px');
    const t = st.titleRect;
    /* 一态可见却量不到标题 = 断言自身失效（空过），必须算红 */
    if (!t && (st.loadingVis || st.failVis || st.emptyVis || st.offVis)) bad.push('可见态里找不到标题元素（断言自己空过了）');
    if (t) {
      if (t.l < -1 || t.r > st.vw + 1 || t.t < -1 || t.b > st.vh + 1) bad.push('标题出视口 ' + JSON.stringify(t));
      if (st.footVis && st.footRect && t.b > st.footRect.t) bad.push('标题被页脚盖住');
    }
    if (st.offVis && st.offRect) {
      if (st.offRect.l < -1 || st.offRect.r > st.vw + 1) bad.push('离线块横向溢出 ' + JSON.stringify(st.offRect));
    }
    /* 只在失败态真的可见时量按钮：块隐藏时按钮的尺寸恒为 0，
     * 不加这个前提会让"每条都红"—— 那是断言写错，不是布局坏了。 */
    if (st.failVis && st.failBtnRects.length) {
      const br = st.failBtnRects[0];
      if (br.w <= 0 || br.h <= 0) bad.push('失败态按钮没有尺寸');
      if (st.docScrollX > 0) bad.push('失败态出现横向滚动');
    }
    ok(bad.length === 0, label + '：' + st.vw + '×' + st.vh + ' 布局无溢出/遮挡', bad.join(' | ')
      + '  [debug empty=' + JSON.stringify(st.emptyRect) + ' parent=' + st.emptyParent + ']');
    return bad;
  };
  {
    /* 当前就是 390×844 的空态 */
    st = await read();
    await layoutCheck('空态');
    /* 失败态（本机无数据 + 500） */
    API.records = { status: 500, delay: 0, body: profile(1) };
    await evaluate(`(function(){ document.getElementById('btn-records-back').click(); return 'ok'; })()`);
    await sleep(300);
    await openRecords();
    await waitFor(`(function(){ return document.getElementById('screen-records').getAttribute('data-rstate') === 'fail'; })()`, 4000);
    st = await read();
    await layoutCheck('失败态');
    /* 加载态（挂 900ms） */
    API.records = { status: 200, delay: 900, body: profile(1) };
    await evaluate(`document.getElementById('btn-records-retry').click()`);
    await sleep(600);
    st = await read();
    await layoutCheck('加载态');
    await sleep(600);
    /* 离线态（有内容 → strip） */
    await seed(true);
    API.records = { status: 200, delay: 0, body: profile(2) };
    await goto(W, H);
    await openRecords();
    await sleep(600);
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await sleep(600);
    st = await read();
    await layoutCheck('离线态');
    const p6 = await shot('states-layout-' + W + 'x' + H + '.png');
    if (p6) console.log('    图：' + p6);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  }

  cdp.close();
  edge.kill();
  server.close();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await sleep(100);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
