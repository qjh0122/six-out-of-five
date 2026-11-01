/**
 * 机型矩阵探针（一次性诊断脚本，不进测试套件）
 *
 * 回答一个问题：**哪些机型/窗口能上圆桌，分别落在哪一档，牌面多大。**
 *
 * 为什么不能靠算术推：档位判定读的是 lastStageH / lastStageScale，来自 resize()
 * 里的 availW / availH / 安全区；而档位边界全卡在整数阈值上（1200 / 1500 / 1000 / 0.47 / 0.5），
 * 差 20 设计px 就跨档了。手算能算个大概，但断不出「这一档到底进没进」。
 *
 * ★ 为什么要**每个机型重新加载一次**，而不是改完视口直接量：
 *   试过只调 setDeviceMetricsOverride 再补一个 resize 事件 —— 量出来的横屏行
 *   设计高等于竖屏值、`rt-narrow` / `rt-desktop` 一个都没挂上，而组槽溢出 611。
 *   那是「DOM 已按新视口算了 scale，但 `--vp-h` 还是旧值」的中间态，
 *   数字看着像真的，其实整张表都不可信。改成 reload 之后每一档都是干净首帧。
 *
 * 用法：node scripts/probe-devices.js [--csv]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const CDP_PORT = 9355;
const ROOT = path.join(__dirname, '..', 'pwa');
const CSV = process.argv.includes('--csv');
const SHOTS = process.argv.includes('--shots');
/* --ready 停在「准备中」那一屏（不进牌桌），用来量房间页/准备页 */
const READY_ONLY = process.argv.includes('--ready');
/* --home 停在首页（只登录、不进房）：用来确认版式改判没有把首页挤坏。
 * 960×1040 这类窄高窗口改走横版之后，横版画布会比设计稿高一倍，首页最容易被拉散。 */
const HOME_ONLY = process.argv.includes('--home');
/* --assert：把「支持」当协议跑，逐档检查四条硬指标。退出码非 0 = 有档位不达标。 */
const ASSERT = process.argv.includes('--assert');
const SHOT_DIR = path.join(__dirname, '..', 'tmp-shots', 'devices');
/* ONLY=子串 只跑名称匹配的机型（补跑几张图时用，省掉整表 40 秒） */
const ONLY = process.env.ONLY || '';
/* 截图轮把倍率降到 1：4K 尺寸下 dpr=2 的截图是 7680×4120、十几 MB，
 * 实测会把 headless 卡住十几分钟。数据轮仍用 2 倍（更接近真机渲染）。 */
const DSF = SHOTS ? 1 : 2;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json', '.json': 'application/json'
};

/* ---------------------------- 机型矩阵 ----------------------------
 * 全部是 CSS px（= 浏览器视口）。桌面行的高度是**扣掉浏览器 UI 之后的内容区**：
 * 24 寸 1080p 的 Chrome 内容区约 947，27 寸 1440p 约 1307。
 * 直接写 1080 / 1440 会高估一档 —— 高度正是这里的判据。
 */
