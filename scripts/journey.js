/**
 * 用户旅途测试（一条命令跑完真实用户必经路径）
 *
 * 存在的理由
 * ----------
 * 全量单测当时 1953 项全绿，但曾经有一条真实用户必经的路径**一条断言都没有**：
 * 「打开页面时建了 WS 连接（此时未登录）→ 用户登录成功 → 复用那条未鉴权连接 →
 *   30 秒后被服务端踢回登录页」（REVIEW.md 8.6 / P6）。
 *
 * 这个 bug 单元测试测不到，不是覆盖率不够，而是它**不是某个函数错了**：
 * 每个函数单独看都对，错的是「先建连、后登录、复用」这个**顺序**。
 * 顺序问题只能在真浏览器里按真实顺序走一遍才会露头。
 *
 * 所以这个脚本不做单元断言，它做的是「一个人从打开页面到看见排行榜」这一段路：
 *
 *   打开页面 → 注册 → 建房 → 补 AI → 开局
 *     → 第一轮分牌（1/2/3 三组，6 张全分完）→ 提交 → 看第一轮结算
 *     → 第二轮分牌（1/5 两组，6 张全分完）→ 提交
 *     → 本局结束 → 查看战绩（必须是账号数据）→ 返回首页 → 看排行榜
 *
 * 任何一步断了，就说明「一个新用户今天进不来」。这比「某个函数返回值对不对」有用得多。
 *
 * 为什么用真 Edge 而不是 jsdom / 直接调 RoomStore
 * --------------------------------------------
 * 这条路径上的关键行为全在浏览器里：DOM 渲染、点击事件绑定时机、WS 的真实建连时序、
 * 首屏 boot 序列（全局引号：`#screen-game` 可见且 `#slots` 有内容才算进对了页面）。
 * jsdom 里没有真 WS、没有 rAF、没有布局，跑出来是「假通过」。
 *
 * 用法
 * ----
 *   node scripts/journey.js              # 常规旅途（约 25 秒）
 *   node scripts/journey.js --with-wait  # 额外做 P6 顺序回归：登录后干等 35 秒不操作
 *
 *   --with-wait 那 35 秒是 P6 的**复现条件**（建连早于登录 + 服务端 30 秒踢线）。
 *   它慢，所以默认不开；但发布前、或改动过 roomStore/auth 之后必须跑一次。
 *
 * 数据隔离
 * --------
 * 服务端的 PROFILE_FILE 和 SEED_FILE 全部指到 os.tmpdir() 下的临时目录，
 * 退出时整目录删掉。**绝不读写 server/data/** —— 那是真实玩家档案。
 * 脚本最后还会校验 server/data 的档案文件没被动过，防止哪天有人把环境变量改错了。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/* 端口故意避开其他探针（probe-table 用 3020/3021/9333，probe-records-cloud 用 3043/9353），
 * 免得两个脚本同时跑时互相踩。 */
const SRV_PORT = 3971;
const CDP_PORT = 9377;

const W = Number(process.env.JOURNEY_W) || 390;
const H = Number(process.env.JOURNEY_H) || 844;

/* P6 顺序回归：登录成功后干等 35 秒（服务端 AUTH_TIMEOUT_MS 是 30 秒）。
 * 默认关闭是为了让这个脚本能进日常流程；发布前必须加 --with-wait 跑一次。 */
const WITH_WAIT = process.argv.includes('--with-wait');
const AUTH_WAIT_MS = 35000;

/* 浏览器路径：走跨平台探测（scripts/lib/browser.js）。
 *
 * 原来写死 Windows 的 Edge —— 在 Linux runner 上必然找不到，于是走到下面
 * 的 [SKIP] + exit 2。而那条 SKIP 逻辑本身是**对的**（环境缺失不能用退出码 0
 * 冒充通过），所以这里只换「怎么找」，不换「找不到怎么办」：
 * 探测不到时仍然保留原来的 Windows 路径，让 existsSync 判假、照旧 SKIP。 */
const EDGE = (function () {
  try {
    return require('./lib/browser.js').findBrowser();
  } catch (e) {
    return 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  }
})();
const SERVER_ENTRY = path.join(__dirname, '..', 'server', 'index.js');
/* 真实档案已从仓库出库，这里指向样例种子（同样用于「有没有被误写」的守卫） */
const REAL_DATA = path.join(__dirname, '..', 'server', 'data', 'profiles.example.json');

/* 临时目录：档案、种子、Edge 用户目录全放这里，退出时一刀删 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxw-journey-'));

/* 播种 3 个「其他玩家」，只为一件事：让排行榜有真实的行。
 *
 * 为什么现在必须播：这一趟旅途是**补 AI 开局**的（见 [4] 的注释），而按
 * 「含 AI 的对局不计入战绩和排行榜」的口径，这一局根本不会进档、不会上榜。
 * 于是「排行榜里有 ≥1 行」「第一名和普通行看得出区别」「7 名一屏排完」
 * 这些版式断言全都会因为没有数据而空转 —— 那不是产品回归，是探针缺了布景。
 * 播种后还多验了一条更有价值的事：AI 局打完，榜上**找不到**刚注册的昵称。
 *
 * 数据是纯合成的：没有 account 字段 → 谁都登不进来，也不会和真实玩家撞号。
 * recent 给 3 条，够排行榜算胜率与净胜。 */
(function seedStandingsPlayers() {
  const now = Date.now();
  const fake = [
    { id: 'pjourneyseed0001', nick: '布景甲', games: 12, wins: 8, losses: 4, net: 61 },
    { id: 'pjourneyseed0002', nick: '布景乙', games: 9, wins: 4, losses: 5, net: 18 },
    { id: 'pjourneyseed0003', nick: '布景丙', games: 6, wins: 2, losses: 4, net: -23 }
  ];
  const seed = {};
  fake.forEach(function (f, i) {
    seed[f.id] = {
      playerId: f.id,
      nickname: f.nick,
      games: f.games,
      wins: f.wins,
      losses: f.losses,
      draws: f.games - f.wins - f.losses,
      totalNet: f.net,
      currentStreak: i === 0 ? 2 : -1,
      longestStreak: 3,
      longestLoseStreak: 2,
      bestNet: 15,
      recent: [
        { endedAt: now - 3600 * 1000, net: 15, roomId: '90010' + i, playerCount: 3, endReason: 'scoreZero' },
        { endedAt: now - 7200 * 1000, net: -6, roomId: '90020' + i, playerCount: 4, endReason: 'dissolve' },
        { endedAt: now - 9000 * 1000, net: 4, roomId: '90030' + i, playerCount: 2, endReason: 'scoreZero' }
      ],
      updatedAt: now
    };
  });
  fs.writeFileSync(path.join(TMP, 'seed.json'), JSON.stringify(seed), 'utf8');
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------- 断言计数 ---------------------------- */
let pass = 0;
let fail = 0;

function ok(cond, name, extra) {
  if (cond) {
    pass += 1;
    console.log('  PASS  ' + name);
  } else {
    fail += 1;
    console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : ''));
  }
}
function eq(a, b, name) {
  ok(a === b, name, '期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a));
}

/* ---------------------------- 服务端 ---------------------------- */
let serverProc = null;
let serverLog = '';
let edge = null;
let cdp = null;
let cleaned = false;

/* 兜底清场：正常路径自己会清（见 main 末尾），这里管「被中途打断」——
 * Ctrl+C（--with-wait 要跑 46 秒，很可能有人按）、或者输出被 head 截断导致 EPIPE。 */
function cleanupOnExit() {
  if (cleaned) return;
  cleaned = true;
  try { edge && edge.kill(); } catch (e) {}
  try { serverProc && serverProc.kill(); } catch (e) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 句柄还没释放，留给系统临时目录 */ }
}
process.on('exit', cleanupOnExit);
process.on('SIGINT', () => { cleanupOnExit(); process.exit(130); });
process.on('SIGTERM', () => { cleanupOnExit(); process.exit(143); });

function startServer() {
  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    env: Object.assign({}, process.env, {
      PORT: String(SRV_PORT),
      HOST: '127.0.0.1',
      /* 关键：档案和种子都指到临时目录。少写一个 SEED_FILE，服务端就会拿
       * server/data/ 下的种子当种子读，甚至往里写 —— 那是真实玩家档案（现已出库）。 */
      PROFILE_FILE: path.join(TMP, 'profiles.json'),
      SEED_FILE: path.join(TMP, 'seed.json')
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  /* 必须消费输出：stdio 是 pipe 却不读，管道写满后子进程会卡住（表现为「服务端没起来」）。 */
  const collect = (buf) => { serverLog = (serverLog + buf.toString()).slice(-6000); };
  serverProc.stdout.on('data', collect);
  serverProc.stderr.on('data', collect);
}

function waitServer() {
  return new Promise((resolve, reject) => {
    let tries = 0;
    (function tick() {
      tries += 1;
      http.get('http://127.0.0.1:' + SRV_PORT + '/api/health', (res) => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (tries > 80) return reject(new Error('服务端没起来（80 次探活失败）\n' + serverLog));
        setTimeout(tick, 250);
      });
    })();
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

/* ---------------------------- CDP 极简客户端 ---------------------------- */
/* 从 probe-table.js 原样复用：它能跑，就不重新发明一遍。 */
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

/* ---------------------------- 页面内工具（注入一次，全程复用） ----------------------------
 * 全部塞在 window.__journey 下，后面的表达式只写 __journey.xxx()。
 * 好处：Node 侧代码短，页面侧逻辑也不用把同一段正则/选择器抄三遍。
 */
const PAGE_HELPERS = `(function(){
  var J = window.__journey = window.__journey || {};

  /* 「进对页面了吗」只看 DOM，不看内部状态。
   * 曾经用 state.room 当判据，而建房前它天然是 null —— 正常的首页被误判成「被打断」，
   * 于是脚本一直重试、一直注册新号，最后把自己送进注册限流（REVIEW.md 8.4 第三条）。 */
  J.vis = function(id){ var e = document.getElementById(id); return !!(e && !e.classList.contains('hidden')); };
  J.screenStates = function(){
    return [].slice.call(document.querySelectorAll('[id^="screen-"]')).map(function(e){
      return e.id + ':' + (e.classList.contains('hidden') ? 'h' : 'SHOW');
    });
  };
  J.handCount = function(){ return document.querySelectorAll('#hand .card-wrap').length; };
  J.slotCount = function(){ return document.querySelectorAll('#slots .slot').length; };
  J.chips = function(){
    return [].slice.call(document.querySelectorAll('#group-chips .gchip[data-group]')).map(function(c){
      var m = /(\\d+)\\/(\\d+)/.exec(((c.querySelector('.gchip-count') || {}).textContent || ''));
      return { key: c.dataset.group, got: m ? Number(m[1]) : -1, need: m ? Number(m[2]) : -1,
               full: c.classList.contains('is-full') };
    });
  };
  /* 结算弹窗（每轮结算后必弹）会盖住整块牌桌。不关它，后面点什么都点不到。
   * ★ v89 起结算是**逐组**放的：点一下只是前进一幕，第一轮 3 组要点 3 次，
   *   之后还可能接一张轮次交替卡。所以这里循环点到「什么都不开着」为止 ——
   *   只点一次的话，第二轮的手牌会被挡在弹窗后面，点谁都点不动。 */
  J.closeResult = function(){
    var clicked = 0;
    for (var i = 0; i < 12; i++) {
      var m = document.getElementById('result-modal');
      if (m && !m.classList.contains('hidden')) {
        var b = document.getElementById('btn-result-close');
        if (b) { b.click(); clicked++; continue; }
      }
      var k = document.getElementById('round-break-modal');
      if (k && !k.classList.contains('hidden')) {
        var kb = document.getElementById('btn-rb-close');
        if (kb) { kb.click(); clicked++; continue; }
      }
      break;
    }
    return clicked > 0;
  };
  /* 逐组结算的当前状态。写在这里而不是让调用方去数标题文字：
   * 幕序号已经落在 data-* 上，读它比解析「第 2/3 组」稳。 */
  J.resultMeta = function(){
    var m = document.getElementById('result-modal');
    if (!m) return null;
    var t = document.getElementById('result-title');
    var n = document.getElementById('result-next');
    var g = document.getElementById('result-groups');
    var b = document.getElementById('btn-result-close');
    return {
      open: !m.classList.contains('hidden'),
      step: Number(m.dataset.step || 0),
      steps: Number(m.dataset.steps || 0),
      round: Number(m.dataset.round || 0),
      hold: Number(m.dataset.hold || 0),
      title: t ? (t.textContent || '').trim() : '',
      next: n ? (n.textContent || '').trim() : '',
      btn: b ? (b.textContent || '').trim() : '',
      cards: g ? g.querySelectorAll('.result-group').length : -1
    };
  };
  J.breakOpen = function(){
    var m = document.getElementById('round-break-modal');
    return !!(m && !m.classList.contains('hidden'));
  };
  J.breakMeta = function(){
    var m = document.getElementById('round-break-modal');
    if (!m) return null;
    var t = document.getElementById('rb-title');
    var n = document.getElementById('rb-next');
    var b = document.getElementById('rb-body');
    return {
      open: !m.classList.contains('hidden'),
      title: t ? (t.textContent || '').trim() : '',
      next: n ? (n.textContent || '').trim() : '',
      rows: b ? b.querySelectorAll('.rb-row').length : -1,
      deltas: b ? [].slice.call(b.querySelectorAll('.rb-delta')).map(function(e){ return (e.textContent || '').trim(); }) : []
    };
  };
  /* 手牌 DOM → 牌对象（card-id 就是 suit-rank，和 game.js 的 cardFromId 同一套） */
  J.cardOf = function(img){
    var w = img && img.closest ? img.closest('.card-wrap') : null;
    var id = w && w.dataset ? w.dataset.cardId : '';
    if (!id) return null;
    var p = id.split('-');
    return { suit: p[0], rank: Number(p[1]) };
  };
  /* 十点半这一组按规则挑牌：**能不爆就不许爆**（第 30 章）。
   * 不这么做的话，这一趟有相当大概率撞上爆点 —— 而提交现在会被拦住（那是故意的），
   * 旅途就会卡在「确认框没弹出来」，红得像是功能坏了。
   * 放第一张时挑「手里还有搭档能凑成不爆」的那张；放第二张时挑真正不爆的那张。
   * 真挑不出来（整手怎么配都爆）就随便放 —— 那种局面按口径不拦提交。 */
  J.pickTenHalf = function(imgs){
    var placed = [];
    var boxes = document.querySelectorAll('#slots .slot[data-game="tenhalf"] .card-box[data-card-id]');
    for (var i = 0; i < boxes.length; i++) {
      var p = boxes[i].dataset.cardId.split('-');
      placed.push({ suit: p[0], rank: Number(p[1]) });
    }
    var cards = imgs.map(function(im){ return J.cardOf(im); });
    var k, m, pr;
    if (placed.length === 1) {
      for (k = 0; k < cards.length; k++) {
        if (!cards[k]) continue;
        pr = StateMachine.tenHalfPair([placed[0], cards[k]]);
        if (pr && !pr.bust) return imgs[k];
      }
      return imgs[0];
    }
    for (k = 0; k < cards.length; k++) {
      if (!cards[k]) continue;
      for (m = 0; m < cards.length; m++) {
        if (m === k || !cards[m]) continue;
        pr = StateMachine.tenHalfPair([cards[k], cards[m]]);
        if (pr && !pr.bust) return imgs[k];
      }
    }
    return imgs[0];
  };
  /* 一张一张地分：先点「还没满的组」标签，再点手里一张牌。
   * 走的是真交互路径（标签选组 + 点牌落组），不是直接改 state —— 这样连
   * 「点牌事件有没有绑上」这类毛病也能一起测到。 */
  J.fillStep = function(){
    J.closeResult();
    var cs = [].slice.call(document.querySelectorAll('#group-chips .gchip[data-group]'));
    var target = null;
    for (var i = 0; i < cs.length; i++) {
      if (!cs[i].classList.contains('is-full')) { target = cs[i]; break; }
    }
    if (!target) return { done: true, hand: J.handCount(), chips: J.chips() };
    target.click();
    var imgs = [].slice.call(document.querySelectorAll('#hand .card-wrap img'));
    if (!imgs.length) return { done: false, stuck: true, hand: 0, chips: J.chips() };
    var img = target.dataset.group === 'tenhalf' ? J.pickTenHalf(imgs) : imgs[0];
    img.click();
    return { done: false, key: target.dataset.group, hand: J.handCount(), chips: J.chips() };
  };
  J.tenHalfBust = function(){
    var s = document.querySelector('#slots .slot[data-game="tenhalf"]');
    return s ? s.classList.contains('is-bust') : null;   // 第二轮没有这一组
  };
  J.submitState = function(){
    var b = document.getElementById('btn-submit');
    if (!b) return { exists: false };
    return { exists: true, disabled: !!b.disabled, text: (b.textContent || '').trim() };
  };
  J.clickSubmit = function(){
    var b = document.getElementById('btn-submit');
    if (!b || b.disabled) return false;
    b.click();
    return true;
  };
  /* 提交前有一道「确认提交分组？」的确认框，真实玩家也要点它。 */
  J.confirmOpen = function(){
    var c = document.getElementById('confirm-modal');
    return !!(c && !c.classList.contains('hidden'));
  };
  J.clickConfirmOk = function(){
    if (!J.confirmOpen()) return false;
    document.getElementById('btn-confirm-ok').click();
    return true;
  };
  J.resultOpen = function(){
    var m = document.getElementById('result-modal');
    return !!(m && !m.classList.contains('hidden'));
  };
  J.resultTitle = function(){
    var t = document.getElementById('result-title');
    return t ? (t.textContent || '').trim() : '';
  };
  J.settleBodyLen = function(){
    var b = document.getElementById('settle-body');
    return b ? (b.textContent || '').trim().length : -1;
  };
  J.rankRows = function(){ return document.querySelectorAll('#rank-list li.rank-row').length; };
  /* 结算页的「我」：不只看类名有没有加上，
   * 还把**算出来的**背景/阴影一并取回来 ——
   * 只查 className 的话，CSS 写错了（比如被冠军行的金色底盖掉）照样会绿。 */
  J.settleMe = function(){
    var rows = document.querySelectorAll('#settle-body .settle-row');
    var mine = document.querySelectorAll('#settle-body .settle-row.me');
    var pill = document.querySelectorAll('#settle-body .settle-you');
    var shadow = '';
    var bg = '';
    if (mine.length) {
      var cs = getComputedStyle(mine[0]);
      shadow = cs.boxShadow || '';
      bg = cs.backgroundColor || '';
    }
    return {
      rows: rows.length,
      me: mine.length,
      pills: pill.length,
      pillText: pill.length ? (pill[0].textContent || '').trim() : '',
      shadow: shadow,
      bg: bg
    };
  };
  J.rankPodium = function(){
    var rows = document.querySelectorAll('#rank-list li.rank-row');
    var out = [];
    for (var i = 0; i < rows.length && i < 3; i++) {
      var cs = getComputedStyle(rows[i]);
      out.push({
        bg: cs.backgroundImage || 'none',
        shadow: cs.boxShadow || '',
        h: Math.round(rows[i].getBoundingClientRect().height),
        isMe: rows[i].classList.contains('is-me')
      });
    }
    return out;
  };
  J.rankText = function(){
    var l = document.getElementById('rank-list');
    return l ? (l.textContent || '') : '';
  };
  J.recordsSource = function(){
    var e = document.getElementById('records-source');
    return e ? (e.textContent || '').trim() : '';
  };
  J.games = function(){
    var e = document.getElementById('rp-games');
    return e ? Number((e.textContent || '').trim()) : -1;
  };
  J.authErr = function(){
    var e = document.getElementById('auth-err');
    if (!e) return '';
    return e.classList.contains('hidden') ? '' : (e.textContent || '').trim();
  };
  J.toast = function(){
    var e = document.getElementById('toast');
    if (!e || e.classList.contains('hidden')) return '';
    return (e.textContent || '').trim();
  };
  /* 失败时最想知道的三件事：现在停在哪个屏、牌桌数据到什么程度、页面活了多久。
   * REVIEW.md 8.4 那次定位靠的就是这三个字段，别省。 */
  J.diag = function(){
    return {
      screenStates: J.screenStates(),
      readyState: document.readyState,
      docAgeMs: Math.round(performance.now()),
      hand: J.handCount(),
      slots: J.slotCount(),
      chips: J.chips(),
      authErr: J.authErr(),
      toast: J.toast(),
      submit: J.submitState(),
      wsLog: (window.__wsLog || []).slice(-6),
      href: location.href
    };
  };
  return 'ok';
})()`;

/* 排查用的截图：只在 LXW_SHOTS=1 时才写盘。
 * 平时跑不产生任何文件，免得把一次回归变成一堆垃圾图。 */
const SHOTS = process.env.LXW_SHOTS === '1';
/* 截图前先等切屏/入场动画跑完。
 * 这个仓库已经踩过三次「动画中途取证」：第 19 章把弹窗错峰入场当成卡住、
 * 第 20 章把 translateX -63px 当成整屏右移、第 22 章又把横屏战绩页的入场动画
 * 当成「整块内容被推出屏幕」。像素和矩形不符时，先怀疑取证时机。
 * 判据：所有可见 .screen 的 computed transform 都回到 none，再多等 260ms。 */
async function settleScreens(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 2500)) {
    const busy = await evaluate(`(function(){
      var list = Array.prototype.slice.call(document.querySelectorAll('.screen'));
      return list.some(function(s){
        return !s.classList.contains('hidden') && getComputedStyle(s).transform !== 'none';
      });
    })()`);
    if (!busy) { await sleep(260); return true; }
    await sleep(90);
  }
  return false;
}

async function shot(name) {
  if (!SHOTS) return '';
  try {
    await settleScreens();
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    /* 不能写进 TMP：旅程结束时会把整个 TMP 删掉，图也就没了。 */
    const dir = path.join(os.tmpdir(), 'lxw-shots');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, name + '.png');
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    return f;
  } catch (e) { return ''; }
}

/* ---------------------------- Edge 启动 ---------------------------- */
function startEdge() {
  edge = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(TMP, 'edge-profile'),
    '--window-size=' + W + ',' + H,
    '--force-device-scale-factor=1',
    'about:blank'
  ], { stdio: 'ignore' });
}

