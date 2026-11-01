/**
 * 逐轮回放归档（P3-7）
 * 跑法：node pwa/test/replay.test.js
 *
 * 结算页只有分数变化，"刚才那把怎么输的"看不出来 —— 四组玩法规则差异大，
 * 到底是哪一组输的、对方当时什么牌，全在 lastResult 里，而它下一把就被覆盖。
 *
 * 所以每轮结算时把结果收进 room.history。这里验的就是归档本身：
 *  1. 两轮各归档一条，字段够用（赢家、加减分、每人的牌）；
 *  2. 归档的是**精简副本**，不能把 entries 的中间判定过程原样塞进广播；
 *  3. 有上限，打很多把也不会让 room 无限膨胀（每帧广播都会带上它）。
 */
'use strict';

var SM = require('../js/stateMachine.js');
var CONFIG = require('../js/config.js');

var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

function player(id, nick) {
  return {
    id: id, nickname: nick, ready: true, left: false, connected: true,
    disconnectedAt: null, score: CONFIG.INITIAL_SCORE, hand: [],
    groups: null, submitted: { round1: false, round2: false }
  };
}

/* 用真实手牌分组：不能凭空造牌，submitGroups 会校验牌在手牌里 */
function groups1(p) {
  return {
    single: [p.hand[0]],
    tenhalf: [p.hand[1], p.hand[2]],
    piaosanye: [p.hand[3], p.hand[4], p.hand[5]]
  };
}
function groups2(p) {
  return { single: [p.hand[0]], douniu: [p.hand[1], p.hand[2], p.hand[3], p.hand[4], p.hand[5]] };
}

var room = SM.newRoom('999001', player('p1', '甲'));
room = SM.joinRoom(room, player('p2', '乙')).room;
SM.setReady(room, 'p1', true);
SM.setReady(room, 'p2', true);
var sg = SM.startGame(room, 'p1');
ok(sg.ok === true, '开局成功', JSON.stringify(sg));
room = sg.room;

var p1 = SM.findPlayer(room, 'p1');
var p2 = SM.findPlayer(room, 'p2');
ok(p1.hand.length === 6 && p2.hand.length === 6, '两人各 6 张牌');

/* ---------------------------------------------------------------- */
console.log('\n[1] 第一轮结算后归档 1 条');
var s1 = SM.submitGroups(room, 'p1', groups1(SM.findPlayer(room, 'p1')));
ok(s1.ok === true, '甲提交成功', JSON.stringify(s1));
room = s1.room || room;
var s2 = SM.submitGroups(room, 'p2', groups1(SM.findPlayer(room, 'p2')));
ok(s2.ok === true, '乙提交成功', JSON.stringify(s2));
room = s2.room || room;

ok(Array.isArray(room.history), 'room.history 是数组');
eq(room.history.length, 1, '★ 第一轮归档 1 条');
var h1 = room.history[0];
eq(h1.round, 1, 'round = 1');
eq(h1.hand, 1, 'hand = 1（第一把）');
eq(h1.groups.length, 3, '★ 第一轮 3 组都记了（单张/十点半/飘三叶）');
ok(h1.groups.every(function (g) { return !!g.group && !!g.label; }), '每组都有 key 和中文名');

/* ---------------------------------------------------------------- */
console.log('\n[2] 归档里要有"谁赢、加减多少、每人的牌"');
var g0 = h1.groups[0];
ok(!!g0.winnerId, '有 winnerId');
ok(typeof g0.winnerNickname === 'string' && g0.winnerNickname.length > 0, '有赢家昵称');
ok(g0.deltas && typeof g0.deltas === 'object', '有 deltas');
ok(Object.keys(g0.deltas).length >= 2, 'deltas 覆盖所有参战的人');
ok(Array.isArray(g0.entries) && g0.entries.length >= 2, 'entries 是数组');
ok(g0.entries.every(function (e) { return Array.isArray(e.hand); }), '每人都有 hand 字段');
/* ★ 名字。这一条是补一个「从来没对过」的字段：
 * Engine.settleGroup 返回的 entries 里**没有 nickname**，归档处直接抄 e.nickname
 * 拿到的是 undefined，于是一整列名字全是空串（回放里只剩「6♣ +2」）。
 * 以前这里只查 hand，所以这个洞活了很多版本。 */
ok(g0.entries.every(function (e) {
  return typeof e.nickname === 'string' && e.nickname.length > 0;
}), '★ 每人都有昵称（不能是空串 / undefined）',
  JSON.stringify(g0.entries.map(function (e) { return e.nickname; })));
var names = g0.entries.map(function (e) { return e.nickname; }).sort().join(',');
eq(names, '乙,甲', '★ 昵称来自房间玩家，和牌桌上的名字一致');
var totalCards = g0.entries.reduce(function (n, e) { return n + e.hand.length; }, 0);
ok(totalCards >= 2, '★ 牌面真的被记下来了（共 ' + totalCards + ' 张），不是空数组');
/* 零和：一组的加减分加起来必须是 0，否则归档和实际结算口径不一致 */
var sum = Object.keys(g0.deltas).reduce(function (n, k) { return n + g0.deltas[k]; }, 0);
eq(sum, 0, '★ 单组 deltas 之和为 0（零和）');

/* ---------------------------------------------------------------- */
console.log('\n[3] 归档的是精简副本，不是 entries 原样');
ok(g0.entries.every(function (e) {
  return Object.keys(e).length <= 4;   // id / nickname / hand（+ 可能多一个）
}), '★ entries 只留必要字段，没有把判定中间过程塞进广播');
ok(!('resolved' in (g0.entries[0] || {})), '不含 resolved（内部判定用，前端不需要）');

/* ---------------------------------------------------------------- */
console.log('\n[4] 第二轮结算后 2 条，且轮次正确');
var t1 = SM.submitGroups(room, 'p1', groups2(SM.findPlayer(room, 'p1')));
room = t1.room || room;
var t2 = SM.submitGroups(room, 'p2', groups2(SM.findPlayer(room, 'p2')));
room = t2.room || room;
eq(room.history.length, 2, '★ 第二轮又归档 1 条，共 2 条');
eq(room.history[1].round, 2, '第二条是 round 2');
eq(room.history[1].groups.length, 2, '第二轮 2 组（单张/斗牛）');
var labels2 = room.history[1].groups.map(function (g) { return g.group; }).join(',');
ok(labels2.indexOf('douniu') >= 0, '第二轮里有斗牛');

/* ---------------------------------------------------------------- */
console.log('\n[5] 上限：history 不会无限长');
ok(/history\.length > 4/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'stateMachine.js'), 'utf8')),
  '★ 有上限判断（保留最近 4 条 ≈ 两把）');
ok(room.history.length <= 4, '当前没超上限');

/* ---------------------------------------------------------------- */
console.log('\n[6] 空房间 / 新房间的默认值');
var fresh = SM.newRoom('999002', player('q1', '丙'));
ok(Array.isArray(fresh.history), '新房间 history 是空数组，不是 undefined');
eq(fresh.history.length, 0, '初始为空');
ok(!!fresh.results && fresh.results.round1 === null, 'results 结构没被破坏');

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
