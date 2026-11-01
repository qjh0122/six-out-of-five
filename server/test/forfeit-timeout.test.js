/**
 * 分牌超时「本回合弃权」端到端测试
 * 跑法：SPLIT_TIMEOUT_MS=300 node server/test/forfeit-timeout.test.js
 *
 * 用真实 WebSocket + 短超时（300ms）验证完整链路：
 *   建房 → 加入 → 准备 → 开局 → 一人挂机不提交 → 超时自动弃权 →
 *   另一人提交后立即结算 → 弃权者 0 分且仍可参与下一把
 */
'use strict';

process.env.PROFILE_FILE = require('path').join(require('os').tmpdir(), 'lxw-ft-profiles-' + Date.now() + '.json');
process.env.SEED_FILE = require('path').join(require('os').tmpdir(), 'lxw-ft-seed');
process.env.SPLIT_TIMEOUT_MS = process.env.SPLIT_TIMEOUT_MS || '800';
process.env.PORT = process.env.PORT || '3198';
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

class Client {
  constructor(playerId, nickname, token) {
    this.playerId = playerId;
    this.nickname = nickname;
    this.token = token || null;
    this.seq = 0;
    this.pending = new Map();
    this.rooms = [];
    this.socket = null;
  }
  /** 注册测试账号拿令牌（已带令牌时跳过 → 同一账号开第二个连接，用于多标签页场景） */
  async signup() {
    if (this.token) return;
    const acc = await registerPlayer(PORT, this.nickname);
    this.account = acc;
    this.playerId = acc.playerId;
    this.token = acc.token;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
      this.socket = ws;
      const timer = setTimeout(() => reject(new Error('连接超时')), 5000);
      ws.addEventListener('open', () => {
        // 先鉴权：服务端此后只认这个连接的令牌身份，不再看请求体里的 playerId
        ws.send(JSON.stringify({ type: 'auth', payload: { token: this.token } }));
        clearTimeout(timer); resolve();
      });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接失败')); });
      ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    });
  }
  _onMessage(raw) {
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.type === 'room') this.rooms.push(msg.payload.room);
    else if (msg.type === 'ok' || msg.type === 'error') {
      const p = this.pending.get(msg.reqId);
      if (p) {
        this.pending.delete(msg.reqId);
        if (msg.type === 'ok') p.resolve(msg.payload || {});
        else p.reject(new Error((msg.payload && msg.payload.error) || '请求失败'));
      }
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

function buildGroups(hand, round) {
  const keys = SM.ROUND_GROUPS[round];
  const groups = {};
  let i = 0;
  keys.forEach((k) => { const need = SM.GROUP_COUNT[k]; groups[k] = hand.slice(i, i + need); i += need; });
  return groups;
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* 轮询等待，直到 client 收到满足条件的 room 推送（避免固定 sleep 撞上多次超时滚动） */
async function waitForRoom(client, cond, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const room = client.lastRoom();
    if (room && cond(room)) return room;
    await wait(30);
  }
  return client.lastRoom();
}

async function run() {
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  console.log('\n服务端就绪 127.0.0.1:' + PORT + '（分牌超时 ' + process.env.SPLIT_TIMEOUT_MS + 'ms）');

  const a = new Client('fa_' + Date.now(), '甲');
  const b = new Client('fb_' + Date.now(), '乙');
  await a.signup();
  await a.connect();
  await b.signup();
  await b.connect();
  ok(true, '两个客户端连接成功');

  console.log('\n[建房加入准备开局]');
  const created = await a.request('createRoom', { playerId: a.playerId, nickname: a.nickname });
  const roomId = created.room.roomId;
  await b.request('joinRoom', { roomId: roomId, playerId: b.playerId, nickname: b.nickname });
  await a.request('ready', { ready: true });
  await b.request('ready', { ready: true });
  // 全员准备即开局（「开始游戏」按钮已删），不再需要手动 start
  await wait(80);
  let room = a.lastRoom();
  eq(room.phase, SM.PHASE.ROUND1_SPLIT, '进入第一轮分牌');

  console.log('\n[甲正常提交，乙挂机不提交 → 等超时弃权]');
  await a.request('submitGroups', { groups: buildGroups(a.me(room).hand, 1) });
  await wait(80);
  room = a.lastRoom();
  eq(room.phase, SM.PHASE.ROUND1_SPLIT, '甲提交后仍停在分牌（乙还没交/没弃权）');

  // 等乙超时弃权、结算推进到第二轮（waitForRoom 轮询，避免固定 sleep 撞上后续滚动）
  room = await waitForRoom(a, (r) => r.phase === SM.PHASE.ROUND2_SPLIT || r.phase === SM.PHASE.SETTLED, 2500);
  ok(room.phase === SM.PHASE.ROUND2_SPLIT || room.phase === SM.PHASE.SETTLED,
    '乙超时弃权后，甲已提交 → 立即结算推进', room.phase);

  // 乙一定被标记为第一轮弃权（这是本次超时触发的）
  eq(b.me(room).forfeitRound, 1, '乙被标记为第一轮弃权');
  eq(b.me(room).submitted.round1, true, '乙弃权视为已提交');
  ok(!b.me(room).left, '乙弃权但没离场（还能玩下一把）');

  console.log('\n[弃权者本回合不得分]');
  ok(room.results.round1 !== null, '第一轮有结算结果');
  /* ★ 判据读 CONFIG，不写字面量（v106）。
   * 原来写的是 `score < 20`，分数基准从 20 改成 0 之后这条断言**退化成恒真门**：
   * 弃权者一分不扣、停在 0 分时，`0 < 20` 照样通过 —— 它已经不再证明「被扣分」。
   * 现在改成「严格低于基准分」，只有真的付出去了才通过。 */
  ok((b.me(room).score) < CONFIG.INITIAL_SCORE,
    '乙弃权后被扣分（不得分、还正常付给赢家）',
    '乙分=' + b.me(room).score + '，基准=' + CONFIG.INITIAL_SCORE);

  console.log('\n[下一把乙还能继续玩]');
  const act = SM.activePlayers(room);
  ok(act.some((p) => p.id === b.playerId), '乙仍在活跃玩家列表（可继续玩）');

  a.close(); b.close();
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('测试异常:', e); process.exit(1); });
