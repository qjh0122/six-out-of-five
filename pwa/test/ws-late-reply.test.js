/**
 * WebSocket「迟到回包」不能当成连接故障
 * 跑法：node pwa/test/ws-late-reply.test.js
 *
 * 踩过的坑：request() 有 8 秒超时，超时后会把 pending[reqId] 删掉；
 * 服务端随后才把回包发过来，于是 handleMessage 里 `pending[reqId]` 是 undefined，
 * 落到 `else` 分支 —— 而那个分支是**连接级致命错误**的处理路径（握手鉴权失败、被停用踢线），
 * 会触发 fatalCbs，界面直接把人送回登录页并提示「连接已被服务端关闭」。
 *
 * 也就是说：只要某个请求慢过一次，玩家就会莫名其妙被踢下线。
 * 现在按「有没有 reqId」区分：有 reqId 但本地没有对应请求 = 迟到回包，直接丢弃。
 *
 * 这里用假 WebSocket 直接喂消息，不起真服务端，也不依赖任何计时器。
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
    // 下一个 tick 变 open，模拟真实握手
    setTimeout(() => { this.readyState = 1; this._emit('open', {}); }, 0);
  }
  addEventListener(type, fn) { (this._l[type] = this._l[type] || []).push(fn); }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this._emit('close', {}); }
  _emit(type, ev) { (this._l[type] || []).slice().forEach((fn) => fn(ev)); }
  deliver(obj) { this._emit('message', { data: JSON.stringify(obj) }); }
  sentTypes() { return this.sent.map((d) => { try { return JSON.parse(d).type; } catch (e) { return '?'; } }); }
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

async function run() {
  console.log('\n[建立连接并留一个悬而未决的请求]');
  const fatals = [];
  RS.onFatal(function (msg) { fatals.push(msg); });

  const pendingReq = RS.createRoom({ playerId: 'p1', nickname: '甲' }).catch(function () { return null; });
  await wait(20);

  const ws = FakeWS.instances[0];
  ok(!!ws, '假连接已建立');
  eq(ws.readyState, 1, '连接处于 open 状态');
  ok(ws.sentTypes().indexOf('createRoom') >= 0, '请求已发出');
  eq(fatals.length, 0, '此时还没有任何致命错误');

  /* ---------------------------------------------------------------- */
  console.log('\n[核心：有 reqId 但本地已无对应请求 = 迟到回包，必须丢弃]');
  ws.deliver({ type: 'error', reqId: 999999, payload: { error: '房间不存在' } });
  eq(fatals.length, 0, '★ 不会触发致命错误回调（以前这里会把玩家弹回登录页）');

  ws.deliver({ type: 'error', reqId: 888888, payload: { error: '请求失败' } });
  eq(fatals.length, 0, '再来一次也一样（可重复，不会累积出错）');

  console.log('\n[迟到的 ok 回包同样只丢弃]');
  let threw = null;
  try { ws.deliver({ type: 'ok', reqId: 777777, payload: {} }); } catch (e) { threw = e; }
  ok(threw === null, '迟到的 ok 不会抛异常');
  eq(fatals.length, 0, '迟到的 ok 也不会触发致命错误');

  /* ---------------------------------------------------------------- */
  console.log('\n[没有 reqId 的 error 仍是连接级故障，必须报出来]');
  ws.deliver({ type: 'error', payload: { error: '登录已失效' } });
  eq(fatals.length, 1, '无 reqId → 触发致命回调');
  eq(fatals[0], '登录已失效', '把服务端给的原因原样带给界面');

  console.log('\n[被踢（kicked）要连带断线，别再自动重连]');
  const before = FakeWS.instances.length;
  ws.deliver({ type: 'error', payload: { error: '账号已被停用', kicked: true } });
  eq(fatals.length, 2, '被踢也走致命回调');
  eq(ws.readyState, 3, '连接被主动关闭（不再每 2 秒重连一次）');
  await wait(30);
  eq(FakeWS.instances.length, before, '没有因为 kicked 触发新建连接');

  /* ---------------------------------------------------------------- */
  console.log('\n[对照：pending 里真有的 reqId 仍然走正常的 reject]');
  /* 被踢之后旧 socket 已关闭，新请求会开一条新连接 —— 要拿最新的那条发回包 */
  RS.createRoom({ playerId: 'p1', nickname: '甲' });   // 这一条故意不 await：只为开一条连接
  await wait(20);
  const req2 = RS.createRoom({ playerId: 'p1', nickname: '甲' }).then(
    () => ({ ok: true }), (e) => ({ ok: false, error: e.message })
  );
  await wait(20);
  const ws2 = FakeWS.instances[FakeWS.instances.length - 1];
  ok(ws2.readyState === 1, '新请求用的是新连接');
  const last = ws2.sent.map((d) => JSON.parse(d)).filter((m) => m.type === 'createRoom').pop();
  ok(!!last && typeof last.reqId === 'number', '新请求带 reqId');
  const fatalBefore = fatals.length;
  ws2.deliver({ type: 'error', reqId: last.reqId, payload: { error: '房间已满' } });
  const r2 = await req2;
  eq(r2.ok, false, 'pending 中的请求被 reject（业务错误照常抛出）');
  eq(r2.error, '房间已满', '错误文案原样传给调用方');
  eq(fatals.length, fatalBefore, '业务错误不会触发致命回调');

  await pendingReq;

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