const DEVICES = [
  // ---- iPhone ----
  { g: 'iPhone', m: 'SE 1 代 竖', w: 320, h: 568 },
  { g: 'iPhone', m: 'SE 1 代 横', w: 568, h: 320 },
  { g: 'iPhone', m: 'SE 2/3 竖（375×667）', w: 375, h: 667 },
  { g: 'iPhone', m: 'SE 2/3 横', w: 667, h: 375 },
  { g: 'iPhone', m: '14/15 竖（390×844）', w: 390, h: 844 },
  { g: 'iPhone', m: '14/15 横（844×390）', w: 844, h: 390 },
  { g: 'iPhone', m: '15 Pro Max 竖（430×932）', w: 430, h: 932 },
  { g: 'iPhone', m: '15 Pro Max 横', w: 932, h: 430 },
  // ---- 安卓 ----
  { g: '安卓', m: '360×640 竖（16:9）', w: 360, h: 640 },
  { g: '安卓', m: '360×640 横', w: 640, h: 360 },
  { g: '安卓', m: '360×800 竖（20:9）', w: 360, h: 800 },
  { g: '安卓', m: '360×800 横', w: 800, h: 360 },
  { g: '安卓', m: 'Pixel 7 竖（412×915）', w: 412, h: 915 },
  { g: '安卓', m: 'Pixel 7 横', w: 915, h: 412 },
  // ---- 平板 ----
  { g: '平板', m: 'iPad 竖（768×1024）', w: 768, h: 1024 },
  { g: '平板', m: 'iPad 横（1024×768）', w: 1024, h: 768 },
  { g: '平板', m: 'iPad 竖（820×1180）', w: 820, h: 1180 },
  { g: '平板', m: 'iPad 横（1180×820）', w: 1180, h: 820 },
  { g: '平板', m: 'iPad Pro12.9 竖（1024×1366）', w: 1024, h: 1366 },
  { g: '平板', m: 'iPad Pro12.9 横（1366×1024）', w: 1366, h: 1024 },
  // ---- 折叠屏 ----
  { g: '折叠屏', m: 'Z Fold 外屏 竖（344×882）', w: 344, h: 882 },
  { g: '折叠屏', m: 'Z Fold 外屏 横', w: 882, h: 344 },
  { g: '折叠屏', m: 'Pixel Fold 内屏 竖（673×841）', w: 673, h: 841 },
  { g: '折叠屏', m: 'Pixel Fold 内屏 横', w: 841, h: 673 },
  // ---- 电脑（窗口内容区）----
  { g: '电脑', m: '窗口 728×348（= 1092×522 @150%）', w: 728, h: 348 },
  { g: '电脑', m: '窗口 1092×522（2.09:1）', w: 1092, h: 522 },
  { g: '电脑', m: '窗口 1092×460（2.37:1）', w: 1092, h: 460 },
  { g: '电脑', m: '窗口 1280×720（16:9）', w: 1280, h: 720 },
  { g: '电脑', m: '窗口 1536×730（16:9 @125%）', w: 1536, h: 730 },
  { g: '电脑', m: '窗口 1440×900（13" 笔记本）', w: 1440, h: 900 },
  { g: '电脑', m: '13" 1366×650', w: 1366, h: 650 },
  /* 桌面特有的坑：把窗口拉成「窄高」（左右分屏）。此时 w<h 被判成竖屏版式，
   * 而竖屏圆桌要 stageH ≥1200（= 750×高宽比，需要近乎 9:19.5 的长条）——
   * 桌面分屏的高宽比只有 1.0~1.3，永远够不到。 */
  { g: '电脑', m: '分屏 960×1040（1920 屏左右各半）', w: 960, h: 1040 },
  { g: '电脑', m: '分屏 960×940（笔记本左右各半）', w: 960, h: 940 },
  { g: '电脑', m: '24" 1080p 全屏 1920×947', w: 1920, h: 947 },
  { g: '电脑', m: '24" 1200p 全屏 1920×1040', w: 1920, h: 1040 },
  { g: '电脑', m: '27" 1440p 全屏 2560×1307', w: 2560, h: 1307 },
  { g: '电脑', m: '4K 全屏 3840×2060', w: 3840, h: 2060 }
];

/* ---------------------------- 静态服务 ---------------------------- */
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

const SRV_PORT = 3041;
let serverProc = null;
function startApp() {
  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(SRV_PORT),
      PROFILE_FILE: path.join(os.tmpdir(), 'lxw-dev-' + Date.now(), 'profiles.json'),
      SEED_FILE: path.join(os.tmpdir(), 'lxw-dev-seed-' + Date.now() + '.json')
    }),
    stdio: 'ignore'
  });
}

