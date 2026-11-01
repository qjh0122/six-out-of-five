/**
 * 视口贴合探针：舞台底边必须等于视口底边（竖屏 / 横屏 / PWA）
 *
 * 由来：真机反馈「PWA（添加到主屏幕）底部多出一条空白，手机浏览器打开却没有」。
 * 根因是竖版把 `vh / scale` 写成了 stage 的像素高度，而 vh 取自 `#viewport` 的
 * clientHeight —— iOS standalone 下这个读数有时比真实视口小一截，舞台就矮了，
 * 底部露出 #viewport 的纯色底。
 *
 * 这里把「读数偏小」直接打进页面（Element.clientHeight 对 #viewport 减 66），
 * 于是不需要真机也能复现：改前 stage 底边 = 778，改后 = 844。
 * 同时把 `display-mode: standalone` 打成 true，验证 .pwa 兜底那条规则挂上了。
 *
 * 为什么走 file:// 而不是本地 HTTP：
 * 这台机器上 headless Edge 连不上 127.0.0.1（连接被拒），而 game.js 本来就把
 * file:// 识别为本地演示模式（见 isLocalMode），行为与 ?mode=local 一致。
 *
 * 用法：node scripts/probe-viewport-fit.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PAGE = 'file:///' + path.join(__dirname, '..', 'pwa', 'index.html').replace(/\\/g, '/');
const CDP = 9393;
const SHOT_DIR = path.join(os.tmpdir(), 'lxw-viewport-fit');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.text) + ' :: ' + expr.slice(0, 120));
  return r.result && r.result.value;
}

/* 「iOS standalone 读数偏小」的注入：只减 #viewport 的 clientHeight，
 * 不动 CSS 视口 —— 正是真机上「JS 以为屏幕矮了、CSS 其实铺满」的那种错位。 */
function stubScript(shrink, standalone, cssViewportH, screenH, ios26H) {
  return `(function(){
    var d = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
    if (d && d.get) {
      Object.defineProperty(Element.prototype, 'clientHeight', {
        configurable: true,
        get: function(){ var v = d.get.call(this); return (this.id === 'viewport') ? Math.max(0, v - ${shrink}) : v; }
      });
    }
    ${ios26H ? `
    /* ★ iOS 26 / WebKit bug 313800 的复刻：除 100vh 之外**所有**高度读数都矮一个状态栏 ——
     * #viewport 的 rect、innerHeight、visualViewport.height、screen.height 一起变小，
     * 只有当场量的 100vh 还是整屏。这正是 32/33 章两次都修不掉的那一档：
     * 前两次用的三条来源（rect / clientHeight / screen.height）在同一条坑里。
     * 不改 CSS 布局，只让 JS 读到的数变小 —— 和真机的错位方式一致。 */
    (function(){
      var rawRect = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function(){
        var r = rawRect.call(this);
        if (this.id === 'viewport') {
          return { top: 0, left: 0, right: r.right, bottom: ${ios26H}, width: r.width, height: ${ios26H},
                   x: 0, y: 0, toJSON: function(){ return {}; } };
        }
        return r;
      };
      try { Object.defineProperty(window, 'innerHeight', { configurable: true, get: function(){ return ${ios26H}; } }); } catch (e) {}
      try {
        Object.defineProperty(window, 'visualViewport', { configurable: true, get: function(){
          return { width: 390, height: ${ios26H}, offsetTop: 0, offsetLeft: 0, scale: 1,
                   addEventListener: function(){}, removeEventListener: function(){} };
        } });
      } catch (e) {}
    })();
    ` : ''}
    ${screenH ? `
    /* 模拟「物理屏 852、布局视口只有 790」：screen.height 是独立于视口的另一条读数，
     * 正是 game.js 用来校正的那个依据。 */
    try { Object.defineProperty(Screen.prototype, 'height', { configurable: true, get: function(){ return ${screenH}; } }); } catch (e) {}
    ` : ''}
    ${cssViewportH ? `
    /* 连 CSS 的 100% 也一起变小（#viewport 被强制成 790 高）——
     * 这一档是上一版「只改 calc(100%)」救不回来的情形，必须靠 screen.height 兜上来的
     * --vp-h（v81 起高度统一走这个变量，旧的 --pt-h 已删）。 */
    (function(){
      var iv = setInterval(function(){
        if (document.head) {
          var s = document.createElement('style');
          s.textContent = '#viewport{height:${cssViewportH}px !important}';
          document.head.appendChild(s);
          clearInterval(iv);
        }
      }, 1);
    })();
    ` : ''}
    ${standalone ? `
    var mm = window.matchMedia;
    window.matchMedia = function(q){
      if (typeof q === 'string' && q.indexOf('display-mode: standalone') >= 0) {
        return { matches: true, media: q, addEventListener: function(){}, removeEventListener: function(){},
                 addListener: function(){}, removeListener: function(){} };
      }
      return mm.apply(window, arguments);
    };
    try { Object.defineProperty(navigator, 'standalone', { configurable: true, get: function(){ return true; } }); } catch (e) {}
    ` : ''}
  })()`;
}

