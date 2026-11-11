/**
 * 成就**端到端**（node server/test/achievements-e2e.test.js）
 *
 * 前三个文件各测一段：accumulate 的口径、record 的落库、接线的存在性。
 * 这个文件把它们连起来跑**真的**一局：
 *
 *   发牌 → 提交分组 → Engine 判牌型 → SM.accumulate → room.achRun
 *        → hub._persistSettlement → profile.ach → getSelf
 *
 * 它挡的是一类只有跑起来才看得见的问题：
 *   · 状态机里 results 的 entries 到底有没有 typeName（没有的话统计恒为 0）；
 *   · 落库是不是真的调到了（只在 _broadcast 里调，直接测私有方法测不到）；
 *   · **桶是不是真的按人分开**（第一版是全场一个桶，两人局一跑就露馅）；
 *   · 「一把打完」之后桶有没有被清掉（不清的话下一局翻倍）。
 *
 * 手牌是**故意构造**的，每一张都为某条断言服务（见下面 HAND_A 的注释）。
 * 别随手换牌：单张组里 A 只算 1 点，把 K♠ 换成 A♠ 就会让整条通吃链路塌掉。
 */
'use strict';

const os = require('os');
const path = require('path');

process.env.PROFILE_FILE = path.join(os.tmpdir(), 'lxw-ach-e2e-' + Date.now() + '.json');

const SM = require('../../pwa/js/stateMachine.js');
const Ach = require('../../pwa/js/achievements.js');
const { Hub } = require('../hub.js');
const { ProfileStore } = require('../profile.js');
const EventLog = require('../eventLog.js');
const Replay = require('../achReplay.js');

/* 事件日志开到一个临时目录：这里要验的是「真的跑一局之后，原始观测有没有落下来」，
 * 而 eventLog 默认关闭（见 eventLog.js 头部约束 2），不显式打开就什么都测不到。 */
const EVT_DIR = path.join(os.tmpdir(), 'lxw-ach-e2e-evt-' + Date.now());
EventLog.configure({ dir: EVT_DIR, enabled: true });

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

const profiles = new ProfileStore({ file: process.env.PROFILE_FILE, log: function () {} });
const hub = new Hub({ profiles: profiles, log: function () {} });

function c(suit, rank) { return { suit: suit, rank: rank }; }

/* 甲的 6 张（每一张都为断言服务，换牌之前先想清楚会破坏哪一条）：
 *   单张     K♠           → 比 3♦ 大。**不能换成 A**：单张组里 A 算 1 点，会输。
 *   十点半   10♥ + Q♣      → 10 + 0.5 = 10.5
 *   飘三叶   J♦ J♥ J♣     → 豹子
 * 第二轮重新分成 single + douniu，斗牛用的就是这 5 张：
 *   10♥ Q♣ J♦ J♥ J♣ → 10,10,10,10,10 → 三张 30 + 两张 20 → **牛牛**。
 * 所以甲两轮五组全赢，能一路验到五子登科。
 *
 * 乙的 6 张全是普通牌：
 *   单张 3♦ / 十点半 2♦+4♦（6 点）/ 飘三叶 2♠7♥9♦（散牌）
 *   第二轮斗牛 2,4,2,7,9 → 4+7+9=20，剩 2+2=4 → 牛4（不是大牌型）
 * 这样第一轮三组、第二轮两组都是甲赢，且「大牌撞大牌」一次都没发生。 */
const HAND_A = [c('spade', 13), c('heart', 10), c('club', 12), c('diamond', 11), c('heart', 11), c('club', 11)];
const HAND_B = [c('diamond', 3), c('diamond', 2), c('diamond', 4), c('spade', 2), c('heart', 7), c('diamond', 9)];

const GROUPS_R1_A = {
  single: [HAND_A[0]],
  tenhalf: [HAND_A[1], HAND_A[2]],
  piaosanye: [HAND_A[3], HAND_A[4], HAND_A[5]]
};
const GROUPS_R1_B = {
  single: [HAND_B[0]],
  tenhalf: [HAND_B[1], HAND_B[2]],
  piaosanye: [HAND_B[3], HAND_B[4], HAND_B[5]]
};
/* 第二轮：同一把牌重新分组（single + douniu）。
 * 甲：10, Q(10), J(10), J(10), J(10) → 三张 30 + 两张 20 → 牛牛。
 * 乙：2, 4, 2, 7, 9 → 牛4。
 * 牛牛 > 牛4，而且**只有甲一个人是大牌型**，所以这一组也不产生对撞。 */
