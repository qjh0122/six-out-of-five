/**
 * 「准备」按钮会不会被按死（一次性诊断 + 回归守卫）
 *
 * 真机反馈：「他说准备不了」——截图里房间 3 人、2 人已准备，
 * 他那张卡还是「等待中…」，而底部的「准备」是**灰的、点不动的**。
 *
 * 成因在 pressBusy 的还原分支：
 *     if (btn.textContent === label) { btn.textContent = prevText; btn.disabled = prevDisabled; }
 * 点下去先把 disabled 置真、文案换成「准备中…」；这 8 秒里**任意一次房间广播**
 * （别人准备 / 有人进房）都会让 render() 把文案改回「准备」，
 * 于是 await 结束回到 finally 时文案已经不等于 label，还原被整块跳过 ——
 * disabled 就永久留在按钮上。按钮看起来「准备好了」，其实点不动。
 *
 * 为什么这个探针能在本地模式里稳定复现：
 *   ?mode=local 的 setReady 是同步改状态 + 同步广播，render() 一定发生在
 *   await 续上之前 —— 每次点击都必然踩中这条分支（真机上是「弱网 8 秒内有人准备」）。
 *
 * 用法：node scripts/probe-ready-button.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'pwa');
const PORT = 3073;
/* 视口可传：node scripts/probe-ready-button.js 375 667
 * 准备态这两年在 390×844 上一直是绿的，而 v90 把 16:9 那一档也接上了圆桌
 * —— 环从 179 涨到 404，准备卡还剩多少高度只能实测。 */
const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
const CDP = 9373;
const SHOT_DIR = path.join(os.tmpdir(), 'lxw-ready');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json', '.json': 'application/json'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const p = url === '/' ? '/index.html' : url;
  const abs = path.join(ROOT, p);
  if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(abs, (e, buf) => {
    if (e) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
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
        const w = waiting.get(msg.id); waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(JSON.stringify(msg.error))); else w.resolve(msg.result);
      }
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({
      send(m, p) {
        return new Promise((res, rej) => { id += 1; waiting.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
      },
      close() { try { ws.close(); } catch (e) {} }
    }));
  });
}

async function evaluate(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.text) + ' :: ' + expr.slice(0, 120));
  return r.result && r.result.value;
}

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

/* 按钮此刻的完整状态：disabled / busy / 文案 / 我自己那格的状态 */
const BTN = `(function(){
  var b = document.getElementById('btn-ready');
  var me = document.querySelector('#room-players .player-row.me');
  var st = me ? me.querySelector('.player-status') : null;
  return {
    disabled: !!b.disabled,
    busy: b.dataset.busy || '',
    text: (b.textContent || '').trim(),
    mine: st ? (st.textContent || '').trim() : null,
    rows: document.querySelectorAll('#room-players .player-row').length,
    hint: (document.getElementById('room-hint') || {}).textContent
  };
})()`;

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lxw-ready-' + Date.now()),
    '--window-size=' + W + ',' + H, '--force-device-scale-factor=1', 'about:blank'
  ], { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const l = await getJson('http://127.0.0.1:' + CDP + '/json/list');
      page = (l || []).find((t) => t.type === 'page');
      if (page) break;
    } catch (e) {}
  }
  if (!page) { console.error('连不上 Edge'); edge.kill(); process.exit(1); }
  const cdp = await cdpConnect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?mode=local' });
  await sleep(1600);

  console.log('\n[1] 建房（本地模式：补 AI 不可用，直接一个人准备）');
  await evaluate(cdp, `localStorage.setItem('lxw_guide_seen_v1','1')`);
  await evaluate(cdp, `document.getElementById('btn-create').click()`);
  /* ★ v103 起「创建房间」先弹「本局打几把」，点了确认才真的开房。
   * 缺这一步 → 房间没建 → 后面所有断言都拿不到牌桌（脚本过期，不是功能坏）。 */
  await sleep(500);
  await evaluate(cdp, `(function(){var b=document.getElementById('btn-create-confirm');if(b)b.click();})()`);
  await sleep(500);
  await sleep(1200);
  const before = await evaluate(cdp, BTN);
  console.log('  准备前 ' + JSON.stringify(before));
  ok(before.disabled === false, '准备按钮初始可点', JSON.stringify(before));

  console.log('\n[2] 点一次「准备」');
  await evaluate(cdp, `document.getElementById('btn-ready').click()`);
  await sleep(900);
  const after = await evaluate(cdp, BTN);
  console.log('  准备后 ' + JSON.stringify(after));
  ok(after.mine && /已准备/.test(after.mine), '★ 我这一格变成「已准备」', JSON.stringify(after));
  ok(after.text === '取消准备', '★ 按钮文案变成「取消准备」', after.text);
  ok(after.disabled === false, '★ 按钮没有被按死（可再点）', 'disabled=' + after.disabled + ' busy=' + after.busy);
  ok(!after.busy, '★ 没有残留的 busy 标记', after.busy);

  console.log('\n[3] 再点一次「取消准备」，必须真的能取消');
  await evaluate(cdp, `document.getElementById('btn-ready').click()`);
  await sleep(900);
  const back = await evaluate(cdp, BTN);
  console.log('  取消后 ' + JSON.stringify(back));
  ok(back.mine && /等待中|还在结算/.test(back.mine), '★ 状态回到「等待中」', JSON.stringify(back));
  ok(back.text === '准备', '★ 文案回到「准备」', back.text);
  ok(back.disabled === false, '★ 按钮仍可点', 'disabled=' + back.disabled);

  console.log('\n[4] 准备态版式：一屏放下（' + W + '×' + H + '）');
  const fit = await evaluate(cdp, `(function(){
    function R(e){ if (!e) return null; var r = e.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height) }; }
    var top = document.getElementById('game-top');
    var tr = document.getElementById('tr-card');
    var btn = document.getElementById('btn-ready');
    var ring = !!(top && top.classList.contains('gt-ring'));
    return {
      ring: ring, compact: !!(top && top.classList.contains('rt-compact')),
      top: R(top), tr: R(tr), btn: R(btn),
      vh: innerHeight,
      docOver: document.documentElement.scrollHeight - innerHeight,
      stageScroll: (function(){ var st = document.getElementById('stage'); return st ? st.scrollHeight - st.clientHeight : null; })()
    };
  })()`);
  console.log('  ' + JSON.stringify(fit));
  ok(!!fit && fit.ring, '准备态也在圆桌上（桌子不因「没人开局」而消失）', JSON.stringify(fit && fit.top));
  ok(!!fit && fit.tr && fit.tr.b <= fit.vh, '★ 房间规则卡完整在屏内（底边 ' + (fit && fit.tr && fit.tr.b) + ' / 视口 ' + (fit && fit.vh) + '）');
  ok(!!fit && fit.btn && fit.btn.b <= fit.vh, '★ 「准备」按钮没被挤出屏幕（底边 ' + (fit && fit.btn && fit.btn.b) + '）');
  ok(!!fit && fit.docOver <= 1, '★ 整页不产生纵向滚动（溢出 ' + (fit && fit.docOver) + '）');

  if (process.env.ZOOM) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
    const p = path.join(SHOT_DIR, 'room-ready-' + W + 'x' + H + '.png');
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    console.log('  截图 ' + p);
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  cdp.close();
  edge.kill();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
