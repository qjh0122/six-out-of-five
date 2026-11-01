/**
 * 组级写分 / 负分不再终止游戏（v103 口径）
 * 跑法：node test/group-settle.test.js
 *
 * 【这个文件的历史】
 * v83 时它测的是「有人分数 ≤0 就当场出局、后面几组不许结算」。
 * v103 把那条规则删了 —— 终局只认建房时选的把数。于是同一个文件的语义基础变了：
 *
 *   旧：见底 = 终止条件 → 断言「只算了 1 组」「分数停在 0」
 *   新：负分 = 正常状态 → 断言「三组全算」「分数是负数」「继续进第二轮」
 *
 * 为什么必须删（数值理由，不是口味问题）：
 *   20 分本金，每把最坏 −17 分、典型波动 ±5~8 分 → 只够扛 2~3 把。
 *   不删这条，5 / 10 / 15 / 30 档全都会在 2~4 把被爆分抢先截断，
 *   玩家选的局数等于没选（实测跑 5 次真机对局，3 次是爆分收尾）。
 *
 * 【这个文件要守住的三件事】
 *   1. 跌破 0 不产生任何终止 —— phase 照常推进、endReason 保持 null；
 *   2. 本轮所有组一定算完 —— results.length 恒等于组总数（旧实现会被 break 截短）；
 *   3. 分数可对账 —— 每人净得 == Σ(每组的 deltas[我])，每组 Σdeltas == 0。
 */
'use strict';

var SM = require('../js/stateMachine.js');
var CONFIG = require('../js/config.js');

var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) {
  ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
}
function head(t) { console.log('\n' + t); }

function c(suit, rank) { return { suit: suit, rank: rank }; }
function mk(id, nick) {
  return {
    id: id, nickname: nick, ready: false, left: false, connected: true,
    disconnectedAt: null
  };
}

/* 3 人局。分数在开局之后设置 —— startGame 会走 dealAll，但不动 score，
 * 所以设在这个位置不会被覆盖。
 * handLimit 只在测「续局」时传 1：v103 之后终局只认局数，想拿到一个 SETTLED
 * 的房间就得真把它打完，打 10 把太慢。 */
function setup3(scores, handLimit) {
  var room = SM.newRoom('500001', mk('p1', '甲'), { handLimit: handLimit || 10 });
  SM.joinRoom(room, mk('p2', '乙'));
  SM.joinRoom(room, mk('p3', '丙'));
  room.players.forEach(function (p, i) {
    p.score = scores[i];
    p.ready = true;
  });
  var r = SM.startGame(room, 'p1');
  if (!r.ok) throw new Error('开局失败：' + r.error);
  return room;
}

/* 固定手牌。必须覆盖 p.hand（submitGroups 会核对「用的牌都在手上」） */
var PLAN = {
  p1: {
    single: [c('spade', 2)],
    tenhalf: [c('heart', 2), c('heart', 3)],          // 5 点
    piaosanye: [c('club', 2), c('club', 3), c('club', 4)]
  },
  p2: {
    single: [c('spade', 13)],                          // K，单张最大
    tenhalf: [c('diamond', 9), c('diamond', 14)],      // 9 + A(1点) = 10 点
    piaosanye: [c('heart', 8), c('diamond', 8), c('club', 8)]
  },
  p3: {
    single: [c('spade', 12)],
    tenhalf: [c('heart', 8), c('heart', 7)],           // 15 点，爆
    piaosanye: [c('heart', 9), c('diamond', 9), c('club', 9)]
  }
};

/* 三家的第一轮结果（实测值，别手算赔率 —— 十点半的档位按不爆人数走）：
 *   single    乙赢 1 分档 → 甲 −1 乙 +2 丙 −1
 *   tenhalf   乙赢 1 分档 → 甲 −1 乙 +2 丙 −1
 *   piaosanye 丙赢 3 分档 → 甲 −3 乙 −3 丙 +6  （2 个豹子 → 每家 3 分）
 * 合计每人 −5 / +1 / +4 —— 所以甲从 5 分出发正好归零，从 1 分出发会变 −4。
 */