async function attachPage() {
  let page = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const list = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      page = (list || []).find((t) => t.type === 'page');
      if (page) break;
    } catch (e) { /* 浏览器还没起来 */ }
  }
  if (!page) throw new Error('连不上 Edge CDP（端口 ' + CDP_PORT + ' 被占用？先 taskkill //F //IM msedge.exe）');
  cdp = await cdpConnect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  /* 用设备模拟保证视口精确：headless 的 --window-size 会把内容区扣掉一截，
   * 页面按 750 设计宽算缩放时就会算错，点击命中位置跟着偏。 */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 2, mobile: true
  });
}

/* ---------------------------- 页面求值 ---------------------------- */
let lastJsError = '';
async function evaluate(expr) {
  try {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) {
      lastJsError = String(r.exceptionDetails.exception && r.exceptionDetails.exception.description
        || r.exceptionDetails.text || '');
      return null;
    }
    return r.result && r.result.value;
  } catch (e) {
    lastJsError = String(e && e.message || e);
    return null;   // 页面正在导航（"Inspected target navigated"）也走这里，交给 waitFor 重试
  }
}

/* 显式等待，不用固定 sleep 赌启动速度。
 * 机器一忙，sleep(1500) 可能还没等到首屏脚本绑好事件，点击就落空了，
 * 于是整段断言集体变红 —— 这种「偶发全红」最容易被误判成产品回归（REVIEW.md 8.4）。 */
async function waitFor(expr, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs || 8000);
  while (Date.now() < deadline) {
    const v = await evaluate(expr);
    if (v) return true;
    await sleep(120);
  }
  if (label) console.log('  ! 等待超时：' + label);
  return false;
}

async function diag(label) {
  const d = await evaluate('__journey.diag()');
  console.log('  ⚠ 诊断（' + label + '）：');
  if (d) console.log('    ' + JSON.stringify(d));
  else console.log('    页面已不可求值（' + (lastJsError || '原因未知') + '）');
  if (serverLog.trim()) console.log('    服务端最近输出：' + serverLog.trim().split('\n').slice(-6).join(' | '));
}

/* 进入对局页时，「进对了」的唯一判据是 DOM：牌桌屏可见 + 组槽有内容。
 * 不写 state.room —— 那个判据踩过坑（见 PAGE_HELPERS 里 J.vis 的注释）。 */
const IN_TABLE = `(function(){
  var g = document.getElementById('screen-game');
  return !!(g && !g.classList.contains('hidden')
    && document.querySelectorAll('#slots .slot').length > 0
    && document.querySelectorAll('#hand .card-wrap').length > 0);
})()`;

/* 一轮分牌：按「组标签 → 手牌」一张张放，直到所有组都满。
 * 返回最终快照，供上层断言「6 张牌真的全分出去了」。 */
async function fillRound(roundNo, expectGroups) {
  let snap = null;
  for (let step = 0; step < 10; step++) {
    snap = await evaluate('__journey.fillStep()');
    if (!snap) { await sleep(150); continue; }     // 页面在重绘，重试
    if (snap.done) break;
    if (snap.stuck) break;
    await sleep(70);
  }
  const final = await evaluate('({ hand: __journey.handCount(), chips: __journey.chips(), slots: __journey.slotCount(), submit: __journey.submitState(), tenHalfBust: __journey.tenHalfBust() })');
  const chips = (final && final.chips) || [];
  console.log('    第 ' + roundNo + ' 轮分组：' + JSON.stringify(chips)
    + '  手牌剩 ' + ((final && final.hand) !== undefined ? final.hand : '?')
    + '  提交按钮 ' + JSON.stringify(final && final.submit));

  ok(chips.length === expectGroups,
    '第 ' + roundNo + ' 轮有 ' + expectGroups + ' 个组标签', JSON.stringify(chips.map((c) => c.key)));
  const allFull = chips.length === expectGroups && chips.every((c) => c.full && c.got === c.need);
  ok(allFull, '★ 第 ' + roundNo + ' 轮 6 张牌全部分完，每组 已放/需要 相等', JSON.stringify(chips));
  eq(final && final.hand, 0, '第 ' + roundNo + ' 轮手牌区已清空（6 张都落进组里了）');
  /* 挑牌时已经按「能不爆就不许爆」在挑（J.pickTenHalf），这里是对那个挑选的复核：
   * 十点半还爆着的话，下一步提交会被新加的拦截挡住，后面的断言会以很难归因的方式红。 */
  const bust = final ? final.tenHalfBust : null;
  if (bust !== null && bust !== undefined) {
    ok(bust === false, '★ 第 ' + roundNo + ' 轮十点半没爆（旅途按规则挑牌，不会被提交拦截）');
  }
  return allFull;
}

/* 点提交 → 确认框 → 点确定。返回是否真的把确认框点掉了。 */
async function submitRound() {
  const clicked = await evaluate('__journey.clickSubmit()');
  if (!clicked) {
    const st = await evaluate('__journey.submitState()');
    await diag('提交按钮点不动：' + JSON.stringify(st));
    return false;
  }
  const opened = await waitFor('__journey.confirmOpen()', 3000, '确认提交框没弹出来');
  if (!opened) { await diag('确认框缺失'); return false; }
  await evaluate('__journey.clickConfirmOk()');
  return true;
}