const GROUPS_R2_A = { single: [HAND_A[0]], douniu: [HAND_A[1], HAND_A[2], HAND_A[3], HAND_A[4], HAND_A[5]] };
const GROUPS_R2_B = { single: [HAND_B[0]], douniu: [HAND_B[1], HAND_B[2], HAND_B[3], HAND_B[4], HAND_B[5]] };

function mk(id, nick) {
  return { id: id, nickname: nick, ready: false, left: false, connected: true, disconnectedAt: null };
}

(async function main() {
  const A = await profiles.createAccount('ea1', 'pw123456', '甲');
  const B = await profiles.createAccount('ea2', 'pw123456', '乙');
  ok(A.ok && B.ok, '两个账号建好了');

  const roomId = 'R-ACH';
  const room = SM.newRoom(roomId, mk(A.playerId, '甲'));
  SM.joinRoom(room, mk(B.playerId, '乙'));
  /* handLimit 直接设 1：只打一把就 SETTLED，省 9 把的时间。
   * 不走 normalizeHandLimit —— 那个白名单里没有 1。 */
  room.handLimit = 1;
  hub.rooms.set(roomId, room);
  room.players.forEach(function (p) { p.ready = true; });

  const st = SM.startGame(room, A.playerId);
  ok(st.ok, '开局成功', st.error);

  /* ★ 发牌是随机的，这里直接覆盖手牌。submitGroups 会校验「用的牌都在手上 + 用满 6 张」，
   * 所以覆盖成一对一套的牌才走得通。 */
  room.players.forEach(function (p) {
    p.hand = p.id === A.playerId ? HAND_A.slice() : HAND_B.slice();
  });

  console.log('\n[1] 第一轮：甲拿十点半 + 豹子');
  [[A.playerId, GROUPS_R1_A], [B.playerId, GROUPS_R1_B]].forEach(function (pair) {
    const r = SM.submitGroups(room, pair[0], pair[1]);
    ok(r.ok, '提交第一轮分组（' + pair[0].slice(0, 4) + '）', r.error);
  });
  eq(room.round, 2, '第一轮结算完，进入第二轮');

  ok(!!room.achRun && !!room.achRun.byPid, '★ 结算时把成就桶建起来了（说明状态机真的调到了 accumulate）');
  const runA1 = Ach.runOf(room.achRun, A.playerId);
  const runB1 = Ach.runOf(room.achRun, B.playerId);
  ok(!!runA1 && !!runB1, '★ 两个人各有一桶（按人分开，不是全场一份）');

  eq(runA1.t.th, 1, '★★ 甲的十点半被引擎判出来并计数（10♥+Q♣ = 10.5）');
  eq(runA1.t.lp, 1, '★★ 甲的豹子被引擎判出来并计数（J♦J♥J♣）');
  eq(runA1.n.tenhalf, 1, '★ 甲的分母 = 他自己参与 1 次（不是场上 2 次）');
  eq(runA1.n.piaosanye, 1, '甲飘三叶的分母也是 1');
  eq(runB1.t.th || 0, 0, '★★ 乙没拿到十点半 → 0（不分桶的话这里会是 1）');
  eq(runB1.t.lp || 0, 0, '乙也没拿到豹子');
  eq(runB1.n.tenhalf, 1, '但乙的分母照记（他参与了，只是没拿到）');
  eq(runA1.vsn, 0, '只有甲拿大牌型 → 不算对撞');
  eq(runA1.s1, 1, '甲第一轮三组全赢 → 一巡清场');
  eq(runB1.s1 || 0, 0, '乙没有通吃');

  console.log('\n[2] 第二轮：甲再全赢 → 五子登科');
  [[A.playerId, GROUPS_R2_A], [B.playerId, GROUPS_R2_B]].forEach(function (pair) {
    const r = SM.submitGroups(room, pair[0], pair[1]);
    ok(r.ok, '提交第二轮分组', r.error);
  });
  eq(room.phase, SM.PHASE.SETTLED, '打满 1 把 → 进入 SETTLED（终局只认局数）');

  const runA2 = Ach.runOf(room.achRun, A.playerId);
  eq(runA2.t.nn, 1, '第二轮甲拿到牛牛（10♥Q♣J♦J♥J♣）');
  eq(runA2.s2, 1, '第二轮两组全赢');
  eq(runA2.sa, 1, '★★ 两轮都全赢 → 五子登科（跨轮判定生效）');
  eq(runA2.sw, 2, '通吃总数 2');

  console.log('\n[3] 落库：广播链路里写进档案');
  hub._broadcast(roomId);

  const recA = profiles.data.get(A.playerId);
  const recB = profiles.data.get(B.playerId);
  ok(!!recA && !!recA.ach, '★ 甲的档案里有成就桶（广播 → _persistSettlement → record 走通了）');
  eq(recA && recA.ach.t.th, 1, '档案里十点半 1 次');
  eq(recA && recA.ach.t.lp, 1, '档案里豹子 1 次');
  eq(recA && recA.ach.t.nn, 1, '档案里牛牛 1 次');
  eq(recA && recA.ach.s1, 1, '档案里一巡清场 1 次');
  eq(recA && recA.ach.sa, 1, '档案里五子登科 1 次');

  eq(recB && recB.ach.t.th || 0, 0, '★★ 乙的档案里十点半是 0（不是甲那份被抄过来）');
  eq(recB && recB.ach.sa || 0, 0, '乙也没有五子登科');
  eq(recB && recB.ach.n.tenhalf, 1, '但乙的分母在（他打过这个组）');

  eq(recA && recA.games, 1, '战绩也照常记了 1 场（成就没把战绩搞乱）');

  console.log('\n[4] 桶要清掉，否则下一局翻倍');
  eq(room.achRun, null, '★ 落库后 room.achRun 被清空');

  console.log('\n[5] 对外接口');
  const self = profiles.getSelf(A.playerId);
  ok(!!self.ach, 'getSelf 带完整桶');
  eq(self.ach.sa, 1, '明细里五子登科 1 次');
  /* v116 起「打完一把能亮几条」是被刻意压缩的：
   *   · 一巡清场 / 五子登科的门槛 1 → 3，一把不亮；
   *   · 牌型类门槛 5~30，一把只有 1 次，不亮；
   *   · 你咋这幸要求 ≥3 人，这是两人局，不亮。
   * 剩下就只有「第一次」。**这是有意的**：以前一把能亮 5~6 条，
   * 那等于注册礼包；现在第一条真正的成就要打几把才出来，曲线才有东西可爬。 */
  const litA = Ach.evaluate(self.ach, self).list.filter(function (x) { return x.ok; });
  eq(litA.length, 1, '★★ 打完一把只亮 1 条（第一次）—— 以前是 5 条起，等于白送');
  eq(litA[0].id, 'first', '亮的就是「第一次」');
  eq(self.achCount, 1, '对外计数一致');

  const pub = profiles.get(A.playerId);
  eq(pub.ach, undefined, '★ 对外档案不带明细');
  eq(pub.achCount, self.achCount, '但数量一致（信息档显示 12 / 34 靠它）');
  eq(pub.achTotal, 39, '总数 39（v116 补熟面孔 / 铁人 / 十五连胜 / 单场之王）');

  const pubB = profiles.get(B.playerId);
  const selfB = profiles.getSelf(B.playerId);
  /* v114：原来这条写「乙的解锁数比甲少」，靠的是「甲拿到就解锁的那批首次成就」。
   * 那 5 条删掉之后两边数量可能持平，而且**持平也可能是桶串了** —— 判据不成立。
   * 换成直接对账：甲有五子登科（全赢）、乙没有；乙有五子皆输（全输）、甲没有。
   * 这两个方向一起断，才真的证明「同一个房间的两个人各记各的」。 */
  eq(self.ach.sa, 1, '甲的桶里有五子登科');
  eq(selfB.ach.sa || 0, 0, '★ 乙的桶里没有（没有串到乙头上）');
  eq(selfB.ach.la, 1, '★ 乙的桶里有五子皆输（全输也算一件事）');
  eq(self.ach.la || 0, 0, '★ 甲没有（没有串到甲头上）');
  ok(pubB.achCount >= 1, '乙的对外档案也有解锁数');

  /* 新建一个房间再来一把：确认上一局的桶没有残留 */
  console.log('\n[6] 第二局不继承上一局的数');
  const room2 = SM.newRoom('R-ACH2', mk(A.playerId, '甲'));
  SM.joinRoom(room2, mk(B.playerId, '乙'));
  room2.handLimit = 1;
  hub.rooms.set('R-ACH2', room2);
  room2.players.forEach(function (p) { p.ready = true; });
  SM.startGame(room2, A.playerId);
  room2.players.forEach(function (p) {
    p.hand = p.id === A.playerId ? HAND_A.slice() : HAND_B.slice();
  });
  [[A.playerId, GROUPS_R1_A], [B.playerId, GROUPS_R1_B]].forEach(function (pair) {
    SM.submitGroups(room2, pair[0], pair[1]);
  });
  const runAnew = Ach.runOf(room2.achRun, A.playerId);
  eq(runAnew.t.th, 1, '★ 新房间的桶从 0 开始（不是接着上一局的 1）');
  eq(runAnew.s1, 1, '通吃也从 0 开始');

  /* ================================================================
   * 7. 原始观测落盘 + 重放能否复现线上结果
   *
   * 这一段是整个「改口径能不能重算历史」的最终证据：
   * 跑一局真牌 → 事件写进文件 → 拿重放器折一遍 → 必须等于档案里的 ach。
   * 对不上，就说明重放器抄错了 record/accumulate 的逻辑，或者接线断了一环。
   * ================================================================ */
  console.log('\n[7] 原始观测落盘 + 重放复现');
  const evts = EventLog.readAll({ dir: EVT_DIR });
  const evtA1 = evts.filter(function (e) { return e.r === 'R-ACH'; });
  eq(evtA1.filter(function (e) { return e.k === 'g'; }).length, 2,
    '★ 第一局两轮各一条轮级事件');
  const settles = evtA1.filter(function (e) { return e.k === 's'; });
  eq(settles.length, 1, '★ 一条场级事件');
  ok(settles[0] && settles[0].p.length === 2, '场级事件带的是全场两个人');
  const g1 = evtA1.filter(function (e) { return e.k === 'g'; })[0];
  const tenhalfGroup = (g1.g || []).filter(function (x) { return x[0] === 'tenhalf'; })[0];
  ok(!!tenhalfGroup, '事件里有十点半这一组');
  const aEntry = tenhalfGroup[2].filter(function (e) { return e[0] === A.playerId; })[0];
  eq(aEntry[1], '10.5点', '★ 牌型存的是原文（10.5点），不是映射后的短键');

  /* 用空白基线重放：档案里此刻的 ach 就是这一局算出来的，两者必须一致 */
  const replayed = Replay.replay(evtA1, { baseByPid: new Map([
    [A.playerId, { at: 0, counts: {}, currentStreak: 0 }],
    [B.playerId, { at: 0, counts: {}, currentStreak: 0 }]
  ]) });
  const liveA = profiles.data.get(A.playerId).ach;
  const rrA = replayed.byPid.get(A.playerId).counts;
  eq(rrA.t.th, liveA.t.th, '★★ 重放出来的十点半次数 == 线上（' + liveA.t.th + '）');
  eq(rrA.t.lp, liveA.t.lp, '★★ 豹子次数一致');
  eq(rrA.s1, liveA.s1, '★★ 一巡清场一致');
  eq(rrA.sa, liveA.sa, '★★ 五子登科一致');
  eq(rrA.sw, liveA.sw, '通吃总数一致');
  eq(rrA.vsn || 0, liveA.vsn || 0, '对撞分母一致（这一局本来就该是 0）');
  const liveB = profiles.data.get(B.playerId).ach;
  const rrB = replayed.byPid.get(B.playerId).counts;
  eq(rrB.t.th || 0, liveB.t.th || 0, '★ 乙那边也一致（甲拿的没记到乙头上）');

  /* 反向验证：把轮级事件拿掉，重放结果必须塌成 0 —— 证明上面的相等不是巧合 */
  const onlySettle = evtA1.filter(function (e) { return e.k === 's'; });
  const rNoRounds = Replay.replay(onlySettle, { baseByPid: new Map([
    [A.playerId, { at: 0, counts: {}, currentStreak: 0 }]
  ]) });
  const rrNo = rNoRounds.byPid.get(A.playerId).counts;
  eq(rrNo.t.th || 0, 0, '★ 只留场级事件时牌型计数为 0（轮级事件确实是唯一来源）');
  eq(rrNo.sa || 0, 0, '五子登科也归 0');

  /* ================================================================
   * 汇总
   * ================================================================ */
  console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' 项通过，' + fail + ' 项失败');
  try { profiles.flush(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
