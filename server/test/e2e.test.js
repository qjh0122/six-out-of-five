/**
 * 服务端端到端测试：两个真实 WebSocket 客户端打完一局
 * 跑法：node server/test/e2e.test.js
 *
 * 覆盖：建房 → 加入 → 准备 → 开局 → 两轮提交 → 结算/换把 → 解散投票 → 档案落库
 */
'use strict';

process.env.PROFILE_FILE = require('path').join(require('os').tmpdir(), 'lxw-test-profiles-' + Date.now() + '.json');
// 种子也指到临时目录：否则会读到仓库里的真实榜单，断言的数量一变就挂
process.env.SEED_FILE = require('path').join(require('os').tmpdir(), 'lxw-test-seed');
process.env.PORT = process.env.PORT || '3199';
const PORT = Number(process.env.PORT);

const { server, profiles } = require('../index.js');
const SM = require('../../pwa/js/stateMachine.js');
const CONFIG = require('../../pwa/js/config.js');
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
    this.roomDeleted = [];
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
      ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('连接失败')); });
      ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    });
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.type === 'room') {
      this.rooms.push(msg.payload.room);
    } else if (msg.type === 'roomDeleted') {
      this.roomDeleted.push(msg.payload.roomId);
    } else if (msg.type === 'ok' || msg.type === 'error') {
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

/* 从手牌构造合法分组：按 ROUND_GROUPS 顺序切片 */
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

  const a = new Client('pa_' + Date.now(), '甲玩家');
  const b = new Client('pb_' + Date.now(), '乙玩家');

  console.log('\n[连接]');
  await a.signup();

  await a.connect();
  await b.signup();

  await b.connect();
  ok(true, '两个客户端连接成功');

  console.log('\n[建房与加入]');
  const created = await a.request('createRoom', { playerId: a.playerId, nickname: a.nickname });
  ok(!!created.room, '创建房间返回 room');
  const roomId = created.room.roomId;
  eq(roomId.length, 6, '房间号 6 位');
  ok(/^\d{6}$/.test(roomId), '房间号纯数字');

  const joined = await b.request('joinRoom', { roomId: roomId, playerId: b.playerId, nickname: b.nickname });
  const bToken = joined.token;  // 座位令牌，重连时要带
  eq(joined.room.players.length, 2, '房间里 2 人');

  /* 错误路径：加入不存在的房间 */
  let errMsg = null;
  try { await b.request('joinRoom', { roomId: '000000', playerId: b.playerId, nickname: 'x' }); }
  catch (e) { errMsg = e.message; }
  ok(errMsg && errMsg.indexOf('房间不存在') >= 0, '加入不存在的房间被拒绝', errMsg);

  console.log('\n[准备与开局]');
  /* 非房主开局必须被拒。
   * ★ 这段必须在两人准备之前跑：全员准备即开局（「开始游戏」按钮已删），
   * 准备完之后房间已经在分牌，再调 start 只会得到「需至少 2 人且全部准备」，
   * 测到的就不是房主权限了。 */
  let startErr = null;
  try { await b.request('start'); } catch (e) { startErr = e.message; }
  ok(startErr && startErr.indexOf('房主') >= 0, '非房主开局被拒绝', startErr);

  await a.request('ready', { ready: true });
  await b.request('ready', { ready: true });
  await wait(80);   // 两人都准备好 → 服务端自动开局
  let room = a.lastRoom();
  eq(room.phase, SM.PHASE.ROUND1_SPLIT, '进入第一轮分牌（全员准备自动开局，无需房主点按钮）');
  eq(room.round, 1, '轮次为 1');
  ok(a.me(room) && a.me(room).hand.length === 6, '自己的 6 张牌');
  /* 这里原本断言「对手也 6 张」——那正是手牌泄漏：a 的推送里带着 b 的牌。
   * 现在服务端按视角下发，别家手牌一律清空，改为反面断言。 */
  ok(b.me(room) && b.me(room).hand.length === 0, '看不到对手的手牌（按视角下发）');

  console.log('\n[第一轮提交：1/2/3]');
  // 先只提交一方，确认不会提前结算
  await a.request('submitGroups', { groups: buildGroups(a.me(room).hand, 1) });
  await wait(80);
  room = a.lastRoom();
  eq(room.phase, SM.PHASE.ROUND1_SPLIT, '只交一方时仍停在分牌阶段');
  ok(a.me(room).submitted.round1 === true, '甲的提交状态被记录');
  ok(b.me(room).submitted.round1 === false, '乙尚未提交');

  // 错误路径：缺张必须被拒
  let groupErr = null;
  try { await b.request('submitGroups', { groups: { single: [], tenhalf: [], piaosanye: [] } }); }
  catch (e) { groupErr = e.message; }
  ok(!!groupErr, '缺张的分组被拒绝', groupErr);

  // 乙的牌只能在乙自己的推送里拿到（a.lastRoom() 里别家手牌已清空）
  await b.request('submitGroups', { groups: buildGroups(b.me(b.lastRoom()).hand, 1) });
  await wait(120);
  room = a.lastRoom();
  ok(room.phase === SM.PHASE.ROUND2_SPLIT || room.phase === SM.PHASE.SETTLED,
    '双方提交后推进到第二轮或直接结算', room.phase);
  ok(room.results.round1 !== null, '第一轮结果已产出');

  /* v83 上线门槛：**分数对账**。
   * 原型侧的 e2e-score 证明「画出来的分 == 引擎算的分」，
   * 这里证明的是另一件事：「写到 player.score 上的分 == 引擎算的分」。
   * 两者不能互相替代 —— 中间隔着「应用 deltas」这一段，而这一段是这次改动碰过的地方
   * （逐组应用 + 见底即停）。 */
  console.log('\n[v83 分数对账]');
  {
    const sum1 = {};
    (room.results.round1 || []).forEach((g) => {
      let t = 0;
      for (const pid in g.deltas) {
        t += g.deltas[pid];
        sum1[pid] = (sum1[pid] || 0) + g.deltas[pid];
      }
      eq(t, 0, g.label + ' 组内零和');
    });

    /* 只在「第一轮刚结算、第二轮还没结算」时比总分：
     * 如果已经进了下一把（ROUND1_SPLIT），分数里已经含了第二轮，
     * 拿它跟第一轮的 deltas 比必然对不上 —— 那不是 bug。 */
    if (room.phase !== SM.PHASE.ROUND1_SPLIT) {
      room.players.forEach((p) => {
        eq(p.score - CONFIG.INITIAL_SCORE, sum1[p.id] || 0, (p.nickname || p.id) + ' 净得 == Σ本轮 deltas');
      });
    } else {
      ok(true, '已进下一把，跳过按轮对账（分数含两轮）');
    }

    ok(typeof room.groupsDone === 'number', 'groupsDone 随房间下发');
    ok(Array.isArray(room.bustedIds), 'bustedIds 随房间下发');
    ok(room.players.every((p) => typeof p.out === 'boolean'), '每人都有 out 标记（布尔，不是 undefined）');
    ok(room.players.every((p) => !(p.out && p.score > 0)), '★ 出局的人分数必须 ≤ 0（不会误标）');
  }

  console.log('\n[第二轮提交：1/5]');
  if (room.phase === SM.PHASE.ROUND2_SPLIT) {
    await a.request('submitGroups', { groups: buildGroups(a.me(room).hand, 2) });
    await b.request('submitGroups', { groups: buildGroups(b.me(b.lastRoom()).hand, 2) });
    await wait(150);
    room = a.lastRoom();
    ok(room.results.round2 !== null, '第二轮结果已产出');
    ok(room.phase === SM.PHASE.SETTLED || room.phase === SM.PHASE.ROUND1_SPLIT,
      '进入结算或自动开下一把', room.phase);
  } else {
    ok(true, '第一轮即爆分，直接结算（跳过第二轮）');
  }

  console.log('\n[结算与档案]');
  /* 用结束本局投票把当前对局收口到 SETTLED，验证结算与「作废不落库」 */
  let endedByDissolve = false;
  if (room.phase !== SM.PHASE.SETTLED) {
    endedByDissolve = true;
    await a.request('proposeDissolve');
    await wait(60);
    await a.request('voteDissolve', { agree: true });
    await wait(60);
    await b.request('voteDissolve', { agree: true });
    await wait(150);
    room = a.lastRoom();
  } else {
    ok(true, '已自然结算');
  }
  eq(room.phase, SM.PHASE.SETTLED, '最终进入结算');
  ok(!!room.settledAt, 'settledAt 已下发（前端战绩幂等依赖）');
  ok(room.handSeq >= 1, 'handSeq 已下发，值 = ' + room.handSeq);

  await wait(200);
  const prof = await a.request('getProfile', { playerId: a.playerId });
  ok(!!prof.profile, '玩家档案可查');
  if (prof.profile) {
    ok(typeof prof.profile.totalNet === 'number', '档案有累计净胜');
    /* 口径必须跟着「这一局到底打没打过」走：
     *   一分没打就结束 → 不记（记一场 0 分平局只会污染场次、断连胜）
     *   已经打过分     → 照记（那是真赢真输，作废等于抹掉战绩）
     * 两条分支都断言，免得下次改判据时只测到一半。 */
    if (endedByDissolve) {
      eq(room.endReason, 'dissolve', '中途结束本局带上了 endReason');
      if (room.voided) {
        eq(prof.profile.games, 0, '一分没打就结束 → 不进档案');
        ok(!prof.profile.recent || prof.profile.recent.length === 0,
          '一分没打就结束 → 没有留下 0 分流水', JSON.stringify(prof.profile.recent));
      } else {
        eq(prof.profile.games, 1, '★ 打过分再结束 → 照记一场（真赢真输不能抹）');
        ok(Array.isArray(prof.profile.recent) && prof.profile.recent.length === 1,
          '★ 流水里有这一局（净胜 = 结算时的分数）', JSON.stringify(prof.profile.recent));
      }
    } else {
      eq(prof.profile.games, 1, '正常结算 → 档案场次 = 1');
      ok(Array.isArray(prof.profile.recent) && prof.profile.recent.length === 1, '档案最近对局 1 条');
    }
  }

  console.log('\n[重开下一把]');
  if (room.endReason !== 'someoneLeft') {
    /* 报名制：两个人都要点「开始下一局」。C-2（v116）之后报名即就位，
     * 所以第二个人点完，人数就齐了，服务端在这一次广播里直接开局 ——
     * 不需要再各点一次准备。只点一方的话另一方还留在结算页，房间停在结算态。 */
    await a.request('wantNext');
    await b.request('wantNext');
    await wait(120);
    room = a.lastRoom();
    eq(room.phase, SM.PHASE.ROUND1_SPLIT, '重开后回到第一轮（两人都报名 + 准备）');
    eq(room.handSeq, 1, 'handSeq 不因重开重置');
    eq(a.me(room).score, CONFIG.INITIAL_SCORE, '分数重置为初始分');
  }

  console.log('\n[断线宽限]');
  b.close();
  await wait(300);
  room = a.lastRoom();
  const bp = room ? SM.findPlayer(room, b.playerId) : null;
  ok(bp && bp.connected === false, '对手断线后标记为离线');
  ok(bp && bp.left === false, '宽限内没有直接判弃');

  /* 宽限内重连 */
  // 同一账号再开一个连接（模拟多标签页 / 刷新后重连）：复用令牌，不再注册新账号
  const b2 = new Client(b.playerId, b.nickname, b.token);
  await b2.signup();

  await b2.connect();
  // 座位令牌：服务端入房时下发给本人，重连必须带上
  const rc = await b2.request('reconnect', { roomId: roomId, playerId: b.playerId, token: bToken });
  ok(!!rc.room, '宽限内重连成功拿回房间');
  await wait(120);
  room = a.lastRoom();
  const bp2 = room ? SM.findPlayer(room, b.playerId) : null;
  ok(bp2 && bp2.connected === true, '重连后恢复在线');

  console.log('\n[离开与回收]');
  await b2.request('leaveRoom');
  await wait(100);
  await a.request('leaveRoom');
  await wait(200);

  console.log('\n[健康检查]');
  const res = await fetch('http://127.0.0.1:' + PORT + '/api/health');
  const health = await res.json();
  ok(health.ok === true, '健康检查可用');
  eq(health.rooms, 0, '房间已全部回收');

  a.close(); b2.close();
  await wait(100);
}

run()
  .then(() => {
    console.log('\n========================================');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    console.log('========================================');
    try { profiles.flush(); } catch (e) {}
    server.close();
    setTimeout(() => process.exit(fail === 0 ? 0 : 1), 200);
  })
  .catch((e) => {
    console.error('\n测试异常中断：', e && e.stack ? e.stack : e);
    try { server.close(); } catch (err) {}
    setTimeout(() => process.exit(1), 200);
  });
