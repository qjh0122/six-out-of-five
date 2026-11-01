/**
 * 弃局结算口径 + 停用即踢线
 * 跑法：node server/test/abandon.test.js
 *
 * 这里锁的是两条「以前能刷榜」的口径：
 *   1. 中途离开的人**不再免掉本场战绩**。旧实现 `if (p.left) return;` 意味着
 *      「输定了就点离开房间」= 本场不记，排行榜净胜、最长连胜都能这么刷。
 *      现在按离开时的分数照记。
 *   2. 被管理员停用/删除的账号，**当场**从桌上的连接里踢掉，而不是等他下次登录。
 *      以前 auth 只在握手时查一次 disabled，人只要不刷新就能一直玩、一直被记战绩。
 */
'use strict';

process.env.PROFILE_FILE = require('path').join(require('os').tmpdir(), 'lxw-ab-profiles-' + Date.now() + '.json');
process.env.SEED_FILE = require('path').join(require('os').tmpdir(), 'lxw-ab-seed-' + Date.now());
process.env.BACKUP_KEY = 'abandon-test-key-0123456789';
process.env.PORT = process.env.PORT || '3197';
const PORT = Number(process.env.PORT);
const KEY = process.env.BACKUP_KEY;

const { server, profiles, hub } = require('../index.js');
const SM = require('../../pwa/js/stateMachine.js');
const CONFIG = require('../../pwa/js/config.js');
const { registerPlayer, httpJson } = require('./helpers/account');

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
    this.errors = [];
    this.socket = null;
    this.closed = false;
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
      ws.addEventListener('close', () => { this.closed = true; });
      ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    });
  }
  _onMessage(raw) {
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.type === 'room') this.rooms.push(msg.payload.room);
    else if (msg.type === 'error') this.errors.push((msg.payload && msg.payload.error) || '');
    if (msg.type === 'ok' || msg.type === 'error') {
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
async function waitForRoom(client, cond, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const room = client.lastRoom();
    if (room && cond(room)) return room;
    await wait(25);
  }
  return client.lastRoom();
}
async function admin(path, body) {
  return httpJson(PORT, 'POST', path, body, { 'x-backup-key': KEY });
}

