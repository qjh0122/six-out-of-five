/**
 * 分牌超时：重连者补时限（P2-11）
 * 跑法：node server/test/split-reconnect.test.js
 *
 * 分牌计时器是**幂等**的——从「首次进入分牌阶段」起算，之后谁重连都不重置。
 * 好处是不会被「连接抖一下就重新计时」拖住；坏处是极端情况很荒唐：
 * 第 59 秒才连回来的人只剩 1 秒，一下就被判弃权，看起来像「一进来就白送分」。
 *
 * 约定：重连成功后，若剩余时间不足 MIN_RECONNECT_SPLIT_MS，就把**这个人**的
 * 计时器续到该下限。只补自己的 key，不影响别人的倒计时。
 *
 * 测试用 SPLIT_TIMEOUT_MS=1500 / MIN_RECONNECT_SPLIT_MS=1200 缩短等待。
 */
'use strict';

process.env.PROFILE_FILE = require('path').join(require('os').tmpdir(), 'lxw-sr-profiles-' + Date.now() + '.json');
process.env.SEED_FILE = require('path').join(require('os').tmpdir(), 'lxw-sr-seed-' + Date.now() + '.json');
process.env.PORT = process.env.PORT || '3208';
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
async function waitForRoom(client, cond, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const room = client.lastRoom();
    if (room && cond(room)) return room;
    await wait(25);
  }
  return client.lastRoom();
}

async function run() {
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  console.log('\n服务端就绪 127.0.0.1:' + PORT + '（分牌超时 1500ms / 重连补到 1200ms）');

  const a = new Client('甲');
  const b = new Client('乙');
  await a.signup(); await a.connect();
  await b.signup(); await b.connect();

  const created = await a.request('createRoom', { nickname: '甲' });
  const roomId = created.room.roomId;
  const joined = await b.request('joinRoom', { roomId: roomId, nickname: '乙' });
  const bSeatToken = joined.token;              // 座位令牌，重连要用
  await a.request('ready', { ready: true });
  await b.request('ready', { ready: true });

  const t0 = Date.now();
  // 全员准备即开局（「开始游戏」按钮已删），不再需要手动 start
  await wait(80);
  eq(a.lastRoom().phase, SM.PHASE.ROUND1_SPLIT, '进入第一轮分牌');

  /* ---------------------------------------------------------------- */
  console.log('\n[0] 分牌倒计时随视图下发（只给本人、只在未提交时）');
  /* 为什么要有这一组：以前 60 秒这个期限只活在服务端的 setTimeout 里，
   * 玩家界面上什么都看不到，到点直接收到「你已超时弃权」。
   * 现在把它下发成数据，前端才有东西可以显示。 */
  const roomA0 = a.lastRoom();
  const roomB0 = b.lastRoom();
  ok(typeof roomA0.splitEndsAt === 'number' && roomA0.splitEndsAt > 0,
    '进入分牌后视图里带 splitEndsAt', JSON.stringify(roomA0.splitEndsAt));
  ok(typeof roomA0.now === 'number' && Math.abs(roomA0.now - Date.now()) < 5000,
    '同时带服务端当前时间 now（客户端靠它扣掉本机时钟偏差）', JSON.stringify(roomA0.now));
  const remainA = roomA0.splitEndsAt - roomA0.now;
  ok(remainA > 0 && remainA <= 1500,
    '★ 剩余时间落在本轮超时（1500ms）以内，不是恒定给满额', 'remain=' + remainA);
  ok(Math.abs(roomA0.splitEndsAt - roomB0.splitEndsAt) <= 100,
    '两个座位各自挂在同一轮的时限上（同一轮同时进入，差值应在 100ms 内）',
    'A=' + roomA0.splitEndsAt + ' B=' + roomB0.splitEndsAt);

  /* ---------------------------------------------------------------- */
  console.log('\n[1] 乙在快超时前断线再重连 → 拿到补足的时限');
  await wait(900);                              // 距超时只剩约 600ms
  b.close();                                    // 断线（走 90 秒宽限，不会被判弃权）
  await wait(200);                              // 距超时约 400ms
  const b2 = new Client('乙');
  b2.playerId = b.playerId; b2.token = b.token;
  await b2.connect();
  await b2.request('reconnect', { roomId: roomId, token: bSeatToken });
  const reconnectAt = Date.now();
  ok(true, '乙已重连（距首次进入分牌约 ' + (reconnectAt - t0) + 'ms）');

  /* 补时限之后，下发的剩余时间必须是「补的那个量」，不是原始满额。
   * 这条守的是一个真 bug：_armOneSplitTimer 以前把 Date.now() 记成起点，
   * 而这次 timer 只有 1200ms —— 「起点 + 1500」比真实截止晚 300ms；
   * 换成生产配置（60s 满额、重连补 15s）就是**晚 45 秒**，
   * 玩家会看到「还剩 45 秒」然后当场被判弃权。 */
  const bFresh = b2.lastRoom();
  const bFreshRemain = (bFresh.splitEndsAt || 0) - (bFresh.now || 0);
  ok(bFreshRemain > 0 && bFreshRemain <= 1300,
    '★ 补时限后倒计时反映的是补的量（≤1300ms），不是原始 1500ms',
    'remain=' + bFreshRemain);

  /* 原定超时点（t0+1500）过后，乙不能被判弃权 */
  await wait(Math.max(0, (t0 + 1500 + 250) - Date.now()));
  let room = b2.lastRoom() || a.lastRoom();
  const meMid = SM.findPlayer(room, b.playerId);
  eq(!!(meMid && meMid.submitted['round1']), false, '★ 原定超时点已过，乙没有被判弃权（补时限生效）');
  eq(room.phase, SM.PHASE.ROUND1_SPLIT, '房间仍在分牌阶段，没有提前结算');

  /* 补足的时限（重连后 1200ms）到了之后，乙应该被判弃权 */
  await wait(Math.max(0, (reconnectAt + 1200 + 400) - Date.now()));
  room = a.lastRoom();
  const meAfter = SM.findPlayer(room, b.playerId);
  eq(!!(meAfter && meAfter.forfeitRound === 1), true, '★ 补足的时限用尽后，乙被正常判弃权');
  /* 两个人这一轮都没提交 → 本轮结束、进第二轮。第二轮是**新的一轮计时**，
   * 所以这里必须重新有倒计时（而不是「弃权之后就永远没有倒计时了」）。 */
  const bRoomFinal = b2.lastRoom();
  eq(bRoomFinal.round, 2, '两人都弃权 → 本轮结束并进入第二轮，不是卡在原地');
  ok(typeof bRoomFinal.splitEndsAt === 'number'
      && (bRoomFinal.splitEndsAt - bRoomFinal.now) > 1000,
    '★ 第二轮按新轮次重新给满倒计时（不是沿用上一轮的截止时刻）',
    'remain=' + (bRoomFinal.splitEndsAt - bRoomFinal.now));
  ok(Date.now() - t0 > 1500, '总耗时确实超过了原始超时（不是「本来就没超时」的假通过）');

  a.close(); b2.close();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await new Promise((r) => setTimeout(r, 80));
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
