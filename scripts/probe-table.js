/**
 * 牌桌布局探针（一次性诊断脚本，不进测试套件）
 *
 * 用途：用真 Edge（headless + CDP）打开 ?mode=local，走完
 *   建房 → 补 AI → 开局 → 进第一轮分牌
 * 然后量每个组槽的实际位置，回答「飘三叶是不是被挡住了」。
 *
 * 为什么必须真浏览器：组槽高度依赖 flex 分配 + JS 算出的 stage 缩放（scale = 视口宽/750），
 * 这些在 Node 里算不出来，静态读 CSS 也会得出"放得下"的错误结论。
 *
 * 用法：node scripts/probe-table.js [宽] [高] [线上地址]
 *   不给地址 → 本地起一个真实服务端（tmp 数据，不碰线上）
 *   给地址   → 直接打线上（必须带 ?sharecode=...），用于发布后复验
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
/* 线上地址（含 sharecode）。给了就跳过本地服务端，直接打线上。 */
const LIVE_URL = process.argv[4] || process.env.LIVE_URL || '';
const PORT = 3020;
const CDP_PORT = 9333;
const ROOT = path.join(__dirname, '..', 'pwa');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json', '.json': 'application/json'
};

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

/* ---------------------------- 被探测的服务端 ---------------------------- */
/* 必须走真实服务端（ws 模式）：`?mode=local` 里补 AI 按钮是**故意隐藏**的
 * （game.js 的 canAddBot 要求 getMode()==='ws'），所以 local 模式没法一个人开局，
 * 也就测不到真实牌桌。这里起一个真实例，端口和数据文件都指向临时目录。 */
