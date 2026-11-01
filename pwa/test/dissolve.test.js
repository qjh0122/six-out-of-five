/**
 * 解散投票测试
 * 跑法：node pwa/test/dissolve.test.js
 *
 * 核心规则：投票只统计「在场 + 真人 + 在线」的玩家。
 * 机器人无法应答投票，一旦计入 quorum 就会永久卡在「等待其他玩家同意」——
 * 这是线上实际报上来的问题，所以每条都要锁死。
 */
'use strict';

const SM = require('../js/stateMachine.js');
const CONFIG = require('../js/config.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

const P = (id, extra) => Object.assign({ id: id, nickname: id }, extra || {});
const BOT = (id) => P(id, { isBot: true });

/* 构造一个已经开局的房间（解散只在对局中有意义） */
function makeRoom(players) {
  const owner = players[0];
  const room = SM.newRoom('R-TEST', owner);
  players.slice(1).forEach((p) => SM.joinRoom(room, p));
  room.phase = SM.PHASE.ROUND1_SPLIT;
  // 每个玩家发 6 张牌，模拟真实开局
  room.players.forEach(function (p, i) {
    p.hand = [];
    for (let k = 0; k < 6; k++) p.hand.push({ suit: 'spade', rank: 2 + ((i + k) % 12) });
  });
  return room;
}

console.log('\n[单人 + AI：发起即解散，不等待]');

let room = makeRoom([P('me'), BOT('bot_1'), BOT('bot_2')]);
ok(SM.dissolveVoters(room).length === 1, '有效投票人只有 1 个（AI 不计入）');

let r = SM.proposeDissolve(room, 'me');
ok(r.ok === true, '发起解散成功');
ok(r.settled === true, '只有自己在场 → 立即成立');
ok(room.phase === SM.PHASE.SETTLED, '房间直接进入 SETTLED，不再卡住');
ok(room.dissolve.active === false, '投票标记已清理');
ok(room.handSeq === 1, '场次序号 +1（作废的一把也占号，避免和下一把撞键）');
/* 这两个标记是「解散不吃亏」的全部依据：
 *   voided    → hub 落库时跳过（不记一场 0 分平局，不断连胜）
 *   endReason → 结算页说一句「本局中途结束，不计入战绩」 */
ok(room.voided === true, '★ 一分没打就结束 → 标记作废（不进档案）');
ok(room.endReason === 'dissolve', '★ 结账原因写成 dissolve（结算页据此说明）');

console.log('\n[打过分的局不算作废：真实的输赢必须照记]');
/* 分数每一轮就在加减，一局常常已经打了好几把才被结束。
 * 这种局要是也作废，等于把玩家已经打出来的战绩抹掉 —— 比原来更糟。 */
room = makeRoom([P('a'), P('b')]);
room.players[0].score = 26;   // 甲已经赢着
SM.proposeDissolve(room, 'a');
SM.voteDissolve(room, 'b', true);
ok(room.voided === false, '★ 有人分数动过 → 不作废');
ok(room.phase === SM.PHASE.SETTLED, '照样进结算（分数按现状写入档案）');

console.log('\n[单人 + 3 个 AI：同样立即解散]');
room = makeRoom([P('me'), BOT('b1'), BOT('b2'), BOT('b3')]);
r = SM.proposeDissolve(room, 'me');
ok(r.settled === true && room.phase === SM.PHASE.SETTLED, 'AI 数量再多也不影响');

console.log('\n[2 人 + AI：仍需另一个真人同意]');
room = makeRoom([P('a'), P('b'), BOT('bot_1')]);
ok(SM.dissolveVoters(room).length === 2, '有效投票人 2 个');

r = SM.proposeDissolve(room, 'a');
ok(r.ok === true && !r.settled, '发起后不立即成立');
ok(room.dissolve.active === true, '投票进行中');
ok(room.phase === SM.PHASE.ROUND1_SPLIT, '对局尚在继续');
ok(room.dissolve.votes['a'] === true, '发起者默认投同意');

r = SM.voteDissolve(room, 'b', true);
ok(r.settled === true, '第二人同意 → 成立');
ok(room.phase === SM.PHASE.SETTLED, '进入结算');
ok(room.handSeq === 1, '场次序号 +1');

console.log('\n[2 人 + AI：被否决]');
room = makeRoom([P('a'), P('b'), BOT('bot_1')]);
SM.proposeDissolve(room, 'a');
r = SM.voteDissolve(room, 'b', false);
ok(r.rejected === true, '有人拒绝 → 否决');
ok(room.dissolve.active === false, '投票作废');
ok(room.phase === SM.PHASE.ROUND1_SPLIT, '对局继续，没有误结算');
// 否决后重新发起：整个投票对象被重建，旧票不残留
r = SM.proposeDissolve(room, 'b');
ok(r.ok === true && !r.settled, '可以重新发起解散');
ok(room.dissolve.initiatorId === 'b', '发起人换成新的');
ok(room.dissolve.votes['a'] === undefined, '旧票已清空（a 需要重新表态）');
ok(room.dissolve.votes['b'] === true, '新发起者默认同意');

console.log('\n[掉线真人：等不到票，不计入 quorum]');
room = makeRoom([P('a'), P('b'), BOT('bot_1')]);
room.players[1].connected = false;          // b 掉线但还没到宽限超时
ok(SM.dissolveVoters(room).length === 1, '掉线的人被排除');
r = SM.proposeDissolve(room, 'a');
ok(r.settled === true, '只剩自己在线 → 立即解散，不会干等一个连不上的人');

console.log('\n[已离开的玩家不计入]');
room = makeRoom([P('a'), P('b'), BOT('bot_1')]);
room.players[1].left = true;
ok(SM.dissolveVoters(room).length === 1, '弃局的人被排除');
r = SM.proposeDissolve(room, 'a');
ok(r.settled === true, '立即解散');

console.log('\n[幂等与边界]');
room = makeRoom([P('a'), P('b'), BOT('bot_1')]);
SM.proposeDissolve(room, 'a');
const again = SM.proposeDissolve(room, 'a');
ok(again.ok === true && again.settled !== true, '重复发起是幂等的，不会误结算');
ok(room.dissolve.votes['a'] === true, '投票状态没被清空');

r = SM.proposeDissolve(room, 'b');
ok(r.ok === true && room.dissolve.initiatorId === 'a', '别人再发起仍指向原发起人');

room = makeRoom([P('a')]);
room.phase = SM.PHASE.SETTLED;
r = SM.proposeDissolve(room, 'a');
ok(r.ok === false && /结账/.test(r.error), '已结算的房间不能发起解散');

room = makeRoom([P('a'), P('b'), BOT('bot_1')]);
r = SM.proposeDissolve(room, 'stranger');
ok(r.ok === false, '不在房间的人不能发起');

room = makeRoom([P('a'), P('b'), BOT('bot_1')]);
r = SM.voteDissolve(room, 'b', true);
ok(r.ok === false, '没有投票时投票被拒绝');

console.log('\n[AI 不会投出真实票]');
room = makeRoom([P('a'), P('b'), BOT('bot_1')]);
SM.proposeDissolve(room, 'a');
const botVote = SM.voteDissolve(room, 'bot_1', true);
ok(room.dissolve.votes['bot_1'] === true, '即使 AI 被强行投票也会记录');
ok(botVote.settled !== true, '但 AI 单独同意不构成解散（quorum 只算真人）');
ok(room.phase === SM.PHASE.ROUND1_SPLIT, '对局没有被 AI 的票误结算');

console.log('\n[真人之间 3 人：需全部同意]');
room = makeRoom([P('a'), P('b'), P('c'), BOT('bot_1')]);
SM.proposeDissolve(room, 'a');
let r1 = SM.voteDissolve(room, 'b', true);
ok(!r1.settled, '两人同意还不够');
let r2 = SM.voteDissolve(room, 'c', true);
ok(r2.settled === true, '第三人同意 → 成立');

console.log('\n[解散后能正常开下一局]');
room = makeRoom([P('a'), P('b'), BOT('bot_1')]);
SM.proposeDissolve(room, 'a');
SM.voteDissolve(room, 'b', true);
ok(room.phase === SM.PHASE.SETTLED, '解散后处于结算阶段');
/* 报名制：a 点「开始下一局」；AI 在 markSettled 时就被预置为已报名 + 已准备。
 * b 没点 —— 他应该留在结算页，并且不在新一局里。 */
const restarted = SM.restart(room, 'a');
ok(restarted.ok === true, 'a 点了「开始下一局」');
const nextStarted = SM.autoStartIfReady(room);
ok(!!nextStarted && nextStarted.kind === 'next', '本人 + AI 都就绪 → 自动开下一局');
ok(room.phase === SM.PHASE.ROUND1_SPLIT, '回到第一轮分牌');
ok(room.dissolve.active === false && room.dissolve.initiatorId === null, '新一局解散状态已重置');
ok(room.handSeq === 1, '场次序号保留，不会归零（否则战绩判重会出错）');
ok(room.players.every(function (p) { return p.hand.length === 6; }), '新一局每人重新发 6 张');
ok(!SM.findPlayer(room, 'b'), '★ 没点「开始下一局」的 b 不在新一局里（没点的人不影响别人）');
ok(nextStarted.removed.indexOf('b') >= 0, '★ b 被告知「新的一局开始了」（removed 名单里有他）');

console.log('\n[发起人可以取消，别人不行]');
room = makeRoom([P('a'), P('b'), P('c')]);
SM.proposeDissolve(room, 'a');
ok(room.dissolve.active === true, '投票已开始');
let cx = SM.cancelDissolve(room, 'b');
ok(cx.ok === false, '非发起人取消被拒');
ok(room.dissolve.active === true, '被拒后投票仍然有效');
cx = SM.cancelDissolve(room, 'a');
ok(cx.ok === true, '发起人可以取消');
ok(room.dissolve.active === false && room.dissolve.initiatorId === null, '取消后投票状态清空');
ok(room.dissolve.lastReason === 'cancelled', '结束原因记为 cancelled（界面据此提示「发起人取消」）');
ok(room.phase === SM.PHASE.ROUND1_SPLIT, '取消不会让对局结束');
ok(SM.cancelDissolve(room, 'a').ok === false, '没有投票时再取消会被拒（幂等安全）');

console.log('\n[超时自动作废：谁也没被扣分，房间回到对局]');
room = makeRoom([P('a'), P('b'), P('c')]);
SM.proposeDissolve(room, 'a');
const startAt = room.dissolve.startedAt;
ok(typeof startAt === 'number' && startAt > 0, '发起时记录了 startedAt（超时的起点）');
ok(SM.expireDissolve(room, startAt + 1000) === false, '才过 1 秒 → 不作废');
ok(room.dissolve.active === true, '投票仍在进行');
ok(SM.expireDissolve(room, startAt + SM.DISSOLVE_TIMEOUT_MS - 1) === false, '差 1ms 到点 → 仍不作废');
ok(SM.expireDissolve(room, startAt + SM.DISSOLVE_TIMEOUT_MS) === true, '满 30 秒 → 作废');
ok(room.dissolve.active === false, '投票已关闭');
ok(room.dissolve.lastReason === 'expired', '结束原因记为 expired');
ok(room.phase === SM.PHASE.ROUND1_SPLIT, '房间仍在第一轮分牌（没被解散、也没结算）');
ok(room.players.every(function (p) { return p.score === CONFIG.INITIAL_SCORE; }), '没有人被扣分');
ok(SM.expireDissolve(room, startAt + 99999) === false, '已经作废后再调用不会重复触发（避免重复广播）');

console.log('\n[超时后可以重新发起，计时重新开始]');
r = SM.proposeDissolve(room, 'b');
ok(r.ok === true, '超时作废后能再发起');
ok(room.dissolve.startedAt >= startAt, 'startedAt 重新计时（不沿用上一次的时间）');
ok(room.dissolve.active === true, '新一轮投票是有效的');
ok(SM.expireDissolve(room, room.dissolve.startedAt + SM.DISSOLVE_TIMEOUT_MS) === true, '新一轮同样会超时作废');

console.log('\n[被否决的提示与超时要能区分]');
room = makeRoom([P('a'), P('b'), P('c')]);
SM.proposeDissolve(room, 'a');
SM.voteDissolve(room, 'b', false);
ok(room.dissolve.lastReason === 'rejected', '有人拒绝 → lastReason = rejected');

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
