/**
 * peekRoom（只读快照）的**客户端**归一化
 * 跑法：node pwa/test/peek-room-client.test.js
 *
 * 为什么单开一个测试：`server/test/peek-room.test.js` 只验证服务端行为，
 * 抓不到「客户端把成功当失败」这类错误。
 *
 * 踩过的坑（真机探针才发现的）：服务端的回包是 `{ room }`，**没有 `ok` 字段**——
 * 其它接口（createRoom / joinRoom）也是这样，都由客户端各自补 `{ ok: true }`。
 * peekRoom 第一版漏了这一步，于是 `res.ok === undefined`，
 * `onLeave` 里的 `(res && res.ok && res.room)` 恒为假，快照永远拿不到。
 *
 * 表现是：明明连着网、服务端也回了，确认框却总多出一行
 * 「（没连上服务端核对最新进度，以上按本地画面判断。）」。
 * 这种「功能和降级路径长得一样」的 bug 最麻烦，只能靠断言回包形状挡住。
 */
'use strict';

/* roomStore 在 Node 下走 ws 分支（没有 window），但它会读 location 拼 URL，先补一个 */
global.location = { protocol: 'http:', host: 'app.test' };

class FakeWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this._l = {};
    FakeWS.instances.push(this);
    setTimeout(() => { this.readyState = 1; this._emit('open', {}); }, 0);
  }
  addEventListener(type, fn) { (this._l[type] = this._l[type] || []).push(fn); }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this._emit('close', {}); }
  _emit(type, ev) { (this._l[type] || []).slice().forEach((fn) => fn(ev)); }
  deliver(obj) { this._emit('message', { data: JSON.stringify(obj) }); }
  lastSent() { try { return JSON.parse(this.sent[this.sent.length - 1]); } catch (e) { return null; } }
}
FakeWS.instances = [];
global.WebSocket = FakeWS;

const RS = require('../js/roomStore.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* 一条最小可用的房间快照：onLeave 只用 phase / round / players[].score */
const ROOM = {
  roomId: '123456',
  phase: 'ROUND1_SPLIT',
  round: 1,
  players: [
    { id: 'p1', nickname: '甲', score: 17, connected: true, left: false },
    { id: 'p2', nickname: '乙', score: 23, connected: true, left: false }
  ]
};

async function run() {
  /* 先发一条悬着的请求把连接顶起来 */
  const warm = RS.createRoom({ playerId: 'p1', nickname: '甲' }).catch(function () { return null; });
  await wait(20);
  const ws = FakeWS.instances[0];
  ok(!!ws, '假连接已建立');
  eq(ws.readyState, 1, '连接 open');
  ws.deliver({ type: 'ok', reqId: 1, payload: { room: ROOM, token: 'seat-token' } });
  await warm;

  /* ---------------------------------------------------------------- */
  console.log('\n[请求形状]');
  const p = RS.peekRoom('123456');
  await wait(10);
  const sent = ws.lastSent();
  eq(sent && sent.type, 'peekRoom', '发出的是 peekRoom');
  eq(sent && sent.payload && sent.payload.roomId, '123456', '带上了 roomId');
  ok(sent && typeof sent.reqId === 'number', '带 reqId（可对号入座）');

  /* ---------------------------------------------------------------- */
  console.log('\n[★ 核心：成功回包必须归一化成 { ok: true }]');
  /* 服务端只回 { room }，没有 ok —— 这正是第一版翻车的地方 */
  ws.deliver({ type: 'ok', reqId: sent.reqId, payload: { room: ROOM } });
  const res = await p;
  eq(res.ok, true, '★ ok 被补成 true（服务端回包本身没有 ok 字段）');
  ok(!!res.room, 'room 带回来了');
  eq(res.room.phase, 'ROUND1_SPLIT', 'phase 原样透传');
  eq(res.room.round, 1, 'round 原样透传');
  eq(res.room.players[0].score, 17, '自己的分数可读（确认框要展示）');

  /* onLeave 的判据就是这个三元表达式，顺带锁一遍语义 */
  ok(!!(res && res.ok && res.room), '★ onLeave 的判据 (res.ok && res.room) 成立');
  ok(!(!!(res && res.ok && res.room) === false), '★ 不会被误判成「拿不到快照」');

  /* ---------------------------------------------------------------- */
  console.log('\n[服务端回 ok 但没带 room]');
  const p2 = RS.peekRoom('123456');
  await wait(10);
  const s2 = ws.lastSent();
  ws.deliver({ type: 'ok', reqId: s2.reqId, payload: {} });
  const res2 = await p2;
  eq(res2.ok, true, '仍然算「请求成功」');
  eq(res2.room, null, '但 room 是 null（onLeave 会据此判断拿不到快照）');
  ok(!!(res2.ok && res2.room) === false, '判据此时为假 → 会走「没核对上」的降级文案');

  /* ---------------------------------------------------------------- */
  console.log('\n[服务端报错]');
  const p3 = RS.peekRoom('123456');
  await wait(10);
  const s3 = ws.lastSent();
  ws.deliver({ type: 'error', reqId: s3.reqId, payload: { error: '你不在这个房间里' } });
  const res3 = await p3;
  eq(res3.ok, false, '★ 错误回包归一化成 ok:false（而不是抛异常）');
  eq(res3.error, '你不在这个房间里', '错误原因带回来');
  eq(res3.room, undefined, '没有 room');

  /* ---------------------------------------------------------------- */
  console.log('\n[peekRoom 不能有副作用]');
  /* 它应该只是一条普通请求：不发 reconnect、不带 token */
  const before = ws.sent.length;
  const p4 = RS.peekRoom('123456');
  await wait(10);
  const s4 = ws.lastSent();
  ws.deliver({ type: 'ok', reqId: s4.reqId, payload: { room: ROOM } });
  await p4;
  eq(ws.sent.length, before + 1, '只发了 1 条消息（没有顺带发 reconnect）');
  ok(!s4.payload.token, '不带座位令牌');
  ok(!s4.payload.playerId, '不带 playerId（身份走连接）');

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