async function run() {
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  console.log('\n服务端就绪 127.0.0.1:' + PORT);

  /* ==================== 一、弃局不再免掉战绩 ==================== */
  console.log('\n[弃局按离开时的分数落库]');
  const a = new Client('甲');
  const b = new Client('乙');
  const c = new Client('丙');
  await a.signup(); await a.connect();
  await b.signup(); await b.connect();
  await c.signup(); await c.connect();

  const created = await a.request('createRoom', { nickname: '甲' });
  const roomId = created.room.roomId;
  await b.request('joinRoom', { roomId: roomId, nickname: '乙' });
  await c.request('joinRoom', { roomId: roomId, nickname: '丙' });
  await a.request('ready', { ready: true });
  await b.request('ready', { ready: true });
  await c.request('ready', { ready: true });
  // 全员准备即开局（「开始游戏」按钮已删），不再需要手动 start
  await wait(80);

  let room = a.lastRoom();
  eq(room.phase, SM.PHASE.ROUND1_SPLIT, '开局进入第一轮分牌');

  // 三人都提交 → 第一轮结算，分数出现分化
  // 注意：手牌只能从**自己的视角**取。甲的房间里乙丙的手牌是空的（服务端按视角过滤），
  // 拿甲的快照去给乙分牌会直接报「每组必须填满指定张数」。
  await a.request('submitGroups', { groups: buildGroups(a.me(a.lastRoom()).hand, 1) });
  await b.request('submitGroups', { groups: buildGroups(b.me(b.lastRoom()).hand, 1) });
  await c.request('submitGroups', { groups: buildGroups(c.me(c.lastRoom()).hand, 1) });
  room = await waitForRoom(a, (r) => r.results.round1 !== null, 2000);
  ok(room.results.round1 !== null, '第一轮已结算');

  /* 落库点是**整局结束(SETTLED)**，不是单轮结算 —— 一轮打完分数还会变，
   * 一轮一条记录会让「一场」的定义错乱。所以这里第一轮刚结束时还没有战绩。 */
  const beforeLeave = profiles.get(b.playerId);
  ok(!beforeLeave || beforeLeave.games === 0, '第一轮结算后还没落库（要等整局结束）');

  const frozenScore = b.me(room).score;
  console.log('  乙第一轮后分数 = ' + frozenScore);

  // 第二轮开始，乙退出房间（弃局）
  await b.request('leaveRoom');
  await wait(80);
  room = a.lastRoom();
  ok(b.me(room).left === true, '乙已标记为弃局');
  ok(a.lastRoom().phase !== SM.PHASE.SETTLED, '三人局走掉一个后对局继续（还没结束）');
  /* 净胜口径必须跟服务端落库那段一致（hub 里是 score − CONFIG.INITIAL_SCORE）。 */
  const frozenNet = frozenScore - CONFIG.INITIAL_SCORE;

  /* 甲也离开 → 剩丙一人，人数不足 → 整局结束 → 触发落库。
   * 这一步同时验证「多个弃局者都会被记」，而不是只记最后走的那个人。 */
  await a.request('leaveRoom');
  room = await waitForRoom(c, (r) => r.phase === SM.PHASE.SETTLED, 3000);
  eq(room.phase, SM.PHASE.SETTLED, '人数不足，整局结束');
  await wait(120); // 等一次落盘刷新（走的是同一进程内存，读到即最新）

  const after2 = profiles.get(b.playerId);
  ok(after2 && after2.games === 1, '弃局的乙**仍然被记了一场**（旧实现是 games=0）',
    '乙 games=' + (after2 && after2.games));
  const last = after2 && after2.recent[0];
  ok(last && last.net === frozenNet,
    '记的是「离开时的分数」而不是全胜或 0 分', 'net=' + (last && last.net) + ' 期望 ' + frozenNet);

  const pa = profiles.get(a.playerId);
  eq(pa && pa.games, 1, '后走的甲也被记了一场（不是只记最后一个人）');
  const pc = profiles.get(c.playerId);
  eq(pc && pc.games, 1, '留到最后的丙正常记录');

  const sumNet = ((after2 && after2.totalNet) || 0) + ((pa && pa.totalNet) || 0) + ((pc && pc.totalNet) || 0);
  eq(sumNet, 0, '三人净胜加起来为 0（零和校验：没人凭离开刷到分）');

  /* ==================== 二、AI 不进人类档案 ==================== */
  console.log('\n[AI 不落库]');
  ok(profiles.get('bot_1') === null, '机器人没有云端档案');

  /* ==================== 三、已删账号不会被结算复活 ==================== */
  console.log('\n[删号后不会再被结算写回]');
  const ghost = await registerPlayer(PORT, '幽灵');
  profiles.remove(ghost.playerId);
  ok(profiles.get(ghost.playerId) === null, '账号已删除，档案为空');
  hub._persistSettlement({
    phase: SM.PHASE.SETTLED,
    handSeq: 424242,
    settledAt: Date.now(),
    roomId: '999999',
    players: [
      { id: ghost.playerId, nickname: '幽灵', score: 18, isBot: false, left: true }
    ]
  });
  ok(profiles.get(ghost.playerId) === null,
    '结算不会把删掉的账号复活成一条没有账号的幽灵档案');

  /* ==================== 四、停用即踢线 ==================== */
  console.log('\n[停用账号当场踢掉已有连接]');
  const d = new Client('要停用的人');
  await d.signup(); await d.connect();
  await d.request('createRoom', { nickname: '要停用的人' });
  ok(!d.closed, '停用前连接在线');

  const r = await admin('/api/admin/disable', { playerId: d.playerId, disabled: true });
  eq(r.status, 200, '管理员停用成功');
  await wait(300);
  ok(d.closed === true, '被停用后连接被服务端关闭（不用等他刷新页面）');
  ok(d.errors.some((e) => e.indexOf('停用') >= 0), '关闭前给出了明确原因：' + (d.errors[0] || '(无)'));

  const r2 = await admin('/api/admin/disable', { playerId: d.playerId, disabled: false });
  eq(r2.status, 200, '恢复账号');

  /* ==================== 五、管理端路由精确匹配 ==================== */
  console.log('\n[管理端路径必须精确]');
  const u1 = await httpJson(PORT, 'GET', '/api/admin/usersXYZ', null, { 'x-backup-key': KEY });
  ok(u1.status !== 200, '/api/admin/usersXYZ 不再命中用户列表（前缀匹配已收窄）', 'status=' + u1.status);
  ok(!u1.raw || u1.raw.indexOf('lastLoginAt') < 0, '也没有漏出用户数据');
  const u2 = await httpJson(PORT, 'GET', '/api/admin/users', null, { 'x-backup-key': KEY });
  eq(u2.status, 200, '/api/admin/users 仍然正常');

  /* ==================== 六、写接口必须 application/json ==================== */
  console.log('\n[写接口拒绝非 JSON 类型]');
  const plain = await httpJson(PORT, 'POST', '/api/auth/login', null, { 'Content-Type': 'text/plain' });
  eq(plain.status, 415, 'text/plain 的登录请求被拒（挡跨站表单伪造 JSON）');

  a.close(); b.close(); c.close(); d.close();
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('测试异常:', e); process.exit(1); });