function waitApp() {
  return new Promise((resolve, reject) => {
    let tries = 0;
    (function tick() {
      tries += 1;
      http.get('http://127.0.0.1:' + SRV_PORT + '/api/health', (res) => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (tries > 60) return reject(new Error('服务端没起来'));
        setTimeout(tick, 250);
      });
    })();
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

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 只登录、不建房：--home 用（首页版式检查）。
 * 与 ENTER_TABLE 的前半段同源，但停在首页 —— 复制而不是复用，
 * 是因为「进了牌桌」本身就是 ENTER_TABLE 的成功判据，拆不干净。 */
const LOGIN_ONLY = `(async function(){
  function byId(id){ return document.getElementById(id); }
  function click(id){ var b = byId(id); if (b) { b.click(); return true; } return false; }
  function vis(id){ var e = byId(id); return !!(e && !e.classList.contains('hidden')); }
  function sleep(ms){ return new Promise(function(s){ setTimeout(s, ms); }); }
  try { localStorage.setItem('lxw_guide_seen_v1','1'); } catch (e) {}
  if (vis('screen-auth')) {
    var tab = document.querySelector('[data-auth-tab="register"]');
    if (tab) tab.click();
    await sleep(250);
    byId('auth-name').value = 'devp' + Math.floor(Math.random()*100000);
    byId('auth-pass').value = 'probe123456';
    var nick = byId('auth-nick');
    if (nick && !nick.closest('.hidden')) nick.value = '探' + Math.floor(Math.random()*9000 + 1000);
    click('btn-auth-submit');
    await sleep(2000);
    if (vis('screen-auth')) {
      document.querySelector('[data-auth-tab="login"]').click();
      await sleep(300);
      byId('auth-name').value = 'devmain';
      byId('auth-pass').value = 'probe123456';
      click('btn-auth-submit');
      await sleep(2000);
    }
  }
  return { screen: vis('screen-home') ? 'home' : 'other' };
})()`;

/* 关掉首次引导卡（新注册账号每次都会弹，遮住首页就没法看版式） */
const DISMISS_GUIDE = `(function(){
  function byId(id){ return document.getElementById(id); }
  var g = byId('guide-modal');
  if (!g || g.classList.contains('hidden')) return 'none';
  var s = byId('guide-skip');
  if (s) { s.click(); return 'skip'; }
  var n = byId('guide-next');
  if (n) { n.click(); return 'next'; }
  return 'stuck';
})()`;

/* 进牌桌：登录状态靠 localStorage 延续，所以多数轮次只需要建房。
 * 裸 id 必须走 getElementById —— querySelector('btn-create') 是在找同名标签，静默返回 null。 */
const ENTER_TABLE = `(async function(){
  function byId(id){ return document.getElementById(id); }
  function click(id){ var b = byId(id); if (b) { b.click(); return true; } return false; }
  function vis(id){ var e = byId(id); return !!(e && !e.classList.contains('hidden')); }
  function sleep(ms){ return new Promise(function(s){ setTimeout(s, ms); }); }
  try { localStorage.setItem('lxw_guide_seen_v1','1'); } catch (e) {}

  if (vis('screen-auth')) {
    var tab = document.querySelector('[data-auth-tab="register"]');
    if (tab) tab.click();
    await sleep(250);
    byId('auth-name').value = 'devp' + Math.floor(Math.random()*100000);
    byId('auth-pass').value = 'probe123456';
    var nick = byId('auth-nick');
    if (nick && !nick.closest('.hidden')) nick.value = '探' + Math.floor(Math.random()*9000 + 1000);
    click('btn-auth-submit');
    await sleep(2000);
    if (vis('screen-auth')) {
      document.querySelector('[data-auth-tab="login"]').click();
      await sleep(300);
      byId('auth-name').value = 'devmain';
      byId('auth-pass').value = 'probe123456';
      click('btn-auth-submit');
      await sleep(2000);
    }
  }
  if (vis('screen-game')) return { already: true };

  var nk = byId('nickname-input');
  if (nk) { nk.value = '探针'; nk.dispatchEvent(new Event('input',{bubbles:true})); }
  /* v99 起建房要过一道局数弹框：btn-create 只开弹窗，btn-create-confirm 才真建。 */
  var opened = click('btn-create');
  await sleep(450);
  var confirmed = click('btn-create-confirm');
  await sleep(800);
  var bots = 0;
  for (var i = 0; i < 6; i++) {
    var b = byId('btn-add-bot');
    if (!b || b.classList.contains('hidden')) break;
    b.click(); bots++; await sleep(650);
  }
  var gm = byId('guide-modal');
  if (gm && !gm.classList.contains('hidden')) {
    var gs = byId('guide-skip'); if (gs) gs.click();
    await sleep(300);
  }
  if (window.__READY_STOP__) return { ready: false, stopped: 'ready', bots: bots,
           game: vis('screen-game'), room: vis('screen-room') };
  var ready = click('btn-ready');
  await sleep(1600);
  return { opened: opened, confirmed: confirmed, bots: bots, ready: ready,
           game: vis('screen-game'), room: vis('screen-room'), auth: vis('screen-auth') };
})()`;

/* 量尺：offsetWidth/Height 是布局尺寸（transform 之前）= 设计像素，
 * getBoundingClientRect 是缩放后的 CSS 像素，两者相除即真实 scale。 */
const MEASURE = `(function(){
  var stage = document.getElementById('stage');
  var top = document.getElementById('game-top');
  var screen = document.getElementById('screen-game');
  var slots = document.getElementById('slots');
  var vw = window.innerWidth, vh = window.innerHeight;
  var designW = stage.offsetWidth, designH = stage.offsetHeight;
  var rect = stage.getBoundingClientRect();
  var scale = designW ? rect.width / designW : 0;
  function cssW(el){ if (!el) return null; return Math.round(el.getBoundingClientRect().width * 10) / 10; }
  function box(el){ if (!el) return null; var r = el.getBoundingClientRect();
    return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }
  var cardBox = document.querySelector('#slots .card-box');
  var av = document.querySelector('#game-top .opp-avatar');
  var emo = document.querySelector('#game-top .gt-emo');
  var nm = document.querySelector('#game-top .opp-name');
  var nmFont = nm ? parseFloat(getComputedStyle(nm).fontSize) : 0;
  var ring = top ? top.classList.contains('gt-ring') : false;
  var mode = 'normal';
  if (top && top.classList.contains('rt-compact')) mode = 'compact';
  else if (screen && screen.classList.contains('rt-desktop')) mode = 'desktop';
  else if (screen && screen.classList.contains('rt-narrow')) mode = 'narrow';
  return {
    vw: vw, vh: vh,
    designW: designW, designH: Math.round(designH),
    scale: Math.round(scale * 1000) / 1000,
    ls: stage.classList.contains('ls'),
    compactV: stage.classList.contains('compact-v'),
    lsTight: stage.classList.contains('ls-tight'),
    ring: ring,
    ringMode: mode,
    cardW: cardBox ? cardBox.offsetWidth : null,
    cardH: cardBox ? cardBox.offsetHeight : null,
    avatarCss: av ? cssW(av) : null,
    emoCss: emo ? cssW(emo) : null,
    nameVis: nmFont ? Math.round(nmFont * scale * 100) / 100 : null,
    tapVar: (function(){ var st = document.getElementById('stage');
      return st ? getComputedStyle(st).getPropertyValue('--tap-min').trim() : ''; })(),
    emoRect: emo ? Math.round(emo.getBoundingClientRect().width * 10) / 10 : null,
    emoW: emo ? getComputedStyle(emo).width : null,
    emoInStage: emo ? document.getElementById('stage').contains(emo) : null,
    emoTap: emo ? getComputedStyle(emo).getPropertyValue('--tap-min').trim() : null,
    emoCls: emo ? emo.className : null,
    emoRules: (function(){ var out = [];
      for (var i = 0; i < document.styleSheets.length; i++) {
        var ss = document.styleSheets[i]; var rs;
        try { rs = ss.cssRules; } catch (e) { continue; }
        for (var j = 0; j < rs.length; j++) {
          var r = rs[j];
          if (r.selectorText && r.selectorText.indexOf('gt-emo') >= 0)
            out.push(r.selectorText + ' { ' + r.style.width + ' }');
        }
      }
      return out; })(),
    emoParentCls: emo && emo.parentNode ? emo.parentNode.className : null,
    readyDetail: (function(){
      function r(id){ var e = document.getElementById(id); if (!e) return null;
        var b = e.getBoundingClientRect();
        return { h: Math.round(b.height), sh: e.scrollHeight, ch: e.clientHeight,
                 top: Math.round(b.top), bot: Math.round(b.bottom) }; }
      var sg = document.getElementById('screen-game');
      return { tr: r('table-ready'), acts: r('ready-acts'), hint: r('room-hint'),
               game: sg ? { h: Math.round(sg.getBoundingClientRect().height),
                            sh: sg.scrollHeight, ch: sg.clientHeight, top: Math.round(sg.getBoundingClientRect().top) } : null };
    })(),
    slotsOverflow: slots ? (slots.scrollHeight - slots.clientHeight) : null,
    topBox: box(top), readyBox: box(document.getElementById('table-ready')),
    actsBox: box(document.getElementById('ready-acts')), screenBox: box(screen)
  };
})()`;

async function main() {
  startApp();
  await waitApp();
  server.listen(3040, () => console.log('静态 :3040 / 应用 :' + SRV_PORT));

  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lxw-dev-' + Date.now()),
    '--window-size=390,844', '--force-device-scale-factor=1',
    'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const list = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      const page = (list || []).find((t) => t.type === 'page');
      if (page) { target = page; break; }
    } catch (e) { /* 还没起来 */ }
  }
  if (!target) { console.error('连不上 Edge CDP'); edge.kill(); process.exit(1); }

  const cdp = await cdpConnect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument',
    { source: 'window.__READY_STOP__ = ' + READY_ONLY + ';' });

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { error: String(r.exceptionDetails.text) };
    return r.result && r.result.value;
  };

  const rows = [];
  /* 四条硬指标（写在跑之前，事后不改）：
   *   1. 进了桌就必须不溢出（slotsOverflow <= 0）
   *   2. 牌面 >= 39 CSS px 宽。39 不是拍的：16:9 竖屏紧凑档实测就是 39.4
   *      （82×115 设计px × 0.48），而这一档替换掉的 v86 版式是 62×87 设计px（29.8 CSS）
   *      —— 阈值取在这里是「抓比紧凑档更小的回归」，不是把 360×640 判死。
   *   3. 表情入口 >= 44 CSS px（对局里唯一的表情入口）
   *   4. 座位昵称 >= 10.4 CSS px
   * 只对「RingGate 判定为支持」的档位生效 —— 所以它不能被「把桌子关掉」糊弄过去，
   * 另有一条「三族都必须有档位进桌」防这条路。 */
  const bad = [];
  /* 软门：平板 / 折叠屏的记录项（用户裁定「可以不支持」，不阻塞发布） */
  const soft = [];
  /* 必须支持的三族。加族要同时改文档，否则「支持」这词就散了。 */
  const HARD_FAMILIES = ['iPhone', '安卓', '电脑'];
  const onByGroup = {};
  function chk(cond, label) { if (!cond) bad.push(label); }
  console.log('\n每档重新加载 + 进牌桌（5 人局：我 + 4 个 AI）\n');
  if (!CSV) {
    console.log('机型'.padEnd(30) + '设计高'.padStart(7) + 'scale'.padStart(7) + '  档位'.padEnd(10) + '牌面(设计)'.padEnd(14) + '溢出');
  }

  for (let idx = 0; idx < DEVICES.length; idx++) {
    const d = DEVICES[idx];
    if (ONLY && (d.g + d.m).indexOf(ONLY) < 0) continue;
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: d.w, height: d.h, deviceScaleFactor: DSF, mobile: true
    });
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + SRV_PORT + '/' });

    /* 等页面稳定（首次加载要注册 SW，可能自己 reload 一次） */
    let stable = 0;
    for (let i = 0; i < 40 && stable < 2; i++) {
      await sleep(250);
      const rs = await evaluate('document.readyState');
      stable = rs === 'complete' ? stable + 1 : 0;
    }

    const flow = await evaluate(HOME_ONLY ? LOGIN_ONLY : ENTER_TABLE);
    if (HOME_ONLY) {
      await sleep(600);
      await evaluate(DISMISS_GUIDE);
      await sleep(400);
      const slug = (d.g + '-' + d.m).replace(/[^\w\u4e00-\u9fa5]+/g, '_');
      if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
      const cs = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOT_DIR, 'HOME-' + slug + '.png'), Buffer.from(cs.data, 'base64'));
      const hb = await evaluate(`(function(){
        var s = document.getElementById('screen-home');
        var st = document.getElementById('stage');
        var over = [];
        document.querySelectorAll('#screen-home *').forEach(function(el){
          var r = el.getBoundingClientRect();
          if (el.scrollHeight - el.clientHeight > 1 && el.clientHeight > 0) over.push(el.className || el.id);
        });
        return { stageH: st ? Math.round(st.getBoundingClientRect().height) : 0,
                 homeH: s ? Math.round(s.scrollHeight) : 0,
                 homeClient: s ? Math.round(s.clientHeight) : 0,
                 scrollers: over.slice(0, 6) };
      })()`);
      console.log((d.g + ' ' + d.m).padEnd(30) + ' 舞台高 ' + hb.stageH
        + ' 首页 ' + hb.homeClient + '/' + hb.homeH
        + (hb.scrollers.length ? '  内部滚动: ' + hb.scrollers.join(', ') : ''));
      continue;
    }
    let slots = 0;
    for (let i = 0; i < 30; i++) {
      slots = await evaluate(`document.querySelectorAll('#slots .slot').length`);
      if (typeof slots === 'number' && slots >= 3) break;
      await sleep(300);
    }
    await sleep(500);   // 让最后一次重排落定

    const m = (await evaluate(MEASURE)) || {};
    if (SHOTS) {
      try {
        if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
        const cs = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const slug = (d.g + '-' + d.m).replace(/[^\w\u4e00-\u9fa5]+/g, '_');
        fs.writeFileSync(path.join(SHOT_DIR, slug + '.png'), Buffer.from(cs.data, 'base64'));
      } catch (e) { /* 截图失败不影响数据 */ }
    }
    const row = Object.assign({ g: d.g, m: d.m, w: d.w, h: d.h }, m, {
      flow: flow && flow.error ? ('ERR ' + flow.error) : flow,
      slots: slots
    });
    rows.push(row);

    if (m.ring) {
      onByGroup[d.g] = (onByGroup[d.g] || 0) + 1;
      const cardCss = m.cardW && m.scale ? Math.round(m.cardW * m.scale * 10) / 10 : 0;
      const tag = d.g + ' ' + d.m;
      /* 硬门 / 软门（v106）：
       *   iPhone / 安卓 / 电脑 是「必须支持」的三族 —— 四条硬指标任一不达标就红；
       *   平板 / 折叠屏 是**用户裁定可以不支持**的族 —— 只记录不判死。
       * 这样以后改电脑端版式时，不会被一条「平板竖屏牌面小」的既有事实卡住发布；
       * 但三族一旦退化，一定红。 */
      const hard = HARD_FAMILIES.indexOf(d.g) >= 0;
      const say = hard ? chk : function (c, msg) { soft.push((c ? 'ok ' : 'BAD ') + msg); };
      say((m.slotsOverflow || 0) <= 0, tag + ' 组槽溢出 ' + m.slotsOverflow);
      say(cardCss >= 39, tag + ' 牌面只有 ' + cardCss + ' CSS px');
      say((m.emoCss || 0) >= 44, tag + ' 表情入口 ' + m.emoCss + ' CSS px < 44');
      say((m.nameVis || 0) >= 10.4, tag + ' 昵称 ' + m.nameVis + ' CSS px < 10.4');
    }

    if (!CSV) {
      console.log(
        (d.g + ' ' + d.m).padEnd(30)
        + String(m.designH || '-').padStart(7)
        + String(m.scale || '-').padStart(7)
        + '  ' + (m.ring ? m.ringMode : '无圆桌').padEnd(10)
        + (m.cardW ? (m.cardW + '×' + m.cardH) : '-').padEnd(14)
        + String(m.slotsOverflow || 0).padStart(6)
        + (row.flow && row.flow.bots === undefined ? '  ⚠ ' + JSON.stringify(row.flow) : '')
      );
    }
  }

  if (CSV) {
    console.log('group,model,w,h,designH,scale,ls,compactV,lsTight,ring,ringMode,cardW,cardH,avatarCss,emoCss,slotsOverflow');
    rows.forEach((r) => console.log([r.g, r.m, r.w, r.h, r.designH, r.scale, r.ls, r.compactV, r.lsTight,
      r.ring, r.ring ? r.ringMode : 'none', r.cardW, r.cardH, r.avatarCss, r.emoCss, r.slotsOverflow].join(',')));
  }

  const out = path.join(os.tmpdir(), 'lxw-device-matrix.json');
  fs.writeFileSync(out, JSON.stringify(rows, null, 2));
  console.log('\n完整数据: ' + out);

  /* 支持协议：把「哪些机型能用」变成可执行的四条硬指标。
   * 只对「闸门放行」的档位生效 —— 所以它不能被「把桌子关掉」糊弄过去，
   * 另有一条「三族各自必须有档位进桌」堵住那条路。
   * 硬门只覆盖 iPhone / 安卓 / 电脑；平板与折叠屏的记录单独打印，不阻塞。 */
  if (ASSERT) {
    console.log('\n===== 支持协议（--assert） =====');
    HARD_FAMILIES.forEach(function (g) {
      chk((onByGroup[g] || 0) > 0, g + ' 一个档位都没进桌（闸门被关死了？）');
    });
    if (bad.length === 0) {
      console.log('ALL PASS  ' + HARD_FAMILIES
        .map(function (k) { return k + ' ' + (onByGroup[k] || 0) + ' 档'; }).join(' / '));
    } else {
      console.log('FAILED  ' + bad.length + ' 项');
      bad.forEach(function (b) { console.log('  - ' + b); });
    }
    const softBad = soft.filter(function (s) { return s.indexOf('BAD ') === 0; });
    if (soft.length) {
      console.log('\n--- 记录（不判定：平板 / 折叠屏，用户裁定可以不支持）---');
      console.log('  进档 ' + soft.filter(function (s) { return s.indexOf('ok ') === 0; }).length
        + ' / ' + soft.length + ' 项达标'
        + (softBad.length ? '；不达标 ' + softBad.length + ' 条（不阻塞发布）' : ''));
      softBad.forEach(function (s) { console.log('  · ' + s.slice(4)); });
    }
    try { cdp.close(); } catch (e) {}
    edge.kill();
    if (serverProc) serverProc.kill();
    setTimeout(() => process.exit(bad.length === 0 ? 0 : 1), 400);
    return;
  }

  try { cdp.close(); } catch (e) {}
  edge.kill();
  if (serverProc) serverProc.kill();
  setTimeout(() => process.exit(0), 600);
}

main().catch((e) => { console.error(e); process.exit(1); });
