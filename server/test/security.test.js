/**
 * 防作弊 / 信息隔离测试
 * 跑法：node server/test/security.test.js
 *
 * 背景：状态机里的 room 是单份共享对象，所有玩家的手牌都挂在 players[i].hand。
 * 早期实现把这个对象整份广播给所有人，界面虽然只画牌背，但数据就在客户端内存里，
 * 打开控制台就能看到别家拿的什么牌——游戏彻底失去公平性。
 *
 * 这里锁死三件事：
 *   1. 别人看不到我的手牌和分组（广播 + 各请求回包都要过 _view）
 *   2. 我自己必须完整看到自己的手牌（否则没法玩）
 *   3. 结算揭晓不能被打断（lastResult 里的牌是打完的，可以公开）
 */
'use strict';

const path = require('path');
const os = require('os');

process.env.PROFILE_FILE = path.join(os.tmpdir(), 'lxw-sec-profiles-' + Date.now() + '.json');
// 种子也指到临时目录：否则会读到仓库里的真实榜单，断言的数量一变就挂
process.env.SEED_FILE = path.join(os.tmpdir(), 'lxw-sec-seed-' + Date.now() + '.json');
process.env.BACKUP_KEY = 'sec-test-key-0123456789';
process.env.PORT = process.env.PORT || '3198';
const PORT = Number(process.env.PORT);

const { server, hub } = require('../index.js');
const SM = require('../../pwa/js/stateMachine.js');
const { registerPlayer } = require('./helpers/account');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + b + ', got ' + a); }

/* ---------------------------- 测试用 WS 客户端 ---------------------------- */

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
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.type === 'room') {
      this.rooms.push(msg.payload.room);
    } else if (msg.type === 'ok' || msg.type === 'error') {
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
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(type + ' 超时'));
      }, 5000);
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
  keys.forEach((k) => {
    const need = SM.GROUP_COUNT[k];
    groups[k] = hand.slice(i, i + need);
    i += need;
  });
  return groups;
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ============================ 开始 ============================ */

