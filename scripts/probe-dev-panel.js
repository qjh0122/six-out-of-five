/**
 * 调试侧栏探针（`?dev=1`，v91）
 *
 * 守三件事：
 *   1. 不带参数时**元素根本不存在** —— 「正式包里有没有调试入口」不该靠读代码确认。
 *   2. 带上 `?dev=1` 时四行读数齐全、三个开关按钮的 ·开/·关 与这一页实际生效的值一致。
 *   3. 它不吃点击（容器 pointer-events: none，只有按钮 auto），横屏也不占满屏。
 *
 * 为什么用 file:// 而不是起服务端：这一块与登录、房间、WebSocket 全都无关，
 * game.js 本来就把 file:// 当本地演示模式（见 isLocalMode）。起服务端只会多一个失败点。
 *
 * 用法：node scripts/probe-dev-panel.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PAGE = 'file:///' + path.join(__dirname, '..', 'pwa', 'index.html').replace(/\\/g, '/');
const CDP = 9397;
const SHOT_DIR = path.join(os.tmpdir(), 'lxw-dev-panel');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    require('http').get(url, (res) => {
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
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.text) + ' :: ' + expr.slice(0, 140));
  return r.result && r.result.value;
}

async function open(cdp, w, h, query) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.navigate', { url: PAGE + (query || '') });
  await sleep(1500);
  /* 新手引导会整屏盖住首页；它和侧栏互不影响，但顺手关掉省得截图看不清。 */
  await evaluate(cdp, `(function(){ try { localStorage.setItem('lxw_guide_seen_v1','1'); } catch (e) {} return 1; })()`);
  await cdp.send('Page.navigate', { url: PAGE + (query || '') });
  await sleep(1600);
}

async function shot(cdp, name) {
  try {
    if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(SHOT_DIR, name + '.png');
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  } catch (e) { return '(截图失败)'; }
}

const READ = `(function(){
  var p = document.querySelector('.dev-panel');
  if (!p) return { has: false };
  var rows = [].map.call(p.querySelectorAll('.dev-panel-row'), function (r) { return r.textContent; });
  var btns = [].map.call(p.querySelectorAll('.dev-panel-btn'), function (b) {
    return { q: b.dataset.q || (b.dataset.copy ? 'copy' : (b.dataset.shut ? 'shut' : '?')), text: b.textContent };
  });
  var cs = getComputedStyle(p);
  var r = p.getBoundingClientRect();
  return {
    has: true, rows: rows, btns: btns,
    pe: cs.pointerEvents, h: Math.round(r.height), bottom: Math.round(r.bottom),
    vh: window.innerHeight,
    btnPe: getComputedStyle(p.querySelector('.dev-panel-btn')).pointerEvents,
    hidden: p.classList.contains('hidden'),
    url: location.search
  };
})()`;

async function main() {
  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lxw-dev-' + Date.now()),
    '--window-size=390,844', '--force-device-scale-factor=1',
    '--allow-file-access-from-files', 'about:blank'
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

  console.log('\n[1] 不带参数：调试侧栏不该存在');
  await open(cdp, 390, 844, '');
  let a = await evaluate(cdp, READ);
  ok(a.has === false, '★ 默认页里没有 .dev-panel（不是 hidden，是整个没建）',
    JSON.stringify(a).slice(0, 80));

  console.log('\n[2] ?dev=1：四行读数');
  await open(cdp, 390, 844, '?dev=1');
  let b = await evaluate(cdp, READ);
  ok(b.has === true, '★ 带上 ?dev=1 才出现');
  ok(b.rows.length === 4, '四行：版式 / 舞台 / 组槽 / 牌面', JSON.stringify(b.rows));
  ok(/版式 竖屏 · portrait/.test(b.rows[0] || ''), '版式行写明竖屏 + 圆桌档位', b.rows[0]);
  ok(/舞台 \d+ 设计高 · scale 0\.\d+/.test(b.rows[1] || ''), '舞台行有设计高与 scale', b.rows[1]);
  ok(/组槽 (dense|normal)/.test(b.rows[2] || ''), '组槽行有 dense/normal 与实测高', b.rows[2]);
  ok(/牌面 (\d+×\d+|—)/.test(b.rows[3] || ''), '牌面行有实测尺寸（设计 px）', b.rows[3]);
  console.log('    ' + b.rows.join('\n    '));
  console.log('    截图 ' + (await shot(cdp, 'portrait-390x844')));

  console.log('\n[3] 三个开关按钮的 ·开/·关 与这一页实际生效的值一致');
  const btn = (k) => (b.btns.find((x) => x.q === k) || {}).text || '';
  ok(/圆桌 ·开/.test(btn('seatring')), '圆桌按钮显示 ·开（CONFIG.SEAT_RING 默认开）', btn('seatring'));
  ok(/倒计时 ·关/.test(btn('startcountdown')), '倒计时按钮显示 ·关（默认关，v90 的开关）', btn('startcountdown'));
  ok(/表情 ·开/.test(btn('emoji')), '表情按钮显示 ·开', btn('emoji'));
  ok(!!b.btns.find((x) => x.q === 'copy'), '有「复制」按钮（真机上把读数发出来用）');
  ok(!!b.btns.find((x) => x.q === 'shut'), '有收起按钮');

  console.log('\n[4] ?seatring=0 时读数与按钮一起变');
  await open(cdp, 390, 844, '?dev=1&seatring=0');
  const c = await evaluate(cdp, READ);
  ok(/（圆桌关）/.test(c.rows[0] || ''), '版式行标出「圆桌关」（不是假装还开着）', c.rows[0]);
  ok(/圆桌 ·关/.test((c.btns.find((x) => x.q === 'seatring') || {}).text || ''),
    '圆桌按钮跟着显示 ·关');

  console.log('\n[5] 点「×」收起：只隐藏，不导航');
  const before = await evaluate(cdp, 'location.href');
  await evaluate(cdp, `(function(){
    var b = document.querySelector('.dev-panel-btn[data-shut]');
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 1;
  })()`);
  await sleep(300);
  const d = await evaluate(cdp, READ);
  ok(d.hidden === true, '★ 收起后 classList 里有 hidden');
  ok((await evaluate(cdp, 'location.href')) === before, '★ 收起不触发导航（它不是开关按钮）');

  console.log('\n[6] 不吃点击 + 横屏不占满屏');
  ok(b.pe === 'none', '★ 面板容器 pointer-events: none（不挡住底下的牌桌）', b.pe);
  ok(b.btnPe === 'auto', '★ 按钮自己 auto（不然点不到）', b.btnPe);
  await open(cdp, 844, 390, '?dev=1');
  const e = await evaluate(cdp, READ);
  ok(e.has === true, '横屏也能开');
  ok(e.h <= Math.round(e.vh * 0.42), '★ 横屏 390 高时面板 ≤ 42vh（不盖住手牌）', e.h + ' / ' + e.vh);
  ok(/横屏 · landscape|横屏 · desktop/.test(e.rows[0] || ''), '横屏版式行写明横屏档位', e.rows[0]);
  console.log('    截图 ' + (await shot(cdp, 'landscape-844x390')));

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('截图目录 ' + SHOT_DIR);
  cdp.close();
  edge.kill();
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
