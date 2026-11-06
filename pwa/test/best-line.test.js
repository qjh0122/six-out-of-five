/**
 * 「理论最高分」复盘（node pwa/test/best-line.test.js）
 *
 * 这个模块只有一处会错得很惨的方式：**口径漂移**。
 * 如果 bestLine 自己写一套比较逻辑，某天引擎改了规则，复盘会说「你能拿 6 分」
 * 而结算给 5 分 —— 玩家一眼就能发现游戏在胡说，这比没有这个功能更糟。
 *
 * 所以本文件的第一组断言就是交叉验证：
 *   **拿实际用过的分法跑一遍，得到的净分必须等于实际结算的净分。**
 * 这条一旦红，说明「复盘用的算法」和「结算用的算法」已经不是同一件事了。
 *
 * 其余三组：
 *   2. 最优 ≥ 实际（数学上必然；出现反例说明枚举漏了分法）
 *   3. 十点半爆点的分法不能出现在最优里（那是玩家根本提交不了的选项）
 *   4. 边界：手牌不是 6 张、弃权、数据残缺 → 返回 null 而不是猜一个数
 *
 * 期望值全部手写或用引擎独立算，**没有一处拿 bestLine 自己的结果当期望**。
 */
'use strict';

var BL = require('../js/bestLine.js');
var Engine = require('../js/engine.js');
var SM = require('../js/stateMachine.js');
var Config = require('../js/config.js');

