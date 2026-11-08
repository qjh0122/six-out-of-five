#!/usr/bin/env node
/**
 * 「5 秒内可以反悔」探针（v136）真浏览器 / CDP
 * 跑法：node scripts/probe-undo.js [宽] [高]      例：node scripts/probe-undo.js 390 844
 *      ZOOM=1 额外截图
 *
 * 为什么必须真浏览器：撤销条的整条逻辑都挂在**时间**和**DOM 存在性**上。
 *   · 单测能证明"到点会调 onCommit"，证明不了"5 秒之内数据真的还在"；
 *   · 单测能证明"hidden 会 flush"，证明不了 visibilitychange 真的挂上了；
 *   · 单测能证明"按钮绑了点击"，证明不了那个按钮**点得到**（pointer-events）。
 *
 * 这个探针只验玩家能感知的四件事：
 *   1) 确认清除之后，条子弹出来，且**此时记录还在**（这才是"可以反悔"的含义）
 *   2) 点「撤销」，记录、本机存储都还原到没清过的样子
 *   3) 不点，5 秒后真的清掉，且条子自己消失
 *   4) 条子不挡住「返回」这类关键按钮
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { findBrowser } = require('./lib/browser');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
const PORT = 3055;
const CDP_PORT = 9363;
const ROOT = path.join(__dirname, '..', 'pwa');
const SHOTS = !!process.env.ZOOM;
const OUT = path.join(os.tmpdir(), 'lxw-undo-probe');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json', '.json': 'application/json'
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

/* 两份最小的战绩。清除只关心"有没有数据、有几场"，
 * 所以不造回放 —— 造了也用不上，反而让种子变脆。 */
