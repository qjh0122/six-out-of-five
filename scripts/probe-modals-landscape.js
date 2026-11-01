/**
 * 横屏弹窗审计：把 15 个弹窗逐个强制显示，量「卡片有没有超出视口 / 主按钮还在不在屏内」。
 *
 * 为什么必须单独量：`.modal-card` 的 `max-height` 是百分比（82%），而内部又有多处写死的
 * `min-height`。竖屏舞台 1623 设计高时 82% ≈ 1331，怎么写都装得下；横屏只有 750，
 * 82% ≈ 615 —— 引导弹窗就是这么把「下一步」裁到屏幕外的（REVIEW 22.3）。
 *
 * 注意：这里只做**结构**审计（强制显示 + 现有 DOM）。结果/档案/回放这类
 * 内容由 JS 渲染的弹窗，空壳不会溢出，真正要看的截图在 journey（LXW_SHOTS=1）里。
 *
 * ★ emoji-modal 的空壳尤其不能当结果看：它的 13 个格子由 renderEmojiGrid 按当前牌桌
 *   渲染，而本探针没入座（只点掉引导就开审），所以卡片里只剩标题那一条，高度塌到
 *   ~72 CSS px。那不是布局坏了，是「没内容」。它的横屏真实验收在 probe-emoji.js
 *   （844×390，验 7 列 / 13 图真的加载 / 卡片整体在视口内 / 内容没被裁），这里
 *   只兜一层「head 那一层不溢出」。
 *
 * 用法：node scripts/probe-modals-landscape.js [宽 高]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'pwa');
const PORT = 3089;
const CDP = 9389;
const SHOT_DIR = path.join(os.tmpdir(), 'lxw-modals');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json', '.json': 'application/json'
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const abs = path.join(ROOT, url === '/' ? '/index.html' : url);
  if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(abs, (e, buf) => {
    if (e) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
  });
});

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const waiting = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && waiting.has(msg.id)) {
        const w = waiting.get(msg.id); waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(JSON.stringify(msg.error))); else w.resolve(msg.result);
      }
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({
      send(m, p) { return new Promise((res, rej) => { id += 1; waiting.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); }); },
      close() { try { ws.close(); } catch (e) {} }
    }));
  });
}

const evaluate = async (cdp, expr) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

const MODALS = [
  'guide-modal', 'rules-modal', 'share-modal', 'rename-modal', 'account-modal',
  'pwd-modal', 'confirm-modal', 'dissolve-modal', 'records-clear-modal',
  'result-modal', 'prev-result-modal', 'replay-modal', 'profile-modal',
  'seat-sheet'
];

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

const AUDIT = (id) => `(function(){
  var m = document.getElementById('${id}');
  if (!m) return { err: 'missing' };
  m.classList.remove('hidden');
  var card = m.querySelector('.modal-card, .modal-box');
  if (!card) { m.classList.add('hidden'); return { err: 'no-card' }; }
  var vh = innerHeight, vw = innerWidth;
  var r = card.getBoundingClientRect();
  /* 卡内可滚区：找所有 overflow-y:auto/scroll 且真的有内容的块 */
  var inner = [];
  Array.prototype.forEach.call(card.querySelectorAll('*'), function(e){
    var cs = getComputedStyle(e);
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 2) {
      inner.push({ cls: (e.id || e.className || e.tagName).toString().slice(0, 28),
        need: e.scrollHeight, have: e.clientHeight, hidden: e.scrollHeight - e.clientHeight });
    }
  });
  /* 主按钮：卡内最后一个可见按钮 */
  var btns = Array.prototype.filter.call(card.querySelectorAll('button'), function(b){
    var br = b.getBoundingClientRect();
    return br.width > 0 && br.height > 0 && getComputedStyle(b).visibility !== 'hidden';
  });
  var last = btns.length ? btns[btns.length - 1].getBoundingClientRect() : null;
  var out = {
    card: { t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width) },
    fitsV: r.top >= -1 && r.bottom <= vh + 1,
    overV: Math.round(r.bottom - vh),
    overH: Math.round(Math.max(r.left, 0) - r.left > 0 ? r.left : (r.right - vw)),
    inner: inner,
    lastBtn: last ? { b: Math.round(last.bottom), out: Math.round(last.bottom - vh) } : null,
    /* 卡片自身 overflow:hidden 时，内容超出卡身 = 被直接裁掉（不是可滚） */
    cardOverflow: Math.round(card.scrollHeight - card.clientHeight)
  };
  m.classList.add('hidden');
  return out;
})()`;

async function main() {
  const W = Number(process.argv[2]) || 1112;
  const H = Number(process.argv[3]) || 511;
  server.listen(PORT);
  const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ['--headless=new', '--remote-debugging-port=' + CDP, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  await sleep(2600);
  const list = await getJson('http://127.0.0.1:' + CDP + '/json/list');
  const cdp = await cdpConnect(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?mode=local' });
  await sleep(1600);
  await evaluate(cdp, `(function(){ var s=document.querySelector('#guide-modal .guide-skip'); if (s) s.click(); })()`);
  await sleep(400);

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  console.log('===== ' + W + '×' + H + ' 弹窗审计 =====');

  for (const id of MODALS) {
    const g = await evaluate(cdp, AUDIT(id));
    if (!g || g.err) { console.log(id.padEnd(20) + ' ' + JSON.stringify(g)); continue; }
    /* 静置截图（逐个打开再关，方便肉眼复核） */
    await evaluate(cdp, `document.getElementById('${id}').classList.remove('hidden')`);
    await sleep(220);
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOT_DIR, id + '.png'), Buffer.from(r.data, 'base64'));
    await evaluate(cdp, `document.getElementById('${id}').classList.add('hidden')`);

    const line = id.padEnd(20)
      + ' card h=' + String(g.card.h).padStart(4)
      + ' t=' + String(g.card.t).padStart(4)
      + ' bottom=' + String(g.card.b).padStart(4)
      + ' 卡内溢出=' + String(g.cardOverflow).padStart(4)
      + (g.lastBtn ? ' 末按钮bottom=' + String(g.lastBtn.b).padStart(4) : '')
      + (g.inner.length ? ' 滚区=' + JSON.stringify(g.inner) : '');
    console.log(line);
    ok(g.fitsV, id + '：卡片整体在视口内', 'bottom 超出 ' + g.overV + 'px');
    ok(!g.lastBtn || g.lastBtn.out <= 1, id + '：最后一个按钮可点到', JSON.stringify(g.lastBtn));
    ok(g.cardOverflow <= 2, id + '：卡内内容没被 overflow:hidden 裁掉', '裁掉 ' + g.cardOverflow + 'px');
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('截图目录：' + SHOT_DIR);
  if (fail) process.exitCode = 1;
  cdp.close();
  try { edge.kill(); } catch (e) {}
  server.close();
}
main();
