/**
 * 首屏防闪验证：未登录时，CSS 应用后的**第一帧**到底显示的是哪个页面
 *
 * 为什么不能靠"看正常打开的页面"来判断：
 * boot 跑完之后 showScreen 会把状态修正到正确值，那时看到的永远是"对的"。
 * 闪烁只存在于「CSS 已应用、boot 还没跑」那几十到几百毫秒里，正常加载根本抓不住。
 *
 * 所以这个探针做的事很直接 —— **把 game.js 弄成 404**：
 *   · HTML 照常解析，style.css 照常应用，其他库（engine/card/…）照常加载；
 *   · 只有负责 boot 和切屏的 game.js 不执行。
 * 于是页面就永远停在"首帧"那个状态上，可以从容地量。
 *
 * 量两件事：
 *   A. 没有会话（localStorage 为空）→ 必须看到登录页，首页必须 display:none
 *   B. 有会话（localStorage 里有 token）→ 必须看到首页，不能把老用户挡在登录页
 *
 * 用法：node scripts/probe-first-paint.js [宽] [高]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
const STATIC_PORT = 3047;
const CDP_PORT = 9379;
const ROOT = path.join(__dirname, '..', 'pwa');
const SHOT_DIR = path.join(os.tmpdir(), 'lxw-firstpaint');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';

  /* 关键：默认让 boot 永不执行。其它脚本一个不少 —— 少加载别的会改变解析时序，
   * 那样量到的就不是"真实首帧"了。D 段会把它放开，用来对比"boot 跑完之后"的状态。 */
  if (BLOCK_GAME_JS && p === '/js/game.js') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('// blocked on purpose: see probe-first-paint.js');
    return;
  }

  const abs = path.join(ROOT, p);
  if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(abs, (e, buf) => {
    if (e) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
  });
});

let BLOCK_GAME_JS = true;

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