const MEASURE = `(function(){
  var st = document.getElementById('stage');
  var vp = document.getElementById('viewport');
  var sr = st.getBoundingClientRect();
  var vr = vp.getBoundingClientRect();
  return {
    innerH: innerHeight,
    vhCss: Math.round(document.documentElement.clientHeight),
    vpClientH: vp.clientHeight,
    vpBottom: Math.round(vr.bottom),
    stageTop: Math.round(sr.top),
    stageBottom: Math.round(sr.bottom),
    stageH: Math.round(sr.height),
    /* 这三层以前全是 100%（= 布局视口），正是它们把高出布局视口的舞台裁掉了。
     * 现在必须一起等于 --vp-h，否则「算得对、画不出来」。 */
    bodyH: Math.round(document.body.getBoundingClientRect().height),
    htmlH: Math.round(document.documentElement.getBoundingClientRect().height),
    vpH: document.documentElement.style.getPropertyValue('--vp-h') || '',
    ls: st.classList.contains('ls'),
    pwa: st.classList.contains('pwa'),
    ptScale: st.style.getPropertyValue('--pt-scale') || '(未设)',
    compactV: st.classList.contains('compact-v'),
    inlineH: st.style.height || ''
  };
})()`;

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
  const p = path.join(SHOT_DIR, name + '.png');
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
}

async function loadCase(cdp, label, w, h, shrink, standalone, opts) {
  opts = opts || {};
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  /* 每次导航前重装注入脚本：先清掉上一轮的 */
  const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: stubScript(shrink, standalone, opts.cssViewportH || 0, opts.screenH || 0, opts.ios26H || 0)
  });
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(1400);
  /* 关掉新手引导：它整屏盖住首页，量出来的「最底元素」永远是引导卡片 */
  await evaluate(cdp, `(function(){ try { localStorage.setItem('lxw_guide_seen_v1','1'); } catch (e) {} return 1; })()`);
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(1700);
  const m = await evaluate(cdp, MEASURE);
  /* 底边 4px 处命中的是谁：stage = 那一条被舞台画到了；body/viewport = 还是露底色。
   * 这条比 rect 更硬 —— 33 章的教训就是「rect 到了底、像素没到」。 */
  const hit = await evaluate(cdp, `(function(){
    var e = document.elementFromPoint(${Math.round(w / 2)}, ${h - 4});
    var st = document.getElementById('stage');
    if (!e) return '(none)';
    return (st && st.contains(e)) ? 'stage' : (e.id || e.tagName);
  })()`);
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });

  /* 断言只看「舞台底边有没有到屏底」：差 1 css 是取整误差，差 20 以上就是露底。
   * 基准用机型高 h 而不是 innerHeight —— iOS 26 下 innerHeight 本身就是那条假读数。 */
  const gap = h - m.stageBottom;
  console.log('\n----- ' + label + '  ' + w + '×' + h + ' -----');
  console.log('  innerH ' + m.innerH + '  vp.clientH ' + m.vpClientH + '  stage ' + m.stageTop + '→' + m.stageBottom +
    ' (h ' + m.stageH + ')  --pt-scale ' + m.ptScale + '  --vp-h ' + (m.vpH || '(未设)') + '  内联高 ' + (m.inlineH || '(空)'));
  console.log('  body ' + m.bodyH + '  html ' + m.htmlH + '  底部命中 ' + hit);
  console.log('  .ls ' + m.ls + '  .pwa ' + m.pwa + '  .compact-v ' + m.compactV + '  截图 ' + (await shot(cdp, label.replace(/[^\w-]/g, '_'))));

  ok(Math.abs(gap) <= 1, '★ ' + label + '：舞台铺到屏底', '差 ' + gap + ' CSS px');
  ok(m.inlineH === '', '★ ' + label + '：高度不再是 JS 写死的像素值', '内联 height=' + (m.inlineH || '(空)'));
  /* 裁切守卫：这三层只要有一个比 --vp-h 小，舞台就会被它裁掉（33 章漏掉的那一环）。 */
  const vpH = parseInt(m.vpH, 10) || 0;
  ok(vpH > 0 && Math.abs(m.bodyH - vpH) <= 1 && Math.abs(m.htmlH - vpH) <= 1,
    '★ ' + label + '：html/body 跟着 --vp-h（没有谁在裁舞台）',
    '--vp-h=' + m.vpH + ' body=' + m.bodyH + ' html=' + m.htmlH);
  ok(hit === 'stage', '★ ' + label + '：底边 4px 处画的是舞台，不是底色', '命中 ' + hit);
  return m;
}