var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) pass += 1;
  else { fail += 1; console.error('✗ ' + name + (extra ? ' — ' + extra : '')); }
}
function eq(a, b, name) {
  ok(a === b, name, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
}

var c = function (suit, rank) { return { suit: suit, rank: rank }; };

/* ================================================================
 * 一、交叉验证：实际分法 → 必须得到实际净分
 * ================================================================ */

/* 甲：K♠ / 10♥ Q♣ / J♦ J♥ J♣  →  单张、十点半 10.5、豹子（牌够强，容易看出最优）
 * 乙：3♦ 2♦ 4♦ / 2♠ 7♥ 9♦       →  全普通牌 */
var HAND_A = [c('spade', 13), c('heart', 10), c('club', 12), c('diamond', 11), c('heart', 11), c('club', 11)];
var HAND_B = [c('diamond', 3), c('diamond', 2), c('diamond', 4), c('spade', 2), c('heart', 7), c('diamond', 9)];

/* 乙的手牌按**组**切好。★ v130：`others` 必须按组给，不能给整手 6 张 ——
 * 以前给整手，于是单张组变成「我 1 张 vs 他 6 张」，而这是每把都显示给玩家看的数字。
 * 现在夹具本身就按组写，错的那个形状连表达都表达不出来。 */
var OTHER_B = {
  single: [{ id: 'p2', hand: [HAND_B[0]] }],
  tenhalf: [{ id: 'p2', hand: [HAND_B[1], HAND_B[2]] }],
  piaosanye: [{ id: 'p2', hand: [HAND_B[3], HAND_B[4], HAND_B[5]] }],
  douniu: [{ id: 'p2', hand: HAND_B.slice(1) }]
};

var SPLIT_A1 = { single: [HAND_A[0]], tenhalf: [HAND_A[1], HAND_A[2]], piaosanye: [HAND_A[3], HAND_A[4], HAND_A[5]] };
var SPLIT_A2 = { single: [HAND_A[0]], tenhalf: [], piaosanye: [], douniu: [HAND_A[1], HAND_A[2], HAND_A[3], HAND_A[4], HAND_A[5]] };

/* 把整手 6 张按「1 / 2 / 3」和「1 / 5」切成两组形状。
 * 只用于构造夹具 —— 真实场景里对手怎么分是**结算记录**告诉我们的，不用这里猜。 */
function byModeOf(hand, pid) {
  var who = pid || 'p2';
  return {
    single: [{ id: who, hand: [hand[0]] }],
    tenhalf: [{ id: who, hand: [hand[1], hand[2]] }],
    piaosanye: [{ id: who, hand: [hand[3], hand[4], hand[5]] }],
    douniu: [{ id: who, hand: hand.slice(1) }]
  };
}

/* 逐组算一遍「按这个分法我实际能得几分」。
 *
 * ⚠️ 这个函数**只能是「逐组拼接」这一层的对照**，不能当「bestLine 算对了没」的判据 ——
 * 它的拼接表达式与 netOf 同形，netOf 错它也错。真正独立的判据在第五节：
 * 拿 history 里记的 deltas 比（那是状态机结算时写下的，不是 bestLine 算的）。 */
function engineNet(round, split, othersByMode) {
  var keys = SM.ROUND_GROUPS[round];
  var net = 0;
  keys.forEach(function (mode) {
    var theirs = (othersByMode && othersByMode[mode]) || [];
    var entries = [{ id: 'me', hand: split[mode] || [] }].concat(theirs);
    var r = Engine.settleGroup(mode, entries);
    net += r.deltas.me || 0;
  });
  return net;
}

eq(BL.netOf(1, OTHER_B, SPLIT_A1), engineNet(1, SPLIT_A1, OTHER_B),
  '逐组拼接一致（第一轮）：确认没有多算/漏算某一组');
eq(BL.netOf(2, OTHER_B, SPLIT_A2), engineNet(2, SPLIT_A2, OTHER_B),
  '逐组拼接一致（第二轮）：同上');

/* 三个组都必须真的被结算到：netOf 只看 deltas['__bestline_me']，
 * 少算一组就会偏小，而这在「刚好不输不赢」的牌上会完美隐藏（差 0 和 差一组也可能都是 0）。 */
eq(BL.ROUND_GROUPS[1].length, 3, '第一轮是 3 组（1 + 2 + 3）');
eq(BL.ROUND_GROUPS[2].length, 2, '第二轮是 2 组（1 + 5）');
eq(BL.ROUND_GROUPS[1].join(','), SM.ROUND_GROUPS[1].join(','),
  '★ 第一轮分组与状态机一致（改了分组这里会立刻红）');
eq(BL.ROUND_GROUPS[2].join(','), SM.ROUND_GROUPS[2].join(','),
  '★ 第二轮分组与状态机一致');

/* ================================================================
 * 二、最优 ≥ 实际，且枚举数量正确
 * ================================================================ */

var best1 = BL.bestOf(1, HAND_A, OTHER_B);
var best2 = BL.bestOf(2, HAND_A, OTHER_B);
ok(!!best1 && !!best2, '两手都能算出最优');
eq(best1.tried, 60, '★ 第一轮枚举了 60 种分法（6 × C(5,2)）');
eq(best2.tried, 6, '★ 第二轮枚举了 6 种分法（6 张里挑单张）');
ok(best1.net >= engineNet(1, SPLIT_A1, OTHER_B), '★ 第一轮最优 ≥ 实际（' + best1.net + ' ≥ ' + engineNet(1, SPLIT_A1, OTHER_B) + '）');
ok(best2.net >= engineNet(2, SPLIT_A2, OTHER_B), '★ 第二轮最优 ≥ 实际（' + best2.net + ' ≥ ' + engineNet(2, SPLIT_A2, OTHER_B) + '）');

/* 构造一手「怎么分都很烂」的牌：最优也必须 ≥ 任何一个分法 */
var HAND_WEAK = [c('diamond', 2), c('club', 3), c('diamond', 4), c('spade', 5), c('heart', 6), c('club', 8)];
var HAND_STRONG = [c('spade', 14), c('spade', 13), c('spade', 12), c('spade', 11), c('spade', 10), c('club', 9)];
var OTHER_STRONG = byModeOf(HAND_STRONG);
var OTHER_WEAK = byModeOf(HAND_WEAK);
var w1 = BL.bestOf(1, HAND_WEAK, OTHER_STRONG);
var s1 = BL.bestOf(1, HAND_STRONG, OTHER_WEAK);
ok(s1.net > 0, '强牌对弱牌，最优是正的（' + s1.net + '）');
ok(s1.net >= w1.net, '同一副牌强势一方的最优不小于弱势一方（' + s1.net + ' ≥ ' + w1.net + '）');

/* ★ 这里必须钉一条反直觉的规则：**单张组里 A 算 1 点，是最小的**。
 *
 * 第一版测试写的断言是「弱牌对强牌，最优也是负的」，结果拿到了 +1 —— 因为它
 * 不是实现错了，是我预设错了：A♠ 在单张组里输给 2♦。于是「弱牌一定输」不成立。
 * 这条规则同时决定了「什么是最优」——如果哪天引擎把 A 改成 14，
 * 这里的复盘会给出完全不同的答案，而它是静默变化的。所以单独立一条。 */
var sA = Engine.settleGroup('single', [{ id: 'x', hand: [c('spade', 14)] }, { id: 'y', hand: [c('diamond', 2)] }]);
eq(sA.winnerId, 'y', '★ 单张组 A 算 1 点，输给 2♦（反直觉，但这是复盘算法的前提）');
var sK = Engine.settleGroup('single', [{ id: 'x', hand: [c('spade', 13)] }, { id: 'y', hand: [c('diamond', 2)] }]);
eq(sK.winnerId, 'x', '单张组 K 大于 2（与 A 相反——A 是特例）');

/* 枚举的完整性：手写一个暴力枚举，与 bestOf 的结果比对。
 * 不复用 eachSplit 的实现 —— 那样是拿被测函数的遍历顺序证明它自己没漏。 */
function bruteForce1(hand, others) {
  var best = -Infinity;
  for (var i = 0; i < 6; i++) {
    var rest = [];
    for (var x = 0; x < 6; x++) if (x !== i) rest.push(hand[x]);
    for (var a = 0; a < 5; a++) {
      for (var b = a + 1; b < 5; b++) {
        var tenhalf = [rest[a], rest[b]];
        var psy = [];
        for (var y = 0; y < 5; y++) if (y !== a && y !== b) psy.push(rest[y]);
        /* 爆点分法跳过（与 bestOf 的口径一致） */
        if (Engine.tenHalfBust(tenhalf)) continue;
        var net = engineNet(1, { single: [hand[i]], tenhalf: tenhalf, piaosanye: psy }, others);
        if (net > best) best = net;
      }
    }
  }
  return best;
}
eq(best1.net, bruteForce1(HAND_A, OTHER_B), '★ 与手写暴力枚举的结果一致（没漏分法也没多数）');
eq(BL.bestOf(1, HAND_WEAK, OTHER_STRONG).net,
  bruteForce1(HAND_WEAK, OTHER_STRONG),
  '★ 换一副弱牌，暴力枚举同样一致');

/* ================================================================
 * 三、爆点不算进最优
 * ================================================================ */

/* 9 + 8 → 17 点，爆。这一对绝不能出现在最优分法里。 */
var HAND_BUST = [c('spade', 9), c('heart', 8), c('club', 2), c('diamond', 3), c('spade', 4), c('heart', 5)];
var bBust = BL.bestOf(1, HAND_BUST, OTHER_B);
ok(!!bBust, '有爆点风险的牌也能算出最优');
eq(Engine.tenHalfBust(bBust.split.tenhalf), false,
  '★ 最优分法里的十点半不爆（爆点会被弹窗硬挡，玩家提交不了）');
eq(bBust.busted, false, 'busted=false 表示「存在不爆的分法」');

/* 兜底：整手牌怎么分都爆（6 张全是 9/J/Q/K 这类 0.5 点或大点，两两相加必超 10.5）。
 * 这时 bestOf 应该退回全体最优，并把 busted 标成 true —— 与 ai.js 的 bestSafe || best 同口径。 */
/* 6,6,7,7,8,8：任意两张相加都 ≥ 12 > 10.5，怎么配都爆。
 * 第一版用的是 10,10,10,10,J,K，其实**不成立** —— J/K 都算 0.5 点，10+J = 10.5 不爆，
 * 于是 busted=false，测试红。这也说明「找一手必爆的牌」比看起来难：
 * 10.5 这个上界让 10 和 0.5 点牌成为唯一的安全组合。 */
var HAND_ALL_BUST = [c('spade', 6), c('heart', 6), c('club', 7), c('diamond', 7), c('spade', 8), c('heart', 8)];
var bAll = BL.bestOf(1, HAND_ALL_BUST, OTHER_B);
ok(!!bAll, '全爆的牌也给得出结果（不能返回 null，否则结算页整块消失）');
eq(bAll.busted, true, '★ 全爆时 busted=true（页面可以据此不吹「最优」）');
ok(Engine.tenHalfBust(bAll.split.tenhalf), '★ 全爆时最优分法本身就是爆点（因为别无选择）');

/* ================================================================
 * 四、边界：数据不全时返回 null，不猜
 * ================================================================ */

eq(BL.bestOf(1, [], OTHER_B), null, '空手牌 → null（弃权的人没有「最优分法」）');
eq(BL.bestOf(1, HAND_A.slice(0, 5), OTHER_B), null, '只有 5 张 → null（不拿不完整的手牌硬算）');
var err = null;
try { BL.bestOf(3, HAND_A, OTHER_B); } catch (e) { err = e; }
ok(!!err, '未知轮次 → 抛错（不是静默返回 0）');

/* 没有对手：一个人打（理论上不会发生，但枚举不能因此崩） */
var solo = BL.bestOf(1, HAND_A, {});
ok(!!solo && solo.tried === 60, '没有对手时照常枚举 60 种');

/* ================================================================
 * 五、从 history 还原：结算页和回放走的是这一层
 * ================================================================ */

function mk(id, nick) {
  return { id: id, nickname: nick, ready: false, left: false, connected: true, disconnectedAt: null };
}
function playOneRound() {
  var room = SM.newRoom('T1', mk('p1', '甲'));
  SM.joinRoom(room, mk('p2', '乙'));
  room.players.forEach(function (p) { p.score = 0; p.ready = true; });
  SM.startGame(room, 'p1');
  room.players.forEach(function (p) { p.hand = (p.id === 'p1' ? HAND_A : HAND_B).slice(); });
  SM.submitGroups(room, 'p1', {
    single: [HAND_A[0]], tenhalf: [HAND_A[1], HAND_A[2]], piaosanye: [HAND_A[3], HAND_A[4], HAND_A[5]]
  });
  SM.submitGroups(room, 'p2', {
    single: [HAND_B[0]], tenhalf: [HAND_B[1], HAND_B[2]], piaosanye: [HAND_B[3], HAND_B[4], HAND_B[5]]
  });
  return room;
}

var room = playOneRound();
var rounds = room.history.filter(function (h) { return h.hid === room.handId; });
var recP1 = BL.ofHand(rounds, 'p1');
ok(!!recP1, '★ 能从真实结算记录里还原出一把的复盘');
eq(recP1.actual, room.players[0].score,
  '★ 还原出来的「实际」必须等于结算后的分数（' + recP1.actual + ' vs ' + room.players[0].score + '）');
ok(recP1.best >= recP1.actual, '还原出来的最优 ≥ 实际');
eq(recP1.diff, recP1.best - recP1.actual, 'diff 就是两者之差');

/* ★★ 真正独立的交叉验证（v130 补，这是本轮唯一能抓住「对手手牌没按组切」的判据）
 *
 * 取 history 里「我实际用的那几组牌」当分法，喂给 netOf，净分必须等于
 * **状态机结算时写下的 deltas 之和**。deltas 是 Engine.settleGroup 在结算那一刻算的，
 * bestLine 只是事后重算 —— 只有在「对手手牌按组给」时两边才相等。
 *
 * 变异自证（写完立刻验过）：把 netOf 里 `.concat(theirs)` 改成 `.concat([])`
 * （等于无视对手），这条立刻红；而上一版那条「交叉验证」照样绿 —— 因为它抄的就是 netOf。
 */
function splitFromHistory(roundObj, pid) {
  var split = { single: [], tenhalf: [], piaosanye: [], douniu: [] };
  (roundObj.groups || []).forEach(function (g) {
    (g.entries || []).forEach(function (e) {
      if (e.id === pid) split[g.group] = e.hand;
    });
  });
  return split;
}
(function () {
  for (var i = 0; i < rounds.length; i++) {
    var h = rounds[i];
    eq(BL.netOf(h.round || 1, BL.othersByModeFrom(h, 'p1'), splitFromHistory(h, 'p1')),
      BL.actualOfRound(h, 'p1'),
      '★★ 用「实际分法」重算 → 必须等于结算记录里的净分（第 ' + (h.round || 1) + ' 轮）');
  }
})();

/* ★ v131：整场复盘 = 逐把求和（不是重新枚举整场，也不是取平均） */
var h2 = JSON.parse(JSON.stringify(rounds[0]));
h2.hid = 99;
var m = BL.ofMatch([rounds[0], h2], 'p1');
ok(!!m, '两把的 history 能算出整场复盘');
eq(m.hands, 2, '★ 两把都算进去（不是只挑最后一把）');
eq(m.best, recP1.best * 2, '整场理论最高 = 每把之和');
eq(m.actual, recP1.actual * 2, '整场实得 = 每把之和');
eq(m.diff, m.best - m.actual, 'diff 是差的求和');
eq(m.partial, 2, '★ 两把都只打了一轮 → partial=2（页面必须说出来）');
eq(BL.ofMatch([], 'p1'), null, '空 history → null');
eq(BL.ofMatch([rounds[0]], ''), null, '没有玩家 id → null');

/* 只打到一轮 → complete=false，调用方改用按轮显示（不许把单轮说成「整局」） */
eq(recP1.complete, false, '★ 只打到一轮 → complete=false（这一局是中途结束的）');
eq(recP1.byRound.length, 1, 'byRound 里只有一条（按轮兜底要能拿到数）');
ok(recP1.byRound[0].best >= recP1.byRound[0].actual, '按轮的那条也满足最优 ≥ 实际');

var recP2 = BL.ofHand(rounds, 'p2');
ok(!!recP2, '乙的视角也算得出来');
eq(recP2.actual, room.players[1].score, '★ 乙的「实际」也等于他自己的分数');
ok(recP2.best >= recP2.actual, '乙的最优 ≥ 实际');
/* 两个人看到的「实际」必须是各自的，不能都拿第一个人的 */
ok(recP1.actual !== recP2.actual, '★ 甲的实得分和乙的实得分不同（没有串台）');

/* 空 history / 空 id → null */
eq(BL.ofHand([], 'p1'), null, '空 history → null');
eq(BL.ofHand(rounds, ''), null, '没有玩家 id → null');
eq(BL.ofHand(rounds, 'p-不存在'), null, '查一个不在场的人 → null（拼不出 6 张）');

/* 手牌拼不齐（模拟老数据缺了某一组）→ null，不能拿 5 张算出个荒谬数字 */
var broken = JSON.parse(JSON.stringify(rounds));
broken[0].groups[2].entries.forEach(function (e) { e.hand = []; });
eq(BL.ofHand(broken, 'p1'), null, '★ 有一组手牌缺失 → null（宁可不显示，也不能算错）');

/* ================================================================
 * 五之二、lastHandRounds：取「刚打完的那一把」
 * ================================================================ */

/* ★ 这一组守的是一个**实测踩到的真 bug**，不是假想的边界：
 * 探针跑到结算页时 `room.handId` 是 2，而 history 里那两条记录的 hid 都是 1。
 * 第一版用 `h.hid === room.handId` 过滤 → 得到 0 条 → 复盘行整块消失，
 * 页面其余部分完全正常，没有任何报错。单测当时全绿（因为测的是 ofHand，
 * 而过滤逻辑当时写在 settleView 里、根本测不到）。
 * 现在把过滤抽成纯函数放进来，就是为了让它能被这样测。 */
function fakeRound(hid, round) {
  return { hid: hid, round: round, groups: [{ group: 'single', entries: [], deltas: {} }] };
}
eq(BL.lastHandRounds([]).length, 0, '空 history → 空');
eq(BL.lastHandRounds(null).length, 0, 'null history → 空（不抛）');
eq(BL.lastHandRounds([fakeRound(1, 1), fakeRound(1, 2)]).length, 2,
  '★ hid 全是 1 而 handId 已经变成 2 时，仍然取得到那两轮（原 bug 的现场）');
eq(BL.lastHandRounds([fakeRound(1, 1), fakeRound(1, 2), fakeRound(2, 1)]).length, 1,
  '★ 两把混在 history 里时只取最后一把（不把上一把的账算进来）');
eq(BL.lastHandRounds([{ hand: 1, round: 1 }, { hand: 1, round: 2 }]).length, 2,
  '老数据没有 hid 字段时退回用 hand（回放里的两个月前记录）');

/* 端到端串一次：handId 与 history 脱节时，ofHand 仍然给得出复盘 */
var room2 = playOneRound();
var decoupled = { handId: (room2.handId || 1) + 1, history: room2.history };
var recDecoupled = BL.ofHand(BL.lastHandRounds(decoupled.history), 'p1');
ok(!!recDecoupled, '★ handId 比 history 领先一把时，复盘仍然算得出来（这是本次的真实故障）');
eq(recDecoupled.actual, room2.players[0].score, '脱节场景下「实际」仍然等于结算分');

/* ================================================================
 * 六、性能：结算页渲染前同步算，必须在 500ms 内
 * ================================================================ */

var t0 = Date.now();
for (var k = 0; k < 5; k++) BL.ofHand(rounds, 'p1');
var cost = (Date.now() - t0) / 5;
ok(cost < 500, '★ 一次复盘平均 ' + cost.toFixed(1) + 'ms（上限 500ms）');

/* ================================================================
 * 汇总
 * ================================================================ */
console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' 项通过，' + fail + ' 项失败');
if (fail) process.exit(1);
