/**
 * 只读快照 peekRoom（P2-13 的配套）
 * 跑法：node server/test/peek-room.test.js
 *
 * 客户端在弹「离开房间 / 弃局离开」之前要先跟服务端核对一次最新进度，
 * 因为本地 state.room 是 WS 推来的，可能落后——本地显示「等待中」、
 * 服务端其实已在分牌时，玩家会看到一个毫无预警的「离开房间」，
 * 点确定就默默算成弃局，分数照扣。
 *
 * 为什么不能用现成的 reconnect 来读这一下：
 *   reconnect 会 _refreshSplitDeadline（补分牌时限）、重新 _bind、
 *   下发新座位令牌。客户端只是想知道「现在第几轮」，走 reconnect 意味着
 *   反复点「离开 / 取消」就能一直被补时限——凭空多出分牌时间。
 *
 * 所以本测试的核心不是「能读到状态」，而是「读了不出副作用」：
 *   [1] 能读到服务端的最新 phase（不是发请求那个客户端的本地认知）
 *   [2] 不下发座位令牌
 *   [3] 不改变在线/离线状态
 *   [4] ★ 不补分牌时限：在截止前疯狂 peek，到点照样判弃权
 *   [5] 越权与异常：不在房里 / 房间不存在 / 未登录 都要被拒
 */
'use strict';

process.env.PROFILE_FILE = require('path').join(require('os').tmpdir(), 'lxw-peek-profiles-' + Date.now() + '.json');
process.env.SEED_FILE = require('path').join(require('os').tmpdir(), 'lxw-peek-seed-' + Date.now() + '.json');
process.env.PORT = process.env.PORT || '3211';
process.env.SPLIT_TIMEOUT_MS = '1500';
process.env.MIN_RECONNECT_SPLIT_MS = '1200';
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

