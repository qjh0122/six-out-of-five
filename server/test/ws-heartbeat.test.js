/**
 * WS 心跳判活：僵尸连接必须被收掉，活人不能被误踢
 * 跑法：node server/test/ws-heartbeat.test.js
 *
 * 背景（发布时实测出来的）：部署前 `/api/health` 报 `rooms: 3, conns: 9`，
 * 进程重启后立刻变成 `0 / 0` —— 那 9 条连接**一个活人都没有**。
 * WS 只在对面正常关闭（FIN）或 RST 时才触发 close；移动端切后台被系统回收、
 * 进程被 kill、地铁进隧道，全都不发 FIN，连接就这么一直躺着。
 *
 * 代价三层：占 fd 与缓冲、`room.players[].connected` 一直是 true（别人看不到他掉线）、
 * 并且把 `conns` 这个数字撑成假的在线人数。
 *
 * 这里锁三件事：
 *   ① 一直回 pong 的连接，多少轮都不关；
 *   ② 一直不回 pong 的连接，第 3 轮被关闭（= 发了 2 次 ping、等了 60 秒）；
 *   ③ 虽然不回 pong、但一直有业务消息进来的连接**不能关** ——
 *      有的中间层会吃掉控制帧却正常转发数据，那种连接业务上完全可用。
 */
'use strict';

process.env.WS_AUTH_TIMEOUT_MS = '600000';   // 别让握手超时插进这个测试
const { EventEmitter } = require('events');
const { Hub } = require('../hub.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

/* 只实现 hub 真正用到的那几个方法：ping / close / send / on
 * 用 EventEmitter 当基类，hub 的 attach 直接 on('message'/'pong'/'close')。 */
class FakeClient extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts || {};
    this.pings = 0;
    this.closed = null;
    this.sent = [];
    this.alive = true;
  }
  ping() {
    this.pings++;
    /* 活人：收到 ping 就在网络层自动回 pong（真实浏览器就是这样）。
     * 这里同步 emit 是刻意的简化 —— 真实 pong 会晚几毫秒到，
     * 但下一轮心跳在 30 秒后，先后顺序等价，同步写法能让整个用例保持线性。 */
    if (this.opts.autoPong) this.emit('pong');
    return !this.opts.pingFails;
  }
  send(text) { this.sent.push(text); }
  close(code, reason) {
    if (this.closed) return;
    this.closed = { code: code, reason: reason };
    this.emit('close');
  }
}

function makeHub() {
  return new Hub({
    profiles: { accountOf: () => null, get: () => null, tokenVersion: () => 0 },
    log: () => {},
    resolveToken: () => ''
  });
}

/* attach 之后 hub 会把连接记进 conns；这里补一条最小 ctx，模拟「已鉴权并进房」 */
function attached(hub, client, ctx) {
  hub.attach(client);
  hub.conns.set(client, ctx || { playerId: 'p1', nickname: '甲', roomId: 'R1' });
  return client;
}

console.log('\n[1] 一直回 pong 的连接：多少轮都不关]');
{
  const hub = makeHub();
  const c = attached(hub, new FakeClient({ autoPong: true }));
  for (let i = 0; i < 10; i++) hub._heartbeat();
  ok(c.pings >= 10, '每轮都发了 ping', '发了 ' + c.pings + ' 次');
  eq(c.closed, null, '★ 10 轮之后仍然没有被关闭');
  eq(hub.conns.size, 1, '还挂在连接表里');
}

