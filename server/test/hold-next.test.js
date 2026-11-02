/**
 * 服务端端到端：「等个人」（v122）在真协议上成立
 * 跑法：node server/test/hold-next.test.js
 *
 * 为什么必须有一个真 WebSocket 的文件：
 *   v117（setHandLimit）和 v121（dropNext）都栽在同一处 ——
 *   单测只断言了源码里出现过那个名字，而客户端把参数放在顶层、
 *   服务端读的是 payload.xxx，于是真机上永远收不到。
 *   这一条链路上，`on` 被读错不会有任何报错：读成 false 就等于「解除等待」，
 *   表现是「点了『等个人』之后牌立刻开了」，看起来像按钮坏了。
 *
 * 覆盖：
 *   [1] 房主挂起 → 全员报名也不开牌
 *   [2] 解除 → 人齐了立刻开（不用再点一次）
 *   [3] 非房主挂不起
 *   [4] 状态真的广播出去（前端靠 room.holdNext 渲染那一块）
 */
'use strict';

process.env.PROFILE_FILE = require('path').join(require('os').tmpdir(), 'lxw-holdnext-profiles-' + Date.now() + '.json');
process.env.SEED_FILE = require('path').join(require('os').tmpdir(), 'lxw-holdnext-seed');
process.env.PORT = process.env.PORT || '3202';
const PORT = Number(process.env.PORT);

const { server } = require('../index.js');
const SM = require('../../pwa/js/stateMachine.js');
const { registerPlayer } = require('./helpers/account');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

class Client {
  constructor(nickname) {
    this.nickname = nickname;
    this.playerId = null;
    this.token = null;
    this.seq = 0;
    this.pending = new Map();
    this.rooms = [];
  }

  async signup() {
    const acc = await registerPlayer(PORT, this.nickname);
    this.playerId = acc.playerId;
    this.token = acc.token;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
      this.socket = ws;
      const timer = setTimeout(() => reject(new Error('连接超时')), 5000);
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'auth', payload: { token: this.token } }));
        clearTimeout(timer); resolve();
      });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接失败')); });
      ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    });
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.type === 'room') { this.rooms.push(msg.payload.room); return; }
    if (msg.type === 'ok' || msg.type === 'error') {
      const p = this.pending.get(msg.reqId);
      if (!p) return;
      this.pending.delete(msg.reqId);
      if (msg.type === 'ok') p.resolve(msg.payload || {});
      else p.reject(new Error((msg.payload && msg.payload.error) || '请求失败'));
    }
  }

  request(type, payload) {
    const reqId = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(reqId); reject(new Error(type + ' 超时')); }, 5000);
      this.pending.set(reqId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      this.socket.send(JSON.stringify({ type: type, reqId: reqId, payload: payload || {} }));
    });
  }

  lastRoom() { return this.rooms[this.rooms.length - 1] || null; }
  me(room) { return SM.findPlayer(room, this.playerId); }
  close() { try { this.socket.close(); } catch (e) {} }
}

async function run() {
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  console.log('\n服务端已就绪 127.0.0.1:' + PORT);

  const a = new Client('房主甲');
  const b = new Client('牌友乙');
  await a.signup(); await a.connect();
  await b.signup(); await b.connect();
  ok(true, '两个客户端连接成功');

  const created = await a.request('createRoom', { playerId: a.playerId, nickname: a.nickname });
  const roomId = created.room.roomId;
  await b.request('joinRoom', { roomId: roomId, playerId: b.playerId, nickname: b.nickname });
  await a.request('ready', { ready: true });
  await b.request('ready', { ready: true });
  await wait(150);
  eq(a.lastRoom().phase, SM.PHASE.ROUND1_SPLIT, '前置：两人准备后开局了');

  await a.request('proposeDissolve');
  await wait(60);
  await a.request('voteDissolve', { agree: true });
  await wait(60);
  await b.request('voteDissolve', { agree: true });
  await wait(150);
  eq(a.lastRoom().phase, SM.PHASE.SETTLED, '前置：房间进入结算态');

  console.log('\n[1] 房主挂起「等个人」→ 全员报名也不开牌');
  const holdRes = await a.request('holdNext', { on: true });
  ok(holdRes.leftMs > 0, '★ 服务端读到了 on=true（读成 false 会立刻放行，这里会是 0）', holdRes.leftMs);
  await wait(80);
  ok(a.lastRoom() && a.lastRoom().holdNext && a.lastRoom().holdNext.by === a.playerId,
    '★ 挂起状态广播到了房间（前端靠它渲染「人齐了，开牌」）');
  ok(b.lastRoom() && b.lastRoom().holdNext, '★ 其他人也收得到（那一行提示不能只有房主看见）');

  await a.request('wantNext');
  await wait(60);
  await b.request('wantNext');
  await wait(200);
  eq(a.lastRoom().phase, SM.PHASE.SETTLED, '★ 两个人都报了名，仍然没开牌');
  ok(SM.findPlayer(a.lastRoom(), a.playerId).ready === true
    && SM.findPlayer(a.lastRoom(), b.playerId).ready === true,
    '两人都已就位（不开局的原因只剩「等个人」这一条）');

  console.log('\n[2] 解除 → 人齐了立刻开');
  await a.request('holdNext', { on: false });
  await wait(250);
  eq(a.lastRoom().phase, SM.PHASE.ROUND1_SPLIT, '★ 解除后立刻发牌（不用再点一次「开始下一局」）');
  eq(a.lastRoom().holdNext, null, '字段清干净了');
  eq(b.me(b.lastRoom()).hand.length, 6, '乙手里有 6 张牌（真的开了，不是只改了状态文案）');

  console.log('\n[3] 非房主挂不起');
  await a.request('proposeDissolve');
  await wait(60);
  await a.request('voteDissolve', { agree: true });
  await wait(60);
  await b.request('voteDissolve', { agree: true });
  await wait(150);
  eq(a.lastRoom().phase, SM.PHASE.SETTLED, '前置：再次进入结算态');

  let err = null;
  try { await b.request('holdNext', { on: true }); } catch (e) { err = e.message; }
  ok(err && err.indexOf('房主') >= 0, '★ 非房主被明确拒绝，文案点明权限', err);
  ok(!a.lastRoom().holdNext, '被拒之后没有留下半个状态');

  a.close(); b.close();
  await wait(80);

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => {
  console.error('\n测试异常：', e && e.stack || e);
  process.exit(1);
});
