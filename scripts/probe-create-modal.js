/**
 * 建房「本局局数」弹窗探针（一次性诊断脚本，不进测试套件）
 *
 * 为什么要真浏览器：整页跑在 750 设计空间里（#stage 整体 scale），CSS 里写的
 * 112px 高度落到 390 宽的手机上只有 ~58 屏幕px。五个档位横排会不会挤、
 * 数字会不会被截断，静态读 CSS 只能得出「放得下」的错觉。
 *
 * 验的六件事：
 *   1. 弹窗在视口内，不溢出
 *   2. 五个档位（3/5/10/15/30）都在，且宽度均分
 *   3. 默认选中 10（产品口径：不选就是 10）
 *   4. 点 30 → 选中态真的转移（不是只有样式，aria-checked 也要跟）
 *   5. 取消后弹窗关闭，再打开又回到 10（不记上一次的选择）
 *   6. 每张档位卡的文字没有被截断
 *
 * 用法：node scripts/probe-create-modal.js [宽] [高] [输出目录]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
const OUT = process.argv[4] || path.join(os.tmpdir(), 'lxw-create-' + Date.now());
const STATIC_PORT = 3051;
const CDP_PORT = 9361;
const ROOT = path.join(__dirname, '..', 'pwa');

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

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise((r) => server.listen(STATIC_PORT, '127.0.0.1', r));

  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  if (!fs.existsSync(exe)) { console.error('找不到 Edge：' + exe); process.exit(1); }
  const userDir = path.join(os.tmpdir(), 'lxw-create-edge-' + Date.now());
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
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
  if (!page) { console.error('连不上 Edge CDP'); edge.kill(); process.exit(1); }

  const cdp = await cdpConnect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 2, mobile: true
  });
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + STATIC_PORT + '/' });
  await sleep(2600);   // 新手引导 1.2s 后自动弹，留足余量

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) return { error: String(r.exceptionDetails.text) };
    return r.result && r.result.value;
  };

  async function shot(name) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, name);
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  }

  console.log('视口 ' + W + '×' + H + '  截图目录 ' + OUT);

  /* 先关掉新手引导（新 profile 必弹），否则它会盖住建房按钮 */
  await evaluate(`(function(){
    var g = document.getElementById('guide-modal');
    if (g && !g.classList.contains('hidden')) {
      var s = document.getElementById('guide-skip');
      if (s) s.click();
    }
    return 1;
  })()`);
  await sleep(500);

  console.log('\n[1] 首页「创建房间」→ 弹窗，默认 10');
  await evaluate(`document.getElementById('btn-create').click()`);
  await sleep(400);

  const read = `(function(){
    var box = document.querySelector('#create-modal .modal-box');
    var chips = [].slice.call(document.querySelectorAll('#hand-limit-row .hand-limit-chip'));
    function rect(el){ var b = el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top), left: Math.round(b.left),
               right: Math.round(b.right), bottom: Math.round(b.bottom) }; }
    return {
      hidden: document.getElementById('create-modal').classList.contains('hidden'),
      box: box ? rect(box) : null,
      fitsW: box ? (box.getBoundingClientRect().left >= -1 && box.getBoundingClientRect().right <= window.innerWidth + 1) : null,
      fitsH: box ? (box.getBoundingClientRect().top >= -1 && box.getBoundingClientRect().bottom <= window.innerHeight + 1) : null,
      count: chips.length,
      nums: chips.map(function(c){ return c.querySelector('.hl-num').textContent; }),
      units: chips.map(function(c){ return c.querySelector('.hl-unit').textContent; }),
      checked: chips.map(function(c){ return c.getAttribute('aria-checked'); }),
      onCount: chips.filter(function(c){ return c.classList.contains('is-on'); }).length,
      onNum: (chips.filter(function(c){ return c.classList.contains('is-on'); })[0] || {}).textContent || '',
      widths: chips.map(function(c){ return Math.round(c.getBoundingClientRect().width); }),
      clipped: chips.map(function(c){ return c.scrollHeight > c.clientHeight + 1; }),
      numFs: chips[0] ? parseFloat(getComputedStyle(chips[0].querySelector('.hl-num')).fontSize) : null,
      unitFs: chips[0] ? parseFloat(getComputedStyle(chips[0].querySelector('.hl-unit')).fontSize) : null,
      rowW: document.getElementById('hand-limit-row').getBoundingClientRect().width,
      title: (document.getElementById('create-title') || {}).textContent,
      desc: (document.querySelector('#create-modal .create-desc') || {}).textContent
    };
  })()`;

  let d = await evaluate(read);
  if (d && d.error) { console.log('  读取失败 ' + d.error); fail++; }
  console.log('    弹窗 ' + (d.box ? d.box.w + '×' + d.box.h : '?') + '  档位 ' + JSON.stringify(d.nums)
    + '  宽 ' + JSON.stringify(d.widths) + '  数字 ' + d.numFs + 'px 单位 ' + d.unitFs + 'px');
  const shot1 = await shot('create-modal-default.png');
  console.log('    图：' + shot1);

  ok(d.hidden === false, '点「创建房间」弹出了选局数弹窗');
  ok(d.fitsW && d.fitsH, '弹窗完整落在视口内', JSON.stringify({ w: d.fitsW, h: d.fitsH }));
  ok(d.count === 5, '五个档位都在（实际 ' + d.count + '）');
  ok(JSON.stringify(d.nums) === JSON.stringify(['3', '5', '10', '15', '30']),
    '档位顺序就是 3/5/10/15/30', JSON.stringify(d.nums));
  ok(d.onCount === 1, '只有一个档位是选中态');
  ok(d.onNum.indexOf('10') === 0, '★ 默认选中的是 10', d.onNum);
  ok(d.checked[d.nums.indexOf('10')] === 'true', '★ 默认档 aria-checked=true（读屏也知道选了 10）');
  ok(d.units[d.nums.indexOf('10')].indexOf('默认') >= 0, '默认档标了「默认」', d.units[d.nums.indexOf('10')]);
  const wMin = Math.min.apply(null, d.widths), wMax = Math.max.apply(null, d.widths);
  ok(wMax - wMin <= 2, '五个档位等宽（不会被 10/30 撑变形）', JSON.stringify(d.widths));
  ok(d.widths[0] >= 44, '档位宽度足够手指点（' + d.widths[0] + ' 屏幕px）');
  ok(d.clipped.every(function (c) { return c === false; }), '★ 每个档位的数字/单位都没被裁切');
  ok(d.numFs >= 18 && d.unitFs >= 9, '字号可读：数字 ' + d.numFs + 'px / 单位 ' + d.unitFs + 'px');
  ok(/打满/.test(d.desc || '') && /分数见底/.test(d.desc || ''),
    '★ 说明文案把两个结束条件都写了（只说局数会让人以为爆分还要继续）', d.desc);

  console.log('\n[2] 点 30 → 选中态真的转移');
  await evaluate(`(function(){
    var chips = document.querySelectorAll('#hand-limit-row .hand-limit-chip');
    chips[chips.length - 1].click();
    return 1;
  })()`);
  await sleep(300);
  d = await evaluate(read);
  ok(d.onCount === 1, '仍然只有一个选中');
  ok(d.onNum.indexOf('30') === 0, '★ 选中的变成 30', d.onNum);
  ok(d.checked[0] === 'false', '★ 原来那个（3）的 aria-checked 已经翻成 false');
  const shot2 = await shot('create-modal-30.png');
  console.log('    图：' + shot2);

  console.log('\n[3] 取消 → 再打开，回到默认 10');
  await evaluate(`document.getElementById('btn-create-cancel').click()`);
  await sleep(300);
  ok((await evaluate(`document.getElementById('create-modal').classList.contains('hidden')`)) === true,
    '取消关掉了弹窗');
  await evaluate(`document.getElementById('btn-create').click()`);
  await sleep(300);
  d = await evaluate(read);
  ok(d.onNum.indexOf('10') === 0, '★ 重新打开仍是 10（不记上一次的选择）', d.onNum);

  console.log('\n[4] Esc 能关掉');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);
  ok((await evaluate(`document.getElementById('create-modal').classList.contains('hidden')`)) === true,
    '★ Esc 关掉了弹窗（键盘用户不用去找按钮）');

  cdp.close();
  edge.kill();
  server.close();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await sleep(100);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