var R1_NET = { p1: -5, p2: 1, p3: 4 };

/* 第二轮固定手牌：单张 + 斗牛 */
var PLAN_R2 = {
  p1: {
    single: [c('spade', 3)],
    douniu: [c('heart', 2), c('heart', 3), c('heart', 4), c('heart', 5), c('heart', 6)]
  },
  p2: {
    single: [c('spade', 14)],
    douniu: [c('club', 2), c('club', 3), c('club', 4), c('club', 5), c('club', 6)]
  },
  p3: {
    single: [c('spade', 11)],
    douniu: [c('diamond', 2), c('diamond', 3), c('diamond', 4), c('diamond', 5), c('diamond', 6)]
  }
};

/* 三家按顺序提交。最后一个人提交的那一刻触发结算。 */
function playRound1(room) {
  room.players.forEach(function (p) {
    var g = PLAN[p.id];
    p.hand = [].concat(g.single, g.tenhalf, g.piaosanye);
  });
  ['p1', 'p2', 'p3'].forEach(function (id) {
    var g = PLAN[id];
    var r = SM.submitGroups(room, id, {
      single: g.single.slice(0, 1),
      tenhalf: g.tenhalf.slice(0, 2),
      piaosanye: g.piaosanye.slice(0, 3)
    });
    if (!r.ok) throw new Error(id + ' 提交失败：' + r.error);
  });
}

function playRound2(room) {
  room.players.forEach(function (p) {
    var g = PLAN_R2[p.id];
    p.hand = [].concat(g.single, g.douniu);
  });
  ['p1', 'p2', 'p3'].forEach(function (id) {
    var g = PLAN_R2[id];
    var r = SM.submitGroups(room, id, { single: g.single, douniu: g.douniu });
    if (!r.ok) throw new Error(id + ' 提交失败：' + r.error);
  });
}

function byId(room, id) {
  return room.players.filter(function (p) { return p.id === id; })[0];
}

/* ================================================================
 * 1. 第 1 组就跌破 0 —— 不许终止任何东西
 * ================================================================ */
head('[1] 第 1 组就跌破 0：不终止，三组照算，继续第二轮');
{
  var room = setup3([1, 20, 20]);   // 甲只有 1 分，单张输 1 分就跌破 0
  playRound1(room);

  eq(room.results.round1.length, 3, '★ 三组全部结算（旧实现被 break 截成 1 组）');
  eq(room.results.round1[0].group, 'single', '第一组仍是单张');
  eq(room.phase, SM.PHASE.ROUND2_SPLIT, '★ 照常进第二轮（旧实现是 SETTLED）');
  eq(room.endReason, null, '★ 没有任何结束原因（旧实现是 scoreZero）');
  eq(room.groupsDone, 3, 'groupsDone = 3（恒等于本轮组总数）');

  /* 1 分 + 净得 −5 = −4。负分是合法状态，不是错误状态。 */
  eq(byId(room, 'p1').score, -4, '★ 甲是 −4（可以跌到 0 以下）');
  eq(byId(room, 'p2').score, 21, '乙 20 + 1');
  eq(byId(room, 'p3').score, 24, '丙 20 + 4');

  ok(byId(room, 'p1').out === false, '★ 甲没有 out 标记（不再有「出局」这回事）');
  eq(room.bustedIds.length, 0, 'bustedIds 恒为空');
}

/* ================================================================
 * 2. 跌到 0 之后继续被扣 → 一路扣成负数
 * ================================================================ */