class Client {
  constructor(nickname) {
    this.nickname = nickname;
    this.seq = 0;
    this.pending = new Map();
    this.rooms = [];
    this.socket = null;
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
        ws.send(JSON.stringify({ type: 'auth', reqId: ++this.seq, payload: { token: this.token } }));
        clearTimeout(timer);
        setTimeout(resolve, 150);
      });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接失败')); });
      ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    });
  }
  _onMessage(raw) {
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.type === 'room') { this.rooms.push(msg.payload.room); return; }
    if (msg.type !== 'ok' && msg.type !== 'error') return;
    const p = this.pending.get(msg.reqId);
    if (!p) return;
    this.pending.delete(msg.reqId);
    if (msg.type === 'ok') p.resolve(msg.payload || {});
    else p.reject(new Error((msg.payload && msg.payload.error) || '请求失败'));
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
  close() { try { this.socket.close(); } catch (e) {} }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  console.log('\n服务端就绪 127.0.0.1:' + PORT + '（分牌超时 1500ms）');

  const a = new Client('甲');
  const b = new Client('乙');
  await a.signup(); await a.connect();
  await b.signup(); await b.connect();

  const created = await a.request('createRoom', { nickname: '甲' });
  const roomId = created.room.roomId;
  const joined = await b.request('joinRoom', { roomId: roomId, nickname: '乙' });
  const bSeatToken = joined.token;
  await a.request('ready', { ready: true });
  await b.request('ready', { ready: true });
  /* 全员准备即开局（以前的「开始游戏」按钮已经删了）。
   * 这个用例要的是「peek 能读到服务端最新状态」，不再需要手动 start ——
   * 乙准备的那一下服务端就把房间推进到分牌了。 */
  await wait(80);

  /* ---------------------------------------------------------------- */
  console.log('\n[1] 读到的是服务端最新状态');
  const t0 = Date.now();   // 此刻已在分牌中，分牌超时从这附近起算
  const peeked = await b.request('peekRoom', { roomId: roomId });
  ok(!!peeked.room, 'peekRoom 返回了房间');
  eq(peeked.room.phase, SM.PHASE.ROUND1_SPLIT, '★ peekRoom 读到的 phase 是分牌中（不是调用方的旧认知）');
  eq(Number(peeked.room.round), 1, 'peekRoom 带回轮次');
  const meSnap = SM.findPlayer(peeked.room, b.playerId);
  ok(!!meSnap && typeof meSnap.score === 'number', 'peekRoom 带回自己的分数（确认框要展示）');

  /* 不带 roomId 时应回落到当前连接绑定的房间 */
  const peeked2 = await b.request('peekRoom', {});
  eq(peeked2.room && peeked2.room.roomId, roomId, '不传 roomId 时回落到当前房间');

  /* ---------------------------------------------------------------- */
  console.log('\n[2] 不下发座位令牌');
  eq(peeked.token, undefined, '★ peekRoom 的返回里没有 token（不会重发座位令牌）');

  /* ---------------------------------------------------------------- */
  console.log('\n[3] 不改变在线状态');
  const meBefore = SM.findPlayer(a.lastRoom(), b.playerId);
  eq(!!(meBefore && meBefore.connected), true, '乙当前在线');
  await b.request('peekRoom', { roomId: roomId });
  const meAfterPeek = SM.findPlayer(a.lastRoom(), b.playerId);
  eq(!!(meAfterPeek && meAfterPeek.connected), true, 'peekRoom 之后乙仍在线（没有误判掉线）');
  eq(!!(meAfterPeek && meAfterPeek.left), false, 'peekRoom 之后乙没有被标记离开');

  /* ---------------------------------------------------------------- */
  console.log('\n[4] ★ 不补分牌时限：截止前反复 peek，到点照样判弃权');
  /* 距首次进入分牌约 rightNow-t0。原始截止 t0+1500。
   * 在剩余不足 MIN_RECONNECT_SPLIT_MS(1200) 的窗口里连发 peekRoom，
   * 若 peekRoom 带 reconnect 那种副作用，乙的截止点就会被一路往后推。
   *
   * 节流到 ~20ms 一次：稳定低于 MSG_MAX(60/秒) 的消息限流，
   * 否则测的就不是「peek 有没有副作用」，而是限流有没有生效了。 */
  let peeks = 0;
  while (Date.now() - t0 < 1400) {
    try { await b.request('peekRoom', { roomId: roomId }); peeks++; } catch (e) { break; }
    await wait(20);
  }
  ok(peeks >= 5, '截止前成功发送 ' + peeks + ' 次 peekRoom');

  await wait(Math.max(0, (t0 + 1500 + 400) - Date.now()));
  const room4 = a.lastRoom();
  const me4 = SM.findPlayer(room4, b.playerId);
  eq(!!(me4 && me4.forfeitRound === 1), true, '★ 原定截止点过后乙仍被判弃权（peekRoom 没有续命）');
  ok(Date.now() - t0 > 1500, '确实跑过了原始截止点（不是假通过）');

  /* ---------------------------------------------------------------- */
  console.log('\n[5] 越权与异常');
  const c = new Client('丙');
  await c.signup(); await c.connect();
  let err = '';
  try { await c.request('peekRoom', { roomId: roomId }); } catch (e) { err = e.message; }
  ok(err.indexOf('不在') >= 0 || err.indexOf('房间') >= 0, '不在房里的人 peek 被拒（' + err + '）');

  err = '';
  try { await a.request('peekRoom', { roomId: '000000' }); } catch (e) { err = e.message; }
  ok(err.length > 0, '不存在的房间 peek 被拒（' + err + '）');

  const anon = new Client('匿名');
  anon.socket = null;
  const anonWs = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接超时')), 5000);
    anonWs.addEventListener('open', () => { clearTimeout(timer); resolve(); });
    anonWs.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接失败')); });
  });
  err = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('超时')), 3000);
      anonWs.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'error') { clearTimeout(timer); reject(new Error(m.payload.error)); }
        else if (m.type === 'ok') { clearTimeout(timer); resolve(m.payload); }
      });
      anonWs.send(JSON.stringify({ type: 'peekRoom', reqId: 1, payload: { roomId: roomId } }));
    });
  } catch (e) { err = e.message; }
  ok(err.indexOf('登录') >= 0, '未登录的连接 peek 被拒（' + err + '）');
  try { anonWs.close(); } catch (e) {}

  a.close(); b.close(); c.close();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await new Promise((r) => setTimeout(r, 80));
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