async function run() {
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  console.log('\n服务端已就绪 127.0.0.1:' + PORT);

  /* -------------------- 一、_view 单元层 -------------------- */
  console.log('\n[_view] 视角过滤');

  const now = Date.now();
  const fake = SM.newRoom('999999', { id: 'u_a', nickname: '甲' });
  fake.players[0].hand = [
    { suit: 'spade', rank: 3 }, { suit: 'heart', rank: 4 }
  ];
  fake.players[0].groups = { round1: { single: [{ suit: 'spade', rank: 3 }] } };
  fake.players[0].submitted = { round1: true, round2: false };
  SM.joinRoom(fake, { id: 'u_b', nickname: '乙' });
  fake.players[1].hand = [{ suit: 'club', rank: 9 }, { suit: 'diamond', rank: 10 }];
  fake.players[1].groups = { round1: { single: [{ suit: 'club', rank: 9 }] } };
  fake.players[1].submitted = { round1: true, round2: false };

  const vA = hub._view(fake, 'u_a');
  const vB = hub._view(fake, 'u_b');
  const vNone = hub._view(fake, null);
  const vStranger = hub._view(fake, 'not_in_room');

  eq(SM.findPlayer(vA, 'u_a').hand.length, 2, '甲视角：自己的手牌完整');
  eq(SM.findPlayer(vA, 'u_b').hand.length, 0, '甲视角：乙的手牌被清空');
  eq(Object.keys(SM.findPlayer(vA, 'u_b').groups).length, 0, '甲视角：乙的分组被清空（未提交前泄露等于送答案）');
  eq(SM.findPlayer(vA, 'u_b').submitted.round1, true, '甲视角：仍能看到乙是否已提交（界面要用）');

  eq(SM.findPlayer(vB, 'u_b').hand.length, 2, '乙视角：自己的手牌完整');
  eq(SM.findPlayer(vB, 'u_a').hand.length, 0, '乙视角：甲的手牌被清空');

  ok(vNone.players.every((p) => p.hand.length === 0), '无身份视角：所有人手牌都空');
  ok(vStranger.players.every((p) => p.hand.length === 0), '冒充视角：不在房间里的 id 一律拿不到牌');

  eq(fake.players[0].hand.length, 2, '_view 不修改原始 room（否则会把真实手牌洗掉）');
  eq(fake.players[1].hand.length, 2, '_view 不修改原始 room（乙）');
  eq(vA.roomId, fake.roomId, '视角副本保留房间基本字段');
  eq(vA.phase, fake.phase, '视角副本保留阶段字段');
  ok(vA.players.length === fake.players.length, '视角副本保留全部座位（不能少人）');

  /* -------------------- 二、真实广播 -------------------- */
  console.log('\n[广播] 两个真人开局后的推送');

  const a = new Client('sec_a_' + now, '甲玩家');
  const b = new Client('sec_b_' + now, '乙玩家');
  await a.signup();

  await a.connect();
  await b.signup();

  await b.connect();

  const created = await a.request('createRoom', { playerId: a.playerId, nickname: a.nickname });
  const roomId = created.room.roomId;
  const aToken = created.token;
  ok(!!aToken && aToken.length >= 16, '建房间时服务端下发座位令牌');

  const bJoin = await b.request('joinRoom', { roomId: roomId, playerId: b.playerId, nickname: b.nickname });
  const bToken = bJoin.token;
  ok(!!bToken && bToken.length >= 16, '入房时服务端下发座位令牌');
  ok(aToken !== bToken, '两个玩家的令牌不同（不是房间共用密钥）');

  await a.request('ready', { ready: true });
  await b.request('ready', { ready: true });
  // 全员准备即开局（「开始游戏」按钮已删），不再需要手动 start
  await wait(120);

  const aSees = a.lastRoom();
  const bSees = b.lastRoom();
  ok(!!aSees && !!bSees, '双方都收到最新房间推送');

  eq(aSees.players.length, 2, '甲看到的座位数是 2');
  const aMe = a.me(aSees);
  const aOther = aSees.players.filter((p) => p.id !== a.playerId)[0];
  eq(aMe.hand.length, 6, '甲在自己这边能看到 6 张手牌');
  eq(aOther.hand.length, 0, '甲看不到乙的手牌（核心修复）');
  eq(Object.keys(aOther.groups || {}).length, 0, '甲看不到乙的分组');

  const bMe = b.me(bSees);
  const bOther = bSees.players.filter((p) => p.id !== b.playerId)[0];
  eq(bMe.hand.length, 6, '乙在自己这边能看到 6 张手牌');
  eq(bOther.hand.length, 0, '乙看不到甲的手牌（核心修复）');

  /* 请求回包同样要过滤：reconnect / start 这些回包里的 room 也是整份下发的 */
  const aBack = await a.request('reconnect', { roomId: roomId, playerId: a.playerId, token: aToken });
  eq(SM.findPlayer(aBack.room, a.playerId).hand.length, 6, 'reconnect 回包：自己的手牌完整');
  eq(SM.findPlayer(aBack.room, b.playerId).hand.length, 0, 'reconnect 回包：别人的手牌为空');
  const joined = await b.request('reconnect', { roomId: roomId, playerId: b.playerId, token: bToken });
  eq(SM.findPlayer(joined.room, b.playerId).hand.length, 6, 'reconnect 回包：乙自己的手牌完整');
  eq(SM.findPlayer(joined.room, a.playerId).hand.length, 0, 'reconnect 回包：乙看不到甲的手牌');

  /* -------------------- 二之二：座位冒领 -------------------- */
  console.log('\n[冒领] 拿到 roomId + playerId 也抢不走座位');

  /* 攻击者 Eve 连上来，已经能从广播里读到房间号和所有人 id */
  const eve = new Client('sec_eve_' + now, '冒名者');
  await eve.signup();

  await eve.connect();
  ok(!!aSees.players.find((p) => p.id === b.playerId), '前提：广播里确实能看到乙的 playerId（这正是要防的）');

  let r1 = null;
  try { await eve.request('reconnect', { roomId: roomId, playerId: b.playerId }); }
  catch (e) { r1 = e.message; }
  ok(!!r1 && r1.indexOf('身份校验') >= 0, '不带令牌的 reconnect 被拒', r1 || '(竟然成功了)');

  let r2 = null;
  try { await eve.request('reconnect', { roomId: roomId, playerId: b.playerId, token: aToken }); }
  catch (e) { r2 = e.message; }
  ok(!!r2 && r2.indexOf('身份校验') >= 0, '拿别人（甲）的令牌也进不去', r2 || '(竟然成功了)');

  let r3 = null;
  try { await eve.request('reconnect', { roomId: roomId, playerId: b.playerId, token: 'x'.repeat(bToken.length) }); }
  catch (e) { r3 = e.message; }
  ok(!!r3 && r3.indexOf('身份校验') >= 0, '伪造等长令牌被拒（长度对得上也不算数）', r3 || '(竟然成功了)');

  let r4 = null, r4err = null;
  try { r4 = await eve.request('joinRoom', { roomId: roomId, playerId: b.playerId, nickname: '冒名者' }); }
  catch (e) { r4err = e.message; }
  /* ★ v122 起「对局中一律拒绝」没了：晚到的人可以进房旁听。
   * 所以这条断言要守的**不是「进不来」**，而是「抢不走座位」：
   *   · 服务端只用令牌身份（this._pid(client)），payload 里写别人的 playerId 完全无效；
   *   · 因此 Eve 进来拿的是她自己的座位，而且只能是旁听（benched）；
   *   · 乙的座位一个字段都没变。
   * 若哪天又收紧成拒绝，也算通过 —— 两种结果都不构成冒领。 */
  if (r4err) {
    ok(r4err.indexOf('身份校验') >= 0 || r4err.indexOf('正在打') >= 0,
      'joinRoom 被挡（没有冒领成功）', r4err);
  } else {
    const eveSeat = SM.findPlayer(r4.room, eve.playerId);
    const bSeat = SM.findPlayer(r4.room, b.playerId);
    ok(!!eveSeat && eveSeat.benched === true,
      '★ joinRoom 不能冒领：进来的只能是自己的座位，且是旁听');
    ok(!!bSeat && bSeat.nickname === '乙玩家', '★ 乙的座位没被接管（payload 里的 playerId 被无视）');
  }

  /* 最关键的一条：请求体里写别人的 playerId 完全无效。
   * 以前 createRoom 直接采信 payload.playerId，等于谁都能以别人的名字开房、把战绩记到别人头上。 */
  const spoof = await eve.request('createRoom', { playerId: b.playerId, nickname: '冒名者' });
  const spoofMe = SM.findPlayer(spoof.room, b.playerId);
  ok(!spoofMe, '用房主身份冒充开房：乙没有出现在这个房间里');
  ok(!!SM.findPlayer(spoof.room, eve.playerId), '房间里的玩家是 Eve 自己的账号，不是乙');

  /* 冒领失败后，乙的座位必须完好 */
  await wait(60);
  const aCheck = a.lastRoom();
  const bStill = SM.findPlayer(aCheck, b.playerId);
  ok(!!bStill && bStill.nickname === '乙玩家', '乙的昵称没有被改写');
  ok(bStill.connected !== false, '乙的在线状态没有被冒领者搞乱');
  eve.close();

  /* -------------------- 三、手牌不空的前提下能真的打完 -------------------- */
  console.log('\n[结算] 过滤后仍能正常打完，且揭晓不被打断');

  const aHand = aMe.hand.slice();
  const bHand = b.me(bSees).hand.slice();
  await a.request('submitGroups', { round: 1, groups: buildGroups(aHand, 1) });
  await b.request('submitGroups', { round: 1, groups: buildGroups(bHand, 1) });
  await wait(150);

  const aAfter = a.lastRoom();
  ok(!!aAfter.lastResult, '第一轮结算已推送');
  const grp = aAfter.lastResult.groups[0];
  ok(Array.isArray(grp.entries) && grp.entries.length === 2, '结算明细包含两位玩家');
  ok(grp.entries.every((en) => Array.isArray(en.hand) && en.hand.length > 0),
    '结算揭晓：双方的牌都能看到（这一份是打完的牌，必须公开）');

  /* 结算后仍然不能从 players[] 里读到别人的手牌——揭晓只走 lastResult */
  eq(SM.findPlayer(aAfter, b.playerId).hand.length, 0, '结算后 players[] 仍不下发别家手牌');

  a.close();
  b.close();
  eve.close();
  await wait(80);

  /* -------------------- 四、备份导出接口鉴权 -------------------- */
  console.log('\n[/api/leaderboard] 榜单公开、全量导出要密钥');

  const base = 'http://127.0.0.1:' + PORT;
  const KEY = process.env.BACKUP_KEY;

  const pub = await fetch(base + '/api/leaderboard?sharecode=TESTCODE');
  const pubBody = await pub.json();
  eq(pub.status, 200, '公开榜单不需要密钥');
  ok(Array.isArray(pubBody.list), '公开榜单返回 list');
  ok(pubBody.list.every((p) => p.recent === undefined), '公开榜单不含近 20 场流水');

  const noKey = await fetch(base + '/api/leaderboard?full=1&sharecode=TESTCODE');
  const noKeyBody = await noKey.json();
  eq(noKey.status, 403, 'full=1 不带密钥被拒');
  ok(/无权|未启用/.test(noKeyBody.error || ''), '拒绝时给出可读原因', noKeyBody.error);

  const badKey = await fetch(base + '/api/leaderboard?full=1&sharecode=TESTCODE', {
    headers: { 'x-backup-key': 'x'.repeat(KEY.length) }
  });
  eq(badKey.status, 403, 'full=1 等长伪造密钥被拒');

  const goodKey = await fetch(base + '/api/leaderboard?full=1&sharecode=TESTCODE', {
    headers: { 'x-backup-key': KEY }
  });
  const goodBody = await goodKey.json();
  eq(goodKey.status, 200, 'full=1 带正确密钥可导出');
  ok(Array.isArray(goodBody.list), '导出结果含 list');

  /* 密钥不能出现在任何静态资源里：静态根是 pwa/，server/ 下的文件不该被取到 */
  const leak = await fetch(base + '/backup-key.txt?sharecode=TESTCODE');
  ok(leak.status === 404, '根路径下取不到 backup-key.txt', 'HTTP ' + leak.status);
  const leak2 = await fetch(base + '/../server/backup-key.txt?sharecode=TESTCODE');
  ok(leak2.status === 404 || leak2.status === 403, '路径穿越也取不到密钥', 'HTTP ' + leak2.status);

  /* -------------------- 结果 -------------------- */
  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  if (fail > 0) process.exitCode = 1;
  setTimeout(() => process.exit(fail > 0 ? 1 : 0), 100);
}

run().catch((e) => {
  console.error('测试异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
