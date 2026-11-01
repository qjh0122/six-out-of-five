/**
 * 前后台切换的「连接醒来」（P4-1）
 * 跑法：node pwa/test/room-visibility.test.js
 *
 * 这条 bug 的表现很特殊：不报错、不提示、不发红，只是点牌没反应。
 * 真实场景是「群里打牌 → 切出去回微信 → 切回来」，iOS 上连接多半已经半开，
 * 而客户端的 readyState 还停在 1，只有心跳能发现 —— 30s 一拍、连续 2 拍
 * 没 pong 才判死，最坏 60 秒。玩家最后只会说一句「这游戏有点卡」。
 *
 * 所以这里锁的是三件事：
 *   1) 回到前台必须主动探活（发 ping），而不是等下一个心跳周期；
 *   2) 探活有回音就什么都不做（不能平白断一次连接）；
 *   3) 探活没回音（半开）要主动断，让正常重连流程接管；
 *   4) bfcache 复活（pageshow.persisted）时连接一定是死的，直接重建。
 */
'use strict';

global.location = { protocol: 'http:', host: 'app.test' };

/* 只挂 addEventListener，故意不给 window.location ——
 * detectMode() 判的是 `window.location`，给了它就会被当成浏览器真环境 */
const docListeners = {};
const winListeners = {};
global.document = {
  visibilityState: 'visible',
  addEventListener: function (t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); }
};
global.window = {
  addEventListener: function (t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); }
};

function fireDoc(type, ev) { (docListeners[type] || []).slice().forEach(function (fn) { fn(ev || {}); }); }
function fireWin(type, ev) { (winListeners[type] || []).slice().forEach(function (fn) { fn(ev || {}); }); }

class FakeWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closeCalls = 0;
    this._l = {};
    FakeWS.instances.push(this);
    setTimeout(() => { this.readyState = 1; this._emit('open', {}); }, 0);
  }
  addEventListener(type, fn) { (this._l[type] = this._l[type] || []).push(fn); }
  send(data) { this.sent.push(data); }
  close() {
    this.closeCalls += 1;
    if (this.readyState === 3) return;
    this.readyState = 3;
    this._emit('close', {});
  }
  _emit(type, ev) { (this._l[type] || []).slice().forEach((fn) => fn(ev)); }
  deliver(obj) { this._emit('message', { data: JSON.stringify(obj) }); }
  pings() { return this.sent.filter((s) => { try { return JSON.parse(s).type === 'ping'; } catch (e) { return false; } }).length; }
}
FakeWS.instances = [];
global.WebSocket = FakeWS;

