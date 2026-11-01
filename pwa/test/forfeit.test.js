/**
 * 分牌超时「本回合弃权」测试
 * 跑法：node pwa/test/forfeit.test.js
 *
 * 背景：有人开着页面不提交（挂机），整桌会永久卡死。
 * 方案：分牌超时后自动「本回合弃权」——弃权者仍留在房间、下一把照常玩，
 *       本回合按空分组结算（各组当弃权，向赢家正常付分、自己 0 分）。
 * 关键约束（区别于「弃局 left」）：
 *   - 弃权者不 left，仍在 activePlayers 里，下一把能玩
 *   - 弃权后其余人提交即结算，不再等弃权者
 *   - 弃权者本回合不会拿到分（躺赢被杜绝）
 */
'use strict';

const SM = require('../js/stateMachine.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

function makeRoom(ids) {
  const room = SM.newRoom('R-FT', { id: ids[0], nickname: ids[0] });
  ids.slice(1).forEach((id) => SM.joinRoom(room, { id: id, nickname: id }));
  room.players.forEach((p) => { p.ready = true; });
  SM.startGame(room, ids[0]);
  return room;
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

console.log('\n[弃权基本语义：两人局，一人超时弃权]');

let room = makeRoom(['a', 'b']);
let a = SM.findPlayer(room, 'a');
let b = SM.findPlayer(room, 'b');

// b 超时弃权
let r = SM.forfeitRound(room, 'b');
eq(r.ok, true, '弃权成功');
eq(b.forfeitRound, 1, '标记本回合弃权');
eq(b.submitted.round1, true, '弃权视为已提交');
ok(!b.left, '弃权不等于弃局（还在房间）');
eq(b.groups.round1.single.length, 0, '弃权分组为空（各组都弃权）');

// a 正常提交后，应立刻结算（不再等 b）
const g = buildGroups(a.hand.slice(), 1);
r = SM.submitGroups(room, 'a', g);
eq(r.ok, true, 'a 正常提交');
eq(room.phase, 'ROUND2_SPLIT', '两人局：a 提交后立即结算进入第二轮（弃权者不卡桌）');

console.log('\n[弃权者本回合不得分，且正常付分给赢家]');

// 记录第一轮结算后 b 的分数变化：b 弃权，a 全赢，b 应该被扣分
// 用单张组验证：a 的单张必然赢过 b 的空组
const r1 = room.results.round1;
ok(Array.isArray(r1), '第一轮有结算结果');
let bPaid = false;
r1.forEach((grp) => {
  if (grp.winnerId === 'a' && grp.deltas && grp.deltas.b < 0) bPaid = true;
});
ok(bPaid, '弃权者 b 向赢家 a 付了分（不得分）');

console.log('\n[弃权者下一把能继续玩]');

/* 结算 → 下一局现在是两步：各自报名「开始下一局」，各自准备，全员就绪自动开局。
 * 这条测的是 dealAll 对弃权标记的清理，所以两步都要走完 —— 只点报名不发牌，
 * 断言会全部落在「没变化」上而假通过。 */
room.phase = SM.PHASE.SETTLED;
room.endReason = 'scoreZero';
SM.wantNext(room, 'b');
SM.setReady(room, 'b', true);
const rr = SM.restart(room, 'a');          // a 报名，并视为已准备（旧入口的语义）
eq(rr.ok, true, '房主点了「开始下一局」');
const nextStarted = SM.autoStartIfReady(room);
eq(nextStarted && nextStarted.kind, 'next', '双方都就绪 → 自动开下一局');
eq(b.forfeitRound, null, '新一把弃权标记被清掉');
eq(b.left, false, '弃权者仍可继续玩');
ok(b.submitted.round1 === false, '新一把提交状态复位');

console.log('\n[边界：已提交者不能弃权 / 非分牌阶段不能弃权]');

let room2 = makeRoom(['x', 'y']);
let x = SM.findPlayer(room2, 'x');
let y = SM.findPlayer(room2, 'y');
const g2 = buildGroups(x.hand.slice(), 1);
SM.submitGroups(room2, 'x', g2);
let r2 = SM.forfeitRound(room2, 'x');
eq(r2.ok, false, '已提交的人不能再弃权');
r2 = SM.forfeitRound(room2, 'y');
eq(r2.ok, true, '未提交的 y 可以弃权');
eq(room2.phase, 'ROUND2_SPLIT', 'x 已提交 + y 弃权 → 结算进第二轮');

console.log('\n[边界：非分牌阶段弃权被拒]');

let room3 = makeRoom(['m', 'n']);
room3.phase = SM.PHASE.WAITING;
let r3 = SM.forfeitRound(room3, 'm');
eq(r3.ok, false, '等待阶段不能弃权');

console.log('\n[边界：弃局者不能弃权]');

let room4 = makeRoom(['p', 'q']);
let p = SM.findPlayer(room4, 'p');
p.left = true;
let r4 = SM.forfeitRound(room4, 'p');
eq(r4.ok, false, '弃局者不能弃权');

console.log('\n[关键：弃权之后不能再提交真牌]');
/* 弃权会把 submitted 置 true 并把四条分组清空。如果 submitGroups 不先拦，
 * 就会走「已提交 → 允许修改一次」那条通道，把空分组换成真牌 ——
 * 超时弃权的约束等于没有，挂机的人反而能事后补一手。 */
const room5 = makeRoom(['u', 'v']);
const u = SM.findPlayer(room5, 'u');
const keepHand = u.hand.slice();
const f5 = SM.forfeitRound(room5, 'u');
eq(f5.ok, true, 'u 弃权成功');
eq(u.forfeitRound, 1, 'u 的 forfeitRound 记为本轮');
eq(u.submitted.round1, true, '弃权同时把 submitted 置 true');

const retry = SM.submitGroups(room5, 'u', buildGroups(keepHand, 1));
eq(retry.ok, false, '弃权后再提交被拒');
ok(/弃权/.test(retry.error || ''), '错误文案说明是弃权（不是「每组必须填满」这种误导）', retry.error);
eq(u.forfeitRound, 1, '被拒后弃权状态没被抹掉');
eq(u.groups.round1.single.length, 0, '分组仍然是空的（没被真牌替换）');

console.log('\n[下一轮可以正常提交：弃权只锁本回合]');
/* 两个人：u 弃权第一轮、v 提交 → 进第二轮，u 应当能正常提交 */
const room6 = makeRoom(['u2', 'v2']);
const u2 = SM.findPlayer(room6, 'u2');
const v2 = SM.findPlayer(room6, 'v2');
SM.forfeitRound(room6, 'u2');
const s6 = SM.submitGroups(room6, 'v2', buildGroups(v2.hand, 1));
eq(s6.ok, true, 'v2 提交推进结算');
eq(room6.phase, 'ROUND2_SPLIT', '已进入第二轮');
const u2r2 = SM.submitGroups(room6, 'u2', buildGroups(u2.hand, 2));
eq(u2r2.ok, true, 'u2 第二轮可以正常提交（弃权不跨轮）');
eq(u2.forfeitRound, 1, 'forfeitRound 仍停在第一轮，不会被误清');

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
