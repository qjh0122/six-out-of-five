#!/usr/bin/env node
/**
 * 「5 秒内可以反悔」探针（v136）真浏览器 / CDP
 * 跑法：node scripts/probe-undo.js [宽] [高]      例：node scripts/probe-undo.js 390 844
 *      ZOOM=1 额外截图
 *
 * 为什么必须真浏览器：撤销条的整条逻辑都挂在**时间**和**DOM 存在性**上。
 *   · 单测能证明"到点会调 onCommit"，证明不了"5 秒之内数据真的还在"；
 *   · 单测能证明"hidden 会 flush"，证明不了 visibilitychange 真的挂上了；
 *   · 单测能证明"按钮绑了点击"，证明不了那个按钮**点得到**（pointer-events）。
 *
 * 这个探针只验玩家能感知的四件事：
 *   1) 确认清除之后，条子弹出来，且**此时记录还在**（这才是"可以反悔"的含义）
 *   2) 点「撤销」，记录、本机存储都还原到没清过的样子
 *   3) 不点，5 秒后真的清掉，且条子自己消失
 *   4) 条子不挡住「返回」这类关键按钮
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { findBrowser } = require('./lib/browser');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
const SRV_PORT = 3056;                 // 真实应用服务（不再是 ?mode=local 的静态服务器）
const CDP_PORT = 9363;
const ROOT = path.join(__dirname, '..', 'pwa');
const SHOTS = !!process.env.ZOOM;
/* SHOT_DIR 可指定：验收要看图时收进仓库（tmp-shots/ 是 .gitignore 的），
 * 默认仍进临时目录 —— 与 probe-numbers.js:353-359 同一条通道。 */
const OUT = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : path.join(os.tmpdir(), 'lxw-undo-probe');

/* ★ v139 / N-1：本探针从 `?mode=local` 改成**真实应用服务**（ws 模式）。
 * 原因是一条硬门槛，不是偏好：`game.js` 的「补 AI」按钮只在 `RoomStore.getMode() === 'ws'`
 * 时才出现（game.js L761）。本地演示模式永远凑不够 MIN_PLAYERS=2，于是
 * 「对局屏」根本进不去 —— 上一版在这里量到的其实是**就绪态**那一排按钮，
 * 一条看起来全绿的假断言。要量对局屏 / 结算屏，就必须让服务端把 AI 补进来。
 * 代价：多起一个 Node 服务 + 一次注册，约 3 秒。 */
/* 两个来源并存，各管一段：
 *   · 静态服务器 + ?mode=local  —— [1]–[7] 的撤销机制（战绩清除 / 离开）。
 *     这一段不需要服务端，也不会被云端记录干扰（ws 模式下战绩页读的是云端，
 *     种进 localStorage 的 2 条根本不会显示 —— 换成 ws 会当场把 [1]–[5] 全打红）。
 *   · 真实应用服务（ws）        —— [8]–[10] 的三屏几何。
 *     只有 ws 模式才允许补 AI（game.js L761），才凑得够 MIN_PLAYERS=2。 */
const PORT = 3055;
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

let serverProc = null;
function startApp() {
  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(SRV_PORT),
      PROFILE_FILE: path.join(os.tmpdir(), 'lxw-undo-' + Date.now(), 'profiles.json'),
      SEED_FILE: path.join(os.tmpdir(), 'lxw-undo-seed-' + Date.now() + '.json')
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
        if (tries > 60) return reject(new Error('应用服务没起来'));
        setTimeout(tick, 200);
      });
    })();
  });
}

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

/* 两份最小的战绩。清除只关心"有没有数据、有几场"，
 * 所以不造回放 —— 造了也用不上，反而让种子变脆。 */