const RS = require('../js/roomStore.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

const ROOM = {
  roomId: '654321',
  phase: 'ROUND1_SPLIT',
  round: 1,
  players: [
    { id: 'p1', nickname: '甲', score: 20, connected: true, left: false },
    { id: 'p2', nickname: '乙', score: 20, connected: true, left: false }
  ]
};

async function run() {
  console.log('\n[0] 监听注册');
  ok((docListeners.visibilitychange || []).length === 1, 'document 上注册了 visibilitychange');
  ok((winListeners.pageshow || []).length === 1, 'window 上注册了 pageshow');

  /* 建连 */
  const warm = RS.createRoom({ playerId: 'p1', nickname: '甲' }).catch(function () { return null; });
  await wait(20);
  const ws = FakeWS.instances[0];
  ok(!!ws, '假连接已建立');
  eq(ws.readyState, 1, '连接 open');
  ws.deliver({ type: 'ok', reqId: 1, payload: { room: ROOM, token: 'seat-token' } });
  await warm;
  const before = FakeWS.instances.length;

  /* ---------------------------------------------------------------- */
  console.log('\n[1] 回到前台：必须立刻发 ping（不等心跳周期）');
  const pingsBefore = ws.pings();
  global.document.visibilityState = 'visible';
  fireDoc('visibilitychange');
  await wait(30);
  eq(ws.pings(), pingsBefore + 1, '探活 ping 已经发出');
  eq(FakeWS.instances.length, before, '还没断，没有新建连接');

  /* ---------------------------------------------------------------- */
  console.log('\n[2] 有 pong 回来：不能平白断一次连接');
  ws.deliver({ type: 'pong' });
  await wait(2700);           // 超过 2.5s 的判死窗口
  eq(ws.closeCalls, 0, '连接没有被关掉');
  eq(FakeWS.instances.length, before, '没有触发重连');
  ok(ws.readyState === 1, '连接仍是 open');

  /* ---------------------------------------------------------------- */
  console.log('\n[3] 没有 pong（半开）：2.5s 后主动断，交给正常重连');
  const ws2 = FakeWS.instances[FakeWS.instances.length - 1];
  const ping2 = ws2.pings();
  fireDoc('visibilitychange');
  await wait(30);
  eq(ws2.pings(), ping2 + 1, '又发了一次探活 ping');
  eq(ws2.closeCalls, 0, '2.5s 还没到，先不动它');
  await wait(2700);
  eq(ws2.closeCalls, 1, '★ 超时后主动 close（半开连接的唯一出路）');
  await wait(60);
  ok(FakeWS.instances.length > before, 'close 触发了重连（新建了连接）');

  /* 让这次重连真正走完：服务端回包之后 reconnecting 才会复位。
   * 不复位的话后面几段会被 dropAndReconnect 里的「已在重连中就别动」挡住，
   * 那不是 bug，是这里没把前一步收尾。 */
  const wsR = FakeWS.instances[FakeWS.instances.length - 1];
  await wait(40);
  const reMsg = JSON.parse(wsR.sent[wsR.sent.length - 1] || '{}');
  if (reMsg.type === 'reconnect') wsR.deliver({ type: 'ok', reqId: reMsg.reqId, payload: { token: 'seat-2' } });
  await wait(60);

  /* ---------------------------------------------------------------- */
  console.log('\n[4] 后台期间攒的心跳欠账不算数');
  const ws3 = FakeWS.instances[FakeWS.instances.length - 1];
  await wait(30);
  /* 模拟：后台待了很久，回来时 missedPongs 已经被记账 —— 这里只能间接验：
   * 回来后发一次探活并收到 pong，之后不应因为旧账立刻判死 */
  const closes0 = ws3.closeCalls;
  fireDoc('visibilitychange');
  await wait(30);
  ws3.deliver({ type: 'pong' });
  await wait(2700);
  eq(ws3.closeCalls, closes0, '收到 pong 后不会被旧欠账牵连');

  /* ---------------------------------------------------------------- */
  console.log('\n[5] bfcache 复活（pageshow.persisted）：连接一定是死的 → 直接重建');
  const inst0 = FakeWS.instances.length;
  const ws4 = FakeWS.instances[FakeWS.instances.length - 1];
  fireWin('pageshow', { persisted: true });
  await wait(60);
  ok(ws4.closeCalls >= 1, '★ 直接断掉旧连接');
  ok(FakeWS.instances.length > inst0, '并重建了一条');

  /* ---------------------------------------------------------------- */
  console.log('\n[6] 普通 pageshow（不是 bfcache）不该动连接');
  const ws5 = FakeWS.instances[FakeWS.instances.length - 1];
  await wait(30);
  const c5 = ws5.closeCalls;
  const inst5 = FakeWS.instances.length;
  fireWin('pageshow', { persisted: false });
  await wait(80);
  eq(ws5.closeCalls, c5, '没有多余的 close');
  eq(FakeWS.instances.length, inst5, '没有多余的重连');

  /* ---------------------------------------------------------------- */
  console.log('\n[7] 已经彻底掉线（disconnected）时不该再折腾');
  const ws6 = FakeWS.instances[FakeWS.instances.length - 1];
  await wait(20);
  /* 收一条连接级致命错误 → disconnected = true */
  RS.onFatal(function () {});
  ws6.deliver({ type: 'error', payload: { error: '登录已失效', kicked: true } });
  await wait(30);
  const c6 = ws6.closeCalls;
  const inst6 = FakeWS.instances.length;
  fireDoc('visibilitychange');
  await wait(80);
  eq(ws6.closeCalls, c6, '不再反复关闭');
  eq(FakeWS.instances.length, inst6, '不再偷偷重连（被踢还连回来会更糟）');

  console.log('\n' + '='.repeat(48));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

run().catch(function (e) { console.error(e); process.exit(1); });