/* ---------------------------- 主流程 ---------------------------- */
async function main() {
  const t0 = Date.now();

  /* [0] 先确认本机有浏览器，再谈别的。
   * 必须显式判存在：spawn 一个不存在的路径不会当场抛，而是异步发 error 事件，
   * 表现是「服务端起来了，然后 attachPage 干等 20 秒超时」，报错完全指不到真正的原因。
   *
   * 退出码用 2，不是 0 也不是 1：
   *   0 会被当成「旅途测试通过」—— 这是最糟的结果，一台没有浏览器的 CI 会变成绿灯；
   *   1 会和「断言真的红了」混在一起，看日志的人分不清是代码坏了还是环境缺了；
   *   2 = 环境缺失，这一趟压根没跑，不算通过。 */
  if (!fs.existsSync(EDGE)) {
    console.log('');
    console.log('[SKIP] 本机没有找到 Edge（' + EDGE + '）。');
    console.log('       旅途测试需要真浏览器，发布前必须在有 Edge 的机器上跑；这不是通过。');
    console.log('');
    process.exit(2);
  }

  /* server/data 的守门快照：脚本前后比对，证明这套测试一个字节都没碰真实档案 */
  const realBefore = fs.existsSync(REAL_DATA)
    ? { size: fs.statSync(REAL_DATA).size, mtime: fs.statSync(REAL_DATA).mtimeMs }
    : null;

  console.log('='.repeat(60));
  console.log('[1] 起本地服务端 + 真 Edge');
  console.log('    临时目录 ' + TMP);
  startServer();
  await waitServer();
  console.log('    服务端 :' + SRV_PORT + '（PROFILE_FILE / SEED_FILE 都指向临时目录）');

  startEdge();
  await attachPage();

  /* 两个必须在**每个新文档**生成前就位的补丁：
   *
   * 1) 新手引导已被看过的标记。新账号第一次打开必然弹引导，它盖住整个牌桌，
   *    后面所有「点不到」都会被误读成产品坏了（REVIEW.md 8.4 第一条）。
   * 2) 干掉 navigator.serviceWorker。SW 首次接管会 controllerchange → 页面自己 reload，
   *    这个 reload 可能正好落在建房之后：房间没了、DOM 重置，整段旅途断在半路。
   *    与其反复赌「reload 会落在哪一帧」，不如从源头不让它发生。
   *    register 返回 rejected（index.html 里本来就 .catch 忽略），其余做成 noop，全程零报错。
   *
   * 顺带记录 WebSocket 的生命周期**和每个发出的帧**：
   * P6 那类「留下一条未鉴权连接」的问题，只有把连接摊开看才说得清 ——
   * 光看建连时刻只能证明「有没有连」，看帧才知道「连上之后到底有没有自报身份」。 */
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: '(function(){'
      + 'try{ localStorage.setItem("lxw_guide_seen_v1","1"); }catch(e){}'
      + 'try{'
      + '  var f={register:function(){return Promise.reject(new Error("journey: sw disabled"));},'
      + '  addEventListener:function(){},removeEventListener:function(){},'
      + '  getRegistrations:function(){return Promise.resolve([]);},'
      + '  controller:null, ready:Promise.resolve({active:null})};'
      + '  Object.defineProperty(navigator,"serviceWorker",{get:function(){return f;},configurable:true});'
      + '}catch(e){}'
      + 'try{'
      + '  var Real=window.WebSocket; window.__wsLog=[]; var seq=0;'
      /* 帧记录挂在 prototype.send 上：socket 自己不知道要上报，
       * 但只要是原型链上的实例，就一定从这里过。id 用自增数存在实例属性上，
       * 不用 WeakMap —— 这个脚本只活几十秒，不需要回收，而 WeakMap 在 CDP 里也没法查。 */
      + '  var realSend=Real.prototype.send;'
      + '  Real.prototype.send=function(data){'
      + '    try{'
      + '      var list=window.__wsLog, rec=null;'
      + '      for(var i=list.length-1;i>=0;i--){ if(list[i].id===this.__wsId){ rec=list[i]; break; } }'
      + '      if(rec){'
      + '        var type="";'
      + '        try{ type=(JSON.parse(data)||{}).type||""; }catch(e){ type="raw"; }'
      + '        rec.sent.push({ t:Math.round(performance.now()-(rec.openedAt||0)), type:type });'
      + '      }'
      + '    }catch(e){}'
      + '    return realSend.apply(this, arguments);'
      + '  };'
      + '  function W(u,p){'
      + '    var s = (p===undefined) ? new Real(u) : new Real(u,p);'
      + '    s.__wsId = ++seq;'
      + '    var rec={id:s.__wsId,at:Math.round(performance.now()),url:String(u),sent:[]}; window.__wsLog.push(rec);'
      + '    s.addEventListener("open",function(){rec.openedAt=Math.round(performance.now());});'
      + '    s.addEventListener("close",function(e){rec.closedAt=Math.round(performance.now());rec.code=e.code;rec.reason=e.reason||"";});'
      + '    s.addEventListener("error",function(){rec.errored=true;});'
      + '    return s;'
      + '  }'
      + '  W.prototype=Real.prototype; W.CONNECTING=0; W.OPEN=1; W.CLOSING=2; W.CLOSED=3;'
      + '  window.WebSocket=W;'
      + '}catch(e){}'
      + '})();'
  });

  const url = 'http://127.0.0.1:' + SRV_PORT + '/';
  await cdp.send('Page.navigate', { url });

  /* 等页面真的活稳：readyState 完整、且文档已活过 1.5 秒。
   * 只看 readyState 不够 —— 版本自检 / 首屏 boot 仍可能在它之后触发一次 reload，
   * 那一 reload 会让后面的 evaluate 报 "target navigated"。 */
  await waitFor('document.readyState === "complete"', 15000, '首屏 readyState');
  for (let i = 0; i < 40; i++) {
    const age = await evaluate('performance.now()');
    if (typeof age === 'number' && age > 1500) break;
    await sleep(250);
  }
  await evaluate(PAGE_HELPERS);

  const booted = await waitFor(`(function(){
    return !!document.getElementById('auth-name') && !!document.getElementById('btn-auth-submit');
  })()`, 10000, '登录表单没渲染出来');
  ok(booted, '首屏加载完成，登录页就绪');
  ok((await evaluate('__journey.vis("screen-auth")')) === true, '未登录时首屏是登录页（不是首页）');

  /* 工具自检：先证明「诊断输出本身是可用的」。
   * 否则真出问题时会打出一句「页面已不可求值」，人就分不清是产品挂了还是脚本没注入对 ——
   * 那条弯路 REVIEW.md 8.4 走过四次。 */
  const selfCheck = await evaluate('__journey.diag()');
  ok(!!(selfCheck && Array.isArray(selfCheck.screenStates) && selfCheck.screenStates.length >= 5
    && selfCheck.readyState === 'complete'),
    '诊断输出可用（能读到 screenStates / readyState，失败时才定位得到）',
    JSON.stringify(selfCheck && { screens: selfCheck.screenStates, readyState: selfCheck.readyState }));

  /* ---------------------------------------------------------------- */
  console.log('\n[2] 注册新账号 → 进首页');

  /* 账号名只能是中文/字母/数字/下划线，长度 2~16；这里用时间戳保证唯一，
   * 免得连跑两次撞名拿到 409。昵称 4 个字，最后要在排行榜里认出来。 */
  const stamp = String(Date.now()).slice(-8);
  const account = 'jrny' + stamp;
  const nickname = '旅探' + stamp.slice(-2);
  console.log('    账号 ' + account + '  昵称 ' + nickname);

  const reg = await evaluate(`(async function(){
    function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
    var tab = document.querySelector('[data-auth-tab="register"]');
    if (tab) tab.click();
    await sleep(200);
    document.getElementById('auth-name').value = ${JSON.stringify(account)};
    document.getElementById('auth-pass').value = 'journey123456';
    var nick = document.getElementById('auth-nick');
    if (nick) nick.value = ${JSON.stringify(nickname)};
    return 'ready';
  })()`);
  ok(reg === 'ready', '切到注册 tab 并填好账号/密码/昵称');

  /* 记下「点注册之前」的页面时刻。下面用它判断
   * 「现在这条 WS 连接是登录前就有的，还是登录后才换的」—— 这正是 P6 的分界线。 */
  const tBeforeLogin = await evaluate('performance.now()');
  await evaluate('document.getElementById("btn-auth-submit").click()');

  const onHome = await waitFor('__journey.vis("screen-home")', 12000, '注册后没进首页');
  if (!onHome) {
    const err = await evaluate('__journey.authErr()');
    await diag('注册后停在登录页，auth-err：' + JSON.stringify(err));
  }
  ok(onHome, '★ 注册成功 → 进入首页 #screen-home');
  ok((await evaluate('__journey.vis("screen-auth")')) === false, '首页出现后登录页已隐藏');
  const myNick = await evaluate('(document.getElementById("nickname-input")||{}).value || ""');
  ok(String(myNick).trim() === nickname, '首页昵称框用的是账号昵称', JSON.stringify(myNick));

  /* 版式守卫：横屏必须有 .ls，竖屏必须没有，而且字不能小到看不见。
   *
   * 为什么要断言而不是靠探针截图：横屏这套版式是靠 resize() 里一堆条件 + CSS 里
   * 的 .ls 前缀撑起来的，任何一处掉链子（类没加上、规则被别处覆盖）都不会报错，
   * 只会「看起来怪」。第 21 章量过一次 5.1px，第 22 章又量到引导按钮跑到屏外 ——
   * 两次都是靠人去量才发现的。这里把它变成红绿灯。 */
  const layoutGuard = await evaluate(`(function(){
    var st = document.getElementById('stage');
    var cs = getComputedStyle(st).transform;
    var m = /matrix\\(([-0-9.]+)/.exec(cs || '');
    var scale = m ? Number(m[1]) : 1;
    var btn = document.querySelector('#screen-home .btn-primary');
    var btnPx = btn ? parseFloat(getComputedStyle(btn).fontSize) * scale : null;
    var tap = getComputedStyle(st).getPropertyValue('--tap-min');
    return {
      landscape: innerWidth >= innerHeight,
      ls: st.classList.contains('ls'),
      wide: st.classList.contains('wide-stage'),
      scale: Math.round(scale * 1000) / 1000,
      btnRealPx: btnPx ? Math.round(btnPx * 10) / 10 : null,
      tapMin: tap.trim()
    };
  })()`);
  ok(layoutGuard.ls === layoutGuard.landscape,
    '★ 横屏挂 .ls / 竖屏不挂（版式与朝向一致）', JSON.stringify(layoutGuard));
  ok(layoutGuard.btnRealPx === null || layoutGuard.btnRealPx >= 9,
    '★ 主按钮实际字号不小于 9px（横屏不再腰斩）', JSON.stringify(layoutGuard));
  ok(layoutGuard.landscape || layoutGuard.wide === false,
    '竖屏不该挂桌面宽窗类 .wide-stage', JSON.stringify(layoutGuard));

  /* ---------------------------------------------------------------- */
  /* 顺序不变量（P6 的机制断言，和 --with-wait 的等待行为断言互为补充）。
   *
   * P6 的病根是「留下了一条未鉴权的连接，登录后还被复用」。
   * 正确的实现必须满足三条：
   *   1) 登录完成后，手上这条连接是**登录之后**才建立的（不是遗留的那条）；
   *   2) 全程没有连接被关闭/出错（没有 30 秒踢线，也没有新旧两条抢同一个身份）；
   *   3) ★ 每一条建立的连接，open 后 2 秒内都发出过一条 type:"auth" 帧。
   * 第 3 条是最根本的一条：它不看「哪条路径先建了连」，只看「连上之后有没有自报身份」，
   * 所以换任何入口都成立 —— 只要有人写出一条「令牌为空时建的连接」，
   * 它在这里就会红，不用等 30 秒。 */
  const wsLog = await evaluate('(window.__wsLog || [])');
  const sockets = Array.isArray(wsLog) ? wsLog : [];
  const aliveAfterLogin = sockets.filter((s) => typeof s.at === 'number' && s.at >= tBeforeLogin);
  const dead = sockets.filter((s) => s.closedAt || s.errored);
  const frameLog = sockets.map((s) => '#' + s.id + ' 建连@' + s.at + 'ms ['
    + (s.sent || []).map((f) => f.type + '@' + f.t + 'ms').join(', ') + ']').join(' / ');
  console.log('    WS 建连与帧：' + (frameLog || '（无连接）'));
  ok(aliveAfterLogin.length >= 1,
    '★ 登录后的连接是登录之后新建的（没有复用登录前那条未鉴权连接）',
    '点注册时刻 ' + Math.round(tBeforeLogin) + 'ms，记录 ' + JSON.stringify(sockets));
  ok(dead.length === 0,
    '★ 全程没有连接被关闭/出错（没有 30 秒踢线，也没有新旧两条连接抢身份）',
    JSON.stringify(dead));

  /* 每一条连接都必须在 open 后 2 秒内自报身份。
   * 2 秒是宽限：open 回调里同步发 auth，正常 <5ms；给 2 秒是留给慢机器的排队时间。
   * 判据只看「有没有一条 type:auth 且发生在 open 后 2000ms 内」，
   * 不要求它是第一帧（将来在 auth 之前加个 hello 也不该让这条断言变红）。 */
  const AUTH_WINDOW_MS = 2000;
  const noAuth = sockets.filter((s) => {
    const sent = Array.isArray(s.sent) ? s.sent : [];
    return !sent.some((f) => f.type === 'auth' && typeof f.t === 'number' && f.t <= AUTH_WINDOW_MS);
  });
  ok(sockets.length >= 1, '确实建立过连接（否则下面的自报身份断言没有意义）', '连接数 ' + sockets.length);
  ok(noAuth.length === 0,
    '★ 每条连接都在 open 后 ' + (AUTH_WINDOW_MS / 1000) + ' 秒内发出过 type:"auth" 帧（没有留下未鉴权连接）',
    '未自报身份的连接：' + JSON.stringify(noAuth.map((s) => ({ id: s.id, at: s.at, sent: s.sent }))));

  /* 首页是唯一「进来第一眼」的屏，它的留白比例与字号最影响观感（真机反馈过两轮）。 */
  if (SHOTS) console.log('    截图：' + (await shot('home')));

  /* ---------------------------------------------------------------- */
  if (WITH_WAIT) {
    console.log('\n[3] 顺序回归（P6）：登录成功后干等 ' + Math.round(AUTH_WAIT_MS / 1000) + ' 秒');
    console.log('    复现条件：页面建连（未登录）→ 登录 → 复用未鉴权连接 → 30 秒被踢。');
    const waitStart = Date.now();
    await sleep(AUTH_WAIT_MS);
    console.log('    已等待 ' + Math.round((Date.now() - waitStart) / 1000) + ' 秒，检查页面还在不在首页');
    const stillHome = await evaluate('__journey.vis("screen-home")');
    const kickedErr = await evaluate('__journey.authErr()');
    ok(stillHome === true, '★ 等待 ' + Math.round(AUTH_WAIT_MS / 1000) + ' 秒后仍在首页（没有被踢回登录页）',
      JSON.stringify(await evaluate('__journey.screenStates()')));
    ok(!/未登录|已断开/.test(String(kickedErr || '')), '没有出现「连接未登录，已断开」提示', JSON.stringify(kickedErr));
    console.log('    等待结束时的连接记录：' + JSON.stringify(await evaluate('(window.__wsLog||[])')));
  } else {
    console.log('\n[3] 顺序回归（P6）：本次跳过');
    console.log('    （加 --with-wait 才会真的等 35 秒。发布前或改过 roomStore/auth 后必须跑一次。）');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[4] 建房 → 准备 → 补 AI → 开局');

  await evaluate('document.getElementById("btn-create").click()');
  /* v101 起建房多了一层「本局打几局」弹窗（默认 10）。这里**不选档位**直接确认，
   * 顺带把「不选就是 10」这条产品口径走一遍。 */
  await sleep(200);
  await evaluate('document.getElementById("btn-create-confirm").click()');
  /* 建房后进的是「准备态」。v82 起准备态画在牌桌上，所以判据取「准备按钮在视口里」——
   * 它在两种模式下都成立（牌桌的动作条 / 房间页的底排），而 #screen-room
   * 在牌桌模式下是**故意**不显示的。只盯 #screen-room 会把改动本身判成失败。 */
  /* 判据不能只是「#btn-ready 不含 .hidden」—— 它就算整屏被藏起来也不带 .hidden，
   * 于是会在 render 还没跑完时就返回真，紧接着的断言读到「准备层还没显示」。
   * 要判「准备态真的画出来了」：牌桌准备层或房间页，至少有一个在显示。 */
  const READY_DRAWN = '__journey.vis("table-ready") || __journey.vis("screen-room")';
  const readyShown = await waitFor(READY_DRAWN, 8000, '建房后没进准备态');
  if (!readyShown) await diag('建房失败');
  ok(readyShown, '建房成功 → 准备态可见（#btn-ready 在视口里）');
  const readyOnTable = await evaluate('__journey.vis("table-ready")');
  ok(readyOnTable === true, '★ 准备态长在牌桌上（v82：不再另开房间页）');
  ok((await evaluate('__journey.vis("screen-room")')) === false, '★ 独立的房间页 #screen-room 不再显示');

  /* 补 AI 必须放在「准备」之前。
   * 全员准备即开局（「开始游戏」按钮已经删了），顺序反过来的话：
   * 房主先点准备、再补第一个 AI —— AI 自带 ready，两人就绪的瞬间服务端直接开局，
   * 第二个 AI 根本没机会补进来。 */
  await evaluate('document.getElementById("btn-add-bot").click()');
  await sleep(400);
  const seatCount = await evaluate('document.querySelectorAll("#room-players .player-row").length');
  ok(seatCount >= 2, '补 AI 成功（房间里有 ' + seatCount + ' 人）');

  /* 座位表指纹（新开一局 / 首次开局的等待页）。
   *
   * 以前这里采两份（「新开一局」与「继续下一把回到房间」）做对照 ——
   * 用户报过这两屏长得不一样（一边 8 格挤满邀请卡，另一边只剩 3 格、分数那列还写「—」）。
   * C-2（v116）之后，2 人 AI 房里点「开始下一局」直接开打、不再有那一屏，
   * 所以现在只剩这一份：它仍然能抓住「房子建成时座位表就画错了」，
   * 但抓不到「就位态画错了」—— 那条留白记在 release-progress 的 v116 一节里。 */
  const seatSign = () => evaluate(`(function(){
    var g = document.getElementById('room-players');
    var rows = Array.prototype.map.call(g.children, function(c){
      if (c.classList.contains('invite-card')) return 'invite';
      return 'player[' + Array.prototype.map.call(c.children, function(k){
        return k.className.split(' ')[0];
      }).join(',') + ']';
    });
    return { slots: g.children.length,
             players: g.querySelectorAll('.player-row').length,
             invites: g.querySelectorAll('.invite-card').length,
             shape: rows.join('|') };
  })()`);
  const seatSignNew = await seatSign();
  console.log('    座位表（新开一局）' + JSON.stringify(seatSignNew));
  ok(seatSignNew.slots >= seatSignNew.players && seatSignNew.players >= 2,
    '★ 座位表里有我已补进来的 AI（格子数 ≥ 人数 ≥ 2）', JSON.stringify(seatSignNew));
  /* 房间页是横屏版式唯一没被别处截到的屏（对局页有 probe-table、结算页有下面那张），
   * 而它横屏走的是两栏排布，布局错了只能靠眼睛发现。 */
  /* 顶栏与玩家列表不许叠在一起：横屏改成 grid 之后，这里最容易出现
   * 「房间号被第一张玩家卡盖住」—— 只截图看不出来是叠了还是本来就这样，所以量。
   * v82 起准备态的「玩家列表」是中央房间卡（#tr-card）：牌桌上的座位在顶栏里，
   * 所以这里按「当前显示的是哪一块」取对照物，两种模式量的是同一件事 —— 有没有叠。 */
  const roomGeom = await evaluate(`(function(){
    var t = document.querySelector('.room-top');
    var table = document.getElementById('table-ready');
    var onTable = !!(table && !table.classList.contains('hidden'));
    var p = onTable ? document.getElementById('tr-card') : document.getElementById('room-players');
    var s = t ? t.closest('.screen') : null;
    if (!t || !p || !s) return null;
    var a = t.getBoundingClientRect(), b = p.getBoundingClientRect();
    var c = s.getBoundingClientRect();
    return {
      topBottom: Math.round(a.bottom), listTop: Math.round(b.top),
      overlap: Math.round(a.bottom - b.top),
      screenTop: Math.round(c.top), screenH: Math.round(c.height),
      topRect: Math.round(a.top) + '..' + Math.round(a.bottom),
      listRect: Math.round(b.top) + '..' + Math.round(b.bottom),
      display: getComputedStyle(s).display,
      ls: document.getElementById('stage').classList.contains('ls'),
      rows: getComputedStyle(s).gridTemplateRows,
      topRow: getComputedStyle(t).gridRowStart, listRow: getComputedStyle(p).gridRowStart,
      listPos: getComputedStyle(p).position,
      listTransform: getComputedStyle(p).transform,
      listOffsetTop: p.offsetTop,
      offsetParent: p.offsetParent ? (p.offsetParent.id || p.offsetParent.className) : null,
      parent: p.parentElement ? (p.parentElement.id || p.parentElement.className) : null,
      listInline: p.getAttribute('style') || '',
      kids: Array.prototype.map.call(document.getElementById('screen-room').children, function (k) {
        var r = k.getBoundingClientRect();
        return (k.id || k.className) + '|row=' + getComputedStyle(k).gridRowStart
          + '|col=' + getComputedStyle(k).gridColumnStart
          + '|' + Math.round(r.top) + '..' + Math.round(r.bottom);
      })
    };
  })()`);
  ok(roomGeom && roomGeom.overlap <= 2, '房间号行与玩家列表不重叠', JSON.stringify(roomGeom));
  if (SHOTS) console.log('    截图：' + (await shot('room')));

  /* 最后一个人准备 → 服务端自动开局。不再有点得到的「开始游戏」按钮。 */
  await evaluate('document.getElementById("btn-ready").click()');
  const inTable = await waitFor(IN_TABLE, 12000, '全员准备后没自动开局');
  if (!inTable) await diag('全员准备后没进牌桌');
  ok(inTable, '★ 全员准备 → 自动开局（不需要房主点「开始游戏」）');
  ok((await evaluate('__journey.slotCount()')) >= 3, '第一轮组槽渲染出来了（≥3 组）');

  /* ---------------------------------------------------------------- */
  console.log('\n[5] 第一轮分牌：1 张 / 2 张 / 3 张');

  /* 分牌倒计时：服务端到点会直接判「本回合弃权」（不收分、还得照付各组赢家），
   * 而界面以前一个字都不提示。这里在真浏览器里读两次文本，确认它真的在走、且往下走 ——
   * 静态断言只能证明「有个元素」，证明不了「它在跳」。 */
  const timerA = await evaluate(`(function(){ var e = document.getElementById('gt-timer'); return e ? { t: e.textContent, hidden: e.classList.contains('hidden') } : null; })()`);
  await sleep(1200);
  /* 第二次读之前主动派发一次 visibilitychange（把 visibilityState 临时改成 visible，
   * 测完删掉恢复原型 getter）。为什么不能只 sleep 完直接读：
   * headless 浏览器会把不可见页面的 setInterval 节流到最狠一分钟一次，
   * 于是「1.2 秒后数字自然变小」在这台机器上不成立 —— 那是测试环境的属性，不是产品的问题。
   * 而「切回前台立刻刷新倒计时」本身就是产品必须做的事（玩家切到别的浏览器操作另一个账号，
   * 回来看到的不该是过期数字），所以这里验的正是那条路径。 */
  const timerB = await evaluate(`(function(){
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: function(){ return 'visible'; } });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.visibilityState;
    var e = document.getElementById('gt-timer');
    return e ? { t: e.textContent, hidden: e.classList.contains('hidden') } : null;
  })()`);
  const secA = timerA ? parseInt(String(timerA.t).replace(/[^0-9]/g, ''), 10) : NaN;
  const secB = timerB ? parseInt(String(timerB.t).replace(/[^0-9]/g, ''), 10) : NaN;
  ok(!!timerA && timerA.hidden === false,
    '分牌阶段顶栏出现倒计时（我还没提交时）', JSON.stringify(timerA));
  ok(secA > 0 && secB > 0 && secB < secA,
    '★ 倒计时随真实时间推进（1.2 秒后数字变小），切回前台会立刻刷新',
    secA + ' -> ' + secB);
  console.log('    倒计时实测：' + (timerA && timerA.t) + ' → ' + (timerB && timerB.t));

  /* 满手牌是牌桌最挤的状态：6 张手牌 + 三组空槽 + 对手座位卡同屏，横屏尤其要看。
   * 必须在 fillRound **之前**截 —— 分完牌手牌就空了，截出来是「已全部放入分组」的
   * 半空状态，看不到手牌区真实排版（上一版就是这么截的，等于没验）。 */
  if (SHOTS) console.log('    截图：' + (await shot('game')));

  const r1 = await fillRound(1, 3);
  ok(r1, '★ 第一轮 6 张牌全部分完（牌桌真的能玩）');

  const submitted1 = await submitRound();
  ok(submitted1, '第一轮提交成功（确认框弹出并点了确定）');

  /* 提交后全员到齐 → 服务端结算 → 前端弹「第一轮结算」。
   * AI 提交有一点延迟，所以这里是显式等待，不是固定 sleep。 */
  const result1 = await waitFor('__journey.resultOpen()', 15000, '第一轮结算弹窗没出现');
  if (!result1) await diag('第一轮结算弹窗没出现');
  ok(result1, '第一轮结算弹窗出现');
  const title1 = await evaluate('__journey.resultTitle()');
  ok(/结算/.test(String(title1 || '')), '结算弹窗标题是「第X轮结算」', JSON.stringify(title1));

  /* ★ 逐组结算（v89 §13.1）：一次结算里有 3 组，应该**一幕一组**地放，
   * 而不是一次把三张卡铺满。以前一次铺满，三组之间只有 0.35s 的错峰，
   * 五六行 ×3 一起出现，玩家根本来不及看第一组到底谁赢。 */
  const meta0 = await evaluate('__journey.resultMeta()');
  ok(meta0 && meta0.steps === 3, '★ 第一轮结算拆成 3 幕（实际 ' + (meta0 && meta0.steps) + '）',
    JSON.stringify(meta0));
  ok(meta0 && meta0.cards === 1, '★ 每一幕只画一组（实际 ' + (meta0 && meta0.cards) + ' 组）',
    JSON.stringify(meta0));
  ok(meta0 && meta0.step === 0, '从第 1 幕开始', JSON.stringify(meta0));
  ok(meta0 && /第 1\/3 组/.test(meta0.title), '标题带「第 1/3 组」', meta0 && meta0.title);
  ok(meta0 && /下一组/.test(meta0.next) && /3 秒/.test(meta0.next),
    '脚注写清楚「下一组 · 3 秒后自动」', meta0 && meta0.next);
  ok(meta0 && meta0.btn === '下一组', '按钮说的是「下一组」，不是「继续游戏」',
    meta0 && meta0.btn);
  ok(meta0 && meta0.hold === 3000, '★ 默认节奏 3000ms（不是被 ?hold= 顶掉的探针节奏）',
    meta0 && String(meta0.hold));

  await evaluate(`document.getElementById('btn-result-close').click()`);
  await sleep(150);
  const meta1 = await evaluate('__journey.resultMeta()');
  ok(meta1 && meta1.open && meta1.step === 1, '★ 点「下一组」前进一幕（不是一下关掉整轮）',
    JSON.stringify(meta1));
  ok(meta1 && /第 2\/3 组/.test(meta1.title), '标题跟着走到「第 2/3 组」', meta1 && meta1.title);

  /* ---------------------------------------------------------------- */
  console.log('\n[6] 第二轮分牌：1 张 / 5 张');

  /* 可能有两种走向：
   *   a) 第一轮结算就有人分数见底 → 直接进结算页（#screen-settle）
   *   b) 常见情况 → 关闭结算弹窗，进入第二轮
   * 两条都算真实路径，都要能继续走。 */
  const settleAlready = await evaluate('__journey.vis("screen-settle")');
  if (!settleAlready) {
    await evaluate('__journey.closeResult()');
    const r2Ready = await waitFor('(function(){ var c = __journey.chips(); return c.length === 2; })()', 8000, '第二轮组标签没出来');
    if (!r2Ready) await diag('第二轮没开始');
    ok(r2Ready, '关闭第一轮结算弹窗 → 进入第二轮（组标签变成 2 个：单张 / 斗牛）');

    if (r2Ready) {
      const r2 = await fillRound(2, 2);
      ok(r2, '★ 第二轮 6 张牌全部分完');
      const submitted2 = await submitRound();
      ok(submitted2, '第二轮提交成功');
    }
  } else {
    console.log('    第一轮结算就有人见底 → 直接进结算页，跳过第二轮');
    ok(true, '第一轮结算即结束本局（分数见底）');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[7] 本局结束 → 结算页');

  /* 第二轮结算后，如果没人见底，服务端会直接发下一把（回到第一轮分牌）。
   * 一局打到「有人分数清零」可能要好几把，旅程测试不能陪它打十把 ——
   * 所以这里走真实玩家也会走的另一条结束方式：结束本局（AI 不计入投票人，
   * 单人房当场成立），结束本局并落档。 */
  let settled = await waitFor('__journey.vis("screen-settle")', 6000, null);
  if (!settled) {
    await evaluate('__journey.closeResult()');

    /* ★ 先打第二把，再解散。
     *
     * 为什么必须多打一把：用户报「回放还是只能看到一把」，而**只打一把的旅程里，
     * 「整场」和「只攒到一把」长得一模一样** —— 这条 bug 因此从来没被这条路径测出来。
     * 服务端 history 是 4 条（≈2 把）的滚动窗口，整场必须靠客户端连续吸收攒起来，
     * 只有把「第 2 把」也打出来，才能分辨档案到底在攒还是在原地踏步。 */
    const secondStart = await waitFor('(function(){ var c = __journey.chips(); return c.length === 3; })()', 12000, '第二把第一轮没开始');
    ok(secondStart, '第一把结束后自动开第二把（分牌回到 3 组）');
    if (secondStart) {
      const r3 = await fillRound(1, 3);
      ok(r3, '第二把第一轮分完（6 张全分完）');
      if (r3) await submitRound();
      const res2 = await waitFor('__journey.resultOpen()', 15000, null);
      if (!res2) await diag('第二把第一轮结算弹窗没出现');
      await sleep(400);

      const sessionNow = await evaluate(`(function(){
        var o = { hasSL: typeof SessionLog !== 'undefined' };
        try { o.inspect = SessionLog.inspect(); } catch (e) { o.err = String(e); }
        try { o.rawLen = (localStorage.getItem('lxw_sessions_v1') || '').length; } catch (e) { o.rawLen = -1; }
        return o;
      })()`);
      console.log('    打完两把后的场次档案：' + JSON.stringify(sessionNow));
      ok(sessionNow && sessionNow.hasSL, '★ 场次档案模块已加载（SessionLog 不是 undefined）');
      ok(sessionNow && sessionNow.inspect && sessionNow.inspect.length === 1 && sessionNow.inspect[0].packs === 2,
        '★ 两把都进了场次档案（服务端只有 2 把窗口，靠连续吸收攒齐）',
        JSON.stringify(sessionNow && sessionNow.inspect));

      await evaluate('__journey.closeResult()');
    }

    console.log('    没人见底 → 结束本局（真人只有我一个，投票当场成立）');
    await evaluate('document.getElementById("btn-dissolve-game").click()');
    /* 单人房服务端会立刻判定全员同意，弹窗可能一闪而过 —— 所以两条路都兜。 */
    if (await evaluate('__journey.vis("dissolve-modal")')) {
      await evaluate('document.getElementById("btn-dissolve-agree").click()');
    }
    settled = await waitFor('__journey.vis("screen-settle")', 10000, '结束本局后没进结算页');
  }
  if (!settled) await diag('没能进结算页');
  ok(settled, '★ 本局结束 → 结算页 #screen-settle 可见');

  const bodyLen = await evaluate('__journey.settleBodyLen()');
  ok(typeof bodyLen === 'number' && bodyLen > 30, '★ 结算页 #settle-body 有内容（不是空壳）', 'textContent 长度 ' + bodyLen);

  /* 先等动画落地再量。`.screen.enter` 有 0.3s 滑入，`.settle-row` 有 200ms 起的错峰淡入，
   * 在动画中间量出来的坐标是「飞进来一半」的位置，会让人误以为布局溢出了（真踩过）。 */
  await sleep(700);

  /* 「我」必须看得出来：不光有类名，背景和金色竖条也要真的算出来。
   * 以前只有一圈描边，而冠军行本身就是金底 —— 金碰金，等于没标。 */
  const meInfo = await evaluate('__journey.settleMe()');
  console.log('    我的那一行：' + JSON.stringify(meInfo));
  ok(meInfo && meInfo.rows >= 2, '结算列表至少 2 行（我 + AI）', meInfo && meInfo.rows);
  ok(meInfo && meInfo.me === 1, '★ 恰好一行被标成「我」', meInfo && meInfo.me);
  ok(meInfo && meInfo.pills === 1 && meInfo.pillText === '我', '★ 名字后面有「我」胶囊', meInfo && (meInfo.pills + '/' + meInfo.pillText));
  ok(meInfo && /inset/.test(meInfo.shadow || ''), '★ 那一行有金色左竖条（和排行榜同一套语言）', meInfo && meInfo.shadow);

  /* 结算页不许横向溢出：加了「我」胶囊之后行内容变长，窄屏最容易在这一步崩掉。 */
  const settleFit = await evaluate(`(function(){
    var de = document.documentElement;
    var body = document.getElementById('settle-body');
    return {
      docOver: de.scrollWidth - de.clientWidth,
      bodyOver: body ? body.scrollWidth - body.clientWidth : 0
    };
  })()`);
  ok(settleFit && settleFit.docOver <= 0 && settleFit.bodyOver <= 0,
    '★ 结算页无横向溢出（页面/滚动区都不超宽）', settleFit && JSON.stringify(settleFit));

  if (SHOTS) console.log('    截图：' + (await shot('settle')));

  /* ---------------------------------------------------------------- */
  /* ★ C-3（v117）：候场期改把数。
   *
   * 判据不能用「按钮亮起来了」—— 那可能只是前端自己改了样式。
   * 要看服务端有没有把新档位广播回来：这块是整块重画的，
   * 重画之后仍是 15，说明房间上的 handLimit 真的变了。 */
  console.log('\n[7c] 候场期改把数：点档位 → 服务端广播 → 那块重画');
  const hlBefore = await evaluate('(function(){var b=document.querySelector("#settle-body [data-hand-limit].is-on");return b?b.getAttribute("data-hand-limit"):"";})()');
  console.log('    当前档位：' + hlBefore);
  await evaluate('document.querySelector(\'#settle-body [data-hand-limit="15"]\').click()');
  const hlOk = await waitFor(
    'document.querySelector(\'#settle-body [data-hand-limit="15"]\').classList.contains("is-on")',
    6000, '改了把数那块没重画');
  ok(hlOk, '★ 点档位 15 → 结算页那块重画成 15（说明服务端收下并广播了）', hlBefore + ' → 15');
  /* 顺带确认这块没有把结算页撑宽 —— 它比名次列表还宽就会横向溢出 */
  const hlFit = await evaluate(`(function(){
    var d = document.documentElement;
    var row = document.querySelector('#settle-body .shl-opts');
    return { docOver: d.scrollWidth - d.clientWidth,
             rowW: row ? Math.round(row.getBoundingClientRect().width) : 0,
             rowWrap: row ? Math.round(row.getBoundingClientRect().height) : 0 };
  })()`);
  ok(hlFit && hlFit.docOver <= 0, '★ 加了这块之后结算页仍然没有横向溢出', JSON.stringify(hlFit));

  /* ★ C-2（v116）：结算后点「开始下一局」是一步到位 —— 报名即就位，
   * 人数够的话服务端在这一次广播里就发牌，中间不再有「回房间页再点一次准备」那一屏。
   *
   * 这一段的形状因此变了：以前验的是「回到准备态 + 能撤回」，现在验的是
   * 「按一下就真的开打」。就位态本身没有消失（多真人房里，有人还在结算页时仍会出现），
   * 但这个脚本只有一个真人 + 一个 AI，AI 在结算那一刻就自动报名了，
   * 所以这里永远凑得够人、永远看不到就位态。
   *
   * 就位态的 UI（按钮在不在视口里、会不会被 overflow 静默裁掉）因此**失去了自动化覆盖**，
   * 见 docs/release-progress.md v116 一节的「没验证到的」。
   *
   * 开打之后要「结束本局」回到结算页 —— 下面 [8] 的战绩是从结算页进的，
   * 停在对局里会把那条链路截断。 */
  console.log('\n[7b] 一次点击：结算页 →「开始下一局」→ 直接开打');
  await evaluate('document.getElementById("btn-next").click()');
  /* 判据用「真的进了牌桌」而不是「进了准备态」：C-2 要的正是跳过准备态。 */
  const straightIn = await waitFor(IN_TABLE, 12000, '点了「开始下一局」没有直接开打');
  ok(straightIn, '★ 点「开始下一局」直接开打（不再有「回房间页再点一次准备」）');

  if (straightIn) {
    /* 确认框：房间里没有「停在结算页的真人」时不该弹 —— 弹了就是多点一次，
     * 而 C-2 的全部意义就是少这一次。 */
    ok(!(await evaluate('__journey.confirmOpen()')), '★ 没人在结算页时不再弹「现在就开下一局」确认框');

    const slotsNow = await evaluate('__journey.slotCount()');
    ok(slotsNow >= 3, '★ 新一局真的发了牌（第一轮组槽 ≥3 组）', slotsNow);

    /* 上一局打完时我的分数会被清零：新一把从 0 起算。
     * 结算页上那句「下一把分数从 0 分重新开始」说的就是这件事，这一条是它的实测版。 */
    const zeroed = await evaluate(`(function(){
      var t = document.getElementById('game-top');
      return t ? t.textContent : '';
    })()`);
    ok(/0/.test(zeroed || ''), '新一局分数从 0 起（顶栏能看到 0）', JSON.stringify(String(zeroed).slice(0, 60)));

    /* 回到结算页，给 [8] 铺路。这一把一分没打，服务端会判 voided，
     * 不会往档案里记一场 —— 所以不会污染下面「战绩」和「排行榜」的期望值。 */
    console.log('    收尾：结束本局，回到结算页');
    await evaluate('document.getElementById("btn-dissolve-game").click()');
    if (await evaluate('__journey.vis("dissolve-modal")')) {
      await evaluate('document.getElementById("btn-dissolve-agree").click()');
    }
    const backSettle = await waitFor('__journey.vis("screen-settle")', 10000, '结束本局后没回结算页');
    ok(backSettle, '★ 新一局结束本局 → 回到结算页（下面还要从这里进战绩）');
  } else {
    await diag('点了「开始下一局」没直接开打');
  }

  /* ---------------------------------------------------------------- */
  /* ★ v122：房主「等个人」。
   *
   * 真机场景：三个人打完都在结算页，手一起点到「开始下一局」→ 服务端立刻发牌，
   * 第四个人这时候才输完房号，被关在门外一整局。
   * 门外有没有人，服务端不可能知道（没连接、没房间），所以只能由房主明说。
   *
   * 这一段验三件事，缺一件这个功能就是假的：
   *   ① 结算页真的画出了那颗按钮（房主可见）；
   *   ② 挂起之后**报名也不开牌** —— 这才是它存在的意义；
   *   ③ 解除之后立刻开牌（不用再点一次「开始下一局」）。
   * 用的是真按钮 + 真协议，不是直接改前端状态。 */
  console.log('\n[7e] 等个人：挂起 → 报了名也不开牌 → 放行 → 立刻开');
  const holdShown = await waitFor(
    '!!document.querySelector("[data-hold-next]")', 8000, '结算页没有「先别开，我等个人」');
  ok(holdShown, '★ 结算页有「先别开，我等个人」（房主可见）');

  /* ★ 必须在首屏：结算列表在 390×844 上要滚动才看得全，而房主只有几秒决策时间。
   * 第一版把它放在滚动区底部，功能"存在"但点不到 —— 那等于不存在。 */
  const holdRect = await evaluate(`(function(){
    var b = document.querySelector('[data-hold-next]');
    if (!b) return null;
    var r = b.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom),
             vh: window.innerHeight, w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  ok(holdRect && holdRect.top >= 0 && holdRect.bottom <= holdRect.vh,
    '★★ 「等人」在首屏可见（不用滚动就能点）', holdRect && JSON.stringify(holdRect));
  ok(holdRect && holdRect.h >= 44 && holdRect.w >= 44,
    '★ 热区 ≥ 44×44（拇指点得到）', holdRect && (holdRect.w + '×' + holdRect.h));

  await evaluate('document.querySelector(\'[data-hold-next="1"]\').click()');
  const held = await waitFor(
    '!!document.querySelector(\'[data-hold-next="0"]\')', 8000, '挂起后按钮没变成「人齐了，开牌」');
  ok(held, '★ 点一下变成「人齐了，开牌」（服务端收下并广播回来了，不是前端自己翻转的）');
  const heldTxt = await evaluate('(document.getElementById("settle-wait").textContent||"").trim()');
  ok(/挂起/.test(heldTxt || ''), '★ 结算页说明「房间已挂起」', JSON.stringify(heldTxt));
  /* 倒计时（v125）：3 分钟后会自动放行这件事，以前界面一个字都不说 ——
   * 到点牌突然开了反而像 bug。这里守两件事：有这么一句，且它是从服务端下发的
   * 绝对到期时刻算出来的（本地凭 3 分钟算不出来「2 分 59 秒」这种值）。 */
  const holdLeft = await evaluate(`(function(){
    var n = document.querySelector('#settle-wait .hold-left');
    return { text: n ? n.textContent : '', exists: !!n };
  })()`);
  ok(holdLeft && holdLeft.exists, '★★ 挂起时显示「还剩多久」', JSON.stringify(holdLeft));
  ok(holdLeft && /还剩|即将放行/.test(holdLeft.text || ''),
    '★ 文案是倒计时（说明真的读到了服务端下发的到期时刻）', JSON.stringify(holdLeft));

  /* 报名：AI 早就报了，我再点一下就齐了 —— 但挂起挡着，不许开。
   * 判据不能用 IN_TABLE：就位态里 #slots 只是被加了 hidden，上一把的 slot 节点还在 DOM 里，
   * 拿「节点数量」判断会假阳性（这里第一次跑就是这么红的）。
   * 真正要看的是「停在就位态」：table-ready 露着、#slots 还是 hidden。 */
  await evaluate('document.getElementById("btn-next").click()');
  await sleep(1500);
  const stillReady = await evaluate(`(function(){
    var tr = document.getElementById('table-ready');
    var slots = document.getElementById('slots');
    return {
      ready: !!(tr && !tr.classList.contains('hidden')),
      slotsHidden: !!(slots && slots.classList.contains('hidden')),
      cards: document.querySelectorAll('#hand .card-wrap').length
    };
  })()`);
  ok(stillReady && stillReady.ready && stillReady.slotsHidden,
    '★★ 报名之后停在就位态、没有发牌（挂起真的挡住了自动开局）', JSON.stringify(stillReady));
  ok(await evaluate('__journey.vis("btn-hold-off")'), '★ 就位态里房主也能看到「人齐了，开牌」（不用先撤回报名）');

  await evaluate('document.getElementById("btn-hold-off").click()');
  const opened = await waitFor(IN_TABLE, 12000, '点「人齐了，开牌」之后没有开局');
  ok(opened, '★ 解除之后立刻开牌（人已经齐了，不该再要一次点击）');

  /* 收尾：这一把一分没打，服务端判 voided，不污染下面的战绩期望值。 */
  if (opened) {
    await evaluate('document.getElementById("btn-dissolve-game").click()');
    if (await evaluate('__journey.vis("dissolve-modal")')) {
      await evaluate('document.getElementById("btn-dissolve-agree").click()');
    }
    const backSettle2 = await waitFor('__journey.vis("screen-settle")', 10000, '结束本局后没回结算页');
    ok(backSettle2, '新一局结束本局 → 回到结算页');
  } else {
    await diag('「等个人」解除后没开牌');
  }

  /* ---------------------------------------------------------------- */
  /* ★ C-3b（v118）：旁听。
   *
   * 这是本次唯一「1 真人 + 1 AI 房造不出来」的场景 —— 旁听的前提是
   * 「别人把下一局开了，而我没报名」，也就是至少两个人报了名。
   * 而 AI 房里我能看见的「补 AI」按钮只在「我已经报名」时才出现（就位态），
   * 一旦报名就自动开局、我就是上场的人，永远看不到旁听。
   *
   * 所以这里用协议补第二个 AI：等价于「房主在另一台设备上点了补 AI」。
   * 两张 AI 都会在结算期自动报名（markSettled / addBot 各自预置），
   * 人数一够服务端立刻开局，而我没报名 → 旁听。
   *
   *
   * 把数保持 [7c] 改成的 15 不动，这是**故意的**：第一次跑的时候把它改回了 3，
   * 结果两个 AI 一两秒就把整局打完，journey 的轮询连一帧旁听态都没抓到
   * （诊断里已经是打完的结算页了）。要看得见这一屏，就得让它多活一会儿。
   * 代价是这一段结束时这一局还在打 —— 所以旁听的人要从这颗卡自带的
   * 「离开房间」退出去（旁听态藏了整条动作条，没有第二个出口）。 */
  console.log('\n[7d] 门槛：我不表态，整桌就不开（v121）');
  const addedBot = await evaluate('RoomStore.addBot().then(function(r){ return JSON.stringify(r); })');
  console.log('    补第二个 AI：' + addedBot);
  /* 两个 AI 都会在结算期自动报名（markSettled / addBot 各自预置），
   * 所以「人数够」这件事已经成立 —— 但 v121 起还要等房间里所有真人表态。
   * 我没点，就不许开。这一条就是真机上那个 bug 的正面复现：
   * 以前这一刻会直接发牌，然后我被判成旁听。 */
  await sleep(1500);
  ok(await evaluate('__journey.vis("screen-settle")'),
    '★★ 两个 AI 都报名了、我没点 → 不开局（不再把人静默判成旁听）');
  const waitTxt = await evaluate('(document.getElementById("settle-wait").textContent || "").trim()');
  console.log('    结算页等待文案：' + JSON.stringify(waitTxt));
  ok(/还在等你/.test(waitTxt || ''),
    '★★ 结算页点名「还在等你」（以前只说「已经有 N 人进入下一把」，不说是谁在等）', JSON.stringify(waitTxt));

  console.log('\n[7d2] 自己请假：这一把先不打 → 他们开了，我在旁边看');
  /* 「这一把先不打」是 v121 新增的出口。它存在的理由：门槛收紧之后，
   * 一个人如果什么都不点，整桌就一直等 —— 于是「不等他」成了唯一出路，
   * 而那是**别人**替他做的决定。让他自己说更省事，也不伤感情。
   *
   * 这一步同时是这条链路的端到端验收：它点的是真按钮、走的是真协议，
   * 顺手把两个一直没被点过的 bug 打了出来（见 release-progress v121）。 */
  await evaluate('document.getElementById("btn-sit-out").click()');
  const satOut = await waitFor('__journey.vis("spectator")', 12000, '请假之后没进旁听态');
  ok(satOut, '★★ 点「这一把先不打」→ 两个 AI 立刻开打 → 我进旁听（说明请假真的被服务端收下了）');
  const specShown = await waitFor('__journey.vis("spectator")', 12000, '没进旁听态');
  if (specShown) {
    const spec = await evaluate(`(function(){
      var sp = document.getElementById('spectator');
      var hand = document.getElementById('hand');
      return {
        text: (sp.textContent || '').replace(/\\s+/g, ' ').trim(),
        slotsHidden: document.getElementById('slots').classList.contains('hidden'),
        bottomHidden: document.querySelector('#screen-game .game-bottom').classList.contains('hidden'),
        docOver: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        handCards: hand ? hand.querySelectorAll('.card').length : 0
      };
    })()`);
    console.log('    旁听态：' + JSON.stringify(spec));
    ok(/旁听中/.test(spec.text || ''), '★ 旁听卡画出来了（写着「旁听中」）', JSON.stringify(spec.text));
    ok(/你不在这一局/.test(spec.text || ''), '★ 标题说清「你不在这一局」（v121 换掉了含糊的「这一局你在旁观」）');
    ok(/打完会回到结算页/.test(spec.text || ''), '★ 说明里给出了终点：这一局打完就回结算页');
    ok(spec.slotsHidden === true, '★ 组槽藏起来了（旁听的人没有牌可放）');
    ok(spec.bottomHidden === true, '★ 手牌与提交那块整体藏起来了');
    ok(spec.handCards === 0, '★ 手上确实一张牌都没有');
    ok(spec.docOver <= 0, '★ 旁听卡没把对局页撑出横向滚动', JSON.stringify(spec));
    if (SHOTS) console.log('    截图：' + (await shot('spectator')));

    /* 旁听卡自带的出口。底部动作条整块藏起来了（里面有「离开房间」），
     * 所以这里必须有一颗自己的 —— 否则旁听的人只能关页面或干等。 */
    const hasLeave = await evaluate(`(function(){
      var b = document.querySelector('#spectator .btn');
      return b ? (b.textContent || '').trim() : '';
    })()`);
    ok(/离开房间/.test(hasLeave || ''), '★ 旁听卡自带「离开房间」出口（动作条整块藏了）', JSON.stringify(hasLeave));
    await evaluate('document.querySelector("#spectator .btn").click()');
    /* 离开之前 onLeave 会先 fetch 一次快照（最长 2.5 秒）再弹确认框 ——
     * 点完立刻看 #confirm-modal 一定是 false，得等它出来。 */
    const askLeave = await waitFor('__journey.vis("confirm-modal")', 8000, '离开没弹确认框');
    ok(askLeave, '★ 旁听时离开仍然先问一次');
    if (askLeave) await evaluate('document.getElementById("btn-confirm-ok").click()');
    const leftToHome = await waitFor('__journey.vis("screen-home")', 12000, '旁听后没离开房间');
    ok(leftToHome, '★ 旁听状态下能正常离开 → 回到首页（不被锁在房间里）');
  } else {
    /* 失败时最想知道的一件事：**是没开局，还是开太快没抓到**。
     * 这两种的修法完全相反（前者是服务端没推进，后者是这段脚本等不住），
     * 所以把客户端手上的房间态一并打出来。 */
    const dbg = await evaluate(`(function(){
      var rid = (document.getElementById('room-code') || {}).textContent || '';
      var r = RoomStore.getRoom(rid);
      if (!r) return 'null';
      return JSON.stringify({
        phase: r.phase, n: r.players.length,
        players: r.players.map(function(p){
          return p.id.slice(-4) + ':' + (p.benched ? 'B' : '-') + ':' + (p.wantNext ? 'W' : '-');
        })
      });
    })()`);
    await diag('没进旁听态；room=' + dbg);
  }

  console.log('\n[8] 查看战绩：必须是账号数据');

  /* v118（C-3b）之后从这里开始我已经不在房间里了（旁听那一段结束时退了出来），
   * 所以入口换成首页那颗。测的东西没变：战绩页读的是账号数据、人机局不计入。 */
  await evaluate('document.getElementById("btn-records-home").click()');
  const recShown = await waitFor('__journey.vis("screen-records")', 8000, '战绩页没打开');
  if (!recShown) await diag('战绩页没打开');
  ok(recShown, '从首页点「查看战绩」→ #screen-records 可见');

  /* 页脚文案是异步切的：登录后等账号数据回来才变成「已保存到账号」。
   * 所以要等文案到位才算数，不能拿第一帧的断言。 */
  const cloudSrc = await waitFor('/已保存到账号/.test(__journey.recordsSource())', 12000, '战绩页没切到账号数据');
  const srcText = await evaluate('__journey.recordsSource()');
  if (!cloudSrc) await diag('战绩页数据源文案：' + JSON.stringify(srcText));
  ok(cloudSrc, '★ 战绩页页脚写的是「已保存到账号 · 换设备也在」（读的是账号数据）', JSON.stringify(srcText));

  const games = await evaluate('__journey.games()');
  /* 这一趟是「补一个 AI 凑够人开局」，属于含 AI 的对局 —— 按口径不计入战绩，
   * 所以 #rp-games 必须是 0。断言反过来写，是因为这条正是需求的核心：
   * 以前这里断言 ≥1，改口径后如果还看见 1，就说明人机局又混进统计了。 */
  ok(games === 0, '★ 人机局不进档案：#rp-games 仍是 0', JSON.stringify(games));

  const aiInfo = await evaluate(`(function(){
    var note = document.getElementById('rp-ai-note');
    var rows = document.querySelectorAll('#records-list .rp-row');
    return {
      noteHidden: note ? note.classList.contains('hidden') : null,
      noteText: (document.getElementById('rp-ai-note-text') || {}).textContent || '',
      rows: rows.length,
      aiRows: document.querySelectorAll('#records-list .rp-row.is-ai').length,
      badges: document.querySelectorAll('#records-list .rp-row .rp-row-ai').length,
      total: (document.getElementById('rp-net') || {}).textContent,
      count: (document.getElementById('rp-list-count') || {}).textContent
    };
  })()`);
  console.log('    含人机：' + JSON.stringify(aiInfo));
  ok(aiInfo.aiRows >= 1, '★ 人机局在战绩列表里看得见（不是藏起来）', JSON.stringify(aiInfo));
  ok(aiInfo.badges >= 1, '★ 那一行带「含人机」徽标', JSON.stringify(aiInfo));
  ok(aiInfo.noteHidden === false, '★ 列表上方出现人机说明行', JSON.stringify(aiInfo));
  /* 正文前面还有一枚「含人机」芯片，所以文案本身从「N 局」起头，
   * 不再重复「人机对局」三个字（否则读成「含人机人机对局」）。 */
  /* v110：单位统一成「场」（aiCount 是场数）。原来是「局」，产品改了这里就得跟。 */
  ok(/^\d+ 场/.test(aiInfo.noteText || '') && /不计入战绩与排行榜/.test(aiInfo.noteText),
    '★ 说明行写清「不计入战绩与排行榜」', aiInfo.noteText);
  ok(aiInfo.total === '0', '★ 累计净胜仍是 0（那一局 +/− 没有混进汇总）', aiInfo.total);
  if (SHOTS) console.log('    截图：' + (await shot('records')));

  /* ★ 真实数据下的回放（不是播种数据）。
   * 用户报的就是这条：点进去只有一把、标题写着「那局」「这一把的过程」。
   * 只看 `.replay-pack` 数量不够 —— 还要看副标题，因为「单把兜底」和
   * 「整场只有一把」渲染出来的 DOM 几乎一样，区别只在文案与标题。 */
  const hasReplayBtn = await evaluate('!!document.querySelector(".rp-replay")');
  ok(hasReplayBtn, '战绩列表里有「看回放」按钮');
  if (hasReplayBtn) {
    /* 先 focus 再 click：程序化 click() **不会让按钮获得焦点**，而真人点击会。
     * 不补这一步，`hideModalEl` 记录的归还目标就是 null，
     * 后面「关闭后焦点归还」的两条断言会被误判成红（已经踩过一次）。 */
    await evaluate('(function(){ var b = document.querySelector(".rp-replay"); b.focus(); b.click(); })()');
    await sleep(700);
    const rv = await evaluate(`(function(){
      var sub = document.getElementById('replay-sub');
      var title = document.getElementById('replay-title');
      return {
        title: title ? title.textContent : '',
        sub: sub ? sub.textContent : '',
        packs: document.querySelectorAll('.replay-pack').length,
        rounds: document.querySelectorAll('.replay-round-title').length,
        target: document.querySelectorAll('.replay-pack.is-target').length,
        packInfo: Array.prototype.map.call(document.querySelectorAll('.replay-pack'), function (el) {
          return { hand: el.getAttribute('data-hand'), no: (el.querySelector('.replay-pack-no') || {}).textContent || '' };
        }),
        gameTitles: Array.prototype.map.call(document.querySelectorAll('.replay-game-title'), function (el) {
          return el.textContent;
        })
      };
    })()`);
    console.log('    真实数据回放：' + JSON.stringify(rv));
    /* 把数不写死。原来这里断言「整场 2 把」，那是这段脚本恰好只打了两把；
     * v118 加了旁听那一段（两个 AI 自己往下打了几把才被看见），现在是 4 把。
     * 断言要守的是**「整场而不是单把」**，不是某个具体数字 ——
     * 写成数字只会在场景一变时假红，然后被人把数字改大，守的东西一点没变。 */
    ok(rv.packs >= 2, '★ 回放里是整场（不是单把兜底）', JSON.stringify(rv));
    ok(/这一局/.test(rv.title), '★ 标题写「这一局」（走的是整场档案，不是单把兜底）', JSON.stringify(rv.title));
    /* 副标题有两种合法形态（v124）：
     *   「整场 N 把」—— 这份档案只有一局；
     *   「N 局 · M 把」—— 同一个房间里打完一局又点了「开始下一局」。
     * 档案是按**房间**攒的（房号 + 建房时间），续局不换房间，所以跨局是正常的。
     * 这里守「数字与实际把数一致」，不守某一种措辞 —— 写死措辞只会在场景一变时假红。 */
    const subNums = String(rv.sub).match(/\d+/g) || [];
    const subPacks = subNums.length ? Number(subNums[subNums.length - 1]) : -1;
    ok(/^(整场 \d+ 把|\d+ 局 · \d+ 把)$/.test(String(rv.sub)) && subPacks === rv.packs,
      '★ 副标题里的把数与实际把数一致', JSON.stringify(rv.sub) + ' / packs=' + rv.packs);

    /* ★ 「第 N 把」的数字不能是跨局连续的身份号。
     *
     * 用户报的 bug：房间打完一局再点「开始下一局」，第二局的详情显示
     * 「第 4 把 / 第 5 把」—— 因为标题借用了 handId（dealAll 里递增、永不重置），
     * 而 handId 是**身份**，不是序号。
     *
     * 判据用「序号 ≤ 这份档案的总把数」：
     *   · 序号来自 handCount，它每局归 1，所以任何一局里最大也只到该局把数，
     *     而该局把数 ≤ 总把数 —— 超过总把数就一定不是局内序号。
     *   · 身份号来自 handId，跨局一直涨，第 4 局第 3 把会变成「第 7 把」，
     *     7 > 4 直接命中。
     *
     * 为什么不断言「每局从 1 连续」：这台 ci 机器上 AI 快进，SessionLog 偶尔
     * 收不全（history 只留 2 把，吸收跟不上就会漏前面的把），缺口会让
     * 「从 1 开始」变成假红。纯数据层的连续性由 replay-handno.test.js 守，
     * 那里是可控的真对局，能做到每把都收全。 */
    const noNums = (rv.packInfo || []).map(function (p) {
      var parts = String(p.no || '').split(' ');
      return Number(parts[1]);
    });
    ok(noNums.length === rv.packs && noNums.every(function (n) {
      return isFinite(n) && n >= 1 && n <= rv.packs;
    }), '★★ 「第 N 把」是局内序号（不大于总把数），不是跨局累加的身份号',
      JSON.stringify(rv.packInfo));
    const gt = rv.gameTitles || [];
    ok(gt.length === 0 || gt.length >= 2,
      '局分隔要么不出现（单局），要么每局一个 —— 不会只冒出孤零零一个', JSON.stringify(gt));
    ok(rv.target === 1, '★ 我点的那把被标出来（不是一把都不标）', JSON.stringify(rv.target));
    if (SHOTS) console.log('    截图：' + (await shot('replay')));

    /* 焦点：打开时进弹窗、关闭后回到那个「看回放」按钮。
     * 键盘用户靠它知道自己还在哪 —— 关掉之后焦点停在已经看不见的按钮上，
     * 下一次 Tab 等于从虚空开始数。 */
    const focusIn = await evaluate('(function(){ var m = document.getElementById("replay-modal"); return m.contains(document.activeElement) ? (document.activeElement.id || document.activeElement.className) : "外面"; })()');
    ok(focusIn !== '外面', '打开回放时焦点进入弹窗', String(focusIn));
    await evaluate('document.getElementById("btn-replay-close").click()');
    await sleep(400);
    const focusBack = await evaluate('(function(){ var a = document.activeElement; return { id: a.id, cls: a.className, isOpener: !!a.closest(".rp-replay") }; })()');
    console.log('    关闭回放后的焦点：' + JSON.stringify(focusBack));
    ok(focusBack && focusBack.isOpener, '★ 关闭回放后焦点回到「看回放」按钮', JSON.stringify(focusBack));
    await evaluate('(function(){ var b = document.getElementById("btn-records-back"); if (b) b.focus(); })()');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[9] 返回首页 → 排行榜');

  await evaluate('document.getElementById("btn-records-back").click()');
  /* 从结算页进来的，返回先回结算页；再点「离开房间」并确认，才回首页。 */
  const backToSettle = await waitFor('__journey.vis("screen-settle")', 5000, null);
  if (backToSettle) {
    await evaluate('document.getElementById("btn-back-room").click()');
    if (await waitFor('__journey.confirmOpen()', 4000, null)) {
      await evaluate('__journey.clickConfirmOk()');
    }
  }
  const backHome = await waitFor('__journey.vis("screen-home")', 10000, '离开房间后没回首页');
  if (!backHome) await diag('离开房间后没回首页');
  ok(backHome, '离开房间 → 回到首页');

  await evaluate('document.getElementById("btn-rank-home").click()');
  const rankShown = await waitFor('__journey.vis("screen-rank")', 8000, '排行榜页没打开');
  if (!rankShown) await diag('排行榜页没打开');
  ok(rankShown, '首页排行入口 → #screen-rank 可见');

  const rankReady = await waitFor('__journey.rankRows() >= 1', 12000, '排行榜没有行');
  const rows = await evaluate('__journey.rankRows()');
  if (!rankReady) await diag('排行榜行数 ' + JSON.stringify(rows));
  ok(typeof rows === 'number' && rows >= 1, '★ 排行榜 #rank-list 里有 ≥1 行', JSON.stringify(rows));

  /* 同样要等滑入动画跑完：`.screen.enter` 是 0.3s，
   * 在动画中间量出来的行会整体右移，看台底色/宽度全都不准。 */
  await sleep(600);
  const podium = await evaluate('__journey.rankPodium()');
  console.log('    前三名：' + JSON.stringify(podium));
  /* 第一名必须和普通行看得出区别。两条路都算数：
   *   不是我 → 看台底色（金/银/铜）；
   *   就是我 → 我的金条高亮（这种情况下看台底色是故意让位的，否则两者的金会互相盖）。
   * 所以不能只断言 bg —— 单人榜单里第一名永远是我，那样会误报。 */
  const first = (podium && podium[0]) || null;
  ok(!!first && (first.isMe ? /inset/.test(first.shadow || '') : first.bg !== 'none'),
    '★ 第一名和普通行看得出区别（看台底色或我的金条）',
    JSON.stringify(first));

  /* 榜单满载：真实数据只有 1 行，补到 7 行再量版式 ——
   * 真机上「第一名被容器上边缘硬切」只在行数超过可视高度时才出现，
   * 而横屏改成两列之后就必须一屏排完。合成行只为量版式，量完还原。 */
  const rankFill = await evaluate(`(function(){
    var body = document.getElementById('rank-body');
    if (!body) return { err: 'no-body' };
    var before = body.querySelectorAll('.rank-row').length;
    var guard = 0;
    while (body.querySelectorAll('.rank-row').length < 7 && guard++ < 20) {
      var n = body.querySelectorAll('.rank-row').length + 1;
      var li = document.createElement('li');
      li.className = 'rank-row';
      li.setAttribute('data-synthetic', '1');
      li.innerHTML = '<span class="rank-no">' + n + '</span>'
        + '<span class="rank-name">玩家' + n + '</span>'
        + '<span class="rank-meta">9 场 · 33%</span>'
        + '<span class="rank-net up">+' + (100 - n * 7) + '</span>';
      body.appendChild(li);
    }
    var wrap = document.getElementById('rank-scroll');
    var rows = body.querySelectorAll('.rank-row');
    var r0 = rows[0].getBoundingClientRect();
    var wr = wrap.getBoundingClientRect();
    var out = {
      realRows: before, rows: rows.length,
      cols: (getComputedStyle(body).gridTemplateColumns || '').split(' ').length,
      canScroll: wrap.scrollHeight > wrap.clientHeight + 1,
      firstCut: Math.round(wr.top - r0.top)
    };
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i].getAttribute('data-synthetic')) rows[i].remove();
    }
    return out;
  })()`);
  console.log('    榜单满载（合成了合成行）：' + JSON.stringify(rankFill));
  ok(rankFill && rankFill.canScroll === false,
    '★ 排行榜 7 名一屏排完（不用滚）', JSON.stringify(rankFill));
  ok(rankFill && rankFill.firstCut <= 1,
    '★ 排行榜第一名没被容器上边缘切掉', JSON.stringify(rankFill));

  if (SHOTS) console.log('    截图：' + (await shot('rank')));
  const rankText = await evaluate('__journey.rankText()');
  /* 同样反过来了：这一趟只打过人机局，所以榜上**不该有**这个昵称。
   * 榜上的行是开跑前播种的 3 个合成玩家（见 seedStandingsPlayers）。 */
  ok(String(rankText || '').indexOf(nickname) < 0,
    '★ 榜单里找不到刚注册的昵称「' + nickname + '」（人机局不入榜）',
    JSON.stringify(String(rankText || '').slice(0, 200)));
  ok(/布景甲/.test(String(rankText || '')),
    '榜上的行来自播种的合成玩家（说明榜确实是活的，只是没有我）',
    JSON.stringify(String(rankText || '').slice(0, 200)));

  /* ---------------------------------------------------------------- */
  /* 弹窗无障碍（P7-1）：这一块**必须**在真浏览器里验。
   *
   * pwa/test/modal-a11y.test.js 只能证明「源码里写了 role 属性、写了 Tab 拦截」，
   * 证明不了「按下去真的生效」—— 焦点有没有动、preventDefault 有没有调、
   * 关闭后焦点回到哪，这些只有浏览器知道。所以放在旅途里，每跑一次就验一次。
   *
   * 用 CDP 真页面 + 合成 KeyboardEvent：合成事件会正常派发到监听器上，
   * 而浏览器自己不会替我们移动焦点 —— 于是「焦点动了」只可能是我那段代码干的，
   * 正是要验的东西（真按 Tab 反而分不清是浏览器默认行为还是拦截生效）。 */
  /* ★ 档案卡 → 成就页（v119）：档案卡必须一起关掉。
   *
   * 被报过：从档案卡底部点「成就 3/35 ›」，成就页确实打开了，
   * 但那张个人信息卡还盖在上面 —— 玩家看到的是「一张挡住成就页的档案卡」，
   * 以为功能坏了。根因是那个点击委托只关了座位信息档（.ss-info），
   * 漏了档案卡自己（.profile-box 这个宿主）。
   *
   * 这里从排行榜点一行进档案卡（榜单里的行都带 data-pid），
   * 再点卡里的「成就」，两条一起验：成就页打开了、档案卡关掉了。 */
  console.log('\n[9a] 档案卡 → 成就页：不能留一张卡盖在成就页上');
  const pfOpened = await evaluate(`(function(){
    var row = document.querySelector('#rank-list .rank-row[data-pid]');
    if (!row) return false;
    row.click();
    return true;
  })()`);
  ok(pfOpened, '排行榜点一行（能找到带 data-pid 的行）');
  const pfShown = await waitFor('__journey.vis("profile-modal")', 8000, '档案卡没弹出来');
  ok(pfShown, '★ 点榜单行 → 弹出玩家档案卡');

  const achBtnReady = await waitFor('!!document.querySelector("#profile-body .pf-ach")', 12000,
    '档案卡里没出现「成就」入口');
  ok(achBtnReady, '★ 档案卡底部有「成就 N/35 ›」入口');
  if (achBtnReady) {
    await evaluate('document.querySelector("#profile-body .pf-ach").click()');
    const achOpen = await waitFor('__journey.vis("screen-achievements")', 10000, '点了「成就」没进成就页');
    ok(achOpen, '★ 点档案卡里的「成就」→ 进入成就页');
    const pfGone = await evaluate('!(__journey.vis("profile-modal"))');
    ok(pfGone, '★★ 档案卡同时被关掉（不再盖在成就页上）');
    if (!pfGone) {
      await diag('档案卡还在：' + JSON.stringify(await evaluate(
        '(function(){var m=document.getElementById("profile-modal");return {cls:m.className, shown:!m.classList.contains("hidden")};})()')));
    }
    /* 返回：成就页的返回目标是「打开它时所在的那一屏」，也就是排行榜。 */
    await evaluate('document.getElementById("btn-ach-back").click()');
    const backRank = await waitFor('__journey.vis("screen-rank")', 8000, '成就页返回没回排行榜');
    ok(backRank, '★ 成就页返回 → 回到排行榜（不是回首页）');
  }

  console.log('\n[9b] 弹窗无障碍：语义 / 焦点进出 / Tab 圈定');

  /* 语义：在 DOM 里查，而不是回头 grep 源码。
   * 源码写了属性但没生效的情况（写错元素、被后面覆盖）只有这里看得见。 */
  const sem = await evaluate(`(function(){
    return [].slice.call(document.querySelectorAll('.modal')).map(function(m){
      var lb = m.getAttribute('aria-labelledby');
      var t = lb ? document.getElementById(lb) : null;
      return {
        id: m.id,
        role: m.getAttribute('role'),
        ariaModal: m.getAttribute('aria-modal'),
        labelOk: !!(t && (t.textContent || '').trim())
      };
    });
  })()`);
  const semList = Array.isArray(sem) ? sem : [];
  /* 数量不写死：从源码里数一遍，再和运行时 DOM 对账。
   * 写死过一个 12，加第 13 个弹窗时这条就红了 ——
   * 但那个数字本身不是要验的东西，要验的是「源码里有几个，页面上就该有幾個」，
   * 以及「每一个都带了无障碍语义」。前者对账能在 DOM 被误删时报警，
   * 后者逐个查属性。两边都不用再随弹窗数量手改。 */
  const modalSrcCount = (fs.readFileSync(path.join(__dirname, '..', 'pwa', 'index.html'), 'utf8')
    .match(/class="modal(?:\s[^"]*)?"/g) || []).length;
  ok(semList.length === modalSrcCount,
    '运行时 .modal 数量与源码一致（' + modalSrcCount + ' 个）',
    'DOM ' + semList.length + ' vs 源码 ' + modalSrcCount);
  ok(semList.every((s) => s.role === 'dialog'), '★ 每个弹窗 role 都是 dialog',
    JSON.stringify(semList.filter((s) => s.role !== 'dialog').map((s) => s.id)));
  ok(semList.every((s) => s.ariaModal === 'true'), '★ 每个弹窗都有 aria-modal=true',
    JSON.stringify(semList.filter((s) => s.ariaModal !== 'true').map((s) => s.id)));
  ok(semList.every((s) => s.labelOk), '★ 每个 aria-labelledby 都能读到非空标题（读屏才念得出名字）',
    JSON.stringify(semList.filter((s) => !s.labelOk).map((s) => s.id)));

  /* 打开引导弹窗（首页「玩法规则」入口）。它有两个可聚焦元素：跳过 / 下一步
   * （第一步的「上一步」是 hidden，正好用来验「过滤掉看不见的按钮」）。 */
  await evaluate('document.getElementById("btn-rank-back").click()');
  const backHome2 = await waitFor('__journey.vis("screen-home")', 6000, '从排行榜回不到首页');
  if (!backHome2) await diag('从排行榜回不到首页');

  /* 先把焦点放到「玩法规则」上再点它 —— 模拟键盘用户 Tab 过去按回车。
   * 必须这么做：JavaScript 的 .click() 不会移动焦点，而真实的鼠标/键盘点击会；
   * 不先聚焦的话，「关闭后焦点归还到哪」这条断言验的是一个真实用户不会遇到的状态。 */
  await evaluate('(function(){ var b = document.getElementById("btn-rules"); b.focus(); b.click(); return "ok"; })()');
  const guideOpen = await waitFor('__journey.vis("guide-modal")', 5000, '引导弹窗没打开');
  ok(guideOpen, '首页「玩法规则」→ 引导弹窗打开');

  /* 长正文装不完时必须给「下面还有」的暗示。
   * 横屏实测：引导正文 542 设计高、可视 325（滚掉 217），规则更狠（1252 / 342）。
   * 移动端滚动条平时是隐藏的，最后一行断在半句上，玩家会以为读完了。 */
  const fadeInfo = await evaluate(`(function(){
    var b = document.getElementById('guide-body');
    if (!b) return null;
    return { scrollable: b.scrollHeight > b.clientHeight + 4, fade: b.classList.contains('scroll-fade') };
  })()`);
  ok(!!fadeInfo && (fadeInfo.scrollable ? fadeInfo.fade === true : fadeInfo.fade === false),
    '★ 长正文弹窗：能滚才加底部渐隐、装得下就不加', JSON.stringify(fadeInfo));
  if (SHOTS) console.log('    截图：' + (await shot('guide')));

  /* 焦点移进弹窗是延后 30ms 做的（等弹窗内容注入完），所以这里轮询而不是立刻读 */
  const focusIn = await waitFor(`(function(){
    var a = document.activeElement;
    return !!(a && a.closest && a.closest('#guide-modal'));
  })()`, 3000, '打开后焦点没进弹窗');
  const focusId = await evaluate('(document.activeElement || {}).id || ""');
  if (!focusIn) await diag('打开后焦点没进弹窗');
  ok(focusIn, '★ 打开后焦点自动进入弹窗', '当前焦点 #' + focusId);

  const tabInfo = await evaluate(`(function(){
    function press(shift){
      var ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: !!shift, bubbles: true, cancelable: true });
      document.activeElement.dispatchEvent(ev);
      return ev.defaultPrevented;
    }
    var btns = [].slice.call(document.querySelectorAll('#guide-modal button:not([disabled])'))
      .filter(function (b) { return !b.hidden; });
    var first = btns[0], last = btns[btns.length - 1];
    /* 读焦点必须在 press() **之后** —— 先读 id 再 press 拿到的是按键前的元素，
     * 那样断言永远对不上（我第一版就这么写的，三条全红，看着像产品坏了）。 */
    last.focus();
    var pFwd = press(false);
    var fwd = { id: document.activeElement.id, prevented: pFwd };
    first.focus();
    var pBack = press(true);
    var back = { id: document.activeElement.id, prevented: pBack };
    /* 焦点被挪到弹窗外面（模拟用户点了背景）后再按 Tab：必须被拉回弹窗 */
    var out = document.getElementById('btn-create');
    if (out) out.focus();
    var pPull = press(false);
    var pulled = { id: document.activeElement.id, prevented: pPull,
                   inside: !!(document.activeElement.closest && document.activeElement.closest('#guide-modal')) };
    return { count: btns.length, firstId: first.id, lastId: last.id, fwd: fwd, back: back, pulled: pulled };
  })()`);
  console.log('    Tab 圈定实测：' + JSON.stringify(tabInfo));
  ok(tabInfo && tabInfo.count === 2,
    '弹窗内只算 2 个可聚焦元素（第一步的「上一步」是 hidden，被正确滤掉）',
    JSON.stringify(tabInfo && tabInfo.count));
  ok(tabInfo && tabInfo.fwd.id === tabInfo.firstId && tabInfo.fwd.prevented === true,
    '★ 最后一个元素上按 Tab → 回卷到第一个，并且拦掉了默认行为（不会跑到背景）');
  ok(tabInfo && tabInfo.back.id === tabInfo.lastId && tabInfo.back.prevented === true,
    '★ 第一个元素上按 Shift+Tab → 回卷到最后一个');
  ok(tabInfo && tabInfo.pulled.inside === true && tabInfo.pulled.prevented === true,
    '★ 焦点被挪到弹窗外之后按 Tab → 被拉回弹窗内');

  /* Esc 关闭 + 焦点归还：归还目标是「打开它的那个按钮」 */
  await evaluate(`document.getElementById('guide-modal').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  const guideClosed = await waitFor('!__journey.vis("guide-modal")', 3000, 'Esc 关不掉引导');
  ok(guideClosed, 'Esc 能关掉引导（既有行为没被改动）');
  const returned = await evaluate('(document.activeElement || {}).id || ""');
  ok(returned === 'btn-rules', '★ 关闭后焦点归还到打开它的「玩法规则」按钮', '当前焦点 #' + returned);

  const autoFocusId = await evaluate(`(function(){
    var el = document.querySelector('#confirm-modal [data-autofocus]');
    return el ? el.id : '';
  })()`);
  ok(autoFocusId === 'btn-confirm-cancel',
    '★ 通用确认框的默认焦点在「取消」上（这里也挂着删号，不能让一个回车删掉数据）', autoFocusId);

  /* ---------------- 真浏览器验「嵌套关闭时焦点交给剩下那层」 ----------------
   * 这三条**必须**在真浏览器里验：modal-a11y.test.js 那 8 条只能证明「代码长这样」，
   * 证明不了浏览器真的按这个意图挪了焦点。而焦点没挪的时候界面完全看不出来 ——
   * 只有键盘用户下一次 Tab 从虚空开始数才会察觉。
   *
   * 这条路径也确实有区分力：修之前 hideModalEl 是 if (topModalId()) return;，
   * 关掉改密码后焦点会停在刚被隐藏的 #btn-pwd-cancel 上，
   * accountModal.contains(activeElement) 为 false —— 断言会红。
   *
   * 全程读的是 document.activeElement，不做任何合成事件；
   * 唯一的人工干预是先 focus() 再 click()（JS 的 .click() 自己不移动焦点，
   * 而真实用户按键盘/鼠标点会），这样验的才是真实用户会遇到的状态。 */
  console.log('    嵌套关闭：账号卡 → 修改密码 → 关掉改密码');

  /* ① 打开「我的账号」：弹窗在前台，且焦点已经进到卡里 */
  await evaluate('(function(){ var b = document.getElementById("btn-account"); b.focus(); b.click(); return "ok"; })()');
  const accOpen = await waitFor('__journey.vis("account-modal")', 6000, '账号卡没打开');
  const accFocusIn = await waitFor(`(function(){
    var f = document.activeElement;
    return !!(f && f.closest && f.closest('#account-modal'));
  })()`, 3000, '账号卡打开后焦点没进去');
  const accFocusId = await evaluate('(document.activeElement || {}).id || ""');
  if (!accOpen || !accFocusIn) await diag('账号卡 / 焦点异常');
  ok(accOpen && accFocusIn, '★ 打开「我的账号」→ 账号卡在前台，焦点也在卡里', '焦点 #' + accFocusId);

  /* ② 在账号卡里点「修改密码」，叠出一层。
   * 先确认账号卡真的还在前台 —— 否则这一下点在空气里，后面两条都会莫名其妙地红。 */
  await evaluate('(function(){ var b = document.getElementById("btn-acc-pwd"); b.focus(); b.click(); return "ok"; })()');
  const pwdOpen = await waitFor('__journey.vis("pwd-modal")', 5000, '改密码弹窗没打开');
  /* 焦点进密码框是两段延后叠出来的：showModalEl 自己 30ms，openPwdModal 又补了 60ms，所以轮询 */
  const pwdFocusIn = await waitFor(`(function(){
    var f = document.activeElement;
    return !!(f && f.closest && f.closest('#pwd-modal'));
  })()`, 3000, '改密码打开后焦点没进去');
  const pwdInfo = await evaluate(`(function(){
    return {
      focusId: (document.activeElement || {}).id || '',
      pwdShown: !document.getElementById('pwd-modal').classList.contains('hidden'),
      accStillShown: !document.getElementById('account-modal').classList.contains('hidden')
    };
  })()`);
  if (!pwdOpen || !pwdFocusIn) await diag('改密码弹窗 / 焦点异常');
  ok(pwdOpen && pwdFocusIn && pwdInfo.pwdShown && pwdInfo.accStillShown,
    '★ 账号卡里点「修改密码」→ 改密码在前台、账号卡仍开着（真叠了两层），焦点进密码框',
    JSON.stringify(pwdInfo));

  /* ③ 关掉改密码：焦点必须交给还开着的账号卡。
   * 用点「取消」而不是 Esc —— 这是真实用户更常走的那条路（Esc 走的是同一个 hideModalEl）。 */
  await evaluate('(function(){ var b = document.getElementById("btn-pwd-cancel"); b.focus(); b.click(); return "ok"; })()');
  const pwdClosed = await waitFor('!__journey.vis("pwd-modal")', 3000, '「取消」关不掉改密码');
  const nested = await evaluate(`(function(){
    var f = document.activeElement;
    return {
      inAccount: !!(f && f.closest && f.closest('#account-modal')),
      focusId: (f || {}).id || '',
      tag: (f || {}).tagName || '',
      accShown: !document.getElementById('account-modal').classList.contains('hidden'),
      pwdShown: !document.getElementById('pwd-modal').classList.contains('hidden')
    };
  })()`);
  if (!pwdClosed || !nested.inAccount) await diag('嵌套关闭后焦点没落回账号卡');
  ok(pwdClosed && nested.accShown && !nested.pwdShown && nested.inAccount,
    '★ 关掉改密码 → 焦点交给还开着的账号卡（不是 body，也不是刚被隐藏的「取消」）',
    JSON.stringify(nested));
  /* 绿的时候也把实测到的焦点打出来 —— 数字要能被人看见，
   * 否则「焦点真的动了」这句话就退化成一句口号。 */
  console.log('    嵌套焦点实测：' + JSON.stringify({
    打开账号卡后: accFocusId,
    改密码打开后: pwdInfo.focusId,
    关掉改密码后: nested.focusId + '<' + nested.tag + '>',
    落在账号卡内: nested.inAccount
  }));

  /* 把账号卡关掉，别让它挡着后面的事（这一步不产生断言，只是收拾现场）。
   * 顺带也是「单层关闭」的反面验证：没有下层了，焦点该还回首页那个入口按钮。 */
  await evaluate('(function(){ var b = document.getElementById("btn-acc-close"); if (b) b.click(); return "ok"; })()');
  const accClosed = await waitFor('!__journey.vis("account-modal")', 3000, '账号卡关不掉');
  if (!accClosed) await diag('账号卡关不掉');

  /* ---------------------------------------------------------------- */
  console.log('\n[9c] 缩放健壮性：视口尺寸读到 0 时不许把舞台缩成 0 或负数');

  /* 为什么必须用真浏览器测：这是纯布局事故，静态断言只能证明「代码里有 if」，
   * 证明不了「写进 DOM 的那组像素值是对的」。
   *
   * 事故形态（用户实测：同一部手机同时开 Safari / Edge / PWA 三个容器打牌，
   * 提交后切到另一个浏览器，切回来整屏只剩背景色）：
   *   多开时内存压力最大，iOS 挂起期间可能回收渲染树；恢复那一帧
   *   #viewport 的 clientHeight 读到 0 → availH 变负 →
   *   isLandscapePhone 判定成立 → scale = Math.min(availW/750, 负数/1440) = 负数
   *   → 整个 750×1624 舞台被镜像缩到看不见，stageW 还变成上万的负数，
   *   而且**不会自愈**（此后不再有 resize 事件，用户只能刷新）。
   *
   * 验法：在页面里盖掉 clientHeight 的 getter，派发 resize，读 stage 上真正被写进去的值。 */
  const resizeProbe = await evaluate(`(function(){
    var vp = document.getElementById('viewport');
    var st = document.getElementById('stage');
    if (!vp || !st) return { err: 'missing #viewport or #stage' };
    /* 量的是**渲染结果**（computed transform + 实际盒子），不是内联字符串。
     * 横屏的宽高与缩放现在由 CSS 反算（#stage.ls 的 calc(100% / --ls-scale)），
     * 内联 style 里根本没有 transform —— 拿内联值断言只会得到空字符串，是误判。 */
    function sig() {
      var tf = getComputedStyle(st).transform || 'none';
      var r = st.getBoundingClientRect();
      return tf + '|' + Math.round(r.width) + 'x' + Math.round(r.height);
    }
    var realT = sig();
    /* 有效读数现在是 getBoundingClientRect（不是 clientHeight）。
     * v70 之前 resize() 读 clientHeight，探针也就打桩 clientHeight；
     * v71 改成读 rect 之后，打桩 clientHeight 已经完全影响不到缩放了 ——
     * 自检当场变红（mockWorks:false），这正是它存在的意义：
     * **探针的影响手段失效时要自己喊出来**，否则下面几条断言全是空转。
     *
     * 而且要打的是**宽度**：竖版 scale = availW / 750，高度根本进不了这个式子
     * （舞台高由 CSS 的 calc(100%/--pt-scale) 反算）。只打高度的话，
     * 即使读值真的被吃掉了，舞台也不会变 —— 又是一条空转断言。 */
    var realRect = vp.getBoundingClientRect();
    function stubRect(w, h) {
      vp.getBoundingClientRect = function () {
        var r = realRect;
        return {
          x: r.x, y: r.y, top: r.top, left: r.left,
          right: r.left + w, bottom: r.top + h, width: w, height: h,
          toJSON: function () { return this; }
        };
      };
    }
    function unstub() { delete vp.getBoundingClientRect; }

    /* 自检：先证明「改视口宽度真的会改变缩放」。
     * 不做这一步的话，后面「0 值下缩放没变」可能只是因为这套探针压根影响不了它。 */
    stubRect(Math.round(realRect.width * 0.8), Math.round(realRect.height));
    window.dispatchEvent(new Event('resize'));
    var midT = sig();
    var mockWorks = (midT !== realT);

    /* 核心：把宽度打到 0（= 真机上「布局视口还没算出来」的那一帧）。
     * 修复前 scale = 0/750 = 0，整个舞台被缩成 0 像素，屏幕上只剩背景色。
     *
     * clientWidth/clientHeight 也要一起打 0：resize() 里有一层
     * 「Math.round(rect.width) || vp.clientWidth」的兜底，只打 rect 的话
     * 会从 clientWidth 拿回真实宽度，这条断言就又变成空转了
     * （实测就是这么绿的：zeroT 直接等于真实值 0.52，而不是 0.416）。 */
    stubRect(0, 0);
    Object.defineProperty(vp, 'clientWidth', { configurable: true, get: function () { return 0; } });
    Object.defineProperty(vp, 'clientHeight', { configurable: true, get: function () { return 0; } });
    window.dispatchEvent(new Event('resize'));
    var zeroT = sig();
    delete vp.clientWidth;
    delete vp.clientHeight;

    /* 恢复真实尺寸，但**不手动再派发 resize** —— 交给 resize() 内部那 80ms 重试自愈。
     * 手动补一脚就测不出「它自己会不会补算」了。 */
    unstub();
    return {
      realT: realT, midT: midT, zeroT: zeroT,
      mockWorks: mockWorks,
      unchangedOnZero: zeroT === midT,
      /* 判据必须是「scale 是不是一个正常的正数」，不能只找负号：
       * 没有安全区的设备上算出来的是 scale(0) —— 比负数更彻底，直接缩成 0 像素。
       * （实测：320/390 视口、无安全区时写进去的是 scale(0)；真机带安全区才是负数。） */
      badScale: (function(){
        /* sig() 给的是 "matrix(a,b,c,d,e,f)|WxH"：比例在 matrix 第一个数。
         * 横屏已不在内联样式里写 transform（宽高与缩放都由 CSS 反算），
         * 所以不能再按 scale(...) 这种写法解析。 */
        var tf = String(zeroT || 'none');
        if (tf.indexOf('matrix') !== 0) return true;
        var nums = tf.slice(tf.indexOf('(') + 1, tf.lastIndexOf(')')).split(',');
        var sc = Number(nums[0]);
        return !(isFinite(sc) && sc > 0.01);
      })()
    };
  })()`);

  if (!resizeProbe || resizeProbe.err) await diag('缩放探针注入失败');
  ok(!!resizeProbe && resizeProbe.mockWorks === true,
    '探针自检：改视口宽度确实会改变舞台缩放（否则下面的断言是空转）',
    JSON.stringify(resizeProbe));
  ok(!!resizeProbe && resizeProbe.unchangedOnZero === true && resizeProbe.badScale === false,
    '★ 视口读到 0 时不写 0/负缩放（保留上一次算好的舞台）',
    JSON.stringify(resizeProbe));

  /* 内部重试是 80ms 一次；这里轮询到 1.2s 而不是死等 260ms ——
   * 断言要保证的是「会自愈」，不是「在某个固定毫秒内自愈」。
   * 之前写成单次 260ms 取样，机器忙的时候偶发假红（实测出现过一次 0.545 残留）。 */
  const healedSig = `(function(){
    var st = document.getElementById('stage');
    var tf = getComputedStyle(st).transform || 'none';
    var r = st.getBoundingClientRect();
    return tf + '|' + Math.round(r.width) + 'x' + Math.round(r.height);
  })()`;
  let healed = null;
  for (let i = 0; i < 12; i++) {
    healed = { sig: await evaluate(healedSig) };
    if (resizeProbe && healed.sig === resizeProbe.realT) break;
    await sleep(100);
  }
  ok(!!healed && !!resizeProbe && healed.sig === resizeProbe.realT,
    '★ 尺寸恢复后缩放自己算回来了（不靠外部再派发一次 resize）',
    JSON.stringify(healed) + ' vs ' + JSON.stringify(resizeProbe && resizeProbe.realT));

  /* 回前台重算：iOS 上「切到别的浏览器再切回来」会改视口高度，
   * 却不一定发 resize。不补这一条，牌桌会被裁掉一截或整体缩小。 */
  const visProbe = await evaluate(`(function(){
    var vp = document.getElementById('viewport');
    var st = document.getElementById('stage');
    /* 同上：横屏不写内联 transform，改读 computed + 真实盒子（sig 与上面一致） */
    function sig() {
      var tf = getComputedStyle(st).transform || 'none';
      var r = st.getBoundingClientRect();
      return tf + '|' + Math.round(r.width) + 'x' + Math.round(r.height);
    }
    var before = sig();
    /* 同 9c：打桩 rect 的**宽度**（竖版 scale = availW / 750），不是 clientHeight */
    var realRect = vp.getBoundingClientRect();
    vp.getBoundingClientRect = function () {
      var r = realRect;
      var w = Math.max(200, Math.round(r.width * 0.7));
      return {
        x: r.x, y: r.y, top: r.top, left: r.left,
        right: r.left + w, bottom: r.bottom, width: w, height: r.height,
        toJSON: function () { return this; }
      };
    };
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: function(){ return 'visible'; } });
    document.dispatchEvent(new Event('visibilitychange'));
    var after = sig();
    delete vp.getBoundingClientRect;
    delete document.visibilityState;
    window.dispatchEvent(new Event('resize'));   /* 收拾现场，回到真实尺寸 */
    return { changed: after !== before, before: before, after: after };
  })()`);
  ok(!!visProbe && visProbe.changed === true,
    '★ 回到前台（visibilitychange）会重算一次缩放',
    JSON.stringify(visProbe));

  /* ---------------------------------------------------------------- */
  console.log('\n[9d] 禁止页面缩放：拦截器真的拦住了，且没误伤单指拖拽');

  /* 为什么要真浏览器验：`pwa/test/zoom-lock.test.js` 是静态断言，只能证明
   * 「源码里有 gesturestart 监听、有 touches.length > 1 判断」。它证明不了
   * 「事件真的被 preventDefault 了」—— 挂在被动监听器里的 preventDefault
   * 会被浏览器**静默忽略**，代码看着一模一样，效果为零。这个项目已经栽过
   * 一次同类的坑（注释说做了、实际没做）。
   *
   * 能验到哪一层要说清楚：桌面 Chrome/Edge 没有「页面捏合缩放」这件事，
   * 所以这里验的是**拦截层**（事件派发下去，defaultPrevented 是不是 true）。
   * iOS 真机上「双指之后牌有没有变大」得靠人试，而那一前提正是这条。 */
  const zoomProbe = await evaluate(`(function(){
    function fire(type, touchCount) {
      var e = new Event(type, { bubbles: true, cancelable: true });
      /* cancelable:true 是必须的：不可取消的事件上调 preventDefault 无效，
       * defaultPrevented 永远 false，断言会红成「没拦住」，其实是测法错了。 */
      if (touchCount != null) Object.defineProperty(e, 'touches', { value: { length: touchCount } });
      document.body.dispatchEvent(e);
      return e.defaultPrevented;
    }
    return {
      bodyTouchAction: getComputedStyle(document.body).touchAction,
      htmlTouchAction: getComputedStyle(document.documentElement).touchAction,
      twoFinger: fire('touchmove', 2),
      oneFinger: fire('touchmove', 1),
      gestureStart: fire('gesturestart', null),
      gestureChange: fire('gesturechange', null),
      vvScale: (window.visualViewport && window.visualViewport.scale) || 1
    };
  })()`);

  console.log('    缩放拦截实测：' + JSON.stringify(zoomProbe));
  ok(!!zoomProbe && /pan-x/.test(zoomProbe.bodyTouchAction || '') && !/pinch-zoom/.test(zoomProbe.bodyTouchAction || ''),
    '★ body 的计算样式里没有 pinch-zoom（不给浏览器捏合放大的许可）',
    String(zoomProbe && zoomProbe.bodyTouchAction));
  ok(!!zoomProbe && zoomProbe.twoFinger === true,
    '★ 双指 touchmove 被 preventDefault（捏合不会缩放页面）');
  /* 这一条是反向守：只拦双指、不拦单指。写错成「无条件 preventDefault 所有 touchmove」
   * 也能让上一条变绿，但会把单指拖牌和点击一起搞坏 —— 而且这种坏在自动化里不一定露头。 */
  ok(!!zoomProbe && zoomProbe.oneFinger === false,
    '★ 单指 touchmove 没有被拦（拖牌、点击不受影响）');
  ok(!!zoomProbe && zoomProbe.gestureStart === true && zoomProbe.gestureChange === true,
    '★ Safari 私有手势 gesturestart / gesturechange 都被拦（iPhone 上真正生效的那道）');
  ok(!!zoomProbe && zoomProbe.vvScale === 1,
    '当前页面没有被缩放（visualViewport.scale = 1）', String(zoomProbe && zoomProbe.vvScale));

  /* ---------------------------------------------------------------- */
  console.log('\n[10] 收尾：真实档案未被污染');

  const realAfter = fs.existsSync(REAL_DATA)
    ? { size: fs.statSync(REAL_DATA).size, mtime: fs.statSync(REAL_DATA).mtimeMs }
    : null;
  ok(JSON.stringify(realBefore) === JSON.stringify(realAfter),
    '★ server/data/profiles.example.json 一个字节都没动（档案全在临时目录里）',
    JSON.stringify(realBefore) + ' -> ' + JSON.stringify(realAfter));

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  /* 收尾：顺序是「先关页面 → 再关浏览器 → 再关服务端 → 最后删目录」。
   * 反过来的话 Windows 上临时目录里的 Edge 用户目录还被占着，rm 会报 EBUSY。 */
  try { cdp && await cdp.send('Page.close'); } catch (e) {}
  try { cdp && cdp.close(); } catch (e) {}
  try { edge && edge.kill(); } catch (e) {}
  try { serverProc && serverProc.kill(); } catch (e) {}
  await sleep(600);                       // 等文件句柄释放，否则 rm 可能失败
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {
    console.log('  ! 临时目录没删干净：' + TMP + '（' + e.code + '，下次开机可手动删）');
  }
  cleaned = true;

  console.log('\n' + '='.repeat(60));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项，耗时 ' + elapsed + ' 秒'
    + (WITH_WAIT ? '（含 --with-wait 的 35 秒）' : ''));
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error('\n脚本异常终止：' + (e && e.stack || e));
  if (serverLog.trim()) console.error('服务端输出：\n' + serverLog.trim().split('\n').slice(-15).join('\n'));
  try { cdp && cdp.close(); } catch (x) {}
  try { edge && edge.kill(); } catch (x) {}
  try { serverProc && serverProc.kill(); } catch (x) {}
  await sleep(400);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) {}
  cleaned = true;
  process.exit(1);
});
