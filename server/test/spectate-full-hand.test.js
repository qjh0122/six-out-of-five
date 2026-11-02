/**
 * 服务端端到端：牌局进行中进来一个旁听者，这一把要照常打完
 * 跑法：node server/test/spectate-full-hand.test.js
 *
 * 为什么单独一个文件：v122 放行「打牌中加入」之后，最危险的**不是**视图漏牌
 * （`_view` 早就按观众过滤了），而是**结算判定被一个永远不提交的人卡住**。
 *
 *   `settleIfAllIn` 如果按 `room.players` 判「全员已交」，旁听者手上没有牌、
 *   永远不会提交，整桌就停在「等一个人交牌」——他没计时器（我们专门跳过了），
 *   也没有任何 UI 让他知道自己在卡着别人。这就是一个没有出口的死锁。
 *
 * 所以这里用两个真人 + 一个局中进来的旁听者，把一整把牌**真的打完**：
 *   [1] 旁听者进来，手上没牌、不进 playingPlayers
 *   [2] 一个真人交牌 → 不结算（该等另一个人，不是等旁听者）
 *   [3] 另一个真人也交 → **必须当场结算**（这一条就是死锁的探针）
 *   [4] 旁听者不能提交分组（否则他会收到「每组必须填满」这种看不懂的话）
 *   [5] 打完回结算页，他点「开始下一局」→ 下一把真的有牌
 */
'use strict';

process.env.PROFILE_FILE = require('path').join(require('os').tmpdir(), 'lxw-spectate-profiles-' + Date.now() + '.json');
process.env.SEED_FILE = require('path').join(require('os').tmpdir(), 'lxw-spectate-seed');
process.env.PORT = process.env.PORT || '3203';
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

/* 把一手 6 张按本轮的组数填满（复制自 e2e.test.js：全靠规则，不猜牌面） */
function buildGroups(hand, round) {
  const keys = SM.ROUND_GROUPS[round];
  const groups = {};
  let i = 0;
  keys.forEach((k) => {
    const need = SM.GROUP_COUNT[k];
    groups[k] = hand.slice(i, i + need);
    i += need;
  });
  return groups;
}

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

  const a = new Client('旁听甲');
  const b = new Client('旁听乙');
  const c = new Client('晚到丙');
  await a.signup(); await a.connect();
  await b.signup(); await b.connect();
  await c.signup(); await c.connect();

  const created = await a.request('createRoom', { playerId: a.playerId, nickname: a.nickname });
  const roomId = created.room.roomId;
  await b.request('joinRoom', { roomId: roomId, playerId: b.playerId, nickname: b.nickname });
  await a.request('ready', { ready: true });
  await b.request('ready', { ready: true });
  await wait(200);
  eq(a.lastRoom().phase, SM.PHASE.ROUND1_SPLIT, '前置：两人准备后发牌');

  console.log('\n[1] 牌已经发了，这时第三个人进来');
  const joined = await c.request('joinRoom', { roomId: roomId, playerId: c.playerId, nickname: c.nickname });
  const cSeat = SM.findPlayer(joined.room, c.playerId);
  eq(cSeat && cSeat.benched, true, '★ 他是旁听（这一把不补人）');
  eq(cSeat && (cSeat.hand || []).length, 0, '手上没有牌');
  eq(joined.room.players.filter(function (p) { return !p.left && !p.benched; }).length, 2,
    '★ 参与本局的仍是 2 人');

  console.log('\n[2] 一个人交牌 → 不该结算（要等另一个真人，不是等旁听者）');
  await a.request('submitGroups', { groups: buildGroups(a.me(a.lastRoom()).hand, 1) });
  await wait(300);
  eq(a.lastRoom().phase, SM.PHASE.ROUND1_SPLIT, '只有一个人交了，仍停在分牌阶段');

  console.log('\n[3] 另一个真人也交 → 必须当场结算（死锁探针）');
  await b.request('submitGroups', { groups: buildGroups(b.me(b.lastRoom()).hand, 1) });
  await wait(600);
  const afterRound1 = a.lastRoom();
  ok(afterRound1.phase !== SM.PHASE.ROUND1_SPLIT,
    '★★ 两个真人都交了 → 第一轮结算了（旁听者不会把整桌卡在「等一个人交牌」）',
    afterRound1.phase);

  console.log('\n[4] 旁听者提交分组 → 明确拒绝');
  let subErr = null;
  try { await c.request('submitGroups', { groups: { single: [], tenhalf: [], piaosanye: [] } }); }
  catch (e) { subErr = e.message; }
  ok(subErr && subErr.indexOf('旁听') >= 0, '★ 文案说「这一把你在旁听，没有牌可提交」，不是「每组必须填满」', subErr);

  console.log('\n[5] 旁听者的分数与状态没被这一把影响');
  const cNow = c.me(c.lastRoom());
  eq(cNow.score, 0, '旁听者分数没变（基准 0）');
  eq(!!cNow.forfeitRound, false, '★ 没被判「超时弃权」（旁听者不挂分牌计时器）');
  eq((cNow.hand || []).length, 0, '还是没牌');

  console.log('\n[6] 打完这一把 → 他点「开始下一局」→ 下一把真的有牌');
  /* 用「结束本局」收口，比打满 10 把快，且不影响本文件要验的东西。 */
  await a.request('proposeDissolve');
  await wait(80);
  await a.request('voteDissolve', { agree: true });
  await wait(80);
  await b.request('voteDissolve', { agree: true });
  await wait(300);
  eq(a.lastRoom().phase, SM.PHASE.SETTLED, '这一局收口到结算页');

  await c.request('wantNext');
  await wait(120);
  const cWants = c.me(c.lastRoom());
  eq(cWants.wantNext, true, '旁听者报了下一局');
  eq(cWants.benched, false, '★ 报名就把旁听身份摘掉');

  await a.request('wantNext');
  await wait(80);
  await b.request('wantNext');
  await wait(400);
  const nextRound = c.lastRoom();
  eq(nextRound.phase, SM.PHASE.ROUND1_SPLIT, '三个人都表态 → 下一局开了');
  eq(c.me(nextRound).hand.length, 6, '★ 晚到的人这一把真的有 6 张牌');
  eq(SM.playingPlayers(nextRound).length, 3, '★ 三个人都在打');

  a.close(); b.close(); c.close();
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
