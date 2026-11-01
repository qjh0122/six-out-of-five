/**
 * 「一手牌」身份键测试（handKey）
 * 跑法：node pwa/test/handkey.test.js
 *
 * 线上症状：点「开下一把」后，新一局的牌区里还留着**上一把**已经分好的牌，
 * 但那些牌既点不动也拖不回，手牌区 6 张新牌又一张都放不进牌区，整轮分牌死锁。
 *
 * 根因：客户端的分牌草稿用 room.round 判重。换手有两条路径，round 都会回到 1：
 *   A. 结算页「开下一把」restart()：round=1、handCount=1、handSeq +1
 *   B. 第二轮结算后无人见底、就地续局 settleRound(2)：round=1、handCount +1
 * 于是「上一把第 1 轮」和「这一把第 1 轮」的 round 完全相同 → 草稿没清 → 死锁。
 *
 * 修法：键 = handSeq:handCount:round，三个分量各自挡住一条路径。
 * 这个测试锁住键的唯一性，防止有人把它简化回「只看 round」。
 */
'use strict';

const SM = require('../js/stateMachine.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function ne(a, b, name) { ok(a !== b, name, '两者不应相等，都是 ' + JSON.stringify(a)); }

function makeRoom(ids) {
  const room = SM.newRoom('R-HK', { id: ids[0], nickname: ids[0] });
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

/* 结算 → 真正发出下一把的牌。
 *
 * 以前 restart() 一步到位（清分 + 发牌 + 进第一轮），现在拆成了
 * 「各自报名 → 各自准备 → 全员就绪自动开局」，少走一步就还是结算态。
 * handKey 的全部价值在于「新一把的第 1 轮不能撞上一把的第 1 轮」，
 * 所以这里必须真的走到发牌，不能只调 restart 就断言。 */
function startNextHand(room) {
  const alive = SM.activePlayers(room);
  alive.forEach((p) => { if (!p.wantNext) SM.wantNext(room, p.id); });
  alive.forEach((p) => { SM.setReady(room, p.id, true); });
  return SM.autoStartIfReady(room);
}

/* 当前在场玩家全部按手牌顺序分好组并提交，推进一轮 */
function allSubmit(room) {
  const round = room.round;
  SM.activePlayers(room).forEach((p) => {
    SM.submitGroups(room, p.id, buildGroups(p.hand, round), round);
  });
}

/* 解散投票 → SETTLED（handSeq 会 +1），模拟「结算页」的前置状态 */
function dissolveToSettled(room) {
  const ids = SM.activePlayers(room).filter((p) => !p.isBot).map((p) => p.id);
  SM.proposeDissolve(room, ids[0]);
  ids.slice(1).forEach((id) => SM.voteDissolve(room, id, true));
}

console.log('\n[导出检查]');
ok(typeof SM.handKey === 'function', 'stateMachine 导出了 handKey');

console.log('\n[路径 B：第二轮打完就地续局，round 回到 1]');
let room = makeRoom(['a', 'b']);
const k1 = SM.handKey(room);
eq(k1, '0:1:1', '开局键为 handSeq:handCount:round = 0:1:1');

allSubmit(room);
eq(room.round, 2, '两位玩家都提交后进入第二轮');
const k2 = SM.handKey(room);
eq(k2, '0:1:2', '第二轮键为 0:1:2');
ne(k1, k2, '轮次变了键就变');

allSubmit(room);
eq(room.round, 1, '第二轮结束、无人见底 → 自动续局，round 回到 1');
eq(room.handCount, 2, '续局后 handCount 变成 2');
const k3 = SM.handKey(room);
eq(k3, '0:2:1', '续局后的键为 0:2:1');
ne(k1, k3, '★ 续局第 2 把第 1 轮 ≠ 第 1 把第 1 轮 —— 旧实现（只看 round）正是在这里撞键');
ok(room.players.every((p) => p.submitted.round1 === false), '续局后提交状态已清空（服务端数据是干净的，问题只在客户端草稿）');

console.log('\n[路径 A：「开下一把」restart，round 和 handCount 都回到 1]');
let room2 = makeRoom(['a', 'b']);
const a1 = SM.handKey(room2);
eq(a1, '0:1:1', '第一把开局键 0:1:1');
dissolveToSettled(room2);
eq(room2.phase, SM.PHASE.SETTLED, '全员同意解散 → 进入结算');
const aSet = SM.handKey(room2);
eq(aSet, '1:1:1', '结算后 handSeq +1，键变 1:1:1');
let rr = SM.restart(room2, 'a');
ok(rr.ok === true, 'a 点了「开始下一局」', rr.error);
const hkStarted = startNextHand(room2);
ok(!!hkStarted && hkStarted.kind === 'next', '全员就绪 → 自动发出下一把的牌');
eq(room2.round, 1, '新一把 round 从 1 开始');
eq(room2.handCount, 1, '新一把 handCount 也从 1 开始');
const a2 = SM.handKey(room2);
eq(a2, '1:1:1', '新一把的键 1:1:1（比上一把多了 handSeq）');
ne(a2, a1, '★ 新一把第 1 轮 ≠ 上一把第 1 轮 —— 这正是用户截图里的那一把');
ok(room2.players.every((p) => p.score === SM.findPlayer(room2, p.id).score), '分数可读');

console.log('\n[连续多把：任何两个状态都不会算出同一个键]');
const seen = new Map();
function remember(room2, label) {
  const k = SM.handKey(room2);
  ok(!seen.has(k), label + '：键 ' + k + ' 之前没出现过（' + (seen.get(k) || '') + '）');
  seen.set(k, label);
}
remember(room2, '第 2 把第 1 轮');
allSubmit(room2);
remember(room2, '第 2 把第 2 轮');
allSubmit(room2);                       // 就地续局 → 第 3 把第 1 轮
remember(room2, '第 3 把第 1 轮');
allSubmit(room2);
remember(room2, '第 3 把第 2 轮');
dissolveToSettled(room2);
ok(room2.phase === SM.PHASE.SETTLED, '第 3 把中途解散 → 结算');
// 结算状态下 handKey 可能和「上一把第 1 轮」相同是**安全的**：结算页根本不走 ensureDraft，
// 但真的发出下一把之后必须又是新键
SM.restart(room2, 'a');
startNextHand(room2);
remember(room2, '第 4 把第 1 轮');
console.log('  共 ' + seen.size + ' 个互不相同的键');

console.log('\n[老房间兼容：handSeq / handCount 缺失不报错]');
const legacy = makeRoom(['x', 'y']);
delete legacy.handSeq;
delete legacy.handCount;
eq(SM.handKey(legacy), '0:1:1', '缺字段时退化为 0:1:1（旧存档也能玩）');

console.log('\n[纯函数：同一房间重复计算稳定]');
const room3 = makeRoom(['p', 'q']);
ok(SM.handKey(room3) === SM.handKey(room3), '重复计算得到同一个键（无副作用）');

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
