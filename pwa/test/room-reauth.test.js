/**
 * 登录后换连接（v52）：未鉴权连接 30 秒必被踢
 * 跑法：node pwa/test/room-reauth.test.js
 *
 * 这条 bug 是发布复验时撞出来的，表现很吓人：已经注册成功、已经进了房间、
 * 已经开了局，第 30 秒屏幕一闪回登录页 —— 像被登出。
 *
 * 成因是两条规则各自都合理，凑在一起就不合理：
 *   1) 服务端：连上来 30 秒还不 auth 的连接一律关掉（挡空连接占 fd）；
 *   2) 客户端：ensureConnected 看到 readyState===1 就复用，不再补发 auth。
 * 页面一打开就连 WS，那时还没登录、拿不到令牌，所以那条连接注定未鉴权；
 * 用户登录后复用的正是它，于是 30 秒到点被踢。
 *
 * 这里锁四件事：
 *   1) 没登录时 reauth 什么都不做（不能因为「没令牌」把连接断掉）；
 *   2) 有令牌时 reauth 关旧连新，且新连接 open 时立刻发 auth；
 *   3) 旧连接晚到的 close **不能**把新连接置空（否则新连接成孤儿）；
 *   4) 被踢（disconnected=true）之后 reauth 能把状态复位。
 */
'use strict';

global.location = { protocol: 'http:', host: 'app.test' };

const docListeners = {};
const winListeners = {};
global.document = {
  visibilityState: 'visible',
  addEventListener: function (t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); }
};
global.window = {
  addEventListener: function (t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); }
};

class FakeWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closeCalls = 0;
    this._l = {};
    FakeWS.instances.push(this);
    setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this._emit('open', {}); } }, 0);
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
  auths() {
    return this.sent.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } })
      .filter((o) => o && o.type === 'auth');
  }
}
FakeWS.instances = [];
global.WebSocket = FakeWS;

/* AuthStore 的最小替身：roomStore 只用到 token()。
 * 注意要用 global 上的同名变量——roomStore 里判断的是 `typeof AuthStore`。 */
let fakeToken = '';
global.AuthStore = {
  token: function () { return fakeToken; },
  nickname: function () { return '甲'; },
  playerId: function () { return 'p1'; }
};

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
  phase: 'WAITING',
  round: 1,
  players: [{ id: 'p1', nickname: '甲', score: 20, connected: true, left: false }]
};

async function run() {
  /* ---------------------------------------------------------------- */
  console.log('\n[1] 没登录：reauth 空转');
  const r0 = await RS.reauth();
  eq(r0, null, '没有令牌时直接返回 null');
  eq(FakeWS.instances.length, 0, '也不会去建连接');

  /* ---------------------------------------------------------------- */
  console.log('\n[2] 未登录状态下先连上（页面一打开就会发生）');
  const boot = RS.createRoom({ playerId: 'p1', nickname: '甲' }).catch(function () { return null; });
  await wait(20);
  const oldWS = FakeWS.instances[0];
  ok(!!oldWS, '第一条连接已建立');
  eq(oldWS.readyState, 1, '它是 open 的');
  eq(oldWS.auths().length, 0, '★ 此刻没有令牌，所以一条 auth 都没发（这就是 30 秒后被踢的原因）');
  oldWS.deliver({ type: 'ok', reqId: 1, payload: { room: ROOM, token: 'seat-token' } });
  await boot;

  /* ---------------------------------------------------------------- */
  console.log('\n[3] 登录成功后 reauth：关旧连新');
  fakeToken = 'tk-abc';
  const before = FakeWS.instances.length;
  const p = RS.reauth();
  await wait(20);
  const newWS = FakeWS.instances[FakeWS.instances.length - 1];
  await p;

  eq(FakeWS.instances.length, before + 1, '确实新建了一条连接');
  ok(newWS !== oldWS, '新连接不是旧的那个对象');
  ok(oldWS.closeCalls >= 1, '旧连接被关掉了');
  eq(newWS.auths().length, 1, '★ 新连接 open 时立刻发了 auth');
  eq(newWS.auths()[0].payload.token, 'tk-abc', '带的是登录后拿到的令牌');
  eq(oldWS.auths().length, 0, '旧连接始终没有鉴权（它本来就没有令牌）');

  /* ---------------------------------------------------------------- */
  console.log('\n[4] 旧连接的 close 不能污染新连接');
  /* 真实浏览器里 close 事件是异步的，这里手动补发一次「晚到的 close」 */
  oldWS._emit('close', {});
  await wait(10);
  const countAfterClose = FakeWS.instances.length;
  /* 新连接必须还能用：发一个请求，消息要落在 newWS 上 */
  const req = RS.getRoom(ROOM.roomId);
  await wait(10);
  const lastSent = newWS.sent[newWS.sent.length - 1];
  ok(!!lastSent, '★ 新连接仍然能发消息（没有被旧 close 置空）');
  eq(FakeWS.instances.length, countAfterClose, '没有因为旧 close 触发多余重连');
  newWS.deliver({ type: 'ok', reqId: JSON.parse(lastSent).reqId, payload: { room: ROOM } });
  await req;

  /* ---------------------------------------------------------------- */
  console.log('\n[5] 被踢之后（disconnected=true），reauth 能复位');
  newWS.deliver({ type: 'error', payload: { error: '连接未登录，已断开', kicked: true } });
  await wait(10);
  const before2 = FakeWS.instances.length;
  const p2 = RS.reauth();
  await wait(20);
  const ws3 = FakeWS.instances[FakeWS.instances.length - 1];
  await p2;
  eq(FakeWS.instances.length, before2 + 1, '★ 被踢后仍能重新建连（disconnected 被复位）');
  eq(ws3.auths().length, 1, '新连接照常带令牌鉴权');
  eq(ws3.auths()[0].payload.token, 'tk-abc', '令牌没丢');

  /* ---------------------------------------------------------------- */
  console.log('\n[6] 令牌被清掉之后（退出登录）再 reauth：不要再建连接');
  fakeToken = '';
  const before3 = FakeWS.instances.length;
  const r3 = await RS.reauth();
  eq(r3, null, '没有令牌就返回 null');
  eq(FakeWS.instances.length, before3, '不会建新连接');

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  process.exit(fail ? 1 : 0);
}

run().catch(function (e) { console.error(e); process.exit(1); });
