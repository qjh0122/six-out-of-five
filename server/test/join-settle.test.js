/**
 * 服务端端到端测试：结算期新人能不能进来
 * 跑法：node server/test/join-settle.test.js
 *
 * 为什么单独一个文件：这是真机上被报回来的
 *   「我点了继续下一局已经进房间了，朋友（他不在上一局）加不进来，
 *    提示『这一局刚打完，正在结算，等下一局开始再进来』」
 *
 * 查下去比「等几十秒」严重：phase 只在 newRoom 时写成 WAITING，
 * 之后一直在 SPLIT / SETTLED 之间来回 —— 也就是说房间从第一局打完起，
 * 对新人就是**永久锁门**。所以「结算期能进」不是体验优化，是唯一入口。
 *
 * 这里测的是真 WebSocket 三客户端：A/B 打完一局 → C 在结算期进来 →
 * 三个人一起开下一局，C 手里真的有牌。stateMachine 单测覆盖规则，
 * 这个文件覆盖「规则接进服务端之后还成立」。
 */
'use strict';

process.env.PROFILE_FILE = require('path').join(require('os').tmpdir(), 'lxw-joinsettle-profiles-' + Date.now() + '.json');
process.env.SEED_FILE = require('path').join(require('os').tmpdir(), 'lxw-joinsettle-seed');
process.env.PORT = process.env.PORT || '3201';
const PORT = Number(process.env.PORT);

const { server } = require('../index.js');
const SM = require('../../pwa/js/stateMachine.js');
const CONFIG = require('../../pwa/js/config.js');
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
  const c = new Client('晚来的丙');

  await a.signup(); await a.connect();
  await b.signup(); await b.connect();
  await c.signup(); await c.connect();
  ok(true, '三个客户端连接成功');

  console.log('\n[1] 甲乙打完一局（用「结束本局」收口到结算态）');
  const created = await a.request('createRoom', { playerId: a.playerId, nickname: a.nickname });
  const roomId = created.room.roomId;
  await b.request('joinRoom', { roomId: roomId, playerId: b.playerId, nickname: b.nickname });
  await a.request('ready', { ready: true });
  await b.request('ready', { ready: true });
  await wait(120);
  eq(a.lastRoom().phase, SM.PHASE.ROUND1_SPLIT, '前置：两人准备后开局了');

  await a.request('proposeDissolve');
  await wait(60);
  await a.request('voteDissolve', { agree: true });
  await wait(60);
  await b.request('voteDissolve', { agree: true });
  await wait(150);
  const settled = a.lastRoom();
  eq(settled.phase, SM.PHASE.SETTLED, '前置：房间进入结算态');

  console.log('\n[2] 房主点「开始下一局」，这时丙来了');
  await a.request('wantNext');
  await wait(80);
  const waiting = a.lastRoom();
  eq(waiting.phase, SM.PHASE.SETTLED, '房主报名后房间仍停在结算态（没报名的人还在看回放）');

  let joinErr = null;
  let joined = null;
  try {
    joined = await c.request('joinRoom', { roomId: roomId, playerId: c.playerId, nickname: c.nickname });
  } catch (e) { joinErr = e.message; }
  ok(!joinErr, '★ 结算期新人能进房（以前这里回「这一局刚打完，正在结算，等下一局开始再进来」）', joinErr);
  ok(joined && joined.token, '进房发了座位令牌（重连要用）');
  eq(joined && joined.room.players.length, 3, '房间里 3 人');
  const cMe = joined && SM.findPlayer(joined.room, c.playerId);
  ok(cMe && cMe.wantNext === true, '★ 自动算「报名下一局」（不带这个标记新一局会把他静默丢掉）');
  ok(cMe && cMe.joinedLate === true, '★ 标记「没打上一局」（前端不弹上一局结算、分数不写上局）');
  /* C-2 只把「结算页点开始下一局」那条主路径改成一次点击；
   * 从房号进来的这条仍要自己点一次准备（他还没看到这间房长什么样）。 */
  eq(cMe && cMe.ready, false, '从房号进来的人仍要自己点一次准备');
  eq(cMe && cMe.score, CONFIG.INITIAL_SCORE, '分数是初始分');

  /* 广播：甲乙的推送里也要出现丙，否则房间页的座位表不会更新 */
  await wait(150);
  ok(a.lastRoom() && SM.findPlayer(a.lastRoom(), c.playerId), '甲的推送里有丙（座位表会刷出来）');
  ok(b.lastRoom() && SM.findPlayer(b.lastRoom(), c.playerId), '乙的推送里也有丙');
  ok(c.lastRoom() && c.lastRoom().players.length === 3, '丙自己也收到了房间（进入房间页而不是空白）');

  console.log('\n[3] 三个人一起开下一局，丙手里要有牌');
  /* C-2 之后甲乙点「开始下一局」时就已就位，不用再各点一次准备；
   * 只剩丙（从房号进来的）还差这一步。他一点，三个人齐了，服务端直接开局。 */
  await b.request('wantNext');
  await wait(60);
  eq(a.lastRoom().phase, SM.PHASE.SETTLED, '甲乙都就位了，但丙还没准备 → 停在结算态');
  await c.request('ready', { ready: true });
  await wait(200);
  const next = c.lastRoom();
  eq(next.phase, SM.PHASE.ROUND1_SPLIT, '★ 下一局开了');
  ok(SM.findPlayer(next, c.playerId), '★ 丙没在开局瞬间被丢掉（startNextRound 不会踢掉他）');
  eq(c.me(next).hand.length, 6, '★ 丙手里有 6 张牌（真的进了这一局）');
  eq(c.me(next).joinedLate, false, '新一局开始后 joinedLate 清掉（下一把结算要照常弹）');

  console.log('\n[4] 打起来之后仍然进不来（边界没被放行顺带破掉）');
  const d = new Client('更晚的丁');
  await d.signup(); await d.connect();
  let lateErr = null;
  try { await d.request('joinRoom', { roomId: roomId, playerId: d.playerId, nickname: d.nickname }); }
  catch (e) { lateErr = e.message; }
  ok(lateErr && lateErr.indexOf('正在打') >= 0, '★ 对局中进不来，文案是「这局正在打」', lateErr);

  a.close(); b.close(); c.close(); d.close();
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
