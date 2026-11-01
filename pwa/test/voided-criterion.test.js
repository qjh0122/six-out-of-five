/**
 * 「这一局算不算数」的判据测试
 * 跑法：node pwa/test/voided-criterion.test.js
 *
 * 背景：一局没打成（一分没动）就不该进档案 —— 否则玩家档案里会多出一场
 * 「净胜 0」的平局：场次 +1、胜率被稀释、连胜被清成 0。
 *
 * 这个标记叫 room.voided。它曾经只在 finishDissolve 里写，于是：
 *   · 20/20 点「结束本局」   → 作废，不记   ✅
 *   · 20/20 对手掉线判弃     → 照记一场 0 分平局 ❌  ← 漏的就是这条路
 * 而状态机里有**三条**结束路径，「作废与否」却只在一条上判过。
 *
 * 现在统一在 markSettled() 里判 —— 那是三条路径唯一的收口。
 * 本文件锁住两件事：
 *   1. 三条结束路径的作废口径必须一致（同一个判据，不是各算一遍）
 *   2. 判据是「有没有一轮真的加减过分」，不是「分数是否都等于 20」
 *      —— 后者会把「先赢 1 分又输 1 分」这种真打完的局误判成没打。
 */
'use strict';

const SM = require('../js/stateMachine.js');
const CONFIG = require('../js/config.js');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + label); }
  else { fail += 1; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, label) { ok(a === b, label, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

/* 基准分一律读 CONFIG.INITIAL_SCORE（v106 起是 0）。这里原本有一份
 * `const INITIAL = 20`，基准改成 0 之后它就成了「测试自己编的基准」，
 * 会让所有判据类用例失去判别力，已删除。 */

/* 造一个 n 人、已开局（phase=ROUND1_SPLIT）的房间 */
function startedRoom(roomId, ids) {
  const room = SM.newRoom(roomId, { id: ids[0], nickname: ids[0] });
  ids.slice(1).forEach(function (id) { SM.joinRoom(room, { id: id, nickname: id }); });
  ids.forEach(function (id) { SM.setReady(room, id, true); });
  SM.startGame(room, ids[0]);
  return room;
}

/* 手动把一局的分数改掉，并打上「动过分」的标记 ——
 * 不去驱动真实结算（那要凑齐 6 张分组），这里要验的是判据本身。 */
function pretendPlayed(room, scores) {
  Object.keys(scores).forEach(function (id) {
    SM.findPlayer(room, id).score = scores[id];
  });
  room.anyScoreChange = true;
}

/* ---------------------------------------------------------------- */
console.log('\n[1] 三条结束路径，口径必须一致');

console.log('  · 路径 A：结束本局（finishDissolve）');
(function () {
  const room = startedRoom('V-A1', ['A', 'B']);
  SM.proposeDissolve(room, 'A');
  SM.voteDissolve(room, 'B', true);
  eq(room.phase, SM.PHASE.SETTLED, '  进入结算');
  eq(room.endReason, 'dissolve', '  原因是 dissolve');
  eq(room.voided, true, '  ★ 一分没打 → 作废');
})();

console.log('  · 路径 B：有人离开、人数不足（maybeEndGame）');
(function () {
  const room = startedRoom('V-B1', ['A', 'B']);
  SM.leaveRoom(room, 'B');
  eq(room.phase, SM.PHASE.SETTLED, '  进入结算');
  eq(room.endReason, 'someoneLeft', '  原因是 someoneLeft');
  /* ★ 这条以前是 false —— 于是两个人各被记一场「净胜 0」的平局。 */
  eq(room.voided, true, '  ★ 一分没打 → 作废（和路径 A 同口径）');
})();

console.log('  · 路径 B 的变体：掉线判弃（finalizeLeave）走的也是这条路');
(function () {
  const room = startedRoom('V-B2', ['A', 'B']);
  SM.markDisconnected(room, 'B');
  SM.finalizeLeave(room, 'B');
  eq(room.endReason, 'someoneLeft', '  原因是 someoneLeft');
  eq(room.voided, true, '  ★ 一分没打 → 作废');
})();

/* ---------------------------------------------------------------- */
console.log('\n[2] 打过就照记 —— 三条路径都不能修过头');

console.log('  · 路径 A：打过再结束本局');
(function () {
  const room = startedRoom('V-A2', ['A', 'B']);
  pretendPlayed(room, { A: 26, B: 14 });
  SM.proposeDissolve(room, 'A');
  SM.voteDissolve(room, 'B', true);
  eq(room.voided, false, '  ★ 分数动过 → 不作废');
})();

console.log('  · 路径 B：打过再走人');
(function () {
  const room = startedRoom('V-B3', ['A', 'B', 'C']);
  pretendPlayed(room, { A: 25, B: 16, C: 19 });
  SM.leaveRoom(room, 'B');
  eq(room.phase, SM.PHASE.ROUND1_SPLIT, '  走一个还剩 2 人，够数，本局继续');
  SM.leaveRoom(room, 'C');
  eq(room.phase, SM.PHASE.SETTLED, '  再走一个只剩 1 人 → 结束');
  eq(room.endReason, 'someoneLeft', '  原因是 someoneLeft');
  eq(room.voided, false, '  ★ 分数动过 → 不作废');
})();

/* ---------------------------------------------------------------- */
console.log('\n[3] 判据是「有没有动过分」，不是「分数是否等于基准分」');
(function () {
  /* 甲先赢 1 分又输 1 分、乙反过来 —— 一局真打完了，两个人最后都正好回到基准分。
   * 按分数判会被判成「一分没打」而整局作废，玩家的真实输赢就没了。
   *
   * ★ v106：基准分**必须读 CONFIG**，不能写字面量 20。
   *   原来写的是 `pretendPlayed(room, { A: 20, B: 20 })`。基准归 0 之后，
   *   兜底判据 `20 !== 0` 会先一步判成「动过分」，于是这条用例
   *   **通过得毫无判别力** —— 它以为自己在验 anyScoreChange 的作用，
   *   实际上验的是兜底。把分数设成 0 之后，兜底说「没动过」，
   *   只有 anyScoreChange 能救这局，才真正验到了想验的东西。 */
  const room = startedRoom('V-C1', ['A', 'B']);
  pretendPlayed(room, { A: CONFIG.INITIAL_SCORE, B: CONFIG.INITIAL_SCORE });
  SM.proposeDissolve(room, 'A');
  SM.voteDissolve(room, 'B', true);
  eq(SM.findPlayer(room, 'A').score, CONFIG.INITIAL_SCORE, '  两人分数正好回到基准分');
  eq(room.voided, false, '  ★ 但确实打过 → 不作废（按分数判会误判成作废）');

  /* 对照组：分数一模一样，唯独不打 anyScoreChange 标记 → 必须作废。
   * 没有这一条，上面那条在「判据恒返回 false」时也照样通过（空转门）。 */
  const ctl = startedRoom('V-C2', ['A', 'B']);
  ctl.players.forEach(function (p) { p.score = CONFIG.INITIAL_SCORE; });
  SM.proposeDissolve(ctl, 'A');
  SM.voteDissolve(ctl, 'B', true);
  eq(ctl.voided, true, '  对照组：同分但没标记 → 作废（证明上一条有判别力）');
})();

/* ---------------------------------------------------------------- */
console.log('\n[4] 标记的寿命：开新局要归零，不能污染下一局');
(function () {
  const room = startedRoom('V-D1', ['A', 'B']);
  SM.proposeDissolve(room, 'A');
  SM.voteDissolve(room, 'B', true);
  eq(room.voided, true, '  前置：上一局作废');
  eq(room.anyScoreChange, false, '  前置：上一局没动过分');

  SM.wantNext(room, 'A'); SM.wantNext(room, 'B');
  SM.setReady(room, 'A', true); SM.setReady(room, 'B', true);
  const started = SM.autoStartIfReady(room);
  ok(!!started, '  两人报名 + 准备 → 开了下一局');
  eq(room.voided, false, '  ★ 新一局 voided 归零（否则整晚都不记战绩）');
  eq(room.anyScoreChange, false, '  ★ 新一局 anyScoreChange 也归零');

  /* 反向：上一局打过（不作废），新一局不能带着「打过分」这个标记 —— 
   * 否则下一局一分没打就结束也会被当成打过、照记一场。 */
  const r2 = startedRoom('V-D2', ['C', 'D']);
  pretendPlayed(r2, { C: 30, D: 10 });   // 有人见底 → 结算
  SM.submitGroups(r2, 'C', { single: [], tenhalf: [], piaosanye: [] });   // 触发不了也没关系
  r2.phase = SM.PHASE.SETTLED;
  r2.endReason = 'scoreZero';
  SM.wantNext(r2, 'C'); SM.wantNext(r2, 'D');
  SM.setReady(r2, 'C', true); SM.setReady(r2, 'D', true);
  const s2 = SM.autoStartIfReady(r2);
  ok(!!s2, '  第二局也开得起来');
  eq(r2.anyScoreChange, false, '  ★ 上一局打过分，不会带到新一局');
})();

/* ---------------------------------------------------------------- */
console.log('\n[5] 幂等：结算后反复广播不会重算成别的结果');
(function () {
  const room = startedRoom('V-E1', ['A', 'B']);
  SM.proposeDissolve(room, 'A');
  SM.voteDissolve(room, 'B', true);
  const seq = room.handSeq;
  const settledAt = room.settledAt;
  /* 模拟结算页停留期间又发生若干次广播/操作：handSeq 与 settledAt 都不能再变，
   * voided 更不能被反复重算成另一个值（分数此时不会再变，但判据要稳定）。 */
  room.updatedAt = Date.now();
  eq(room.handSeq, seq, '  handSeq 没有再加一次');
  eq(room.settledAt, settledAt, '  settledAt 稳定');
  eq(room.voided, true, '  voided 稳定为 true');
})();

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
if (fail) process.exitCode = 1;
