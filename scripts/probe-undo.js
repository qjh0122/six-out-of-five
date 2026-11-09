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
const PORT = 3055;
const CDP_PORT = 9363;
const ROOT = path.join(__dirname, '..', 'pwa');
const SHOTS = !!process.env.ZOOM;
/* SHOT_DIR 可指定：验收要看图时收进仓库（tmp-shots/ 是 .gitignore 的），
 * 默认仍进临时目录 —— 与 probe-numbers.js:353-359 同一条通道。 */
const OUT = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : path.join(os.tmpdir(), 'lxw-undo-probe');

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

  /* 用本地演示模式：不需要真服务端，战绩全在 localStorage 里 */
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?mode=local' });
  await sleep(1800);
  const seedJson = JSON.stringify(seedRecords());
  await evaluate(`localStorage.setItem('lxw_records_v1', ${JSON.stringify(seedJson)});
                  localStorage.setItem('lxw_guide_seen_v1','1');
                  localStorage.setItem('lxw_records_deduped_v2','1');
                  'ok'`);
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?mode=local' });
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

  /* 回到首页 → 建房 → 进房间（本地演示模式，RoomStore.createRoom 走 localStorage） */
  const createRoom = async () => {
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

  cdp.close();
  edge.kill();
  server.close();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await sleep(100);
  process.exit(fail ? 1 : 0);
}


main().catch((e) => { console.error(e); process.exit(1); });