let pass = 0; let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await new Promise((r) => server.listen(STATIC_PORT, '127.0.0.1', r));

  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lxw-fp-edge-' + Date.now()),
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __error: String(r.exceptionDetails.text) };
    return r.result && r.result.value;
  };

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(SHOT_DIR, name + '.png');
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  };

  const URL0 = 'http://127.0.0.1:' + STATIC_PORT + '/?sharecode=PROBE';

  /* ================================================================
   * A. 未登录
   * ============================================================== */
  console.log('[A] 未登录时的首帧');
  await cdp.send('Page.navigate', { url: URL0 });
  await sleep(2000);
  await evaluate("try{localStorage.clear()}catch(e){}");
  await cdp.send('Page.navigate', { url: URL0 });
  await sleep(2000);

  const noSession = await evaluate(`(function(){
    var h = document.getElementById('screen-home');
    var a = document.getElementById('screen-auth');
    return {
      htmlClass: document.documentElement.className,
      home: h ? getComputedStyle(h).display : 'MISSING',
      auth: a ? getComputedStyle(a).display : 'MISSING',
      gameJsRan: typeof window.__lxwBooted !== 'undefined' || !!document.getElementById('btn-auth-submit')
    };
  })()`);

  console.log('    html.className = ' + JSON.stringify(noSession.htmlClass));
  console.log('    #screen-home display = ' + noSession.home);
  console.log('    #screen-auth display = ' + noSession.auth);

  ok(String(noSession.htmlClass).indexOf('no-session') >= 0,
    '★ 未登录时 <html> 挂上了 .no-session', noSession.htmlClass);
  ok(noSession.home === 'none',
    '★ 首帧里首页是 display:none（不再闪一下首页）', noSession.home);
  ok(noSession.auth !== 'none' && noSession.auth !== 'MISSING',
    '★ 首帧里登录页是可见的（不是白屏）', noSession.auth);
  console.log('    截图：' + await shot('no-session'));

  /* 预缩放：750 设计空间必须已经在 head 里收进屏幕。
   * 这是比"闪一下首页"更严重的那半个问题 —— 不修的话，boot 之前用户看到的是
   * 一屏放大到溢出、只剩左上角的内容。 */
  const earlyScale = await evaluate(`(function(){
    var st = document.getElementById('stage');
    if (!st) return { skip: 'no-stage' };
    var rect = st.getBoundingClientRect();
    return {
      rectW: Math.round(rect.width),
      vw: window.innerWidth,
      cssVar: getComputedStyle(st).getPropertyValue('--pt-scale').trim(),
      htmlVar: document.documentElement.style.getPropertyValue('--pt-scale').trim(),
      transform: getComputedStyle(st).transform
    };
  })()`);
  console.log('    舞台渲染宽 ' + earlyScale.rectW + 'px，视口 ' + earlyScale.vw + 'px，'
    + 'transform=' + earlyScale.transform);

  ok(!earlyScale.skip, '找到 #stage');
  ok(Math.abs(earlyScale.rectW - earlyScale.vw) <= 2,
    '★ 首帧舞台宽度 = 视口宽（不再 1:1 溢出到 750）',
    '舞台 ' + earlyScale.rectW + ' vs 视口 ' + earlyScale.vw);
  ok(/matrix\(0?\.\d/.test(String(earlyScale.transform)) && earlyScale.transform.indexOf('matrix(1,') < 0,
    '★ 首帧已经应用了非 1 的缩放', earlyScale.transform);

  /* ================================================================
   * B. 有会话
   * ============================================================== */
  console.log('\n[B] 有会话时的首帧');
  await evaluate(`(function(){
    try {
      localStorage.setItem('lxw_session_v1', JSON.stringify({
        token: 'probe-token', playerId: 'p_probe', nickname: '探针'
      }));
    } catch (e) {}
    return 1;
  })()`);
  await cdp.send('Page.navigate', { url: URL0 });
  await sleep(2000);

  const withSession = await evaluate(`(function(){
    var h = document.getElementById('screen-home');
    var a = document.getElementById('screen-auth');
    return {
      htmlClass: document.documentElement.className,
      home: h ? getComputedStyle(h).display : 'MISSING',
      auth: a ? getComputedStyle(a).display : 'MISSING'
    };
  })()`);

  console.log('    html.className = ' + JSON.stringify(withSession.htmlClass));
  console.log('    #screen-home display = ' + withSession.home);
  console.log('    #screen-auth display = ' + withSession.auth);

  ok(String(withSession.htmlClass).indexOf('no-session') < 0,
    '★ 有会话时没挂 .no-session（老用户不会被挡在登录页）', withSession.htmlClass);
  ok(withSession.home !== 'none' && withSession.home !== 'MISSING',
    '★ 有会话时首帧就是首页（不用等 boot）', withSession.home);
  console.log('    截图：' + await shot('with-session'));

  /* ================================================================
   * C. 兜底：存储不可用时必须按「已登录」处理，不能白屏
   * ============================================================== */
  console.log('\n[C] localStorage 抛异常时的兜底');
  {
    /* 用 addScriptToEvaluateOnNewDocument 在页面脚本之前把 localStorage 换成一个会抛的桩。
     * 期望：不加 .no-session（当作已登录）→ 首页可见 → 至少不是白屏。 */
    const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(function(){
        try {
          Object.defineProperty(window, 'localStorage', {
            get: function () { throw new Error('blocked'); }
          });
        } catch (e) {}
      })();`
    });
    await cdp.send('Page.navigate', { url: URL0 });
    await sleep(1800);

    const broken = await evaluate(`(function(){
      var h = document.getElementById('screen-home');
      var a = document.getElementById('screen-auth');
      return {
        htmlClass: document.documentElement.className,
        home: h ? getComputedStyle(h).display : 'MISSING',
        auth: a ? getComputedStyle(a).display : 'MISSING'
      };
    })()`);
    console.log('    html.className = ' + JSON.stringify(broken.htmlClass)
      + '  home=' + broken.home + '  auth=' + broken.auth);

    ok(String(broken.htmlClass).indexOf('no-session') < 0,
      '★ 读存储抛异常时不挂 .no-session（按已登录兜底）', broken.htmlClass);
    ok(broken.home !== 'none' || broken.auth !== 'none',
      '★ 不会出现两个页面都不可见（不会白屏）',
      'home=' + broken.home + ' auth=' + broken.auth);

    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }

  /* ================================================================
   * D. 放开 game.js：boot 跑完之后，缩放必须与 head 预算的值一致（不能跳变）
   * ============================================================== */
  console.log('\n[D] boot 接管后与首帧预缩放是否一致（不能跳变）');
  {
    BLOCK_GAME_JS = false;

    /* 先把 head 预缩放的值记下来：起一个干净页（仍拦截）读一次 */
    BLOCK_GAME_JS = true;
    await cdp.send('Page.navigate', { url: URL0 });
    await sleep(1500);
    const early = await evaluate(`(function(){
      var st = document.getElementById('stage');
      return { w: Math.round(st.getBoundingClientRect().width), vw: window.innerWidth };
    })()`);

    /* 再放开 game.js 跑完整 boot，量最终值 */
    BLOCK_GAME_JS = false;
    await cdp.send('Page.navigate', { url: URL0 });
    await sleep(2800);
    const booted = await evaluate(`(function(){
      var st = document.getElementById('stage');
      if (!st) return { skip: 'no-stage' };
      return {
        w: Math.round(st.getBoundingClientRect().width),
        vw: window.innerWidth,
        inlinePtScale: st.style.getPropertyValue('--pt-scale').trim(),
        hasLsClass: st.classList.contains('ls')
      };
    })()`);

    console.log('    首帧（预缩放）宽 ' + early.w + 'px → boot 后 ' + booted.w + 'px');
    ok(Math.abs(booted.w - early.w) <= 2,
      '★ boot 接管后舞台宽度与首帧一致（用户看不到缩放跳变）',
      early.w + ' → ' + booted.w);
    ok(booted.inlinePtScale !== '' || booted.hasLsClass,
      '★ game.js 确实写入了自己的缩放（内联 --pt-scale 或切了 .ls）',
      JSON.stringify(booted));
  }

  console.log('\n截图目录：' + SHOT_DIR);
  console.log('\n========================================');
  console.log(fail === 0 ? '全部通过' : '有失败');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');

  try { edge.kill(); } catch (e) {}
  server.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