function seedRecords() {
  const now = Date.now();
  return [
    { id: 'R0-1', roomId: 'R0', endedAt: now, playerCount: 3, myStartScore: 20, myEndScore: 15, myNet: -5, endReason: 'dissolve', rounds: 2 },
    { id: 'R1-2', roomId: 'R1', endedAt: now - 3600000, playerCount: 4, myStartScore: 20, myEndScore: 26, myNet: 6, endReason: 'dissolve', rounds: 3 }
  ];
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  startApp();
  await waitApp();
  const BASE = 'http://127.0.0.1:' + PORT;          // 本地演示模式（撤销机制）
  const BASE_WS = 'http://127.0.0.1:' + SRV_PORT;   // 真实服务（三屏几何要补 AI）

  const exe = findBrowser();
  const userDir = path.join(os.tmpdir(), 'lxw-undo-edge-' + Date.now());
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __error: String(r.exceptionDetails.text) };
    return r.result && r.result.value;
  };
  const shot = async (name) => {
    if (!SHOTS) return null;
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, name);
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  };

  /* [1]–[7] 走本地演示模式：不需要真服务端，战绩全在 localStorage 里 */
  await cdp.send('Page.navigate', { url: BASE + '/?mode=local' });
  await sleep(1800);
  const seedJson = JSON.stringify(seedRecords());
  await evaluate(`localStorage.setItem('lxw_records_v1', ${JSON.stringify(seedJson)});
                  localStorage.setItem('lxw_guide_seen_v1','1');
                  localStorage.setItem('lxw_records_deduped_v2','1');
                  'ok'`);
  await cdp.send('Page.navigate', { url: BASE + '/?mode=local' });
  await sleep(1800);
  console.log('视口 ' + W + '×' + H);

  /* ---- 离开房间专项的两个页面内探针（v139） ----
   * 装在这里而不是 addScriptToEvaluateOnNewDocument：本地演示模式刚加载完时
   * 还没有房间，subscribe 一次都没被调过，此刻包一层就能捕获到真正的
   * attachRoom 订阅回调；leaveRoom 同理，游戏代码是在调用时才取 RoomStore 上的方法。
   *   · spy   —— 数「真离开」发生了几次（延迟窗口内必须是 0）。
   *   · subs  —— 留住订阅回调，用来在窗口内**注入一次广播**（P2 阶段推进）。
   * 不注入脚本到产品代码，全部在探针进程里包一层。 */
  const hookOk = await evaluate(`(function(){
    var R = window.RoomStore;
    if (!R) return 'no-RoomStore';
    window.__leaveSpy = { calls: 0, args: [] };
    var origLeave = R.leaveRoom;
    R.leaveRoom = function(){
      window.__leaveSpy.calls++;
      window.__leaveSpy.args.push([].slice.call(arguments));
      return origLeave.apply(this, arguments);
    };
    window.__roomSubs = [];
    var origSub = R.subscribe;
    R.subscribe = function(id, cb){
      window.__roomSubs.push({ id: id, cb: cb });
      return origSub.apply(this, arguments);
    };
    return 'ok';
  })()`);
  ok(hookOk === 'ok', '★ 装上了 leaveRoom spy 与 subscribe 捕获（不是空扫描）', hookOk);

  const readState = `(function(){
    var bar = document.getElementById('undo-bar');
    var msg = document.getElementById('undo-msg');
    var act = document.getElementById('undo-act');
    var allRows = [].slice.call(document.querySelectorAll('#records-list .rp-row'));
    var rows = allRows.length;
    var visRows = allRows.filter(function(x){ return x.offsetParent !== null; }).length;
    var empty = document.getElementById('records-empty');
    var back = document.getElementById('btn-records-back');
    var store = [];
    try { store = JSON.parse(localStorage.getItem('lxw_records_v1') || '[]'); } catch (e) { store = []; }
    function r(el){ if(!el) return null; var b = el.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom), l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }; }
    var br = r(bar), kr = r(back);
    var overlap = 0;
    if (br && kr) {
      var ix = Math.max(0, Math.min(br.r, kr.r) - Math.max(br.l, kr.l));
      var iy = Math.max(0, Math.min(br.b, kr.b) - Math.max(br.t, kr.t));
      overlap = ix * iy;
    }
    return {
      barShown: !!bar && !bar.classList.contains('hidden'),
      msg: msg ? msg.textContent : null,
      actText: act ? act.textContent : null,
      actRect: r(act),
      barRect: br,
      backOverlap: overlap,
      rows: rows,
      visRows: visRows,
      emptyShown: !!empty && !empty.classList.contains('hidden'),
      storeCount: store.length
    };
  })()`;

  console.log('\n[1] 打开战绩页，确认有数据');
  await evaluate(`document.getElementById('btn-records-home').click()`);
  await sleep(700);
  let st = await evaluate(readState);
  ok(st.rows === 2, '★ 战绩页读到 2 条记录（种子生效）', JSON.stringify({ rows: st.rows }));

  console.log('\n[2] 确认清除 → 条子弹出，但**记录还在**');
  await evaluate(`document.getElementById('btn-records-clear').click()`);
  await sleep(400);
  await evaluate(`document.getElementById('btn-records-clear-ok').click()`);
  await sleep(300);
  st = await evaluate(readState);
  ok(st.barShown === true, '★★ 条子弹出来了', JSON.stringify(st));
  ok(/将清除 2 场/.test(st.msg || ''), '★★ 文案说清了「将清除几场」（不是一句模糊的"已清除"）', st.msg);
  ok((st.actText || '').trim() === '撤销', '撤销按钮文案正确', st.actText);
  ok(st.visRows === 2, '★★ 5 秒之内记录**还在**（这就是「可以反悔」的全部含义）', 'visRows=' + st.visRows);
  ok(st.storeCount === 2, '★★ 本机存储也还没动', String(st.storeCount));
  ok(st.actRect && st.actRect.h >= 40, '★ 撤销按钮够高（' + (st.actRect ? st.actRect.h : '?') + ' CSS px，点不中等于没这个功能）');
  /* 条子压在屏幕下半部，最容易盖住「返回」。真重叠会让玩家在 5 秒里点不到返回 ——
   * 而那 5 秒恰好是他最可能想「算了我不清除了，先退出去看看」的时候。 */
  ok(st.backOverlap === 0, '★★ 条子和「返回」按钮零重叠', 'overlap=' + st.backOverlap + 'px²');
  const p1 = await shot('undo-bar.png');
  if (p1) console.log('    图：' + p1);

  console.log('\n[3] 点「撤销」→ 一切回到没清过的样子');
  await evaluate(`document.getElementById('undo-act').click()`);
  await sleep(400);
  st = await evaluate(readState);
  ok(st.barShown === false, '★ 条子收起');
  ok(st.visRows === 2, '★★ 记录仍在（撤销真的撤销了，而不是只是把条子藏起来）', 'visRows=' + st.visRows);
  ok(st.storeCount === 2, '★★ 存储仍是 2 条');
  const pHidden = await shot('undo-bar-hidden.png');       // 撤销条「消失」帧
  if (pHidden) console.log('    图：' + pHidden);

  console.log('\n[4] 再确认一次，这次不撤销 → 5 秒后真的清掉');
  await evaluate(`document.getElementById('btn-records-clear').click()`);
  await sleep(400);
  await evaluate(`document.getElementById('btn-records-clear-ok').click()`);
  await sleep(300);
  st = await evaluate(readState);
  ok(st.barShown === true, '条子再次弹出');
  /* 关键：**5 秒之内**任何时刻都不该清。这里在 3 秒时插一刀。 */
  await sleep(3000);
  st = await evaluate(readState);
  ok(st.visRows === 2, '★★ 第 3 秒（窗口内）记录仍在', 'visRows=' + st.visRows);
  await sleep(2600);                       // 累计 5.6 秒，越过窗口
  st = await evaluate(readState);
  ok(st.barShown === false, '★★ 到点后条子自己消失（不需要玩家再点一次）');
  /* 用**可见**行数，不是 DOM 里的行数：清空时列表容器整块 display:none，
   * 行元素还留在 DOM 里（下一次渲染直接复用）。数 DOM 会一直看到 2 行 ——
   * 上一版就是这么假红的，页面其实已经空了。 */
  ok(st.visRows === 0, '★★ 到点后记录清空了', 'visRows=' + st.visRows + ' rows=' + st.rows);
  ok(st.emptyShown === true, '★ 切到空态（不是留一块空白）');
  ok(st.storeCount === 0, '★★ 本机存储也清了', String(st.storeCount));

  console.log('\n[5] 条子隐藏后不占位');
  {
    const pos = await evaluate(`(function(){
      var bar = document.getElementById('undo-bar');
      if (!bar) return null;
      var br = bar.getBoundingClientRect();
      var cs = getComputedStyle(bar);
      return { w: Math.round(br.width), h: Math.round(br.height), display: cs.display, pe: cs.pointerEvents };
    })()`);
    /* display:none 而不是 opacity:0 硬撑着 —— 后者会让一个不可见的盒子继续吃点击。
     * 这条和 .toast 的 pointer-events:none 是同一个教训的两个面。 */
    ok(pos && pos.display === 'none', '★★ 隐藏时 display:none（不是 opacity:0 留一个看不见的盒子吃点击）', JSON.stringify(pos));
    ok(pos && pos.w === 0 && pos.h === 0, '★ 隐藏时尺寸为 0（不占位）', JSON.stringify(pos));
  }

  /* ===================================================================
   * [6] / [7]：离开房间的「5 秒内可以反悔」（v139 / design-next-batch §2.3、R8）
   *
   * 战绩清除那套验的是「数据还在不在」；离开房间验的是**动作有没有被推迟**：
   *   · 确认后 250ms 内条子必须出现、文案逐字、leaveRoom 调用数 == 0；
   *   · 窗口内注入一次「房间已结算」广播 → 250ms 内条子收起 / 转「已不可撤销」，
   *     leaveRoom 恰好 1 次、flash 文本 == §2.5 终值、「撤销成功 / 已取消」0 次；
   *   · 不注入广播时，5 秒窗口内 leaveRoom 仍为 0，越过窗口恰好 1 次。
   * 250ms 来自 QA §三「消除时机」（250/5000 = 5%），写死不取自运行时常量。
   * =================================================================== */
  const LEAVE_MSG_IDLE = '正在离开房间（5 秒内可撤销）';
  const LEAVE_IRREVOCABLE = '房间状态已变化，已按最新状态离开，本次无法撤销';
  const MS250 = 250;

  const leaveStateExpr = `(function(){
    var bar = document.getElementById('undo-bar');
    var msg = document.getElementById('undo-msg');
    var act = document.getElementById('undo-act');
    var toast = document.getElementById('toast');
    return {
      barShown: !!bar && !bar.classList.contains('hidden'),
      origin: bar ? bar.getAttribute('data-undo-origin') : null,
      msg: msg ? msg.textContent : null,
      actText: act ? act.textContent : null,
      actDisabled: act ? !!act.disabled : null,
      toast: toast ? toast.textContent : null,
      leaveCalls: window.__leaveSpy ? window.__leaveSpy.calls : -1,
      subs: window.__roomSubs ? window.__roomSubs.length : -1,
      screen: (function(){
        var s = document.querySelector('#stage .screen:not(.hidden)');
        return s ? s.id : '';
      })(),
      flashLog: (window.__flashLog || []).slice(),
      undoMsgLog: (window.__undoMsgLog || []).slice()
    };
  })()`;

  /* 回到首页 → 建房 → 进房间（本地演示模式，RoomStore.createRoom 走 localStorage）
   * ★ 已经在一个房间里就**不**再建：出房间页上的 #btn-create 是隐藏的，
   *   点隐藏按钮照样会跑事件处理 —— 那正是「以为在建新房、其实还站在原地」的来源。 */
  const createRoom = async () => {
    const already = await evaluate(`(function(){
      /* 只看元素自己的 .hidden 会误判：#table-ready 是 #screen-game 的子节点，
       * 房间散了以后它自己仍然不是 hidden，而父屏早就藏了 ——
       * 「子节点没藏」不等于「人在房间里」。必须连父屏一起判。 */
      var r = document.getElementById('table-ready');
      var s = document.getElementById('screen-room');
      var g = document.getElementById('screen-game');
      var vis = function(e){ return !!(e && !e.classList.contains('hidden')); };
      return !!(vis(s) || (vis(g) && vis(r)));
    })()`);
    if (already) return;
    await evaluate(`(function(){
      var home = document.getElementById('screen-home');
      if (home && home.classList.contains('hidden')) {
        var b = document.getElementById('btn-records-back');
        if (b) b.click();
      }
      return 'ok';
    })()`);
    await sleep(500);
    await evaluate(`(function(){ var b = document.getElementById('btn-create'); if (b) b.click(); return 'ok'; })()`);
    await sleep(400);
    await evaluate(`(function(){ var b = document.getElementById('btn-create-confirm'); if (b) b.click(); return 'ok'; })()`);
    await sleep(1100);
  };

  /* 点「离开」→ 确认框 → 确定。**动作一律不许在 onCommit 之前发生**。 */
  const clickLeaveAndConfirm = async () => {
    await evaluate(`(function(){
      window.__leaveSpy.calls = 0;
      window.__flashLog = []; window.__undoMsgLog = [];
      var t = document.getElementById('toast'), u = document.getElementById('undo-msg');
      if (window.MutationObserver && t) {
        var mo = new MutationObserver(function(){ window.__flashLog.push(t.textContent); });
        mo.observe(t, { childList: true, characterData: true, subtree: true });
      }
      if (window.MutationObserver && u) {
        var mu = new MutationObserver(function(){ window.__undoMsgLog.push(u.textContent); });
        mu.observe(u, { childList: true, characterData: true, subtree: true });
      }
      return 'ok';
    })()`);
    await evaluate(`(function(){ var b = document.getElementById('btn-leave'); if (b) b.click(); return 'ok'; })()`);
    await sleep(500);                                   // 等 fetchRoomSnapshot + 确认框
    await evaluate(`(function(){ var b = document.getElementById('btn-confirm-ok'); if (b) b.click(); return 'ok'; })()`);
  };

  console.log('\n[6] 离开房间 · 5 秒延迟窗口 + 广播到达时序（250ms）');
  await createRoom();
  let ls = await evaluate(leaveStateExpr);
  ok(ls.subs >= 1, '★★ 建房后 attachRoom 真的订阅了房间广播（捕获到回调）', 'subs=' + ls.subs + ' screen=' + ls.screen);
  await clickLeaveAndConfirm();
  await sleep(150);                                     // < 250ms
  ls = await evaluate(leaveStateExpr);
  ok(ls.barShown === true, '★★ 确认后 ' + MS250 + 'ms 内撤销条已出现', JSON.stringify(ls));
  ok(ls.msg === LEAVE_MSG_IDLE, '★★ 等待期文案逐字一致（§2.5 非对局中）', ls.msg);
  ok(ls.origin === 'leave', '★ 条子带 data-undo-origin="leave"（屏级锚点修饰）', String(ls.origin));
  ok(ls.actText === '撤销' && ls.actDisabled === false, '★ 撤销入口仍可用', ls.actText + '/' + ls.actDisabled);
  ok(ls.leaveCalls === 0, '★★★ ' + MS250 + 'ms 内 leaveRoom 调用数 == 0（延迟执行）', 'leaveCalls=' + ls.leaveCalls);
  const pShown = await shot('leave-undo-bar-shown.png');   // 撤销条「出现」帧（离开场景）
  if (pShown) console.log('    图：' + pShown);

  /* 窗口内注入一次「本局结算」广播：P2 phase 推进 + P4 结算事件，命中即 flush('room-changed')。 */
  const inject = await evaluate(`(function(){
    var list = window.__roomSubs || [];
    var s = list[list.length - 1];
    if (!s) return 'no-sub';
    var room = RoomStore.getRoom(s.id);
    if (!room) return 'no-room';
    var changed = {};
    for (var k in room) if (Object.prototype.hasOwnProperty.call(room, k)) changed[k] = room[k];
    changed.phase = 'SETTLED';
    s.cb(changed, { type: 'settled' });
    return 'ok';
  })()`);
  ok(inject === 'ok', '★ 广播注入成功（不是空注入）', inject);
  await sleep(150);                                     // 广播到达后 < 250ms
  ls = await evaluate(leaveStateExpr);
  ok(ls.leaveCalls === 1, '★★★ 广播到达后 leaveRoom 恰好 1 次（立即提交，非作废/非等满 5 秒）', 'leaveCalls=' + ls.leaveCalls);
  ok(ls.barShown === false, '★★ 广播到达后 ' + MS250 + 'ms 内撤销条已收起', 'barShown=' + ls.barShown);
  ok(ls.msg === LEAVE_IRREVOCABLE, '★ #undo-msg 已切到「已不可撤销」终值', ls.msg);
  ok(ls.undoMsgLog.indexOf(LEAVE_IRREVOCABLE) >= 0,
    '★★ flush 之前 #undo-msg 已切到同一终值（R8）', JSON.stringify(ls.undoMsgLog));
  ok(ls.flashLog.indexOf(LEAVE_IRREVOCABLE) >= 0,
    '★★ 广播到达后 flash 文本 == §2.5 终值（R8）', JSON.stringify(ls.flashLog));
  const uiText = String(ls.toast || '') + '|' + String(ls.msg || '') + '|' + ls.flashLog.join('|') + '|' + ls.undoMsgLog.join('|');
  ok(uiText.indexOf('撤销成功') < 0 && uiText.indexOf('已取消') < 0,
    '★★ 「撤销成功 / 已取消」出现次数 == 0（R8）', uiText.slice(0, 160));
  const pBroadcast = await shot('leave-undo-broadcast.png');  // 广播到达后条子状态帧
  if (pBroadcast) console.log('    图：' + pBroadcast);
  await sleep(300);
  ls = await evaluate(leaveStateExpr);
  ok(ls.leaveCalls === 1, '★ 提交幂等：再等 300ms leaveRoom 仍是 1 次', 'leaveCalls=' + ls.leaveCalls);

  console.log('\n[7] 离开房间 · 无广播，5 秒到点才真离开');
  await createRoom();
  await clickLeaveAndConfirm();
  await sleep(150);
  ls = await evaluate(leaveStateExpr);
  ok(ls.barShown === true && ls.leaveCalls === 0,
    '★★ 第二次进入窗口：条子在、leaveRoom 仍为 0', 'bar=' + ls.barShown + ' calls=' + ls.leaveCalls);
  await sleep(3000);
  ls = await evaluate(leaveStateExpr);
  ok(ls.leaveCalls === 0, '★★ 第 3 秒（窗口内）leaveRoom 仍是 0', 'leaveCalls=' + ls.leaveCalls);
  await sleep(2700);                                    // 累计 5.7s，越过窗口
  ls = await evaluate(leaveStateExpr);
  ok(ls.leaveCalls === 1, '★★ 到点后 leaveRoom 恰好 1 次', 'leaveCalls=' + ls.leaveCalls);
  ok(ls.barShown === false, '★★ 到点后条子自己消失', 'barShown=' + ls.barShown);
  const pGone = await shot('leave-undo-bar-gone.png');
  if (pGone) console.log('    图：' + pGone);

  /* ===================================================================
   * [8] 三屏「撤销条 ∩ 主控件」几何（N-1 / AC-NB-19 的判法，只量格子不看内容）
   *
   * 为什么必须单独量：R15 / R17 只做了 390 / 320 两档**人工看帧**。看帧能发现
   * 「条子压在按钮上」，但发现不了「压了 3px」—— 那恰恰是缩放改动最容易漏的量，
   * 而且下一轮改字号 / 改行高时没有任何东西会变红。这里按 §2.6 A1–A4 的同一条
   * 口径，把「离开」在**房间 / 对局 / 结算**三屏各触发一次，量条子与可见控件的
   * 矩形交集面积，期望恒为 0（不设容差：交集哪怕 1px² 也是压住了）。
   *
   * 三屏各用一个**真实入口**（#btn-leave / #btn-leave-game / #btn-back-room），
   * 不手工 showScreen —— 手工切屏量到的不是玩家看到的那一帧。
   * 每屏量完点「撤销」退回，顺带把「三屏撤销都成立」也验了（§2.4 #1）。
   * =================================================================== */
  const GEO = (sels) => `(function(){
    var bar = document.getElementById('undo-bar');
    if (!bar) return JSON.stringify({ error: 'no-bar' });
    var br = bar.getBoundingClientRect();
    function shown(el){
      if (!el || el.classList.contains('hidden')) return false;
      var b = el.getBoundingClientRect();
      if (b.width <= 0 || b.height <= 0) return false;
      var cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    }
    function area(a, b){
      var x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      var y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return (x > 0 && y > 0) ? Math.round(x * y) : 0;
    }
    var out = { bar: { l: Math.round(br.left), t: Math.round(br.top), r: Math.round(br.right), b: Math.round(br.bottom) },
                shown: !bar.classList.contains('hidden'), checked: 0, hits: [], items: [] };
    var sels = ${JSON.stringify(sels)};
    for (var i = 0; i < sels.length; i++) {
      var els = document.querySelectorAll(sels[i]);
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        if (!shown(el)) continue;
        out.checked++;
        var bb = el.getBoundingClientRect();
        out.items.push({ sel: sels[i], id: el.id || '', l: Math.round(bb.left), t: Math.round(bb.top),
                         r: Math.round(bb.right), b: Math.round(bb.bottom) });
        var a = area(br, bb);
        /* ★ 这里**不许**读 textContent：一读就变成「按文本采集」，
         * tools/qa/geometry-selftest.js 会当场判它不合格并拒绝用它下结论（M8）。
         * 命中项只报 选择器 + id + 面积，够定位了。 */
        if (a > 0) out.hits.push({ sel: sels[i], id: el.id || '', area: a });
      }
    }
    return JSON.stringify(out);
  })()`;

  /* 「主控件」= 当前屏**可见可点**的每一个按钮 + 玩家真正要读/点的内容块。
   * 按屏取，不跨屏扫 —— 跨屏扫会把 display:none 的别人家的按钮算进来，
   * 那种命中说明不了任何事（shown() 也会先滤掉，但选择器本身就该诚实）。
   *
   * ★ 对局屏的 `gameSoft` 是**已知代价**，不算违约、但必须量出来：
   *   390×844 实测该屏从上到下没有 62px 的空档（牌位到 545、分组标签 562–609、
   *   手牌 626–748、动作条 761–807），而撤销条本身 62 CSS px 高 —— 哪一段都放不下。
   *   玩家刚点了「离开」，5 秒窗口里他要么撤销、要么走，手牌不是他此刻要操作的东西；
   *   而且条子容器 pointer-events:none，点手牌照样能落到牌上。
   *   硬判据只压「动作条按钮 + 牌位里的牌」，这两块被盖住才是真的点不到 / 看不见。 */
  const GEO_SELS = {
    /* 就绪态的动作条是**搬**进 #ready-acts 的（那个容器在 #screen-game 里，
     * 不在 #screen-room 里）—— 只写 #screen-room button 会漏掉 #btn-leave 本身。 */
    room: ['#ready-acts button', '#table-ready button', '#screen-room button', '#room-hint'],
    game: ['#btn-submit', '#btn-dissolve-game', '#btn-leave-game', '#btn-emoji', '#slots .card-box'],
    gameSoft: ['#hand .card-wrap', '#group-chips .gchip'],
    /* 结算屏同理分两档：底部动作区（.room-actions 里的按钮）+ 等待行 + 结算数字是硬判据；
     * 正文里的「改把数」那一排按钮算已知代价 —— 320×568 实测条子（308–363）
     * 必然压到它（把数按钮 300–363），而这一屏从上到下也没有 55px 的空档。 */
    settle: ['#screen-settle .room-actions button', '#settle-wait', '.settle-score', '.settle-name'],
    settleSoft: ['#settle-body button', '#settle-body .settle-row']
  };
  /* 只在 DIAG=1 时打印：结算页到底还有没有空档，靠这条量，不靠眼睛。 */
  const GEO_DIAG = ['#settle-body', '#settle-body > *', '#stage', '#screen-settle']; 

  const screenNow = async () => evaluate(`(function(){
    var s = document.querySelector('#stage .screen:not(.hidden)');
    var r = document.getElementById('table-ready');
    return (s ? s.id : '(none)') + (r && !r.classList.contains('hidden') ? '+ready' : '');
  })()`);

  /* 建房 → 补 AI → 准备（全员准备自动开局）→ 等**真的**进入对局
   * ★ 只判 `#screen-game` 可见会假通过：准备态（#table-ready）本来就画在
   *   #screen-game 里面，就绪时那一屏也是可见的 —— 量到的会是「准备」按钮那一排，
   *   而对局屏真正的主控件（#btn-submit / #btn-leave-game）那时根本不存在。
   *   必须同时判 #table-ready 已隐藏，并以 #btn-submit 可见作为进对局的硬证据。 */
  const startGame = async () => {
    /* 切到真实服务的源（另一个 origin，localStorage 不共享 —— 无所谓，
     * 这一段量的是几何，不依赖种子）。首次进入要注册一个一次性账号；
     * 服务端 profile 落在临时目录，不污染本机数据。
     * 整页重来也是必要的一步：上一步「撤销离开」之后就绪态 DOM 还在、state.room 已经没了，
     * 接着用会得到一个「按钮在、点了没反应」的假房间。 */
    await cdp.send('Page.navigate', { url: BASE_WS + '/' });
    await sleep(1800);
    const reg = await evaluate(`(async function(){
      function vis(id){ var e = document.getElementById(id); return !!(e && !e.classList.contains('hidden')); }
      if (vis('screen-home')) return { home: true };
      var tab = document.querySelector('[data-auth-tab="register"]');
      if (tab) tab.click();
      await new Promise(s=>setTimeout(s,250));
      var name = 'undoprobe' + Math.floor(Math.random()*100000);
      document.getElementById('auth-name').value = name;
      document.getElementById('auth-pass').value = 'probe123456';
      var nick = document.getElementById('auth-nick');
      if (nick && !nick.closest('.hidden')) nick.value = '探针';
      document.getElementById('btn-auth-submit').click();
      await new Promise(s=>setTimeout(s,2000));
      return { home: vis('screen-home'), account: name,
               err: (document.getElementById('auth-err')||{}).textContent || null };
    })()`);
    ok(reg && reg.home === true, '★★ 进入对局前先注册并到首页（真实服务，ws 模式才允许补 AI）',
      JSON.stringify(reg));
    /* ★ 真实服务的源是全新 localStorage：规则引导会在进首页 1.2 秒后自动弹。
     * 不关掉它，后面量到的矩形仍然是结算页的（弹窗不改布局），但**截图全是弹窗**——
     * 留帧证据直接作废。必须显式关掉并断言关干净。 */
    await evaluate(`(function(){
      try { localStorage.setItem('lxw_guide_seen_v1', '1'); } catch (e) {}
      var g = document.getElementById('guide-modal');
      if (g && !g.classList.contains('hidden')) {
        var s = document.getElementById('guide-skip') || document.getElementById('guide-next');
        if (s) s.click();
      }
      return 'ok';
    })()`);
    await sleep(400);
    const guideClosed = await evaluate(`(function(){
      var g = document.getElementById('guide-modal');
      return !g || g.classList.contains('hidden');
    })()`);
    ok(guideClosed === true, '★★ 规则引导已关闭（否则留帧全是弹窗，等于没截）');
    if (process.env.DIAG) console.log('    [diag] 进对局前屏=' + await screenNow());
    await createRoom();
    if (process.env.DIAG) console.log('    [diag] createRoom 后屏=' + await screenNow());
    await evaluate(`(function(){
      var n = 0;
      for (var i = 0; i < 8; i++) {
        var b = document.getElementById('btn-add-bot');
        if (!b || b.classList.contains('hidden')) break;
        b.click(); n++;
      }
      return n;
    })()`);
    await sleep(3200);                 // 每个 AI 的加入是异步的，给足落座时间
    if (process.env.DIAG) console.log('    [diag] 补 AI 后屏=' + await screenNow());
    await evaluate(`(function(){ var b = document.getElementById('btn-ready'); if (b) b.click(); return 'ok'; })()`);
    if (process.env.DIAG) console.log('    [diag] 点准备后屏=' + await screenNow());
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const inGame = await evaluate(`(function(){
        var g = document.getElementById('screen-game');
        var r = document.getElementById('table-ready');
        var s = document.getElementById('btn-submit');
        if (!g || g.classList.contains('hidden')) return false;
        if (r && !r.classList.contains('hidden')) return false;
        return !!(s && !s.classList.contains('hidden'));
      })()`);
      if (inGame) return true;
    }
    return false;
  };

  const geoRun = async (sels) => JSON.parse(await evaluate(GEO(sels)));

  /* 从任意一个「离开」入口点进去并确认，然后**等条子真的出现**再返回。
   * 不能写死 sleep：ws 模式下 onLeave 先要发一次 fetchRoomSnapshot（网络往返），
   * 确认框出现得比本地演示模式晚；固定等 600ms 会得到一个「没点开就被判没条子」
   * 的假红，而后面「交集 == 0」会在条子不存在时按 0×0 算，反过来变成假绿。 */
  const confirmLeaveVia = async (btnId) => {
    /* 整段在页面内跑（一次 evaluate、awaitPromise），不来回轮询：
     * 逐次 CDP 往返会在「点击 → 打开确认框」之间插入几十毫秒的间隙，
     * 更关键的是 ws 模式下 onLeave 先发一次 fetchRoomSnapshot，
     * 确认框出现得比本地模式晚 —— 固定 sleep 会假红，
     * 而条子不存在时「交集 == 0」又会被算成 0×0 变成假绿。 */
    const r = await evaluate(`(async function(){
      /* ★ 切到真实服务的源之后，页内 spy 钩子不存在（那是本地模式那个页面装的）。
       * 原来这里直接写 window.__leaveSpy.calls = 0，在 ws 页面上当场抛 TypeError，
       * 整个 IIFE 挂掉 —— click() 一次都没执行，而「没有条子」又被算成 0×0 交集，
       * 于是三条断言全绿、功能一条没验。守卫 + 把错误带出去，才不会再静默。 */
      if (window.__leaveSpy) window.__leaveSpy.calls = 0;
      function modalUp(){ var m = document.getElementById('confirm-modal'); return !!(m && !m.classList.contains('hidden')); }
      function barUp(){ var u = document.getElementById('undo-bar'); return !!(u && !u.classList.contains('hidden')); }
      var b = document.getElementById('${btnId}');
      if (!b) return { dialogUp: false, barUp: false, why: 'no-btn' };
      b.click();
      var waited = 0;
      while (waited < 4000 && !modalUp()) { await new Promise(function(s){ setTimeout(s, 100); }); waited += 100; }
      var dlg = modalUp();
      if (dlg) { var ok = document.getElementById('btn-confirm-ok'); if (ok) ok.click(); }
      waited = 0;
      while (waited < 3000 && !barUp()) { await new Promise(function(s){ setTimeout(s, 80); }); waited += 80; }
      return { dialogUp: dlg, barUp: barUp() };
    })()`);
    return r && r.dialogUp !== undefined ? r : { dialogUp: false, barUp: false, why: String(r && r.__error || r) };
  };

  const geoLog = (tag, g) => {
    console.log('    条子 rect=' + JSON.stringify(g.bar) + ' 量了 ' + g.checked + ' 个控件');
    /* DIAG=1 打印每个控件的实际矩形：压住时靠它定位「往哪挪」，
     * 不靠猜 —— 结算页的可用缝隙是量出来的，不是看帧看出来的。 */
    if (process.env.DIAG) console.log('    ' + tag + ' 控件：' + JSON.stringify(g.items));
  };

  console.log('\n[8] 房间屏 · 撤销条不压主控件（N-1）');
  await createRoom();
  /* 建房后动作条是**挂载**进来的，不是静态节点：等 #btn-leave 真的可见再点，
   * 否则点到的是隐藏按钮（事件照样会跑），而「房间屏」量到的其实是一张没挂完的屏。 */
  let roomBtnUp = false;
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    roomBtnUp = await evaluate(`(function(){
      var b = document.getElementById('btn-leave');
      if (!b || b.closest('.hidden')) return false;
      return b.getBoundingClientRect().height > 0;
    })()`);
    if (roomBtnUp) break;
  }
  ok(roomBtnUp === true, '★ 房间屏：#btn-leave 真的可见可点（不是点到隐藏按钮）');
  await clickLeaveAndConfirm();
  await sleep(200);
  {
    const g = await geoRun(GEO_SELS.room);
    geoLog('房间', g);
    ok(g.shown === true && g.checked >= 2, '★ 房间屏：条子在、且真的量到了控件（不是空扫描）',
      JSON.stringify({ shown: g.shown, checked: g.checked }));
    ok(g.hits.length === 0, '★★ 房间屏：撤销条与 主控件 交集面积恒 0',
      JSON.stringify(g.hits));
    const roomIds = (g.items || []).map((x) => x.id);
    ok(roomIds.indexOf('btn-leave') >= 0,
      '★★ 房间屏：量到的控件里含 #btn-leave（量的是真房间屏，不是空壳）',
      JSON.stringify(roomIds));
    const pRoom = await shot('geo-room-' + W + '.png');
    if (pRoom) console.log('    图：' + pRoom);
    const undoRoom = await evaluate(`(function(){
      document.getElementById('undo-act').click();
      return document.getElementById('undo-bar').classList.contains('hidden');
    })()`);
    ok(undoRoom === true, '★ 房间屏：点撤销退回，条子收起（撤销在三屏都成立）');
    await sleep(200);
  }

  console.log('\n[9] 对局屏 · 撤销条不压主控件（N-1）');
  {
    const inGame = await startGame();
    ok(inGame === true, '★ 进入对局屏（补 AI → 准备 → 自动开局，且 #table-ready 已隐藏）');
    {
      /* 硬证据：对局屏的主控件本身在不在。只判「进去了」不够 —— 准备态也说自己进去了。 */
      const hard = await evaluate(`(function(){
        function vis(id){ var e = document.getElementById(id); return !!(e && !e.classList.contains('hidden') && e.getBoundingClientRect().height > 0); }
        return { submit: vis('btn-submit'), leave: vis('btn-leave-game') };
      })()`);
      ok(hard && hard.submit && hard.leave,
        '★★ 对局屏硬证据：#btn-submit 与 #btn-leave-game 都真的可见', JSON.stringify(hard));
    }
    await sleep(500);
    const cl = await confirmLeaveVia('btn-leave-game');
    ok(cl.dialogUp === true && cl.barUp === true,
      '★★ 对局屏：确认框弹出、确认后条子真的出现（不是没点开就量空）', JSON.stringify(cl));
    const g = await geoRun(GEO_SELS.game);
    geoLog('对局', g);
    ok(g.shown === true && g.checked >= 3, '★ 对局屏：条子在、且真的量到了控件',
      JSON.stringify({ shown: g.shown, checked: g.checked }));
    /* 量的确实是「对局中的那一排」：至少命中一个只有对局屏才有的控件 id。
     * 少了这条，准备态也能凑够 3 个控件让上面那句变绿。 */
    const ids = (g.items || []).map((x) => x.id);
    ok(ids.indexOf('btn-submit') >= 0 || ids.indexOf('btn-leave-game') >= 0,
      '★★ 对局屏：量到的控件里含 #btn-submit / #btn-leave-game（不是准备态那一排）',
      JSON.stringify(ids));
    ok(g.hits.length === 0, '★★ 对局屏：撤销条与 动作条按钮 / 牌位的牌 交集面积恒 0',
      JSON.stringify(g.hits));
    /* 已知代价：手牌 / 分组标签被遮住的部分照样量出来并打印。
     * 不设断言 —— 这一屏没有 62px 空档，遮是必然的（理由见 GEO_SELS 上方）。
     * 但要**量**：将来手牌区变高或条子变厚，遮住的面积会跳变，这里能看见。 */
    {
      const soft = await geoRun(GEO_SELS.gameSoft);
      const total = soft.hits.reduce((a, h) => a + h.area, 0);
      console.log('    已知代价：手牌 / 分组标签被遮 ' + total + 'px²（' +
        soft.hits.length + '/' + soft.checked + ' 个元素）' +
        (total ? ' 明细 ' + JSON.stringify(soft.hits.map((h) => h.id || h.sel)) : ''));
      ok(soft.checked >= 3, '★ 对局屏：已知代价确实量到了手牌与分组标签（不是空扫描）',
        'checked=' + soft.checked);
    }
    const pGame = await shot('geo-game-' + W + '.png');
    if (pGame) console.log('    图：' + pGame);
    const undoGame = await evaluate(`(function(){
      document.getElementById('undo-act').click();
      return document.getElementById('undo-bar').classList.contains('hidden');
    })()`);
    ok(undoGame === true, '★ 对局屏：点撤销退回，条子收起');
    await sleep(200);
  }

  console.log('\n[10] 结算屏 · 撤销条不压主控件与结算数字（N-1）');
  {
    /* N-2：先清掉「本设备已看过」键，保证这一屏是**首次进入**，
     * 策略行才会出现 —— 不清的话 [10] 之前那次结算已经把它烧掉了。 */
    await evaluate(`(function(){
      try {
        var k = (window.LXW && LXW.Store && LXW.Store.KEYS) ? LXW.Store.KEYS.STRATEGY_TIP_SEEN : null;
        if (k) localStorage.removeItem(k);
      } catch (e) {}
      return 'ok';
    })()`);
    /* 走到结算屏的最短**真实**路径：结束本局 → 本局进结算。
     * 不手工 showScreen：结算页的高度取决于 settle-body 真的画出来多少行，
     * 手造的屏量到的矩形是假的。 */
    await evaluate(`(function(){ var b = document.getElementById('btn-dissolve-game'); if (b) b.click(); return 'ok'; })()`);
    await sleep(700);
    await evaluate(`(function(){
      var ok2 = document.getElementById('btn-confirm-ok');
      if (ok2 && !document.getElementById('confirm-modal').classList.contains('hidden')) ok2.click();
      return 'ok';
    })()`);
    let onSettle = false;
    for (let i = 0; i < 30; i++) {
      await sleep(300);
      onSettle = await evaluate(`(function(){
        var s = document.getElementById('screen-settle');
        return !!(s && !s.classList.contains('hidden'));
      })()`);
      if (onSettle) break;
    }
    ok(onSettle === true, '★ 进入结算屏（结束本局 → 本局结束）');
    /* 结算页可能先播牌型特写再画卡；等它画完再量 */
    await sleep(2200);
    /* N-2：320×568 的策略行必须**完整可读** —— 不截断、不越界、不压「开始下一局」。
     * 只量不看：行数、scroll/client 差、textOverflow、与 #btn-next 的纵向交集。 */
    {
      const tip = await evaluate(`(function(){
        var b = document.getElementById('settle-wait');
        if (!b) return { missing: true };
        var cs = getComputedStyle(b);
        var r = b.getBoundingClientRect();
        var nx = document.getElementById('btn-next');
        var nr = nx ? nx.getBoundingClientRect() : null;
        var st = document.getElementById('stage').getBoundingClientRect();
        /* 行数用 Range 数**行盒**，不用 height/line-height 猜：
         * .settle-wait 没写 line-height，computed 是 'normal'，parseFloat 得 NaN ——
         * 猜出来的行数会一直是 -1，那条断言就等于没写。 */
        var lines = -1;
        try {
          var rg = document.createRange();
          rg.selectNodeContents(b);
          lines = rg.getClientRects().length;
        } catch (e) { lines = -1; }
        return {
          flag: b.getAttribute('data-strategy-tip'),
          len: (b.textContent || '').length,
          ws: cs.whiteSpace, to: cs.textOverflow,
          lines: lines,
          h: Math.round(r.height),
          clippedX: b.scrollWidth > b.clientWidth + 1,
          clippedY: b.scrollHeight > b.clientHeight + 1,
          outOfStage: r.left < st.left - 1 || r.right > st.right + 1,
          gapToNext: nr ? Math.round(nr.top - r.bottom) : null
        };
      })()`);
      console.log('    策略行：' + JSON.stringify(tip));
      ok(tip && tip.flag === '1' && tip.len >= 28,
        '★ 策略行真的出现了（首次进结算页，且不是空串）', JSON.stringify(tip));
      ok(tip && tip.ws === 'normal' && tip.to === 'clip',
        '★★ 策略行允许换行、且关掉了省略号（不再「给了但没给」）', JSON.stringify(tip));
      ok(tip && !tip.clippedX && !tip.clippedY,
        '★★ 策略行没有被裁掉任何内容（scroll <= client）', JSON.stringify(tip));
      ok(tip && tip.outOfStage === false,
        '★ 策略行没有越出舞台（左右边界在 #stage 内）', JSON.stringify(tip));
      ok(tip && (tip.gapToNext === null ? false : tip.gapToNext >= 0),
        '★★ 策略行与「开始下一局」不重叠（gap >= 0）', JSON.stringify(tip));
      /* 行数上限写这里而不是设计文档里：320 实测（见上一条打印）决定，
       * 超过就是在挤动作区，届时这条会红，提醒重新排版而不是默默压扁。 */
      ok(tip && tip.lines > 0 && tip.lines <= 3,
        '★★ 策略行最多 3 行（' + W + '×' + H + ' 实测 ' + (tip ? tip.lines : '?') + ' 行）',
        JSON.stringify(tip));
    }
    const cl2 = await confirmLeaveVia('btn-back-room');
    ok(cl2.dialogUp === true && cl2.barUp === true,
      '★★ 结算屏：确认框弹出、确认后条子真的出现', JSON.stringify(cl2));
    const g = await geoRun(GEO_SELS.settle);
    geoLog('结算', g);
    if (process.env.DIAG) {
      const d = await geoRun(GEO_DIAG);
      console.log('    结算 空档诊断：' + JSON.stringify(d.items));
    }
    ok(g.shown === true && g.checked >= 4, '★ 结算屏：条子在、且真的量到了控件与结算数字',
      JSON.stringify({ shown: g.shown, checked: g.checked }));
    ok(g.hits.length === 0, '★★ 结算屏：撤销条与 底部动作区 / 等待行 / 结算数字 交集面积恒 0',
      JSON.stringify(g.hits));
    {
      const soft = await geoRun(GEO_SELS.settleSoft);
      const total = soft.hits.reduce((a, h) => a + h.area, 0);
      console.log('    已知代价：结算正文（含「改把数」那排）被遮 ' + total + 'px²（' +
        soft.hits.length + '/' + soft.checked + ' 个元素）');
      ok(soft.checked >= 1, '★ 结算屏：已知代价确实量到了正文控件（不是空扫描）',
        'checked=' + soft.checked);
    }
    const pSettle = await shot('geo-settle-' + W + '.png');
    if (pSettle) console.log('    图：' + pSettle);
    const undoSettle = await evaluate(`(function(){
      document.getElementById('undo-act').click();
      return document.getElementById('undo-bar').classList.contains('hidden');
    })()`);
    ok(undoSettle === true, '★ 结算屏：点撤销退回，条子收起');
    await sleep(200);
  }

  cdp.close();
  edge.kill();
  server.close();
  if (serverProc) { try { serverProc.kill(); } catch (e) {} }
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await sleep(100);
  process.exit(fail ? 1 : 0);
}


main().catch((e) => { console.error(e); process.exit(1); });
