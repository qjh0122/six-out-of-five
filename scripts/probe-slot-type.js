/**
 * 组槽实时牌型探针（v92）—— 真浏览器 / CDP
 *
 * 守的是「放满那一刻屏幕上真的出现了牌型」：
 *   1. 飘三叶放满 3 张 → `.slot-type` 出现，文字 == **引擎对界面上这三张牌**的判定；
 *   2. 十点半放满 2 张 → 没有 `.slot-type`（它已经有 slot-point 实时点数）；
 *   3. 单张放满 1 张 → 没有 `.slot-type`（牌面就是答案）；
 *   4. 刚成手那一帧 `.slot-type.is-new` 与 `.slot.is-fresh` 出现过一次，
 *      之后不再重放（否则每放一张别的牌就闪一下）。
 *
 * 为什么必须真浏览器：
 *   · `slotTypeSeen` 的提交时机靠「innerHTML 有没有被重写」驱动，
 *     静态读代码看不出它在真实 render 频率下会不会被吃掉；
 *   · `.slot-meta-main` 在窄横屏两列档是 nowrap，胶囊会不会顶出格子只有实测知道。
 *
 * 为什么不是直接读 Engine 期望值：
 *   ★ 断言比对的是「界面上那三张牌」而不是「我以为放进去的三张牌」——
 *     点牌可能被顺延到别的组，读 DOM 才不会有这种错位。
 *
 * 用法：node scripts/probe-slot-type.js [宽] [高]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
const CDP = 9399;
const ROOT = path.join(__dirname, '..', 'pwa');
const SHOT_DIR = path.join(os.tmpdir(), 'lxw-slot-type');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json', '.json': 'application/json'
};

/* ---------------------------- 被探测的服务端 ---------------------------- */
/* 必须走真实服务端（ws 模式）：`?mode=local` 里补 AI 按钮是**故意隐藏**的
 * （game.js 的 canAddBot 要求 getMode()==='ws'），local 模式没法一个人开局，
 * 也就测不到真实牌桌。端口与数据文件都指向临时目录，不碰开发数据。 */
const SRV_PORT = 3023;
let serverProc = null;
function startApp() {
  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(SRV_PORT),
      PROFILE_FILE: path.join(os.tmpdir(), 'lxw-st-' + Date.now(), 'profiles.json'),
      SEED_FILE: path.join(os.tmpdir(), 'lxw-st-seed-' + Date.now() + '.json')
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
        res.resume(); resolve();
      }).on('error', () => {
        if (tries > 60) return reject(new Error('服务端没起来'));
        setTimeout(tick, 250);
      });
    })();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
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
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.text) + ' :: ' + expr.slice(0, 160));
  return r.result && r.result.value;
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

/* 读三组的状态：牌面 / 牌型胶囊 / 进度 / 点数 / 有没有 is-new */
const READ_SLOTS = `(function(){
  var out = {};
  [].forEach.call(document.querySelectorAll('#slots .slot'), function (s) {
    var key = s.dataset.game;
    var cards = [].map.call(s.querySelectorAll('.card-box img'), function (img) {
      return img.dataset.cardId || '';
    });
    var t = s.querySelector('.slot-type');
    var p = s.querySelector('.slot-progress');
    var pt = s.querySelector('.slot-point');
    out[key] = {
      cards: cards,
      type: t ? t.textContent : null,
      typeCls: t ? t.className : null,
      progress: p ? p.textContent : null,
      point: pt ? pt.textContent : null,
      pointCls: pt ? pt.className : null,
      fresh: s.classList.contains('is-fresh'),
      /* 胶囊盒：宽高与是否被裁 */
      box: t ? (function () {
        var r = t.getBoundingClientRect();
        var host = s.querySelector('.slot-meta-main').getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height),
                 over: Math.round((r.right - host.right) > 1 ? r.right - host.right : 0) };
      })() : null
    };
  });
  return out;
})()`;