const SRV_PORT = 3021;
let serverProc = null;
function startApp() {
  const node = process.execPath;
  serverProc = spawn(node, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(SRV_PORT),
      PROFILE_FILE: path.join(require('os').tmpdir(), 'lxw-probe-' + Date.now(), 'profiles.json'),
      SEED_FILE: path.join(require('os').tmpdir(), 'lxw-probe-seed-' + Date.now() + '.json')
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

/* ---------------------------- CDP 极简客户端 ---------------------------- */
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

async function main() {
  if (!LIVE_URL) {
    startApp();
    await waitApp();
    console.log('应用服务 :' + SRV_PORT);
  } else {
    console.log('线上目标 :' + LIVE_URL);
  }

  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const userDir = path.join(require('os').tmpdir(), 'lxw-probe-' + Date.now());
  const edge = spawn(exe, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDir,
    '--window-size=' + W + ',' + H,
    '--force-device-scale-factor=1',
    'about:blank'
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const list = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      const page = (list || []).find((t) => t.type === 'page');
      if (page) { targets = page; break; }
    } catch (e) { /* 还没起来 */ }
  }
  if (!targets) { console.error('连不上 Edge CDP'); edge.kill(); process.exit(1); }

  const cdp = await cdpConnect(targets.webSocketDebuggerUrl);
  const evaluate0 = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) return null;
    return r.result && r.result.value;
  };

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // 用设备模拟保证视口精确（headless 的 window-size 会把内容区扣掉一部分）
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 2, mobile: true
  });

  /* 线上模式下**禁掉 Service Worker**。
   * 布局探针不需要离线缓存，但 SW 首次接管会 controllerchange → 页面自己 reload，
   * 这个 reload 可能落在 [2] 建房之后：房间没了、DOM 重置成 boot 状态，
   * [3] 就会量到一片空（groups: []），看起来像牌桌塌了。
   * 与其反复赌「reload 会在哪一帧发生」，不如从源头不让它发生。
   * 用假对象替换 navigator.serviceWorker：register 返回 rejected（index.html 里本来就 .catch 忽略），
   * addEventListener 做成 noop，controller 为 null —— 全程零报错。 */
  if (LIVE_URL) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "(function(){try{var f={register:function(){return Promise.reject(new Error('probe: sw disabled'));},"
        + "addEventListener:function(){},removeEventListener:function(){},getRegistrations:function(){return Promise.resolve([]);},"
        + "controller:null,ready:Promise.resolve({active:null})};"
        + "Object.defineProperty(navigator,'serviceWorker',{get:function(){return f;},configurable:true});}catch(e){}})();"
    });
  }

  /* Q=countdown=1 这类查询串透传给本地页面：有些功能是 URL 开关（开局倒计时、?seatring），
   * 不给透传的话探针就永远只能测默认档。 */
  const Q = process.env.Q || '';
  const CD = /(^|&)startcountdown=1/.test(Q);
  const target = LIVE_URL || ('http://127.0.0.1:' + SRV_PORT + '/' + (Q ? '?' + Q : ''));
  await cdp.send('Page.navigate', { url: target });
  await sleep(LIVE_URL ? 3000 : 1500);   // 线上要等 CDN + 首次字体

  /* 线上首次加载时 SW 会 skipWaiting + claim → controllerchange → index.html 自己 reload。
   * 这个 reload 会打断后面的 Runtime.evaluate（报 "target navigated"）。
   * 再导航一次：此时 SW 已接管，走缓存出页面，不会再 reload。 */
  if (LIVE_URL) {
    await cdp.send('Page.navigate', { url: target });
    await sleep(1500);
    /* SW 接管的 reload 未必只发生一次：线上首次注册 SW 比本地慢，
     * 第二次导航后它仍可能再来一次 controllerchange → reload，
     * 正好落在后面 evaluate 上就报 "Inspected target navigated or closed"。
     * 所以不要固定 sleep，轮询到「连续两次读到同一个完整 DOM」为止。 */
    let stable = 0;
    for (let i = 0; i < 40 && stable < 2; i++) {
      await sleep(300);
      try {
        const v = await evaluate0(`document.readyState`);
        stable = (v === 'complete') ? stable + 1 : 0;
      } catch (e) { stable = 0; }
    }
    if (stable < 2) console.log('⚠ 页面 12 秒内没稳定下来（SW 反复 reload？），后面的数字可能不可信');

    /* 真正的坑在这里：SW 注册后要等一会儿才接管，接管那一瞬间会
     * controllerchange → 页面自己 reload。如果探针此时已经建好房间，
     * 一 reload 就回到首页，[3] 量到的是首页（groups: []）。
     * 所以必须**等 controller 就位**（= reload 已经发生过）再开始操作。 */
    /* 用「这个文档活了多久」当判据，比等 controller 更本质：
     * 页面首次打开时 SW 接管 + 版本自检都可能触发一次 location.reload，
     * reload 之后 performance.now() 归零。等到它活过 4 秒，说明该发生的 reload 已经发生了。
     * 之前用 controller 判据不灵——headless 下 SW 可以一直不接管，但 reload 照样发生。 */
    let docAge = 0;
    for (let i = 0; i < 60; i++) {
      try { docAge = await evaluate0(`performance.now()`); } catch (e) { docAge = 0; }
      if (typeof docAge === 'number' && docAge > 4000) break;
      await sleep(400);
    }

    /* 新账号第一次打开必然弹新手引导，它会盖住整个牌桌：
     * 探针量到的 #slots .slot 会是 0 —— 看起来像「牌桌塌了」，其实是引导挡着。
     * 先把这个标记写进去再刷新一次，后面就不会弹了。 */
    await evaluate0(`(function(){ try{ localStorage.setItem('lxw_guide_seen_v1','1'); }catch(e){} return 'ok'; })()`);
    await cdp.send('Page.navigate', { url: target });
    await sleep(1500);
    stable = 0;
    for (let i = 0; i < 30 && stable < 2; i++) {
      await sleep(300);
      try {
        const v = await evaluate0(`document.readyState`);
        stable = (v === 'complete') ? stable + 1 : 0;
      } catch (e) { stable = 0; }
    }
    for (let i = 0; i < 40; i++) {
      let a = 0;
      try { a = await evaluate0(`performance.now()`); } catch (e) { a = 0; }
      if (typeof a === 'number' && a > 3000) break;
      await sleep(300);
    }
  }

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) return { error: String(r.exceptionDetails.text) };
    return r.result && r.result.value;
  };

  async function enterTable(round) {
  console.log('\n[1] 注册一个新账号（第 ' + round + ' 次尝试）');
  const reg = await evaluate(`(async function(){
    function click(sel){ var b=document.querySelector(sel); if(b){ b.click(); return true; } return false; }
    var tab = document.querySelector('[data-auth-tab="register"]');
    if (tab) tab.click();
    await new Promise(s=>setTimeout(s,250));
    var name = 'probe' + Math.floor(Math.random()*100000);
    document.getElementById('auth-name').value = name;
    document.getElementById('auth-pass').value = 'probe123456';
    var nick = document.getElementById('auth-nick');
    /* 昵称全局唯一：写死会让第二次之后的注册全部失败，而报错只显示「进不去牌桌」。 */
    if (nick && !nick.closest('.hidden')) nick.value = '探针' + Math.floor(Math.random()*900 + 100);
    document.getElementById('btn-auth-submit').click();
    await new Promise(s=>setTimeout(s,1800));
    return {
      account: name,
      homeVisible: !document.getElementById('screen-home').classList.contains('hidden'),
      authVisible: !document.getElementById('screen-auth').classList.contains('hidden'),
      err: (document.getElementById('auth-err') || {}).textContent || null
    };
  })()`);
  console.log(JSON.stringify(reg));

  /* 单 IP 每 10 分钟只允许 12 次注册（服务端 REG_MAX）。探针跑得勤就会拿到 429，
   * 页面停在登录屏 —— 看起来像「进不去牌桌」，其实是**探针自己把注册配额打满了**。
   * 用固定账号登录兜底：布局探针只关心牌桌，不关心账号是不是新的。 */
  let sess = reg;
  if (reg && reg.authVisible) {
    console.log('  注册未成功（多半是注册限流 429），改用固定账号登录');
    sess = await evaluate(`(async function(){
      function click(sel){ var b=document.querySelector(sel); if(b){ b.click(); return true; } return false; }
      var tab = document.querySelector('[data-auth-tab="login"]');
      if (tab) tab.click();
      await new Promise(s=>setTimeout(s,250));
      document.getElementById('auth-name').value = 'probezz9001';
      document.getElementById('auth-pass').value = 'probe123456';
      click('#btn-auth-submit');
      await new Promise(s=>setTimeout(s,1800));
      return {
        account: 'probezz9001(登录)',
        homeVisible: !document.getElementById('screen-home').classList.contains('hidden'),
        authVisible: !document.getElementById('screen-auth').classList.contains('hidden'),
        err: (document.getElementById('auth-err') || {}).textContent || null
      };
    })()`);
    console.log(JSON.stringify(sess));
  }

  console.log('\n[2] 建房 → 准备 → 补 AI → 开局');
  const BOTS = Number(process.env.BOTS || 12);
  const STOP = process.env.STOP_BEFORE_READY === '1';
  const flow = await evaluate(`(async function(){
    function click(id){ var b=document.getElementById(id); if(b){ b.click(); return true; } return false; }
    function vis(id){ var e=document.getElementById(id); return !!(e && !e.classList.contains('hidden')); }
    /* 先关掉新手引导：它和开局倒计时会同时出现，而 maybeCountdown 在引导开着时
     * 这一局都不放（新手最该看的是「六张牌怎么分」）。探针要验倒计时，
     * 就得站在「已经看过引导的老用户」这个状态上 —— 真实演示 / 录屏也都是这个状态。 */
    try { localStorage.setItem('lxw_guide_seen_v1', '1'); } catch (e) {}
    var nick = document.getElementById('nickname-input');
    if (nick) { nick.value = '探针'; nick.dispatchEvent(new Event('input',{bubbles:true})); }
    var r = { create: click('btn-create') };
    await new Promise(s=>setTimeout(s,500));
    /* ★ v103 起「创建房间」先弹「本局打几把」，确认了才真的开房。
     * 缺这一步 → 房间没建 → 补 AI 点不到、牌桌进不去（脚本过期，不是功能坏）。 */
    click('btn-create-confirm');
    await new Promise(s => setTimeout(s, 400));
    r.roomVisible = vis('screen-room');
    /* 补 AI 必须在「准备」之前：全员准备即开局（「开始游戏」按钮已删），
     * 反过来的话房主一准备、第一个 AI 进来自动就开局了，剩下 6 个补不进来。
     * 补到满员（按钮变隐藏）为止 —— 2 人局的 game-top 只有一条对手栏，
     * 8 人局才接近真实牌桌的挤压程度。 */
    r.botClicks = 0;
    /* BOTS / STOP_BEFORE_READY 两个环境变量是 v87 加的：座位环要按人数看
     * （2 人局对手在正上方、5 人局铺满上弧），也要看「就位态」那张桌子。
     * 默认值与原来完全一致（补到满员、补完就准备开局）。 */
    for (var i = 0; i < ${BOTS}; i++) {
      var b = document.getElementById('btn-add-bot');
      if (!b || b.classList.contains('hidden')) break;
      b.click();
      r.botClicks += 1;
      await new Promise(s=>setTimeout(s,650));
    }
    /* 引导几乎一定已经开了：它在首页停 1.2 秒就自动弹，而注册 / 登录要 1.8 秒。
     * 倒计时遇到开着的引导会整局不放（新手先看「六张牌怎么分」），所以要验倒计时
     * 就得先把这个「老用户」该做的事做掉：点跳过。 */
    var gm0 = document.getElementById('guide-modal');
    r.guideClosed = false;
    if (gm0 && !gm0.classList.contains('hidden')) {
      var gs0 = document.getElementById('guide-skip');
      if (gs0) { gs0.click(); r.guideClosed = true; await new Promise(s=>setTimeout(s,350)); }
    }
    /* 最后一个人准备 → 服务端自动开局，不再有可以点的 start 按钮 */
    r.ready = ${STOP ? 'false' : "click('btn-ready')"};
    /* 开局倒计时（?countdown=1）：采样必须**紧接着**点准备。
     * 第一拍只有 560ms，先 sleep 900 再采就只剩「2」了 —— 第一次写就是这么红的。 */
    r.cd = await (async function () {
      var want = ${CD ? 'true' : 'false'};
      if (!want) {
        await new Promise(s2=>setTimeout(s2, 900));
        var e0 = document.getElementById('countdown');
        return { want: false, openAtStart: !!(e0 && !e0.classList.contains('hidden')), seen: [] };
      }
      var seen = [], closed = false, t0 = Date.now();
      for (var k = 0; k < 120; k++) {
        var e2 = document.getElementById('countdown');
        var n2 = document.getElementById('cd-num');
        var open = !!(e2 && !e2.classList.contains('hidden'));
        if (open) seen.push({ at: Date.now() - t0, txt: n2 ? n2.textContent : '' });
        else if (seen.length) { closed = true; break; }
        if (Date.now() - t0 > 4500) break;
        await new Promise(s2=>setTimeout(s2, 50));
      }
      return { want: true, closed: closed, seen: seen,
        dbg: { search: location.search, guideOpen: (function () { var g = document.getElementById('guide-modal'); return !!(g && !g.classList.contains('hidden')); })(), hasEl: !!document.getElementById('countdown') } };
    })();
    await new Promise(s=>setTimeout(s, 250));
    r.gameVisible = vis('screen-game');
    r.roomStillVisible = vis('screen-room');
    var hint = document.querySelector('#screen-room .room-hint');
    r.roomHint = hint ? hint.textContent.slice(0,40) : null;
    return r;
  })()`);
  console.log(JSON.stringify(flow));

  console.log('\n[2b] 开局倒计时（?startcountdown=1）');
  let cdPass = 0, cdFail = 0;
  const cok = (cond, name, extra) => {
    if (cond) { cdPass++; console.log('  PASS  ' + name); }
    else { cdFail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + JSON.stringify(extra) : '')); }
  };
  {
    const c = (flow && flow.cd) || { seen: [] };
    const gameVisible = await evaluate(`(function(){
      var g = document.getElementById('screen-game');
      return !!(g && !g.classList.contains('hidden'));
    })()`);
    if (CD) {
      const raw = (c.seen || []).map((x) => x.txt);
      /* 去重成「拍」：每拍会被采到好几次（50ms 一次），断言要看的是拍与拍的顺序 */
      const texts = raw.filter((t, i) => i === 0 || t !== raw[i - 1]);
      const ORDER = ['3', '2', '1', '开始'];
      cok(raw.length > 0, '★ ?countdown=1 时遮罩真的出现（采到 ' + raw.length + ' 帧）', raw);
      cok(texts[0] === '3', '第一拍是 3', texts.slice(0, 4));
      cok(texts[texts.length - 1] === '开始', '最后一拍是「开始」', texts.slice(-3));
      cok(texts.join('') === '321开始', '★ 四拍顺序 3 → 2 → 1 → 开始（实际 ' + texts.join(' → ') + '）', texts);
      /* 迟到了一步也不该判红：只要采到的是这个序列的**连续一段**，节奏就是对的 */
      cok(ORDER.join('').indexOf(texts.join('')) >= 0, '采到的拍是完整序列的一段（没有乱序 / 没有跳字）', texts);
      cok(!!c.closed, '★ 跑完自己收起来（不用等用户点）', c);
      const span = c.seen && c.seen.length ? c.seen[c.seen.length - 1].at - c.seen[0].at : -1;
      cok(span >= 1200 && span <= 3200, '整段时长 ' + span + 'ms（4 拍 × 560ms，落在 1.2~3.2 秒）', span);
      /* 遮罩收起之后，牌桌必须已经画好 —— 它是「盖住已发下来的牌」，不是「挡住还没发的牌」 */
      cok(!!c.closed && gameVisible, '收起时牌桌已经在下面画好了（遮罩不挡渲染）', { closed: c.closed, gameVisible: gameVisible });
      /* 留一张照片：数字的字号（220 设计px）与「开始」那两字的宽度只能靠眼睛确认，
       * 而遮罩只活 2.2 秒，探针不可能正好在那一刻截图 —— 这里手动摆回去再拍。 */
      try {
        await evaluate(`(function(){
          var el = document.getElementById('countdown');
          var n = document.getElementById('cd-num');
          if (el) el.classList.remove('hidden');
          if (n) { n.textContent = '3'; n.classList.remove('go'); }
          /* 必须摘掉 .tick：cdPop 的 100% 是 opacity 0，animation-fill-mode: both 会把它按住，
           * 否则拍出来的是一个几乎看不见的「3」（第一版就这么拍糊了）。 */
          if (el) el.classList.remove('tick');
          return 1;
        })()`);
        await sleep(120);
        const cs = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const cp = path.join(require('os').tmpdir(), 'lxw-table-' + W + 'x' + H + '-countdown.png');
        fs.writeFileSync(cp, Buffer.from(cs.data, 'base64'));
        console.log('  倒计时截图: ' + cp);
        await evaluate(`(function(){ var el = document.getElementById('countdown'); if (el) el.classList.add('hidden'); return 1; })()`);
      } catch (e) { /* 截图失败不动断言 */ }
    } else {
      cok(c.openAtStart === false, '★ 默认档一帧都没出现（新增功能不许偷偷上线）', c);
      cok(gameVisible, '默认档照常直接进牌桌（没有多出来的等待）', gameVisible);
    }
  }
  console.log('  —— 倒计时：' + cdPass + ' 通过 / ' + cdFail + ' 失败');
  if (cdFail) process.exitCode = 1;
  }


  /* 首次进入线上页面时，SW 接管 + 版本自检可能各触发一次 reload。
   * 如果它偏偏发生在 [2] 之后，房间没了、DOM 也没了——[3] 量到的是一片空白，
   * 看起来就像「牌桌塌了」。所以进来之后要确认牌桌真的还在，不在就重进。
   * 这一步不能省：探针说「塌了」必须是真的塌了，否则没人会信它。 */
  let tableAlive = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await enterTable(attempt);
    await sleep(1200);
    /* 判据只能是「牌桌屏真的显示着」。
     * 别写 state.room：建房之前它天然是 null，会把正常的首页误判成「被打断」，
     * 于是一直重试、一直注册新账号，最后被服务端的 WS 鉴权超时踢回登录页。 */
    tableAlive = await evaluate(`(function(){
      var g = document.getElementById('screen-game');
      return !!(g && !g.classList.contains('hidden') && document.getElementById('slots'));
    })()`);
    if (tableAlive === true) break;
    console.log('  ↻ 页面被重载打断（DOM 已经不在了），重试进入牌桌');
    await sleep(2500);
  }
  if (tableAlive !== true) console.log('⚠ 三次都没能稳定停在牌桌上，后面的布局数字不可信');

  /* 等真正进入分牌阶段再量。
   * 原来这里固定 sleep(2500)：本地够用，线上（CDN + 首屏 + 牌动画）不够，
   * [3] 会量到一个组槽还没渲染的空布局（groups: []）——看着像「牌桌塌了」，
   * 其实是量早了。这条坑过一次，别改回固定 sleep。 */
  let slotCount = 0;
  for (let i = 0; i < 50; i++) {
    /* 兜底：万一引导还是弹了（比如标记被清），先关掉再量 */
    await evaluate(`(function(){
      var m = document.getElementById('guide-modal');
      if (m && !m.classList.contains('hidden')) {
        var b = document.getElementById('guide-skip');
        if (b) { b.click(); return 'closed'; }
      }
      return 'none';
    })()`);
    slotCount = await evaluate(`document.querySelectorAll('#slots .slot').length`);
    if (typeof slotCount === 'number' && slotCount >= 3) break;
    await sleep(300);
  }
  if (!(slotCount >= 3)) {
    const diag = await evaluate(`(function(){
      return {
        slotCount: document.querySelectorAll('#slots .slot').length,
        slotsHTML: (document.getElementById('slots') || {}).innerHTML ? document.getElementById('slots').innerHTML.slice(0, 120) : null,
        gameVisible: !document.getElementById('screen-game').classList.contains('hidden'),
        homeVisible: !document.getElementById('screen-home').classList.contains('hidden'),
        phase: (window.state && state.phase) || null,
        roomPhase: (window.state && state.room && state.room.phase) || null,
        slotClassNames: [].slice.call(document.querySelectorAll('#slots > *')).map(function(e){ return e.className; }).slice(0, 6),
        guideOpen: !document.getElementById('guide-modal').classList.contains('hidden'),
        wsOpen: !!(window.RoomStore && RoomStore.socketOpen && RoomStore.socketOpen()),
        href: location.href,
        title: document.title,
        bodyChildren: document.body ? document.body.children.length : -1,
        hasStage: !!document.getElementById('stage'),
        hasAuth: !!document.getElementById('screen-auth'),
        docAge: Math.round(performance.now()),
        navType: (performance.getEntriesByType('navigation')[0] || {}).type || null,
        verReloaded: (function(){ try { return Store.read(Store.KEYS.VERSION_RELOADED, null, 'session'); } catch(e){ return 'n/a'; } })(),
        screenStates: [].slice.call(document.querySelectorAll('[id^="screen-"]')).map(function(e){ return e.id + ':' + (e.classList.contains('hidden') ? 'h' : 'SHOW'); })
      };
    })()`);
    console.log('⚠ 没等到组槽渲染，诊断：' + JSON.stringify(diag));
  }
  await sleep(600);   // 让折行/字体最后一次重排落定

  console.log('\n[3] 第一轮组槽布局（核心）');
  const layout = await evaluate(`(function(){
    var stage = document.getElementById('stage');
    var slots = document.getElementById('slots');
    var screen = document.getElementById('screen-game');
    var bottom = document.querySelector('#screen-game .game-bottom');
    var vw = window.innerWidth, vh = window.innerHeight;
    /* 真实缩放 = 渲染宽度 / 舞台自己的设计宽度。
     * 不能写死除以 750：横屏的舞台是 1624×750，那样算会得到 1.125 这种假数字
     * （实际 scale 是 0.52），于是「字号够不够大」这类结论会被这个数带偏。
     * 注意这段字符串是模板字面量，注释里不能出现反引号。 */
    var stageWx = Number(stage.style.width.replace('px','')) || 750;
    var sc = stage.getBoundingClientRect().width / stageWx;
    function box(el){ if(!el) return null; var r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; }
    var slotEls = [].slice.call(document.querySelectorAll('#slots .slot'));
    // 纵向预算明细：stage 是设计像素坐标系（未缩放），每个 band 的 offsetHeight 就是设计像素高
    var stageHx = Number(stage.style.height.replace('px','')) || 0;
    function band(sel){
      var el = document.querySelector(sel);
      if (!el) return null;
      return { h: el.offsetHeight, padT: el.offsetTop };
    }
    var slotMeta = document.querySelector('#slots .slot .slot-meta');
    var slotPad = document.querySelector('#slots .slot');
    var cardBoxEl = document.querySelector('#slots .card-box');
    return {
      viewport: { w: vw, h: vh },
      scale: Number(sc.toFixed(3)),
      trace: window.__t || null,
      stageH: Math.round(stage.getBoundingClientRect().height),
      stageDesignH: stageHx,
      /* 纵向预算：谁吃了多少设计像素 */
      budget: {
        screenPadT: getComputedStyle(screen).paddingTop,
        screenPadB: getComputedStyle(screen).paddingBottom,
        top: band('#screen-game .game-top'),
        slotsH: slots ? slots.offsetHeight : null,
        bottom: band('#screen-game .game-bottom'),
        handH: (function(){ var h = document.getElementById('hand'); return h ? h.offsetHeight : null; })(),
        actionsH: band('#screen-game .game-actions'),
        chipsH: band('#screen-game .group-chips'),
        slotsGap: getComputedStyle(slots).rowGap,
        slotPad: slotPad ? getComputedStyle(slotPad).padding : null,
        slotGapInner: slotPad ? getComputedStyle(slotPad).rowGap : null,
        slotMetaH: slotMeta ? slotMeta.offsetHeight : null,
        cardBox: cardBoxEl ? { w: cardBoxEl.offsetWidth, h: cardBoxEl.offsetHeight } : null
      },
      slots: {
        top: Math.round(slots.getBoundingClientRect().top),
        bottom: Math.round(slots.getBoundingClientRect().bottom),
        clientH: slots.clientHeight,
        scrollH: slots.scrollHeight,
        overflow: slots.scrollHeight - slots.clientHeight,
        canScroll: slots.scrollHeight > slots.clientHeight + 1
      },
      bottomBox: box(bottom),
      screenPaddingBottom: getComputedStyle(screen).paddingBottom,
      groups: (function(){
        // 可见性必须相对 **slots 容器**判断，不是相对视口：
        // slots 有 overflow-y:auto，溢出的部分被裁在容器里，但它相对视口仍然"在屏幕内"，
        // 用视口判断会把被裁掉的组误报成 fullyVisible（我第一版就这么错了）。
        var sr = slots.getBoundingClientRect();
        return slotEls.map(function(el){
          var r = el.getBoundingClientRect();
          var label = el.querySelector('.slot-label');
          var visibleH = Math.max(0, Math.min(r.bottom, sr.bottom) - Math.max(r.top, sr.top));
          return {
            label: label ? label.textContent : '?',
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            h: Math.round(r.height),
            fullyVisible: r.top >= sr.top - 1 && r.bottom <= sr.bottom + 1,
            visibleRatio: Number((visibleH / r.height).toFixed(2)),
            clippedPx: Math.round(r.height - visibleH),
            card: (function(){ var b=el.querySelector('.card-box'); if(!b) return null; return { inline: b.style.width+'/'+b.style.height, box: b.offsetWidth+'x'+b.offsetHeight, img: (function(){var i=b.querySelector('img'); return i? i.style.width+'/'+i.style.height : null;})() }; })(),
            /* 设计像素口径的明细：rect 高是缩放后的 CSS px，判断「谁把行撑高了」
             * 必须看 offsetHeight 与各子块的 offsetHeight。 */
            oh: el.offsetHeight,
            boxesH: (function(){ var b=el.querySelector('.slot-boxes'); return b? b.offsetHeight : null; })(),
            metaH: (function(){ var m=el.querySelector('.slot-meta'); return m? m.offsetHeight : null; })(),
            span: el.getAttribute('data-span'),
            bandW: el.clientWidth
          };
        });
      })()
    };
  })()`);
  console.log(JSON.stringify(layout, null, 2));

  /* ---------------------------- [4] 圆桌环几何（v87） ----------------------------
   * 纯函数那套（pwa/test/seat-ring.test.js）证明的是「算得对」；
   * 这一节证明的是「算出来的数字真的变成了画面上不重叠、不出界的座位」——
   * DOM 一次 transform 写错（比如漏了 translate(-50%,-50%)），纯函数测试全绿，
   * 画面上座位会整体偏半个身位。 */
  console.log('\n[4] 圆桌环几何（v87）');
  let ringPass = 0, ringFail = 0;
  const rok = (cond, name, extra) => {
    if (cond) { ringPass++; console.log('  PASS  ' + name); }
    else { ringFail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
  };
  const ring = await evaluate(`(function(){
    var top = document.getElementById('game-top');
    if (!top) return { on: false, why: 'no #game-top' };
    var on = top.classList.contains('gt-ring');
    function R(el){ var r = el.getBoundingClientRect(); return { l:r.left, t:r.top, r:r.right, b:r.bottom, w:r.width, h:r.height }; }
    var box = R(top);
    var seats = [].slice.call(top.querySelectorAll('.gt-opp')).map(function(el){
      var x = R(el);
      x.nameEl = el.querySelector('.opp-name');
      x.nm = x.nameEl ? parseFloat(getComputedStyle(x.nameEl).fontSize) : 0;
      return x;
    });
    var pl = top.querySelector('.gt-plaque');
    var me = top.querySelector('.gt-me');
    var felt = top.querySelector('.gt-felt');
    var emo = document.getElementById('btn-emoji');
    var slots = document.getElementById('slots');
    var vs = top.querySelector('.gt-vs');
    return {
      on: on,
      box: box,
      seats: seats,
      plaque: pl ? R(pl) : null,
      vs: vs ? R(vs) : null,
      vsText: vs ? vs.textContent : null,
      me: me ? R(me) : null,
      felt: felt ? R(felt) : null,
      emo: emo ? R(emo) : null,
      slots: slots ? { client: slots.clientHeight, scroll: slots.scrollHeight } : null,
      phase: (top.querySelector('.gt-phase') || {}).textContent || null,
      prog: (top.querySelector('.gt-prog') || {}).textContent || null,
      timer: (top.querySelector('#gt-timer') || {}).textContent || null
    };
  })()`);

  if (!ring.on) {
    /* 矮屏 / 横屏 / ?seatring=0 都走这里 —— 不是失败，是分流。
     * 但必须把「为什么没上」说清楚，否则下次看到没圆桌会以为坏了。 */
    console.log('  · 当前这档没开圆桌（横屏 / 矮屏 / 开关关），跳过环几何断言');
  } else {
    rok(ring.seats.length >= 1, '有座位（' + ring.seats.length + ' 个对手）');
    rok(!!ring.plaque, '有中央状态牌');
    rok(!!ring.me, '有「我」那一格');
    rok(!!ring.felt, '有毡面');
    rok(!!ring.emo && ring.emo.w >= 44 && ring.emo.h >= 44,
      '表情入口 ≥ 44 CSS px（实测 ' + Math.round(ring.emo ? ring.emo.w : 0) + '×' + Math.round(ring.emo ? ring.emo.h : 0) + '）');
    /* 座位上的一切都必须落在桌面块内 —— 出去就被 #game-top 裁掉，
     * 而且裁的是文字中间，看起来像「名字被吃了一截」 */
    const outside = ring.seats.filter((s) => s.l < ring.box.l - 1 || s.r > ring.box.r + 1 || s.t < ring.box.t - 1 || s.b > ring.box.b + 1);
    rok(outside.length === 0, '所有座位完整落在桌面块内', JSON.stringify(outside.map((s) => ({ l: Math.round(s.l), t: Math.round(s.t) }))));
    /* 两两不重叠：这是「头像放大」的前提，也是按角度均分时会挂掉的那条 */
    let overlap = null;
    for (let i = 0; i < ring.seats.length; i++) {
      for (let j = i + 1; j < ring.seats.length; j++) {
        const a = ring.seats[i], b = ring.seats[j];
        if (a.l < b.r - 1 && a.r > b.l + 1 && a.t < b.b - 1 && a.b > b.t + 1) overlap = [i, j];
      }
    }
    rok(!overlap, '任意两个座位不重叠', overlap ? ('座位 ' + overlap.join(' / ')) : '');
    if (ring.plaque) {
      const hit = ring.seats.filter((s) => s.l < ring.plaque.r - 1 && s.r > ring.plaque.l + 1 && s.t < ring.plaque.b - 1 && s.b > ring.plaque.t + 1);
      rok(hit.length === 0, '中央状态牌没压住任何座位',
        hit.length + ' 个座位被压 · 牌 ' + JSON.stringify(ring.plaque) + ' · 座位 ' + JSON.stringify(hit));
    }
    if (ring.me && ring.felt) {
      rok(ring.me.t >= ring.felt.b - 2, '「我」在毡面下沿之外（不半悬在桌面上）',
        'me.t ' + Math.round(ring.me.t) + ' / felt.b ' + Math.round(ring.felt.b));
    }
    if (ring.emo) {
      rok(ring.emo.l >= ring.box.l - 1 && ring.emo.r <= ring.box.r + 1, '表情入口横向在桌面块内');
    }
    rok(ring.seats.every((s) => s.nm >= 11), '座位昵称 ≥ 11 CSS px（比这更小真机上读不出来）',
      ring.seats.map((s) => s.nm.toFixed(1)).join('/'));
    rok(!!ring.phase, '中央牌有阶段文字（' + ring.phase + '）');
    rok(/已(提交|准备) \d+\/\d+/.test(ring.prog || ''), '中央牌有提交进度（' + ring.prog + '）');
    rok(!!ring.slots && ring.slots.scroll <= ring.slots.client + 1, '组槽没有溢出（scrollH ≤ clientH）',
      ring.slots ? (ring.slots.scroll + ' / ' + ring.slots.client) : 'no slots');

    /* 2 人局对战条（v89）：探针用 BOTS=1 造出单挑局面。
     * 多人局不画它是**正确行为**（那块地方要留给中央牌报「已提交 3/5」），
     * 所以这里两个方向都断言，避免「永远不画」也能通过。 */
    if (ring.seats.length === 1) {
      rok(!!ring.vs, '2 人局有对战条');
      if (ring.vs) {
        rok(/分差/.test(ring.vsText || ''), '对战条写了分差（' + String(ring.vsText || '').replace(/\s+/g, ' ') + '）');
        rok(ring.vs.t >= ring.box.t - 1 && ring.vs.b <= ring.box.b + 1, '对战条完整落在桌面块内');
        const hitP = ring.plaque && ring.vs.l < ring.plaque.r && ring.vs.r > ring.plaque.l
          && ring.vs.t < ring.plaque.b && ring.vs.b > ring.plaque.t;
        rok(!hitP, '对战条没压住中央牌');
        const hitS = ring.seats.some((s) => ring.vs.l < s.r && ring.vs.r > s.l && ring.vs.t < s.b && ring.vs.b > s.t);
        rok(!hitS, '对战条没压住座位');
      }
    } else {
      rok(!ring.vs, '多人局不画对战条（那块地方归中央牌）', ring.seats.length + ' 个对手');
    }
  }
  console.log('  —— 圆桌环：' + ringPass + ' 通过 / ' + ringFail + ' 失败');
  if (ringFail) process.exitCode = 1;

  /* 环的照片：这一节全是数字，而「桌子看起来对不对」只能靠眼睛 ——
   * 每次调 seatRing 的几何都该留一张档（文件名带尺寸，别的档不会被覆盖）。
   * 必须在 [5] 之前拍：[5] 会把手牌放完、第二轮结束时会盖结算弹窗。 */
  try {
    const ringShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const ringOut = path.join(require('os').tmpdir(), 'lxw-table-' + W + 'x' + H + '-ring.png');
    fs.writeFileSync(ringOut, Buffer.from(ringShot.data, 'base64'));
    console.log('  环截图: ' + ringOut);
  } catch (e) { /* 截图失败不动断言 */ }

  /* ---------------------- [5] 第二轮 · 斗牛 5 张 ----------------------
   * 为什么必须有这一节：第一轮只有 1/2/3 张，**5 张的斗牛在第二轮**。
   * 而「5 张组牌面」恰恰是唯一低于文档 §11 下限的项（线上 69×97 < 82×115）——
   * 它从来没在真浏览器里被量过：本探针只发第一轮，e2e-score 虽然跑第二轮但打的是原型。
   * 纯函数断言不够：cardSize 算对了，CSS 的 flex / padding 一样能把它压回去。 */
  console.log('\n[5] 第二轮 · 斗牛 5 张');
  const r2 = await evaluate(`(async function(){
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    function vis(id){ var e = document.getElementById(id); return !!(e && !e.classList.contains('hidden')); }
    /* 手牌里能点的只有 .card-wrap > img.card —— 点击监听绑在这一张上。
     * #hand 里还有别的带 data-card-id 的装饰图，用 [data-card-id] 会点到没监听的节点，
     * 表现是「点了完全没反应」，很容易被误读成牌桌坏了。 */
    function handIds(){
      return [].slice.call(document.querySelectorAll('#hand .card-wrap img.card'))
        .map(function (i) { return i.dataset.cardId; }).filter(Boolean);
    }
    /* 十点半点数（十分之一）：J/Q/K 算半点、A 算 1、其余按面值 */
    function tenths(id){
      var rank = Number(String(id).split('-')[1]);
      if (!(rank > 0)) return 990;
      if (rank >= 11 && rank <= 13) return 5;
      return rank * 10;
    }
    function isJoker(id){ return Number(String(id).split('-')[1]) === 15; }
    async function place(steps){
      for (var s = 0; s < steps.length; s++) {
        var chip = document.querySelector('.gchip[data-group="' + steps[s].group + '"]');
        if (chip) { chip.click(); await sleep(160); }
        var list = steps[s].ids || [];
        for (var i = 0; i < list.length; i++) {
          var c = document.querySelector('#hand .card-wrap img.card[data-card-id="' + list[i] + '"]')
            || document.querySelector('#hand .card-wrap img.card');
          if (!c) break;
          c.click();
          await sleep(160);
        }
      }
      return document.querySelectorAll('#slots .card-box[data-card-id]').length;
    }

    /* 第一轮：十点半放「两张最小的非王」，保证不爆 ——
     * onSubmit 有一条硬拦：手里还有不爆的打法时，爆点提交会被弹窗挡住（只有「去改」）。
     * 探针随机配牌万一撞上爆点，就永远提交不了，看起来像「进不去第二轮」。
     * 贪心取最小的两张是安全的：两张最小之和都超过 10.5 时，任何两张都爆，
     * tenHalfAdvice 返回 null、不拦（它只在「有更好的打法」时才拦）。 */
    var ids = handIds();
    var plain = ids.filter(function (id) { return !isJoker(id); });
    plain.sort(function (a, b) { return tenths(a) - tenths(b); });
    var rest = plain.concat(ids.filter(isJoker));
    var placed1 = await place([
      { group: 'tenhalf', ids: rest.slice(0, 2) },
      { group: 'single', ids: rest.slice(2, 3) },
      { group: 'piaosanye', ids: rest.slice(3, 6) }
    ]);

    var btn = document.getElementById('btn-submit');
    var canSubmit = !!(btn && !btn.disabled);
    if (canSubmit) btn.click();
    await sleep(400);
    /* 提交前还有一道核对弹窗（askConfirm）—— 不点「确定」等于没提交 */
    var confirmShown = vis('confirm-modal');
    var okBtn = document.getElementById('btn-confirm-ok');
    if (confirmShown && okBtn) okBtn.click();
    var bustBlocked = vis('bust-modal');
    await sleep(700);

    /* 等第二轮发牌：斗牛组出现 = 服务端把第一轮结完、第二轮已经发出 */
    var waited = 0;
    while (waited < 24000) {
      if (document.querySelector('#slots .slot[data-game="douniu"]')) break;
      await sleep(400); waited += 400;
    }
    var hasRound2 = !!document.querySelector('#slots .slot[data-game="douniu"]');
    if (hasRound2) {
      var ids2 = handIds();
      await place([
        { group: 'single', ids: ids2.slice(0, 1) },
        { group: 'douniu', ids: ids2.slice(1, 6) }
      ]);
    }
    await sleep(500);
    var slot = document.querySelector('#slots .slot[data-game="douniu"]');
    var slots = document.getElementById('slots');
    var box = slot ? slot.querySelector('.card-box') : null;
    var meta = slot ? slot.querySelector('.slot-meta') : null;
    var firstBox = document.querySelector('#slots .slot .card-box');
    return {
      canSubmit: canSubmit,
      confirmShown: confirmShown,
      bustBlocked: bustBlocked,
      hasRound2: hasRound2,
      waited: waited,
      placed1: placed1,
      diag: {
        handCards: document.querySelectorAll('#hand .card-wrap').length,
        chips: document.querySelectorAll('.gchip[data-group]').length,
        placed: document.querySelectorAll('#slots .card-box[data-card-id]').length
      },
      slotCount: document.querySelectorAll('#slots .slot').length,
      labels: [].slice.call(document.querySelectorAll('#slots .slot-label')).map(function(e){ return e.textContent; }),
      card: box ? { w: box.offsetWidth, h: box.offsetHeight, inline: box.style.width + '/' + box.style.height } : null,
      firstCard: firstBox ? { w: firstBox.offsetWidth, h: firstBox.offsetHeight } : null,
      metaW: meta ? meta.offsetWidth : null,
      slotW: slot ? slot.clientWidth : null,
      cardsInDouniu: slot ? slot.querySelectorAll('.card-box').length : 0,
      /* 斗牛 5 张放满后应该有牌型胶囊（v92）。这里顺便量它有没有顶出组信息栏：
       * 5 张组的标签最长（「④ 斗牛 · 5张」），胶囊也最长（「五花牛」3 字），
       * 是最容易在窄横屏两列档里顶出去的一格。 */
      typePill: (function () {
        var t = slot ? slot.querySelector('.slot-type') : null;
        if (!t) return null;
        var tr = t.getBoundingClientRect();
        var host = slot.querySelector('.slot-meta-main');
        var hr = host ? host.getBoundingClientRect() : tr;
        return {
          text: t.textContent,
          w: Math.round(tr.width),
          over: Math.round(Math.max(0, tr.right - hr.right)),
          big: t.classList.contains('is-big')
        };
      })(),
      slots: slots ? { client: slots.clientHeight, scroll: slots.scrollHeight, overflow: slots.scrollHeight - slots.clientHeight } : null
    };
  })()`);
  console.log(JSON.stringify(r2));
  let r2pass = 0, r2fail = 0;
  const r2ok = (cond, name, extra) => {
    if (cond) { r2pass++; console.log('  PASS  ' + name); }
    else { r2fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
  };
  if (!r2 || r2.error || !r2.hasRound2) {
    r2fail++;
    console.log('  FAIL  没能走到第二轮（拿不到斗牛组）-> ' + JSON.stringify(r2 && (r2.error || r2)));
  } else {
    /* 判据来自 docs/circle-table-analysis.md §11，与 table-layout.test.js [4b] 同一套数字。
     * ★ 只在圆桌档套这个下限：88 设计 px 的牌面标准是圆桌的验收线，
     *   v86 版式（667×375 这类被分流的小横屏）本来就没有这条承诺，拿它判红只会掩盖真问题。 */
    r2ok(r2.slotCount === 2, '第二轮是 2 组（比大小 + 斗牛）', '实际 ' + r2.slotCount + ' 组：' + (r2.labels || []).join(' / '));
    r2ok(r2.cardsInDouniu === 5, '斗牛组有 5 个牌位', '实际 ' + r2.cardsInDouniu);
    if (ring.on) {
      r2ok(!!r2.card && r2.card.w >= 82 && r2.card.h >= 115,
        '★ 斗牛 5 张 ≥82×115 设计 px（实测 ' + (r2.card ? r2.card.w + '×' + r2.card.h : '无') + '）');
    } else {
      r2ok(!!r2.card && r2.card.w >= 70 && r2.card.h >= 98,
        '斗牛 5 张 ≥70×98（v86 口径，这一档没上圆桌：' + (r2.card ? r2.card.w + '×' + r2.card.h : '无') + '）');
    }
    r2ok(!!r2.slots && r2.slots.overflow <= 1, '第二轮组槽没有溢出',
      r2.slots ? (r2.slots.scroll + ' / ' + r2.slots.client) : 'no slots');
    r2ok(!!r2.metaW && r2.metaW >= 90, '斗牛组的组信息还放得下（≥90 设计 px）', '实际 ' + r2.metaW);
    r2ok(!!r2.typePill, '★ 斗牛 5 张放满后出现了牌型胶囊（' + (r2.typePill ? r2.typePill.text : '无') + '）');
    /* 大牌型（BIG_FX 那 5 个）要挂 is-big —— 随机发牌不一定凑得出，
     * 凑出来了就顺带验一次「组槽上也认得出这是大牌型」。 */
    if (r2.typePill && ['豹子', '同花顺', '牛牛', '五花牛', '10.5点'].indexOf(r2.typePill.text) >= 0) {
      r2ok(r2.typePill.big === true, '★ 大牌型「' + r2.typePill.text + '」挂上了 is-big（牌型色 + 成手脉冲）');
    }
    r2ok(!r2.typePill || r2.typePill.over === 0,
      '★ 胶囊没有顶出组信息栏（实测宽 ' + (r2.typePill ? r2.typePill.w : 0) + '，溢出 ' + (r2.typePill ? r2.typePill.over : 0) + '）');
  }
  console.log('  —— 第二轮：' + r2pass + ' 通过 / ' + r2fail + ' 失败');
  if (r2fail) process.exitCode = 1;

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const out = path.join(require('os').tmpdir(), 'lxw-table-' + W + 'x' + H + '.png');
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('\n截图: ' + out);

  /* 线上模式必须把自己造的探针账号删掉：
   * prune() 会豁免「有账号但还没开局」的档案，否则这些 probeXXXX 会永久留在线上。 */
  if (LIVE_URL) {
    console.log('\n[6] 清理探针账号');
    /* 删号从 v47 起必须带密码（不带就是 403），这里一直是漏的——
     * 表现是每次复验完都往线上留下一个 probeXXXXX 账号，越积越多。
     * 密码就是上面注册时用的那个。Content-Type 也不能少：写接口有 requireJson。 */
    const cleanup = await evaluate(`(async function(){
      try {
        var s = JSON.parse(localStorage.getItem('lxw_session_v1') || 'null');
        if (!s || !s.token) return '没有登录态，跳过';
        var sc = (location.search || '');
        var r = await fetch('/api/auth/delete' + sc, {
          method: 'POST',
          headers: { 'X-Session-Token': s.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: 'probe123456' })
        });
        var j = await r.json();
        if (!j || j.ok !== true) return '清理失败（HTTP ' + r.status + '）：' + JSON.stringify(j);
        localStorage.removeItem('lxw_session_v1');
        return j;
      } catch (e) { return '清理失败: ' + e.message; }
    })()`);
    console.log(JSON.stringify(cleanup));
  }

  cdp.close();
  try { edge.kill(); } catch (e) {}
  try { serverProc && serverProc.kill(); } catch (e) {}
  try { if (server.listening) server.close(); } catch (e) {}
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  try { serverProc && serverProc.kill(); } catch (x) {}
  process.exit(1);
});
