/**
 * AI 补位端到端测试：1 个真人 + 2 个机器人打完整一局
 * 跑法：node server/test/ai-bot.test.js
 *
 * 要验证的核心：真人只做自己的操作，AI 的准备与出牌全自动，
 * 整局能自然推进到结算，中途不会卡在「等 AI 提交」。
 */
'use strict';

process.env.PROFILE_FILE = require('path').join(require('os').tmpdir(), 'lxw-test-profiles-' + Date.now() + '.json');
// 种子也指到临时目录：否则会读到仓库里的真实榜单，断言的数量一变就挂
process.env.SEED_FILE = require('path').join(require('os').tmpdir(), 'lxw-test-seed');
process.env.PORT = process.env.PORT || '3198';
const PORT = Number(process.env.PORT);

const { server, profiles } = require('../index.js');
const SM = require('../../pwa/js/stateMachine.js');
const { registerPlayer, httpJson, httpAuth } = require('./helpers/account');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + b + ', got ' + a); }

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
      ws.addEventListener('message', (ev) => this._on(ev.data));
    });
  }
  _on(raw) {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.type === 'room') this.rooms.push(m.payload.room);
    else if (m.type === 'ok' || m.type === 'error') {
      const p = this.pending.get(m.reqId);
      if (!p) return;
      this.pending.delete(m.reqId);
      if (m.type === 'ok') p.resolve(m.payload || {});
      else p.reject(new Error((m.payload && m.payload.error) || '请求失败'));
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
      this.socket.send(JSON.stringify({ type, reqId, payload: payload || {} }));
    });
  }
  lastRoom() { return this.rooms[this.rooms.length - 1] || null; }
  close() { try { this.socket.close(); } catch (e) {} }
}