console.log('\n[2] 一直不回 pong 的连接：第 3 轮关闭（发 2 次 ping、等 60 秒）]');
{
  const hub = makeHub();
  const c = attached(hub, new FakeClient({ autoPong: false }));

  hub._heartbeat();                                  // 第 1 轮：发 ping，记 1 次欠账
  eq(c.pings, 1, '第 1 轮发了 ping');
  eq(c.closed, null, '第 1 轮还没关（给它一次机会）');

  hub._heartbeat();                                  // 第 2 轮：再发一次，欠账 2
  eq(c.pings, 2, '第 2 轮又发了一次');
  eq(c.closed, null, '第 2 轮仍然没关（到这里一共等了 60 秒）');

  hub._heartbeat();                                  // 第 3 轮：欠账到顶 → 关闭
  ok(c.closed !== null, '★ 第 3 轮关掉了（两轮无 pong）', JSON.stringify(c.closed));
  eq(c.closed && c.closed.code, 4001, '关闭码 4001');
  eq(hub.conns.size, 0, '★ 被关的连接从连接表里摘掉了（onClose 生效）');
}

console.log('\n[3] 有业务消息进来说明连接活着，不能误判]');
{
  /* 有的代理/中间层会吃掉控制帧，但数据帧正常转发。这种连接业务上完全可用，
   * 只认 pong 会把它们全部判死 —— 那不是「清理僵尸」，那是制造故障。 */
  const hub = makeHub();
  const c = attached(hub, new FakeClient({ autoPong: false }));
  for (let i = 0; i < 6; i++) {
    /* 真业务消息：一条 app 层 ping（服务端会回 pong），onMessage 会真的走一遍解析 */
    c.emit('message', JSON.stringify({ type: 'ping' }));
    hub._heartbeat();
  }
  eq(c.closed, null, '★ 每轮都有消息进来，6 轮之后仍然没有被关闭');
}

console.log('\n[4] socket 已经写不进去时立刻关，不等下一轮]');
{
  const hub = makeHub();
  const c = attached(hub, new FakeClient({ autoPong: true, pingFails: true }));
  hub._heartbeat();
  ok(c.closed !== null, '★ ping 发不出去 = socket 已坏，当场关掉');
  eq(c.closed && c.closed.code, 4002, '关闭码 4002（与心跳超时的 4001 区分开）');
}

console.log('\n[5] 心跳关连接走的是普通 close，不是 「踢下线」]');
{
  /* 关键区别：_kick 会给前端发 { kicked: true }，前端据此**永久停止自动重连**。
   * 心跳失败最该做的就是重连（用户可能只是进了电梯）。
   * 所以这里断言：关闭前没有发出任何带 kicked 的消息。 */
  const hub = makeHub();
  const c = attached(hub, new FakeClient({ autoPong: false }));
  hub._heartbeat(); hub._heartbeat(); hub._heartbeat();
  ok(c.closed !== null, '连接被关掉了');
  const kicked = c.sent.some((t) => String(t).indexOf('"kicked"') >= 0);
  ok(kicked === false, '★ 没有发 kicked 消息（前端会照常自动重连）');
}

console.log('\n[6] stats：conns 不等于在线人数]');
{
  const hub = makeHub();
  /* conns 有连接，但房间里一个人都没有 → online 必须是 0。
   * 这就是发布时那个「3 房 9 连、实际没人在玩」的场景。 */
  const dead = new FakeClient({});
  hub.conns.set(dead, { playerId: 'p9', nickname: '僵尸', roomId: null });
  hub.conns.set(new FakeClient({}), { playerId: 'p8', nickname: '僵尸2', roomId: null });
  hub.rooms.set('R1', { players: [] });
  let s = hub.stats();
  eq(s.conns, 2, 'conns 记的是连接数 2');
  eq(s.online, 0, '★ online 是 0（没有人在房间里）');

  hub.rooms.set('R2', {
    players: [
      { id: 'a', connected: true, left: false },
      { id: 'b', connected: false, left: false },   // 断线中，不算在线
      { id: 'c', connected: true, left: true },     // 已弃局，不算在线
      { id: 'bot1', connected: true, isBot: true }  // AI，更不算
    ]
  });
  hub.rooms.set('R3', { players: [{ id: 'a', connected: true, left: false }] });   // 同上一个人
  s = hub.stats();
  eq(s.online, 1, '★ 只有 1 个真人在线（断线/弃局/AI/重复都排除）');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
if (fail > 0) process.exitCode = 1;