head('[2] 归零不是终点：0 分的人继续被扣');
{
  var room = setup3([5, 20, 20]);   // 5 分打满三组正好 0
  playRound1(room);

  eq(byId(room, 'p1').score, 0, '（前置）甲第一轮打完正好 0 分');
  eq(room.phase, SM.PHASE.ROUND2_SPLIT, '★ 0 分照样进第二轮（旧实现当场结账）');
  ok(byId(room, 'p1').out === false, '0 分不算出局');

  /* 第二轮单张再输 1 分 → 从 0 变 −1，是真的跌破 0 了。
   * 断言单组的 delta 而不是最终分：这一把甲在斗牛组赢回来 +6，
   * 最终分是正的，但「0 分照样被扣」这件事发生在单张组那一刻。 */
  playRound2(room);
  eq(room.results.round2.length, 2, '第二轮两组都算完');
  ok(room.results.round2[0].deltas.p1 < 0,
    '★ 0 分的人在单张组继续被扣（旧实现到这一步已经结账了）');
  eq(byId(room, 'p1').score, 5, '甲 0 −1（单张）+6（斗牛）= 5');

  /* 飘三叶的计分档确实按场上豹子数走（2 个豹子 → 1 + 2 = 3 分/人） */
  var psy = room.results.round1.filter(function (g) { return g.group === 'piaosanye'; })[0];
  eq(psy.winPoints, 3, '两个豹子 → 每家付 3 分');
}

/* ================================================================
 * 3. 分数对账（v83 就有的门槛，口径不变）
 * ================================================================ */
head('[3] 分数对账：净得 == Σ组内 deltas，每组零和');
{
  var room = setup3([5, 20, 20]);
  var start = room.players.map(function (p) { return p.score; });
  playRound1(room);

  var sum = { p1: 0, p2: 0, p3: 0 };
  room.results.round1.forEach(function (g) {
    var groupSum = 0;
    for (var pid in g.deltas) {
      groupSum += g.deltas[pid];
      sum[pid] += g.deltas[pid];
    }
    eq(groupSum, 0, g.label + ' 组内零和');
  });

  room.players.forEach(function (p, i) {
    eq(p.score - start[i], sum[p.id], p.nickname + ' 净得 == Σdeltas');
    eq(sum[p.id], R1_NET[p.id], p.nickname + ' 三组净得与实测值一致（' + R1_NET[p.id] + '）');
  });
}

/* ================================================================
 * 4. 离开的人分数冻结，不参与任何判定
 * ================================================================ */
head('[4] left 的人不会被这一组连带');
{
  var room = setup3([20, 20, 20]);
  byId(room, 'p3').left = true;        // 丙已离开，分数冻结
  byId(room, 'p3').score = -8;         // 冻结在一个深度负分上
  room.players.forEach(function (p) { p.ready = true; });

  /* 只剩甲乙提交；丙 left 不进 activePlayers，也不进 pool */
  var g1 = PLAN.p1, g2 = PLAN.p2;
  byId(room, 'p1').hand = [].concat(g1.single, g1.tenhalf, g1.piaosanye);
  byId(room, 'p2').hand = [].concat(g2.single, g2.tenhalf, g2.piaosanye);
  SM.submitGroups(room, 'p1', { single: g1.single, tenhalf: g1.tenhalf, piaosanye: g1.piaosanye });
  SM.submitGroups(room, 'p2', { single: g2.single, tenhalf: g2.tenhalf, piaosanye: g2.piaosanye });

  eq(room.results.round1.length, 3, '两人也把三组都算完');
  eq(byId(room, 'p3').score, -8, '★ 离开的人分数一动不动（既不结算也不再扣）');
  ok(byId(room, 'p3').out !== true, '丙没有被标出局');
}

/* ================================================================
 * 5. 新一局把上一把的痕迹清干净
 * ================================================================ */