/* 页面里用真引擎算「界面上这三张牌」的牌型 —— 探针不用自己判 */
const EXPECT = (key) => `(function(){
  var s = document.querySelector('#slots .slot[data-game="${key}"]');
  if (!s) return { err: 'no slot' };
  var cards = [].map.call(s.querySelectorAll('.card-box img'), function (img) {
    var v = (img.dataset.cardId || '').split('-');
    var rank = Number(v[1]);
    return { suit: v[0], rank: rank };
  });
  if (!window.Engine) return { err: 'no Engine' };
  var mode = { single: 'single', tenhalf: 'tenhalf', piaosanye: 'piaosanye', douniu: 'douniu' }['${key}'];
  return { n: cards.length, name: Engine.typeName(mode, cards) };
})()`;

async function main() {
  /* LIVE=<线上地址> 时不起本地服务端，直接测已部署的那一份。
   * 线上与本地唯一的区别是账号库 —— 线上注册受限流，探针会自动退到固定账号登录。 */
  const LIVE = process.env.LIVE || '';
  if (LIVE) {
    console.log('线上地址 ' + LIVE);
  } else {
    startApp();
    await waitApp();
    console.log('应用服务 :' + SRV_PORT);
  }

  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lxw-st-' + Date.now()),
    '--window-size=' + W + ',' + H, '--force-device-scale-factor=1',
    'about:blank'
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
  if (!page) { console.error('连不上 Edge'); edge.kill(); try { serverProc && serverProc.kill(); } catch (e) {} process.exit(1); }
  const cdp = await cdpConnect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });

  const PAGE_URL = LIVE || ('http://127.0.0.1:' + SRV_PORT + '/');
  await cdp.send('Page.navigate', { url: PAGE_URL });
  await sleep(1600);
  await evaluate(cdp, `(function(){ try { localStorage.setItem('lxw_guide_seen_v1','1'); } catch (e) {} return 1; })()`);
  await cdp.send('Page.navigate', { url: PAGE_URL });
  await sleep(1700);
  /* ★ 线上首次访问会**自己 reload 一次**：index.html 里那段版本自检会 fetch 服务端的
   * index.html、比对 app-version，不一致就刷。刚发版的那几分钟必然撞上，
   * 而这期间任何 CDP evaluate 都会得到 "Inspected target navigated or closed"——
   * 报错在 [1] 的注册那一步，看起来像「注册失败」。
   * 判据用 performance.now()：reload 会把它归零，所以「连续两次 >3 秒」才算稳定。 */
  {
    let stable = 0;
    for (let i = 0; i < 40 && stable < 2; i++) {
      await sleep(300);
      let t = 0;
      try { t = await evaluate(cdp, 'performance.now()'); } catch (e) { t = 0; }
      stable = (typeof t === 'number' && t > 3000) ? stable + 1 : 0;
    }
  }

  console.log('\n[1] 注册 / 登录 → 建房 → 补 2 个 AI → 开局');
  const reg = await evaluate(cdp, `(async function(){
    function click(sel){ var b=document.querySelector(sel); if(b){ b.click(); return true; } return false; }
    var tab = document.querySelector('[data-auth-tab="register"]');
    if (tab) tab.click();
    await new Promise(s=>setTimeout(s,250));
    document.getElementById('auth-name').value = 'slottype' + Math.floor(Math.random()*100000);
    document.getElementById('auth-pass').value = 'probe123456';
    var nick = document.getElementById('auth-nick');
    /* ★ 昵称是全局唯一的。写死「探针」的话：第一次跑成功，之后每次注册都拿到
     * 「这个昵称已经被别人用了」，而断言只表现为「进不来」——看着像线上坏了。 */
    if (nick && !nick.closest('.hidden')) nick.value = '探针' + Math.floor(Math.random()*900 + 100);
    document.getElementById('btn-auth-submit').click();
    await new Promise(s=>setTimeout(s,1900));
    var authVisible = !document.getElementById('screen-auth').classList.contains('hidden');
    if (authVisible) {
      var t2 = document.querySelector('[data-auth-tab="login"]');
      if (t2) t2.click();
      await new Promise(s=>setTimeout(s,250));
      document.getElementById('auth-name').value = 'probezz9001';
      document.getElementById('auth-pass').value = 'probe123456';
      click('#btn-auth-submit');
      await new Promise(s=>setTimeout(s,1900));
    }
    return { authVisible: !document.getElementById('screen-auth').classList.contains('hidden') };
  })()`);
  ok(reg && !reg.authVisible, '进来了（注册或固定账号登录成功）', JSON.stringify(reg));

  const flow = await evaluate(cdp, `(async function(){
    function click(id){ var b=document.getElementById(id); if(b){ b.click(); return true; } return false; }
    function vis(id){ var e=document.getElementById(id); return !!(e && !e.classList.contains('hidden')); }
    var nick = document.getElementById('nickname-input');
    if (nick) { nick.value = '探针'; nick.dispatchEvent(new Event('input',{bubbles:true})); }
    click('btn-create');
    await new Promise(s=>setTimeout(s,600));
    var r = { room: vis('screen-room'), bots: 0 };
    /* 2 个 AI：3 人局。补太满会让 WS 广播次数变多，探针没必要等。 */
    for (var i = 0; i < 2; i++) {
      var b = document.getElementById('btn-add-bot');
      if (!b || b.classList.contains('hidden')) break;
      b.click(); r.bots += 1;
      await new Promise(s=>setTimeout(s,650));
    }
    var gm = document.getElementById('guide-modal');
    if (gm && !gm.classList.contains('hidden')) {
      var gs = document.getElementById('guide-skip');
      if (gs) gs.click();
      await new Promise(s=>setTimeout(s,350));
    }
    click('btn-ready');
    /* 等发牌：牌桌出现 + 手牌 ≥ 6 张 */
    for (var k = 0; k < 40; k++) {
      await new Promise(s=>setTimeout(s,200));
      var hand = document.querySelectorAll('#hand .card-wrap');
      if (vis('screen-game') && hand.length >= 6) break;
    }
    r.game = vis('screen-game');
    r.hand = document.querySelectorAll('#hand .card-wrap').length;
    r.slots = document.querySelectorAll('#slots .slot').length;
    return r;
  })()`);
  console.log(JSON.stringify(flow));
  ok(flow && flow.game === true, '牌桌出来了');
  ok(flow && flow.hand >= 6, '第一轮手牌 6 张（' + (flow && flow.hand) + '）');

  console.log('\n[2] 放满之前：三组都只有 n/n 进度，没有牌型胶囊');
  let s0 = await evaluate(cdp, READ_SLOTS);
  console.log('    ' + JSON.stringify(s0));
  ok(Object.keys(s0 || {}).length === 3, '第一轮三组都在');
  ok(Object.values(s0 || {}).every((x) => x.type === null), '★ 空组没有 slot-type');
  ok(Object.values(s0 || {}).every((x) => /^\d+\/\d+$/.test(x.progress || '')), '空组显示 n/n 进度');

  /* 放牌：点组标签选组 → 依次点手牌。
   * 顺序按标签栏来（单张 1 / 十点半 2 / 飘三叶 3），与真实操作一致。 */
  console.log('\n[3] 依次放满三组，采样「刚成手」那一帧');
  const placed = await evaluate(cdp, `(async function(){
    function gchip(key){
      var b = document.querySelector('#group-chips .gchip[data-group="' + key + '"]');
      if (b) b.click();
      return !!b;
    }
    function handImgs(){
      return [].slice.call(document.querySelectorAll('#hand .card-wrap img'));
    }
    var seen = {};   /* key -> { typeNew:bool, slotFresh:bool, at:number } */
    var t0 = Date.now();
    function sample(){
      [].forEach.call(document.querySelectorAll('#slots .slot'), function (s) {
        var k = s.dataset.game;
        var t = s.querySelector('.slot-type');
        if (!seen[k]) seen[k] = { typeNew: false, slotFresh: false, at: 0, type: null };
        if (t && t.classList.contains('is-new')) { seen[k].typeNew = true; seen[k].at = Date.now() - t0; seen[k].type = t.textContent; }
        if (s.classList.contains('is-fresh')) { seen[k].slotFresh = true; seen[k].at = seen[k].at || (Date.now() - t0); seen[k].type = seen[k].type || (t ? t.textContent : null); }
        /* 十点半 10.5（v93）：徽标自己也会弹一下，与胶囊上的 slotTypePop 是同一支 */
        var pt = s.querySelector('.slot-point');
        if (pt && pt.classList.contains('is-new')) {
          seen[k].pointNew = true;
          seen[k].pointAnim = getComputedStyle(pt).animationName;
          seen[k].pointBg = getComputedStyle(pt).backgroundColor;
        }
      });
    }
    /* ★ 先挑一个「十点半不会爆」的分法再放牌。
     *
     * 不挑的话有概率踩到爆点拦截：提交按钮不弹确认框，直接弹 bust-modal
     * （game.js onSubmit 里那条门 —— 「手里还有不爆的打法却选了爆的」只拦不放）。
     * 探针第一次连跑三次，两次就栽在这里。用 Engine 穷举 6 选 2 找不爆的最优对，
     * 判定仍然只走引擎，探针不自己算点数。
     */
    var cards = handImgs().map(function (img) {
      var v = (img.dataset.cardId || '').split('-');
      return { id: img.dataset.cardId, suit: v[0], rank: Number(v[1]) };
    });
    var best = null;
    if (window.Engine && cards.length === 6) {
      for (var a = 0; a < 6; a++) {
        for (var b = a + 1; b < 6; b++) {
          var pair = [cards[a], cards[b]];
          if (Engine.tenHalfBust(pair)) continue;
          var tot = Engine.tenHalfTotal(pair);
          if (!best || tot > best.tot) best = { tot: tot, ids: [cards[a].id, cards[b].id] };
        }
      }
    }
    var plan = null;
    if (best) {
      var rest = cards.map(function (c) { return c.id; }).filter(function (id) {
        return best.ids.indexOf(id) < 0;
      });
      plan = { single: [rest[0]], tenhalf: best.ids, piaosanye: rest.slice(1, 4) };
    }

    var log = [];
    async function tap(id) {
      var im = document.querySelector('#hand .card-wrap[data-card-id="' + id + '"] img');
      if (im) im.click();
      for (var j = 0; j < 6; j++) { sample(); await new Promise(s=>setTimeout(s,40)); }
    }
    async function place(key, ids) {
      gchip(key);
      await new Promise(s=>setTimeout(s,120));
      for (var i = 0; i < ids.length; i++) {
        await tap(ids[i]);
        log.push(key + ':' + i);
      }
    }
    if (plan) {
      await place('single', plan.single);
      await place('tenhalf', plan.tenhalf);
      await place('piaosanye', plan.piaosanye);
    } else {
      /* 怎么配都爆（或拿不到手牌）：按顺序放，靠后面的 bust-modal 分支兜底。 */
      await place('single', handImgs().slice(0, 1).map(function (i) { return i.dataset.cardId; }));
      await place('tenhalf', handImgs().slice(0, 2).map(function (i) { return i.dataset.cardId; }));
      await place('piaosanye', handImgs().slice(0, 3).map(function (i) { return i.dataset.cardId; }));
    }
    /* 放完之后再多采 400ms，确认 is-new 不会「一直挂在那里」 */
    var after = 0;
    for (var m = 0; m < 10; m++) {
      sample();
      var anyNew = document.querySelector('#slots .slot-type.is-new');
      if (anyNew) after += 1;
      await new Promise(s=>setTimeout(s,40));
    }
    return { seen: seen, log: log, handLeft: handImgs().length, stillNewFrames: after, plan: plan };
  })()`);
  console.log('    ' + JSON.stringify(placed));
  ok(placed && placed.handLeft === 0, '六张手牌全部放完');

  console.log('\n[4] 飘三叶：放满 3 张 → 有牌型胶囊，文字 == 引擎判定');
  const expectPsy = await evaluate(cdp, EXPECT('piaosanye'));
  let s1 = await evaluate(cdp, READ_SLOTS);
  console.log('    ' + JSON.stringify(s1.piaosanye));
  console.log('    引擎期望 ' + JSON.stringify(expectPsy));
  ok(s1.piaosanye.cards.length === 3, '组里有 3 张牌');
  ok(!!s1.piaosanye.type, '★ 出现了 slot-type（' + s1.piaosanye.type + '）');
  ok(s1.piaosanye.type === expectPsy.name,
    '★ 胶囊文字 == Engine.typeName（' + s1.piaosanye.type + ' vs ' + expectPsy.name + '）');
  ok(s1.piaosanye.progress === null, '★ 满组时 n/n 被顶掉（不并存，窄横屏才装得下）');
  ok(placed.seen.piaosanye && placed.seen.piaosanye.typeNew === true,
    '★ 刚成手那一帧出现过 is-new');
  ok(!!s1.piaosanye.box && s1.piaosanye.box.over === 0,
    '★ 胶囊没有顶出 slot-meta-main（overflow ' + JSON.stringify(s1.piaosanye.box) + '）');
  /* 散牌 / 对子 / 顺子 / 同花这些「普通牌型」不该亮组 —— 每组一满就闪一下，
   * 一局下来闪十几次，那个光就失去意义了。只有 BIG_FX 里那 5 个才配 is-fresh。 */
  ok(placed.seen.piaosanye.slotFresh === false,
    '★ 普通牌型不亮组（is-fresh 只给大牌型）',
    'type=' + s1.piaosanye.type + ' fresh=' + placed.seen.piaosanye.slotFresh);
  console.log('    放满时截图 ' + (await shot(cdp, 'slot-type-full-' + W + 'x' + H)));

  console.log('\n[4b] 提交确认弹窗：牌名后面跟牌型名');
  const expectTh = await evaluate(cdp, EXPECT('tenhalf'));
  const conf = await evaluate(cdp, `(async function(){
    var b = document.getElementById('btn-submit');
    if (!b || b.disabled) return { err: 'submit disabled' };
    b.click();
    await new Promise(s=>setTimeout(s,420));
    var m = document.getElementById('confirm-modal');
    var open = !!(m && !m.classList.contains('hidden'));
    var txt = (document.getElementById('confirm-desc') || {}).textContent || '';
    /* 读到了就取消 —— 探针不该真的把这一轮提交掉（后面还要验取回牌）。 */
    var cb = document.getElementById('btn-confirm-cancel');
    if (cb) cb.click();
    await new Promise(s=>setTimeout(s,320));
    return { open: open, txt: txt,
             closed: document.getElementById('confirm-modal').classList.contains('hidden') };
  })()`);
  console.log('    ' + JSON.stringify(conf));
  ok(conf && conf.open === true, '提交按钮弹出了确认框');
  ok(conf && conf.closed === true, '点了取消能关上（没有把探针卡在弹窗里）');
  {
    const lines = ((conf && conf.txt) || '').split('\n');
    const psyLine = lines.find((x) => x.indexOf('飘三叶') === 0) || '';
    const thLine = lines.find((x) => x.indexOf('十点半') === 0) || '';
    const singleLine = lines.find((x) => x.indexOf('比大小') === 0) || '';
    ok(psyLine.indexOf(' · ' + s1.piaosanye.type) > 0,
      '★ 飘三叶那行带牌型名（' + psyLine + '）');
    ok(thLine.indexOf(' · ' + expectTh.name) > 0,
      '★ 十点半那行带点数（' + thLine + '）');
    ok(singleLine.indexOf(' · ') < 0,
      '★ 单张那行不带牌型（' + singleLine + '）');
  }

  console.log('\n[5] 十点半：放满 2 张 → 不报牌型，只有实时点数');
  console.log('    ' + JSON.stringify(s1.tenhalf) + ' 引擎=' + JSON.stringify(expectTh));
  ok(s1.tenhalf.cards.length === 2, '组里有 2 张牌');
  ok(s1.tenhalf.type === null, '★ 没有 slot-type（不重复报）');
  ok(!!s1.tenhalf.point, '有 slot-point 实时点数（' + s1.tenhalf.point + '）');
  ok(/^\d+\/2$/.test(s1.tenhalf.progress || ''), '仍显示 2/2 进度');
  /* 10.5 的成手信号（v93）：探针挑的是「不爆的最优对」，所以经常正好凑到 10.5。
   * 凑到了就必须有：满分绿徽标 + 那一下脉冲 —— 以前四个大牌型里只有它凑到顶了没反应。 */
  if (s1.tenhalf.point && /10\.5/.test(s1.tenhalf.point)) {
    const th = (sampled || {}).tenhalf || {};
    ok(/best/.test(s1.tenhalf.pointCls || ''), '★ 10.5 命中：徽标是满分绿（.best）', s1.tenhalf.pointCls);
    ok(th.pointNew === true, '★ 10.5 命中：刚凑到那一刻徽标挂了 is-new', JSON.stringify(th.pointNew));
    ok(th.pointAnim === 'slotTypePop', '★ 10.5 命中：徽标脉冲动画在跑（与胶囊同一支）', JSON.stringify(th.pointAnim));
    ok(th.slotFresh === true, '★ 10.5 命中：整组也亮了一下（slotFreshGlow）', JSON.stringify(th.slotFresh));
  } else {
    console.log('    （这一手没凑到 10.5，本小节跳过成手信号断言）');
  }

  console.log('\n[6] 单张：放满 1 张 → 不报牌型');
  console.log('    ' + JSON.stringify(s1.single));
  ok(s1.single.cards.length === 1, '组里有 1 张牌');
  ok(s1.single.type === null, '★ 没有 slot-type（牌面就是答案）');

  console.log('\n[7] 脉冲不会常驻');
  ok(placed.stillNewFrames === 0, '★ 放完 400ms 后 is-new 已消失（不循环闪）',
    'stillNewFrames=' + (placed && placed.stillNewFrames));

  console.log('\n[8] 改一次（把飘三叶改成别的组合）也走同一条路');
  {
    /* 「改一次」把已提交的分组拷回草稿 —— 这里还没提交，直接拿一张回去再放，
     * 验证「牌型变了 → 再放一次脉冲」而不是死锁在 is-new 上。 */
    const back = await evaluate(cdp, `(async function(){
      var box = document.querySelector('#slots .slot[data-game="piaosanye"] .card-box');
      if (!box) return { err: 'no card' };
      /* 点组槽里的牌 = 取回手牌 */
      var img = box.querySelector('img');
      if (img) img.click();
      await new Promise(s=>setTimeout(s,260));
      var t = document.querySelector('#slots .slot[data-game="piaosanye"] .slot-type');
      var p = document.querySelector('#slots .slot[data-game="piaosanye"] .slot-progress');
      return { type: t ? t.textContent : null, progress: p ? p.textContent : null,
               cards: document.querySelectorAll('#slots .slot[data-game="piaosanye"] .card-box img').length };
    })()`);
    console.log('    ' + JSON.stringify(back));
    ok(back && back.cards === 2, '取回一张后组里剩 2 张');
    ok(back && back.type === null, '★ 不满 3 张时牌型胶囊消失（回到 n/n）');
    ok(back && /^2\/3$/.test(back.progress || ''), '回到 2/3 进度');
  }

  console.log('\n截图 ' + (await shot(cdp, 'slot-type-' + W + 'x' + H)));

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  cdp.close();
  edge.kill();
  try { serverProc && serverProc.kill(); } catch (e) {}
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); try { serverProc && serverProc.kill(); } catch (e) {} process.exit(1); });
