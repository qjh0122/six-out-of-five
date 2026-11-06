/**
 * 解散投票「超时自动作废」+「发起人可取消」端到端测试
 * 跑法：node server/test/dissolve-timeout.test.js
 *
 * 背景：以前一个人点「发起解散」之后，只要其他人不表态（挂机、走开、网络半断），
 * 房间就永久停在「等待其他玩家同意」——restart 会被这条状态挡住，
 * 谁也没法开下一把，只能全员退房重开。也没有撤销入口，点错只能等。
 *
 * 这里用真实 WebSocket + 短超时（300ms）验证完整链路：
 *   发起 → 无人响应 → 超时作废（没人被扣分、房间回到对局、能重开）
 *   发起 → 发起人取消 → 作废；非发起人取消 → 被拒
 *   发起 → 有人拒绝 → rejected（与超时的提示文案要能区分）
 *   发起 → 全员同意 → 照常结算
 */
'use strict';

process.env.PROFILE_FILE = require('path').join(require('os').tmpdir(), 'lxw-dt-profiles-' + Date.now() + '.json');
process.env.SEED_FILE = require('path').join(require('os').tmpdir(), 'lxw-dt-seed-' + Date.now() + '.json');
/* ★ v128：300ms → 1200ms。
 *
 * 这个测试断言「发起解散后 80ms，投票还在进行中」—— 也就是给"发出请求 + 收广播 +
 * 读快照"这一串留了 220ms 的余量。**本机空载够用，CI 上不够**：
 * 公库的 `test` job 在 v125/v126/v127 三次「回填文档」提交上连续红，
 * 定位到就是这一条（见 BACKLOG C13）。
 *
 * 为什么是"放大窗口"而不是"改成轮询"：要验的是**状态机在超时后翻面**，
 * 不是"它恰好在 300ms 翻面"。窗口越窄，测的就越是机器速度而不是规则。
 * 1200ms 让判定留出 12 倍余量，代价是这个文件多跑约 2 秒。 */
process.env.DISSOLVE_TIMEOUT_MS = process.env.DISSOLVE_TIMEOUT_MS || '1200';
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

class Client {
  constructor(nickname) {
    this.nickname = nickname;
    this.playerId = null;
    this.token = null;
    this.seq = 0;
    this.pending = new Map();
    this.rooms = [];
    this.socket = null;
  }
  async signup() {
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

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
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
  console.log('\n服务端就绪 127.0.0.1:' + PORT + '（解散超时 ' + process.env.DISSOLVE_TIMEOUT_MS + 'ms）');

  const a = new Client('甲');
  const b = new Client('乙');
  await a.signup(); await a.connect();
  await b.signup(); await b.connect();
  ok(true, '两个客户端连接成功');

  const created = await a.request('createRoom', { playerId: a.playerId, nickname: a.nickname });
  const roomId = created.room.roomId;
  await b.request('joinRoom', { roomId: roomId, playerId: b.playerId, nickname: b.nickname });
  await a.request('ready', { ready: true });
  await b.request('ready', { ready: true });
  // 全员准备即开局（「开始游戏」按钮已删），不再需要手动 start
  await wait(80);
  let room = a.lastRoom();
  eq(room.phase, SM.PHASE.ROUND1_SPLIT, '进入第一轮分牌');

  /* ---------------------------------------------------------------- */
  console.log('\n[发起解散 → 乙不表态 → 超时自动作废]');
  await a.request('proposeDissolve');
  await wait(80);
  room = a.lastRoom();
  eq(room.dissolve.active, true, '投票已开始');
  eq(room.dissolve.initiatorId, a.playerId, '发起人是甲');

  room = await waitForRoom(a, (r) => r.dissolve && r.dissolve.active === false, 3000);
  eq(room.dissolve.active, false, '超时后投票自动关闭（不再永久卡住）');
  eq(room.dissolve.lastReason, 'expired', '结束原因记为 expired（界面提示「超时自动取消」）');
  eq(room.phase, SM.PHASE.ROUND1_SPLIT, '房间仍在第一轮分牌 —— 交易没被解散');
  eq(a.me(room).score, CONFIG.INITIAL_SCORE, '甲没被扣分');
  eq(b.me(room).score, CONFIG.INITIAL_SCORE, '乙没被扣分');
  /* 手牌必须从**乙自己的视角**看：服务端按视角裁剪，别人看到的 hand 是空的
   * （同一份快照里 a.me(room).hand 也是空的，拿错视角会得到「手牌被清了」的假结论）。 */
  const roomB = await waitForRoom(b, (r) => r.dissolve && r.dissolve.active === false, 2000);
  eq(b.me(roomB).hand.length, 6, '乙的手牌还在（没有因为超时被清）');

  console.log('\n[超时后可以正常开下一把 / 继续玩]');
  const rst = await a.request('restart').then(() => true).catch(() => false);
  ok(rst === false, '对局进行中不能重开（restart 仍被「已开局」挡住）');
  ok(room.dissolve.active === false, '但解散状态没有残留，不会挡住后续操作');

  /* ---------------------------------------------------------------- */
  console.log('\n[发起 → 发起人自己取消]');
  await a.request('proposeDissolve');
  await wait(60);
  eq(a.lastRoom().dissolve.active, true, '新一轮投票开始');
  const noPerm = await b.request('cancelDissolve').then(() => true).catch(() => false);
  eq(noPerm, false, '非发起人取消被拒');
  await a.request('cancelDissolve');
  await wait(60);
  room = a.lastRoom();
  eq(room.dissolve.active, false, '发起人取消成功');
  eq(room.dissolve.lastReason, 'cancelled', '结束原因记为 cancelled');
  eq(room.phase, SM.PHASE.ROUND1_SPLIT, '取消后仍在分牌阶段');

  /* ---------------------------------------------------------------- */
  console.log('\n[发起 → 有人拒绝 → rejected（与超时区分开）]');
  await a.request('proposeDissolve');
  await wait(60);
  await b.request('voteDissolve', { agree: false });
  await wait(60);
  room = a.lastRoom();
  eq(room.dissolve.active, false, '被否决后投票关闭');
  eq(room.dissolve.lastReason, 'rejected', '结束原因记为 rejected');
  eq(room.phase, SM.PHASE.ROUND1_SPLIT, '否决不会结束对局');

  /* ---------------------------------------------------------------- */
  console.log('\n[发起 → 全员同意 → 照常结算（原有行为不能被改坏）]');
  await a.request('proposeDissolve');
  await wait(60);
  await b.request('voteDissolve', { agree: true });
  room = await waitForRoom(a, (r) => r.phase === SM.PHASE.SETTLED, 3000);
  eq(room.phase, SM.PHASE.SETTLED, '全员同意 → 直接结算');
  eq(room.dissolve.active, false, '结算后投票状态已清');

  a.close(); b.close();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await new Promise((r) => setTimeout(r, 60));
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