head('[5] 新一局重置 bustedIds / groupsDone / 分数');
{
  /* 3 局房打满 3 把才进 SETTLED —— 注意不能用「1 局房」图快：
   * 1 不在 CONFIG.HAND_LIMITS 白名单里，normalizeHandLimit 会把它收敛成 10。
   * 这是有意的（脏参数不许把房间变成永不结束），不是 bug。 */
  var room = setup3([1, 20, 20], 3);
  for (var i = 0; i < 3; i++) { playRound1(room); playRound2(room); }
  eq(room.phase, SM.PHASE.SETTLED, '（前置）3 局房打满 3 把 → 结算');
  eq(room.endReason, 'handLimit', '（前置）结束原因是打满局数');
  eq(room.groupsDone, 2, '（前置）最后一轮 2 组都算完');

  /* 全员报名下一局 → 各自准备 → startNextRound */
  room.players.forEach(function (p) { SM.wantNext(room, p.id); });
  room.players.forEach(function (p) { SM.setReady(room, p.id, true); });
  var r = SM.startNextRound(room);
  ok(r.ok, '开下一局成功');

  eq(room.bustedIds.length, 0, 'bustedIds 清空');
  eq(room.groupsDone, 0, 'groupsDone 归零');
  ok(room.players.every(function (p) { return p.out === false; }), '全员 out=false');
  /* 不管上一局是正是负，下一局一律回到初始分 —— 负分绝不跨局累积。 */
  ok(room.players.every(function (p) { return p.score === CONFIG.INITIAL_SCORE; }),
    '★ 分数重置回 ' + CONFIG.INITIAL_SCORE + '（负分不跨局累积）');
}

/* ================================================================
 * 6. 第二轮第 1 组跌破 0 → 斗牛组照样算，这一把正常打完
 * ================================================================ */
head('[6] 第二轮单张跌破 0 → 斗牛组照算，整把打完');
{
  var room = setup3([20, 20, 20]);
  playRound1(room);
  eq(room.phase, SM.PHASE.ROUND2_SPLIT, '（前置）进入第二轮');

  /* 把甲压到 1 分，单张输 1 分就跌破 0 */
  byId(room, 'p1').score = 1;
  playRound2(room);

  eq(room.results.round2.length, 2, '★ 单张 + 斗牛两组都结算（旧实现只算 1 组）');
  eq(room.phase, SM.PHASE.ROUND1_SPLIT, '★ 这一把打完，直接开下一把');
  eq(room.endReason, null, '★ 没有结束原因');

  /* 单张：丙赢 1 分档 → 甲 −1、乙 −1、丙 +2，甲从 1 变 0。
   * 斗牛：甲赢 3 分档 → 甲 +6、乙 −3、丙 −3。于是甲 0 + 6 = 6。 */
  eq(byId(room, 'p1').score, 6, '★ 甲跌破 0 之后又靠斗牛翻回正分');
  eq(byId(room, 'p2').score, 17, '乙 21 − 1 − 3');
  eq(byId(room, 'p3').score, 23, '丙 24 + 2 − 3');
}

/* ================================================================
 * 7. 没人跌破 0 时行为完全不变（回归保护）
 * ================================================================ */
head('[7] 没人跌破 0：老行为不变');
{
  var room = setup3([20, 20, 20]);
  playRound1(room);
  eq(room.results.round1.length, 3, '三组都结算');
  eq(room.phase, SM.PHASE.ROUND2_SPLIT, '进入第二轮');
  eq(room.endReason, null, '没有结账原因');
  eq(room.bustedIds.length, 0, 'bustedIds 为空');
  ok(room.players.every(function (p) { return p.out === false; }), '没人 out');
}

/* ================================================================
 * 8. 雷达撤掉之后：房间对象里不该再有「计时」字段
 * ================================================================ */
head('[8] 房间不再记每把用时（雷达已是废功能，配套字段一并撤掉）');
{
  var room = setup3([20, 20, 20]);
  eq(room.handStartedAt, undefined, '没有 handStartedAt');
  eq(room.handMsTotal, undefined, '没有 handMsTotal');
  eq(room.handsDone, undefined, '没有 handsDone');
  playRound1(room);
  eq(room.phase, SM.PHASE.ROUND2_SPLIT, '（前置）第一轮照常结算，不依赖这些字段');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