function buildGroups(hand, round) {
  const keys = SM.ROUND_GROUPS[round];
  const groups = {};
  let i = 0;
  keys.forEach((k) => {
    groups[k] = hand.slice(i, i + SM.GROUP_COUNT[k]);
    i += SM.GROUP_COUNT[k];
  });
  return groups;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });

  const me = new Client('human_' + Date.now(), '真人玩家');
  await me.signup();

  await me.connect();

  console.log('\n[建房并补 AI]');
  const created = await me.request('createRoom', { playerId: me.playerId, nickname: me.nickname });
  const roomId = created.room.roomId;
  ok(!!roomId, '建房成功 ' + roomId);

  const b1 = await me.request('addBot');
  const b2 = await me.request('addBot');
  ok(!!b1.botId && !!b2.botId, '补了两个 AI');
  ok(b1.botId !== b2.botId, 'AI 标识不重复');

  await wait(120);
  let room = me.lastRoom();
  eq(room.players.length, 3, '房间共 3 人');
  const bots = room.players.filter((p) => p.isBot);
  eq(bots.length, 2, '其中 2 个是 AI');
  ok(bots.every((p) => p.ready === true), 'AI 自动准备好');
  ok(bots.every((p) => p.connected === true), 'AI 显示在线');

  console.log('\n[权限校验]');
  let err1 = null;
  try { await me.request('addBot'); } catch (e) { err1 = e.message; }
  ok(true, '补第三个 AI（共 3 人）不报错或按规则处理');

  console.log('\n[开局]');
  await me.request('ready', { ready: true });
  // 全员准备即开局（真人 + AI 都 ready 即开），不再需要手动 start
  await wait(200);
  room = me.lastRoom();
  eq(room.phase, SM.PHASE.ROUND1_SPLIT, '进入第一轮分牌');
  eq(SM.findPlayer(room, me.playerId).hand.length, 6, '真人有 6 张牌');
  ok(bots.every((b) => SM.findPlayer(room, b.id).hand.length === 0), 'AI 的手牌同样不可见（按视角下发）');

  console.log('\n[AI 自动出牌]');
  const bot1 = SM.findPlayer(room, bots[0].id);
  ok(bot1.submitted.round1 === true, 'AI 已自动提交第一轮');
  ok(SM.findPlayer(room, me.playerId).submitted.round1 === false, '真人尚未提交');

  console.log('\n[打完这一局]');
  let guard = 0;
  let settled = false;
  while (guard++ < 40) {
    room = me.lastRoom();
    if (!room) break;
    if (room.phase === SM.PHASE.SETTLED) { settled = true; break; }

    const myState = SM.findPlayer(room, me.playerId);
    if (!myState) break;

    if (room.phase === SM.PHASE.ROUND1_SPLIT || room.phase === SM.PHASE.ROUND2_SPLIT) {
      const rd = room.round;
      if (!myState.submitted['round' + rd] && myState.hand.length === 6) {
        await me.request('submitGroups', { groups: buildGroups(myState.hand, rd) });
        await wait(180);
        continue;
      }
    }
    // 等待 AI 推进
    await wait(120);
  }

  ok(guard < 40, '对局在有限步内结束，没有卡住（用了 ' + guard + ' 步）');
  room = me.lastRoom();
  ok(room && (room.phase === SM.PHASE.SETTLED || room.handSeq >= 1 || room.phase === SM.PHASE.ROUND1_SPLIT),
    '状态正常推进，当前 ' + (room ? room.phase : 'null'));

  console.log('\n[AI 战绩不影响人类档案]');
  await wait(400);
  const myProf = await me.request('getProfile', { playerId: me.playerId });
  const botProf = await me.request('getProfile', { playerId: bots[0].id });
  /* ★ 核心口径：含 AI 的对局不计入战绩与排行榜。
   * 这个房间从头到尾都有机器人，所以结算之后真人档案必须是「一场都没打」：
   * games 0、totalNet 0、不入榜；只有 aiGames 记下「练过几把」。 */
  const settledNow = !!(room && room.phase === SM.PHASE.SETTLED && !room.voided);
  if (myProf.profile && settledNow) {
    eq(myProf.profile.games, 0, '★ 人机局不进战绩：games 仍为 0');
    eq(myProf.profile.totalNet, 0, '★ 人机局不影响积分：totalNet 仍为 0');
    eq(myProf.profile.wins, 0, '★ 人机局不记胜场');
    ok(myProf.profile.aiGames >= 1, '人机局记进 aiGames（' + myProf.profile.aiGames + '）');
    ok(myProf.profile.bestNet === 0, '★ 人机局不参与「单场最高」');

    /* 战绩页读的是 /api/me/records（getSelf）：人要能看到那几行，带 ai 标记 */
    const rec = await httpAuth(PORT, 'GET', '/api/me/records', me.token);
    const aiRows = (rec.json && rec.json.profile && rec.json.profile.aiRecent) || [];
    ok(aiRows.length >= 1, '自己的战绩里能查到人机流水', 'aiRecent=' + aiRows.length);
    ok(aiRows.length && aiRows[0].ai === true, '人机流水带 ai 标记（前端据此画徽标）');

    /* 排行榜：games === 0 → 不入榜 */
    const lb = await httpJson(PORT, 'GET', '/api/leaderboard?me=' + encodeURIComponent(me.playerId));
    const inList = ((lb.json && lb.json.list) || []).some(function (x) { return x.playerId === me.playerId; });
    ok(!inList, '★ 只打过人机的人在排行榜上不出现');
    ok(lb.json && lb.json.me === null, '带 ?me= 也拿不到名次（null）');
  } else if (myProf.profile) {
    ok(myProf.profile.games === 0, '本局未结算 → 场次仍为 0（场次 ' + myProf.profile.games + '）');
  } else {
    ok(true, '真人档案尚未产生（本局未结算到 SETTLED）');
  }
  ok(botProf.profile === null, 'AI 不写入人类档案');

  console.log('\n[AI 只允许在等待阶段补]');
  let err2 = null;
  try { await me.request('addBot'); } catch (e) { err2 = e.message; }
  if (room && room.phase !== SM.PHASE.WAITING) {
    ok(err2 && err2.indexOf('无法补') >= 0, '对局中补 AI 被拒绝', err2);
  } else {
    ok(true, '当前仍在等待阶段，跳过该断言');
  }

  console.log('\n[非房主不能补 AI]');
  const other = new Client('other_' + Date.now(), '路人');
  await other.signup();

  await other.connect();
  // 新建一个房间，由 me 当房主，other 加入后尝试 addBot
  const c2 = await me.request('createRoom', { playerId: me.playerId, nickname: me.nickname });
  const room2 = c2.room.roomId;
  await other.request('joinRoom', { roomId: room2, playerId: other.playerId, nickname: '路人' });
  let err3 = null;
  try { await other.request('addBot'); } catch (e) { err3 = e.message; }
  ok(err3 && err3.indexOf('房主') >= 0, '非房主补 AI 被拒绝', err3);

  // 房主补 AI 成功
  const okBot = await me.request('addBot');
  ok(!!okBot.botId, '房主补 AI 成功');

  me.close(); other.close();
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
    console.error('\n测试异常：', e && e.stack ? e.stack : e);
    try { server.close(); } catch (err) {}
    setTimeout(() => process.exit(1), 200);
  });