async function main() {
  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lxw-vf-' + Date.now()),
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

  /* 1) 浏览器里的正常手机竖屏 */
  const a = await loadCase(cdp, '竖屏-浏览器', 390, 844, 0, false);
  ok(!a.pwa, '★ 浏览器里不挂 .pwa（不然 100vh 兜底会裁底部留白）', '.pwa=' + a.pwa);

  /* 2) iOS PWA standalone：读数比真实视口小 66px（复现用户截图） */
  const b = await loadCase(cdp, '竖屏-PWA读数偏小', 390, 844, 66, true);
  ok(b.pwa, '★ PWA standalone 下挂 .pwa（启用 100vh 兜底）', '.pwa=' + b.pwa);

  /* 3) 横屏仍然铺满（第 26 章修过的那条，别被这轮带回去） */
  const c = await loadCase(cdp, '横屏', 844, 390, 0, false);
  ok(c.ls, '★ 横屏仍走 .ls 版式', '.ls=' + c.ls);

  /* 4) 真机实况：布局视口本身只有 790（不是 JS 读错，是 100% 和 100vh 一起变小），
   *    而屏幕是 852。上一版只用 calc(100%) 反算，这一档救不回来 ——
   *    必须靠 screen.height 校正出来的 --vp-h 兜住。 */
  const d = await loadCase(cdp, '竖屏-PWA视口本身偏小', 390, 852, 0, true, { cssViewportH: 790, screenH: 852 });
  ok(d.vpH === '852px', '★ 采用屏幕高（852px）校正读数', '--vp-h=' + d.vpH);
  ok(Math.abs(d.stageBottom - 852) <= 1, '★ 视口读数小时舞台仍铺到屏底',
    '舞台底 ' + d.stageBottom + ' / 屏 852');

  /* 5) ★ iOS 26 standalone（WebKit bug 313800）：除了当场量的 100vh，
   *    其他**所有**高度读数都矮一个状态栏（这里矮 56）。32 章的 calc(100%) 和
   *    33 章的 screen.height 都在这条坑里 —— 这就是那条色带两次都没修掉的原因。
   *    这一档必须靠 100vh 这条来源救回来。 */
  const e5 = await loadCase(cdp, 'iOS26-PWA全部读数矮一栏', 390, 852, 0, true, { ios26H: 796, screenH: 796 });
  ok(e5.vpH === '852px', '★ 只有 100vh 是真屏高时也采纳它（852px）', '--vp-h=' + e5.vpH);
  ok(Math.abs(e5.stageBottom - 852) <= 1, '★ 这一档舞台同样铺到屏底', '舞台底 ' + e5.stageBottom + ' / 屏 852');

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('截图目录 ' + SHOT_DIR);
  cdp.close();
  edge.kill();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
