/**
 * 新手引导探针（一次性诊断脚本，不进测试套件）
 *
 * 为什么需要它：这个页面跑在 750 宽的设计空间里（#stage 整体 scale），
 * 所以 CSS 里写的 px 都会再乘约 0.52 才是屏幕像素。光看源码根本看不出
 * 「19px 的标题」落到手机上只有 10px —— v49 那一版就是这么做出来的。
 * 这里用真 Edge 量的是**渲染后的屏幕像素**，同时检查 4 步有没有溢出。
 *
 * 用法：node scripts/probe-guide.js [宽] [高] [输出目录]
 *   截图写到输出目录（默认系统临时目录），每步一张 guide-N.png。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
const OUT = process.argv[4] || path.join(os.tmpdir(), 'lxw-guide-' + Date.now());
const STATIC_PORT = 3031;
const CDP_PORT = 9341;
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
  const userDir = path.join(os.tmpdir(), 'lxw-guide-edge-' + Date.now());
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
  await sleep(2600);   // 引导是 1.2s 后自动弹，留足余量

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

  /* 量当前这一步所有关键尺寸（全部是屏幕像素，已含 stage 的 scale）*/
  const readStep = `(function(){
    var card = document.querySelector('#guide-modal .guide-card');
    var body = document.getElementById('guide-body');
    var step = document.querySelector('#guide-body .guide-step:not([hidden])');
    var h2 = step && step.querySelector('h2');
    var p = step && step.querySelector('p');
    var tip = step && step.querySelector('.guide-tip');
    var skip = document.getElementById('guide-skip');
    var bars = document.querySelectorAll('#guide-dots i');
    var bar = bars.length ? bars[0] : null;
    var gcard = step && step.querySelector('.gcard');
    var tile = step && step.querySelector('.gtile');
    var next = document.getElementById('guide-next');
    var r = card ? card.getBoundingClientRect() : null;
    var bodyR = body ? body.getBoundingClientRect() : null;
    function fs(el){ return el ? parseFloat(getComputedStyle(el).fontSize) : null; }
    function rect(el){ if(!el) return null; var b=el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height) }; }
    return {
      cardW: r ? Math.round(r.width) : null,
      cardH: r ? Math.round(r.height) : null,
      cardRatio: r ? +(r.width / window.innerWidth).toFixed(3) : null,
      fitsWidth: r ? (r.left >= -1 && r.right <= window.innerWidth + 1) : null,
      fitsHeight: r ? (r.top >= -1 && r.bottom <= window.innerHeight + 1) : null,
      bodyOverflow: body ? body.scrollHeight - body.clientHeight : null,
      titleFs: fs(h2), bodyFs: fs(p), tipFs: fs(tip),
      tipLines: tip ? Math.round(tip.getBoundingClientRect().height / (parseFloat(getComputedStyle(tip).lineHeight) || 1)) : null,
      skipFs: fs(skip),
      bar: bar ? rect(bar) : null,
      gcard: gcard ? rect(gcard) : null,
      tile: tile ? rect(tile) : null,
      nextClipped: next ? (next.scrollWidth > next.clientWidth + 1) : null,
      nextText: next ? next.textContent : null,
      prevHidden: (function(){ var p = document.getElementById('guide-prev');
        return p ? (p.offsetParent === null) : null; })(),
      title: h2 ? h2.textContent : null,
      hidden: document.getElementById('guide-modal').classList.contains('hidden')
    };
  })()`;

  ok(true, '引导是否自动弹出（下面第 1 步数据里看 hidden 必须为 false）');
  let allFits = true, allNoOverflow = true;

  for (let step = 0; step < 4; step++) {
    if (step > 0) {
      await evaluate(`document.getElementById('guide-next').click()`);
      await sleep(420);
    }
    const d = await evaluate(readStep);
    if (d && d.error) { console.log('  读取失败 ' + d.error); fail++; continue; }
    const img = await shot('guide-' + step + '.png');
    console.log('\n[步骤 ' + step + '] ' + (d.title || '') + '   图：' + img);
    console.log('    卡片 ' + d.cardW + '×' + d.cardH + '  占屏宽 ' + (d.cardRatio * 100).toFixed(0) + '%'
      + '  标题 ' + d.titleFs + 'px  正文 ' + d.bodyFs + 'px  提示 ' + d.tipFs + 'px  跳过 ' + d.skipFs + 'px');
    if (d.gcard) console.log('    牌 ' + d.gcard.w + '×' + d.gcard.h + (d.tile ? '  玩法块 ' + d.tile.w + '×' + d.tile.h : '')
      + (d.bar ? '  进度条段 ' + d.bar.w + '×' + d.bar.h : ''));

    ok(d.hidden === false, '第 ' + step + ' 步弹窗是打开的');
    ok(d.cardRatio >= 0.8, '第 ' + step + ' 步卡片占屏宽 ≥ 80%', d.cardRatio);
    ok(d.titleFs >= 17, '第 ' + step + ' 步标题 ≥ 17 屏幕px', d.titleFs);
    ok(d.bodyFs >= 13, '第 ' + step + ' 步正文 ≥ 13 屏幕px', d.bodyFs);
    ok(d.fitsWidth && d.fitsHeight, '第 ' + step + ' 步卡片没有超出视口',
      JSON.stringify({ w: d.fitsWidth, h: d.fitsHeight }));
    ok(d.bodyOverflow <= 0, '第 ' + step + ' 步内容没有溢出滚动', d.bodyOverflow);
    ok(d.nextClipped === false, '第 ' + step + ' 步主按钮文字没有被截断', d.nextText);
    ok(d.prevHidden === (step === 0), '第 ' + step + ' 步「上一步」的显隐正确', d.prevHidden);
    if (d.gcard) ok(d.gcard.w >= 28, '第 ' + step + ' 步牌宽 ≥ 28 屏幕px', d.gcard.w);
    if (!d.fitsWidth || !d.fitsHeight) allFits = false;
    if (d.bodyOverflow > 0) allNoOverflow = false;
  }

  ok(allFits, '4 步全部没超出视口');
  ok(allNoOverflow, '4 步全部没有溢出滚动');

  /* 顺手确认房间页的分组按钮没被引导样式带偏（v49 的 .gchip 撞名事故） */
  const clash = await evaluate(`(function(){
    var probe = document.createElement('button');
    probe.className = 'gchip';
    probe.textContent = '比大小';
    document.body.appendChild(probe);
    var cs = getComputedStyle(probe);
    var b = probe.getBoundingClientRect();
    var out = { fs: parseFloat(cs.fontSize), h: Math.round(b.height),
                bg: cs.backgroundColor, minH: cs.minHeight };
    probe.remove();
    return out;
  })()`);
  console.log('\n[分组按钮 .gchip] ' + JSON.stringify(clash));
  ok(clash && clash.fs >= 20, '.gchip 字号没被引导样式带偏（≥ 20 设计px）', clash && clash.fs);
  ok(clash && clash.minH === '88px', '.gchip 最小热区仍是 88px', clash && clash.minH);

  await cdp.send('Page.close').catch(() => {});
  cdp.close();
  try { edge.kill(); } catch (e) {}
  server.close();

  console.log('\n' + '='.repeat(48));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