function seedRecords() {
  const now = Date.now();
  return [
    { id: 'R0-1', roomId: 'R0', endedAt: now, playerCount: 3, myStartScore: 20, myEndScore: 15, myNet: -5, endReason: 'dissolve', rounds: 2 },
    { id: 'R1-2', roomId: 'R1', endedAt: now - 3600000, playerCount: 4, myStartScore: 20, myEndScore: 26, myNet: 6, endReason: 'dissolve', rounds: 3 }
  ];
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const exe = findBrowser();
  const userDir = path.join(os.tmpdir(), 'lxw-undo-edge-' + Date.now());
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __error: String(r.exceptionDetails.text) };
    return r.result && r.result.value;
  };
  const shot = async (name) => {
    if (!SHOTS) return null;
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, name);
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  };

  /* 用本地演示模式：不需要真服务端，战绩全在 localStorage 里 */
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?mode=local' });
  await sleep(1800);
  const seedJson = JSON.stringify(seedRecords());
  await evaluate(`localStorage.setItem('lxw_records_v1', ${JSON.stringify(seedJson)});
                  localStorage.setItem('lxw_guide_seen_v1','1');
                  localStorage.setItem('lxw_records_deduped_v2','1');
                  'ok'`);
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?mode=local' });
  await sleep(1800);
  console.log('视口 ' + W + '×' + H);

  const readState = `(function(){
    var bar = document.getElementById('undo-bar');
    var msg = document.getElementById('undo-msg');
    var act = document.getElementById('undo-act');
    var allRows = [].slice.call(document.querySelectorAll('#records-list .rp-row'));
    var rows = allRows.length;
    var visRows = allRows.filter(function(x){ return x.offsetParent !== null; }).length;
    var empty = document.getElementById('records-empty');
    var back = document.getElementById('btn-records-back');
    var store = [];
    try { store = JSON.parse(localStorage.getItem('lxw_records_v1') || '[]'); } catch (e) { store = []; }
    function r(el){ if(!el) return null; var b = el.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom), l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }; }
    var br = r(bar), kr = r(back);
    var overlap = 0;
    if (br && kr) {
      var ix = Math.max(0, Math.min(br.r, kr.r) - Math.max(br.l, kr.l));
      var iy = Math.max(0, Math.min(br.b, kr.b) - Math.max(br.t, kr.t));
      overlap = ix * iy;
    }
    return {
      barShown: !!bar && !bar.classList.contains('hidden'),
      msg: msg ? msg.textContent : null,
      actText: act ? act.textContent : null,
      actRect: r(act),
      barRect: br,
      backOverlap: overlap,
      rows: rows,
      visRows: visRows,
      emptyShown: !!empty && !empty.classList.contains('hidden'),
      storeCount: store.length
    };
  })()`;

  console.log('\n[1] 打开战绩页，确认有数据');
  await evaluate(`document.getElementById('btn-records-home').click()`);
  await sleep(700);
  let st = await evaluate(readState);
  ok(st.rows === 2, '★ 战绩页读到 2 条记录（种子生效）', JSON.stringify({ rows: st.rows }));

  console.log('\n[2] 确认清除 → 条子弹出，但**记录还在**');
  await evaluate(`document.getElementById('btn-records-clear').click()`);
  await sleep(400);
  await evaluate(`document.getElementById('btn-records-clear-ok').click()`);
  await sleep(300);
  st = await evaluate(readState);
  ok(st.barShown === true, '★★ 条子弹出来了', JSON.stringify(st));
  ok(/将清除 2 场/.test(st.msg || ''), '★★ 文案说清了「将清除几场」（不是一句模糊的"已清除"）', st.msg);
  ok((st.actText || '').trim() === '撤销', '撤销按钮文案正确', st.actText);
  ok(st.visRows === 2, '★★ 5 秒之内记录**还在**（这就是「可以反悔」的全部含义）', 'visRows=' + st.visRows);
  ok(st.storeCount === 2, '★★ 本机存储也还没动', String(st.storeCount));
  ok(st.actRect && st.actRect.h >= 40, '★ 撤销按钮够高（' + (st.actRect ? st.actRect.h : '?') + ' CSS px，点不中等于没这个功能）');
  /* 条子压在屏幕下半部，最容易盖住「返回」。真重叠会让玩家在 5 秒里点不到返回 ——
   * 而那 5 秒恰好是他最可能想「算了我不清除了，先退出去看看」的时候。 */
  ok(st.backOverlap === 0, '★★ 条子和「返回」按钮零重叠', 'overlap=' + st.backOverlap + 'px²');
  const p1 = await shot('undo-bar.png');
  if (p1) console.log('    图：' + p1);

  console.log('\n[3] 点「撤销」→ 一切回到没清过的样子');
  await evaluate(`document.getElementById('undo-act').click()`);
  await sleep(400);
  st = await evaluate(readState);
  ok(st.barShown === false, '★ 条子收起');
  ok(st.visRows === 2, '★★ 记录仍在（撤销真的撤销了，而不是只是把条子藏起来）', 'visRows=' + st.visRows);
  ok(st.storeCount === 2, '★★ 存储仍是 2 条');

  console.log('\n[4] 再确认一次，这次不撤销 → 5 秒后真的清掉');
  await evaluate(`document.getElementById('btn-records-clear').click()`);
  await sleep(400);
  await evaluate(`document.getElementById('btn-records-clear-ok').click()`);
  await sleep(300);
  st = await evaluate(readState);
  ok(st.barShown === true, '条子再次弹出');
  /* 关键：**5 秒之内**任何时刻都不该清。这里在 3 秒时插一刀。 */
  await sleep(3000);
  st = await evaluate(readState);
  ok(st.visRows === 2, '★★ 第 3 秒（窗口内）记录仍在', 'visRows=' + st.visRows);
  await sleep(2600);                       // 累计 5.6 秒，越过窗口
  st = await evaluate(readState);
  ok(st.barShown === false, '★★ 到点后条子自己消失（不需要玩家再点一次）');
  /* 用**可见**行数，不是 DOM 里的行数：清空时列表容器整块 display:none，
   * 行元素还留在 DOM 里（下一次渲染直接复用）。数 DOM 会一直看到 2 行 ——
   * 上一版就是这么假红的，页面其实已经空了。 */
  ok(st.visRows === 0, '★★ 到点后记录清空了', 'visRows=' + st.visRows + ' rows=' + st.rows);
  ok(st.emptyShown === true, '★ 切到空态（不是留一块空白）');
  ok(st.storeCount === 0, '★★ 本机存储也清了', String(st.storeCount));

  console.log('\n[5] 条子隐藏后不占位');
  {
    const pos = await evaluate(`(function(){
      var bar = document.getElementById('undo-bar');
      if (!bar) return null;
      var br = bar.getBoundingClientRect();
      var cs = getComputedStyle(bar);
      return { w: Math.round(br.width), h: Math.round(br.height), display: cs.display, pe: cs.pointerEvents };
    })()`);
    /* display:none 而不是 opacity:0 硬撑着 —— 后者会让一个不可见的盒子继续吃点击。
     * 这条和 .toast 的 pointer-events:none 是同一个教训的两个面。 */
    ok(pos && pos.display === 'none', '★★ 隐藏时 display:none（不是 opacity:0 留一个看不见的盒子吃点击）', JSON.stringify(pos));
    ok(pos && pos.w === 0 && pos.h === 0, '★ 隐藏时尺寸为 0（不占位）', JSON.stringify(pos));
  }

  cdp.close();
  edge.kill();
  server.close();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await sleep(100);
  process.exit(fail ? 1 : 0);
}


main().catch((e) => { console.error(e); process.exit(1); });
