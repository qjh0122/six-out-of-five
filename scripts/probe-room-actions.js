/**
 * 房间页底排按钮的**文字断行**探针（一次性诊断脚本，不进测试套件）
 *
 * 为什么需要它：BACKLOG N1 —— 390 宽下「补 AI 队友」被拆成「补 AI 队」+「友」。
 * 这件事在单测里看不出来，因为它不是 DOM 结构问题，而是**字体排版**问题：
 * div 里有多少字、容器分到多少宽、浏览器决定在哪里断行，全都要渲染完才知道。
 *
 * 判据用 Range.clientRects 的**矩形个数**，不是高度：
 * 高度会被 line-height / padding 干扰，而一个文本节点被拆成几行，
 * 浏览器就会给出几个矩形 —— 这是最接近「我看到它断成两行」的机器判据。
 *
 * 用法：node scripts/probe-room-actions.js [输出目录]
 *   一次跑完 320 / 360 / 390 / 430 四档，横屏额外跑 844×390。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const OUT = process.argv[2] || path.join(os.tmpdir(), 'lxw-room-actions-' + Date.now());
const STATIC_PORT = 3037;
const CDP_PORT = 9347;
const ROOT = path.join(__dirname, '..', 'pwa');

/* 竖屏四档常用宽度 + 一档横屏。
 * 320 是 iPhone SE 一代的下限，430 是 iPhone Pro Max ——
 * 中间两档覆盖绝大多数安卓机。 */
const CASES = [
  [320, 640], [360, 740], [390, 844], [430, 932], [844, 390]
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.webmanifest': 'manifest+json', '.json': 'application/json'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const abs = path.join(ROOT, p);
  if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(abs, (e, buf) => {
    if (e) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
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

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

/* 在页面里执行：把房间页显示出来，补齐三个按钮，然后量每一颗的文字行数 */
const MEASURE = `(function(){
  /* v82 起准备态画在牌桌上，.room-actions 会被**搬**进 #screen-game 的 #ready-acts。
   * 所以不能写死 \`#screen-room .room-actions\`：那样开关一开就 measure 失败，
   * 而失败信息是「找不到元素」，很容易被读成「按钮被删了」。
   * 改成先找按钮、再显示它所在的那一屏 —— 量的是同一件事（三颗按钮会不会断字）。 */
  var row = document.querySelector('.room-actions .ghost-row');
  if (!row) return { error: '找不到 .room-actions .ghost-row' };
  var host = row.closest('.screen') || document.getElementById('screen-room');
  var screens = document.querySelectorAll('.screen');
  for (var i = 0; i < screens.length; i++) screens[i].classList.add('hidden');
  host.classList.remove('hidden');
  if (host.id === 'screen-game') host.classList.add('is-ready');
  var bot = document.getElementById('btn-add-bot');
  if (bot) bot.classList.remove('hidden');   // 正常对局里可能隐藏，这里强制出现

  var btns = row.querySelectorAll('.btn');

  /* 文本节点的矩形个数 = 行数。用 Range 而不是 offsetHeight，
     是因为高度会被 line-height 和 padding 影响，而矩形个数只反映断行。 */
  function lines(el) {
    var t = el.firstChild;
    if (!t || t.nodeType !== 3) return -1;
    var r = document.createRange();
    r.selectNodeContents(t);
    var rects = r.getClientRects();
    var seen = {}, n = 0;
    for (var k = 0; k < rects.length; k++) {
      var key = Math.round(rects[k].top);
      if (seen[key] === undefined) { seen[key] = 1; n++; }
    }
    return n;
  }
  function box(el) {
    var b = el.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top),
             left: Math.round(b.left), right: Math.round(b.right) };
  }

  var items = [];
  var tops = {};
  for (var j = 0; j < btns.length; j++) {
    var b = btns[j];
    var bb = box(b);
    /* 隐藏的按钮（比如「回结算页」只在特定分支出现）量出来是 0×0。
     * 把它算进去会让「占几行」多出一行，也会让「每颗都是单行」假失败
     * —— 0 宽的东西测出来的 0 什么都不能证明。 */
    if (!bb.w && !bb.h) continue;
    tops[bb.top] = 1;
    items.push({
      text: b.textContent.trim(),
      lines: lines(b),
      w: bb.w, h: bb.h, left: bb.left, right: bb.right,
      fontPx: parseFloat(getComputedStyle(b).fontSize),
      clipped: b.scrollWidth > b.clientWidth + 1
    });
  }
  var rb = box(row);
  return {
    items: items,
    rowsUsed: Object.keys(tops).length,     // 这一排实际占了几行（竖排时 = 几列）
    landscape: document.getElementById('stage').classList.contains('ls'),
    row: rb,
    vw: window.innerWidth,
    stageW: Math.round(document.getElementById('stage').getBoundingClientRect().width)
  };
})()`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise((r) => server.listen(STATIC_PORT, '127.0.0.1', r));

  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const userDir = path.join(os.tmpdir(), 'lxw-roomact-' + Date.now());
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDir,
    '--window-size=390,844',
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
  if (!page) { console.error('连不上 Edge CDP'); edge.kill(); process.exit(1); }

  const cdp = await cdpConnect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) return { error: String(r.exceptionDetails.text) };
    return r.result && r.result.value;
  };

  for (const [W, H] of CASES) {
    console.log('\n[' + W + '×' + H + ']');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: 2, mobile: true
    });
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + STATIC_PORT + '/' });
    await sleep(2200);

    const m = await evaluate(MEASURE);
    if (!m || m.error) { ok(false, '量到了', m && m.error); continue; }

    m.items.forEach(function (it) {
      console.log('    「' + it.text + '」 ' + it.w + '×' + it.h
        + '  行数=' + it.lines + '  字号=' + it.fontPx.toFixed(1) + 'px  裁切=' + it.clipped);
    });
    console.log('    这一排占 ' + m.rowsUsed + ' 行，容器 ' + m.row.w + '×' + m.row.h
      + '，视口 ' + m.vw);

    const allOneLine = m.items.every((it) => it.lines === 1);
    ok(allOneLine, '每个按钮的文字都是单行（不许从词中间断开）',
      m.items.filter((it) => it.lines !== 1).map((it) => it.text + '=' + it.lines + '行').join(', '));
    ok(m.items.every((it) => !it.clipped), '文字没有被横向裁切');
    ok(m.row.right <= m.vw + 1 && m.row.left >= -1, '按钮排没有超出视口',
      'row ' + m.row.left + '→' + m.row.right + ' / vw ' + m.vw);
    /* 横屏是竖排（column），「占几行」等于按钮个数，不能用竖屏的「≤2 排」去卡。 */
    if (m.landscape) {
      ok(m.rowsUsed === m.items.length, '横屏竖排：一颗按钮一行，没有额外换行',
        m.rowsUsed + ' 行 / ' + m.items.length + ' 颗');
    } else {
      ok(m.rowsUsed <= 2, '竖屏最多两排（三排说明挤得过分）', m.rowsUsed + ' 排');
    }

    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, 'room-actions-' + W + 'x' + H + '.png');
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    console.log('    图：' + p);
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  try { cdp.close(); } catch (e) {}
  edge.kill();
  server.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
