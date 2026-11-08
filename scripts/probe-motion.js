#!/usr/bin/env node
/**
 * 动效与焦点探针（v135 · B2）真浏览器 / CDP
 * 跑法：node scripts/probe-motion.js [宽] [高]      例：node scripts/probe-motion.js 1280 720
 *
 * 为什么静态断言不够：这一批全是 **computed style** 上的东西 ——
 * 令牌写错一个字（`--dur-9`）、`var()` 引用了不存在的变量、`transition`
 * 简写里顺序写反（缓动写在时长前面会让整条声明作废），
 * 三种情况下 **CSS 都不报错**，页面看起来完全正常，只是所有按压"没有回执"。
 * 静态守卫能查"引用有没有定义"，查不到"浏览器最后算出来是多少"。
 *
 * 这个探针只量五件玩家能感知的事：
 *   1) 令牌真的解析成了毫秒数（不是空字符串）
 *   2) 按钮真的带 transition，且时长就是文档里那一档
 *   3) Tab 走到按钮上时，**看得见焦点环**（3px 实色 + offset）
 *   4) 按下时 60ms 内**有可见变化**（位移或亮度），松开后复原
 *   5) 系统开了"减少动态效果"后，动画与过渡都塌成 ~0
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { findBrowser } = require('./lib/browser');

const W = Number(process.argv[2]) || 1280;
const H = Number(process.argv[3]) || 720;
const PORT = 3053;
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
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const exe = findBrowser();
  const userDir = path.join(os.tmpdir(), 'lxw-motion-edge-' + Date.now());
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' });
  await sleep(2600);

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __error: String(r.exceptionDetails.text) };
    return r.result && r.result.value;
  };

  /* 新手引导会盖住首页按钮，先跳掉 */
  await evaluate(`(function(){
    var g = document.getElementById('guide-modal');
    if (g && !g.classList.contains('hidden')) { var s = document.getElementById('guide-skip'); if (s) s.click(); }
    return 1;
  })()`);
  await sleep(400);
  console.log('视口 ' + W + '×' + H);

  /* ---------- [1] 令牌解析 ---------- */
  console.log('\n[1] 令牌解析成毫秒数（不是空字符串）');
  const tokens = await evaluate(`(function(){
    var cs = getComputedStyle(document.documentElement);
    function v(n){ return cs.getPropertyValue(n).trim(); }
    return { d1: v('--dur-1'), d2: v('--dur-2'), d3: v('--dur-3'), s: v('--ease-std'), e: v('--ease-emph') };
  })()`);
  const ms = (s) => {
    if (!s) return -1;
    if (/ms$/.test(s)) return parseFloat(s);
    if (/s$/.test(s)) return parseFloat(s) * 1000;
    return -1;
  };
  ok(ms(tokens.d1) > 0 && ms(tokens.d2) > ms(tokens.d1) && ms(tokens.d3) > ms(tokens.d2),
    '★ 三档解析为 ' + tokens.d1 + ' / ' + tokens.d2 + ' / ' + tokens.d3 + '（严格递增）', JSON.stringify(tokens));
  ok(/cubic-bezier/.test(tokens.s) && /cubic-bezier/.test(tokens.e), '★ 两条缓动解析正常');

  /* ---------- [2] 主按钮真的带 transition，且落在三档之内 ---------- */
  console.log('\n[2] 主按钮的 transition 不是 0s，且落在三档之内');
  /* 没登录时首页是隐藏的（0×0），这时用引导页的主按钮。
   * 断言的对象是 `.btn` 这个**家族**的时序，不挑具体哪一颗 —— 挑具体的那颗
   * 会让探针在"有没有登录态"两种情况下行为不同，而这不是它要测的东西。 */
  const PICK = `window._pick = function(){
    function vis(el){ if(!el) return false; var r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; }
    var ids = ['btn-create', 'btn-auth-submit'];
    for (var i = 0; i < ids.length; i++) { var el = document.getElementById(ids[i]); if (vis(el)) return el; }
    return [].slice.call(document.querySelectorAll('button')).filter(vis)[0] || null;
  }`;
  const btn = await evaluate(PICK + ';(function(){ var b = _pick(); if(!b) return {__error:"no visible button"};'
    + ' var cs = getComputedStyle(b), r = b.getBoundingClientRect();'
    + ' return { id: b.id || b.className, dur: cs.transitionDuration, prop: cs.transitionProperty,'
    + ' timing: cs.transitionTimingFunction, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2),'
    + ' w: Math.round(r.width), h: Math.round(r.height) }; })()');
  ok(!btn.__error, '找得到一个可见的主按钮（' + (btn.id || '?') + '，' + btn.w + '×' + btn.h + '）', btn.__error);
  ok(ms(btn.dur) > 0, '★ transition-duration 不是 0（0 意味着整条声明被浏览器丢弃了）', btn.dur);
  ok(Math.abs(ms(btn.dur) - ms(tokens.d1)) < 1, '★ 时长就是 --dur-1 = ' + tokens.d1, btn.dur);
  ok(/transform/.test(btn.prop), '过渡属性含 transform（按压态才有回执）', btn.prop);
  ok(/cubic-bezier/.test(btn.timing), '缓动来自令牌（不是浏览器默认 ease）', btn.timing);

  /* ---------- [3] Tab 走到按钮上要有可见焦点环（桌面档） ---------- */
  console.log('\n[3] 键盘焦点环');
  await evaluate(`document.body.focus(); document.activeElement && document.activeElement.blur();`);
  let ring = null;
  for (let i = 0; i < 12; i++) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await sleep(60);
    ring = await evaluate(`(function(){
      var a = document.activeElement;
      if (!a || a === document.body) return null;
      var cs = getComputedStyle(a);
      return { tag: a.tagName, id: a.id, cls: a.className && a.className.toString().slice(0, 24),
               fv: a.matches(':focus-visible'),
               ow: parseFloat(cs.outlineWidth), os: cs.outlineStyle, oc: cs.outlineColor, oo: parseFloat(cs.outlineOffset) };
    })()`);
    if (ring && ring.fv && ring.ow >= 2) break;
  }
  ok(!!ring, 'Tab 能把焦点落到元素上');
  ok(ring && ring.fv === true, '★ 焦点态匹配 :focus-visible（键盘走到的元素）', ring && JSON.stringify(ring));
  ok(ring && ring.os !== 'none' && ring.ow >= 2, '★★ 焦点环真的画出来了（' + (ring ? ring.ow + 'px ' + ring.os : '?') + '）',
    ring && JSON.stringify({ w: ring.ow, s: ring.os, c: ring.oc }));
  ok(ring && ring.oo >= 1, '★ 焦点环有 offset（贴着边缘会像描边而不是焦点）', ring && String(ring.oo));
  if (process.env.ZOOM) {
    const dir = path.join(os.tmpdir(), 'lxw-motion');
    fs.mkdirSync(dir, { recursive: true });
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(dir, 'focus-ring.png');
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    console.log('    图：' + p);
  }

  /* ---------- [4] 按下 60ms 内有可见变化 ---------- */
  console.log('\n[4] 按压回执（按下 → 有变化 → 松开复原）');
  /* styleOf() 返回一段**完整表达式**（自带 IIFE），拼在 PICK 后面直接当 evaluate 的脚本用。 */
  const styleOf = (extra) => '(function(){ var b = _pick(); var cs = getComputedStyle(b);'
    + ' return { t: cs.transform, f: cs.filter, bg: cs.backgroundColor' + extra + ' }; })()';
  const before = await evaluate(PICK + ';' + styleOf(''));
  const atPoint = await evaluate(PICK + ';(function(){ var b = _pick(); var e = document.elementFromPoint('
    + btn.x + ',' + btn.y + '); return (e === b || (b && b.contains(e))) ? "按钮内的 " + (e.tagName) : "★ 不是按钮：" + (e ? e.tagName + "." + e.className : "null"); })()');
  console.log('    按钮 ' + btn.w + '×' + btn.h + ' @' + btn.x + ',' + btn.y + '  该点：' + atPoint);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1
  });
  await sleep(60);
  const during = await evaluate(PICK + ';' + styleOf(', active: _pick().matches(":active")'));
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1
  });
  await sleep(400);
  const after = await evaluate(PICK + ';' + styleOf(''));
  ok(during.active === true, '★ 按下时元素匹配 :active（说明按下的事件真的到了）', atPoint);
  const moved = during.t !== before.t || during.f !== before.f || during.bg !== before.bg;
  ok(moved, '★★ 按下 60ms 内就有可见变化（玩家能感觉到"按到了"）',
    JSON.stringify({ before: before, during: during }));
  ok(after.t === before.t && after.bg === before.bg, '★ 松开后回到原样（不会按一下就歪着）',
    JSON.stringify({ before: before.t, after: after.t }));

  /* ---------- [5] 减少动态效果：全都塌成约 0 ---------- */
  console.log('\n[5] prefers-reduced-motion: reduce');
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  });
  await sleep(120);
  const rm = await evaluate(`(function(){
    var b = document.getElementById('btn-create');
    var cs = getComputedStyle(b);
    /* 找一个正在跑动画的元素（脉冲点/等待呼吸），没有就用按钮兜底 */
    var cand = document.querySelector('.pulse-dot') || document.querySelector('.btn') || b;
    var ca = getComputedStyle(cand);
    return { trans: cs.transitionDuration, anim: ca.animationDuration,
             animName: ca.animationName, which: cand.className && cand.className.toString().slice(0, 20) };
  })()`);
  ok(ms(rm.trans) <= 1, '★★ 过渡被兜底关掉（' + rm.trans + '）', JSON.stringify(rm));
  ok(ms(rm.anim) <= 1, '★★ 动画被兜底关掉（' + rm.which + ' → ' + rm.anim + '）', JSON.stringify(rm));

  cdp.close();
  edge.kill();
  server.close();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await sleep(100);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
