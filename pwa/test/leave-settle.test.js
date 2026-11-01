/**
 * 「有人离开时，该结算就要结算」测试
 * 跑法：node pwa/test/leave-settle.test.js
 *
 * 锁的是一个**线上会真实卡住整桌**的场景：
 *   3 人局，甲乙都已提交，丙一直不提交，然后丙点了「离开」。
 *   剩下的人其实全都在等——等一个永远不会来的结算。
 *
 * 原因有三层，缺一层都不会卡：
 *   1. leaveRoom 只调 maybeEndGame()，那是「人数不足才结束」，3 人走 1 个还剩 2 人，够数；
 *   2. 「全员提交 → 结算」的判断由**提交的那个人**触发，而那个人正是走掉的丙；
 *   3. 分牌超时只给「未提交且未离开」的人挂计时器，此刻甲乙已提交、丙已 left，一个都不剩。
 *
 * 所以修复点是 leaveRoom 里补一次「剩余在场者是否都已就绪」的判断（settleIfAllIn）。
 * 下面除了正向用例，还专门锁住两种**不该结算**的情况，避免改出一个乱结算的版本。
 */
'use strict';

const SM = require('../js/stateMachine.js');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass += 1; console.log('  PASS  ' + label); }
  else { fail += 1; console.log('  FAIL  ' + label); }
}

/* 初始分从配置读，不再写死 20：v105 把基准改成了 0，
 * 写死的数字会让这个文件在改数值时整片假失败（而它守的是「零和」「分数不被凭空改动」这些真规则）。 */
const CONFIG = require('../js/config.js');
const INITIAL = CONFIG.INITIAL_SCORE;

/* 建一个 n 人已开局的房间 */
function startRoom(roomId, ids) {
  const room = SM.newRoom(roomId, { id: ids[0], nickname: '玩家' + ids[0] });
  ids.slice(1).forEach(function (id) { SM.joinRoom(room, { id: id, nickname: '玩家' + id }); });
  ids.forEach(function (id) { SM.setReady(room, id, true); });
  SM.startGame(room, ids[0]);
  return room;
}

/* 按「1 + 2 + 3」把手上 6 张牌填满第一轮 */
function groupsOf(room, id) {
  const p = SM.findPlayer(room, id);
  return {
    single: [p.hand[0]],
    tenhalf: [p.hand[1], p.hand[2]],
    piaosanye: [p.hand[3], p.hand[4], p.hand[5]]
  };
}

/* 第二轮是「1 + 5」，分组形状不同——用错形状会直接提交失败，
 * 那测出来的"没结算"就是测试自己的问题，不是代码的问题。 */
function groupsOfRound2(room, id) {
  const p = SM.findPlayer(room, id);
  return {
    single: [p.hand[0]],
    douniu: [p.hand[1], p.hand[2], p.hand[3], p.hand[4], p.hand[5]]
  };
}

function totalScore(room) {
  return SM.activePlayers(room).reduce(function (s, p) { return s + p.score; }, 0);
}

/* ---------------------------------------------------------------- */
console.log('\n[1] 最后那个没提交的人离开 → 必须立刻结算（原本永久卡死）');
(function () {
  const room = startRoom('900001', ['A', 'B', 'C']);
  SM.submitGroups(room, 'A', groupsOf(room, 'A'));
  SM.submitGroups(room, 'B', groupsOf(room, 'B'));
  ok(room.phase === SM.PHASE.ROUND1_SPLIT, '离开前仍在分牌阶段');

  SM.leaveRoom(room, 'C');

  ok(!!room.results.round1, '★ 第一轮已结算（以前这里是空的，整桌干等）');
  ok(room.phase !== SM.PHASE.ROUND1_SPLIT, '不再停在第一轮分牌');
  ok(room.phase === SM.PHASE.ROUND2_SPLIT, '正常推进到第二轮');
  ok(totalScore(room) === INITIAL * 2, '两家分数合计仍是 2×初始分（零和没被破坏）');
  ok(SM.findPlayer(room, 'C').score === INITIAL, '走掉的人分数被冻结在初始分，没被结算改动');
})();

/* ---------------------------------------------------------------- */
console.log('\n[2] 还有人没提交时离开 → 不许提前结算');
(function () {
  const room = startRoom('900002', ['A', 'B', 'C']);
  SM.submitGroups(room, 'A', groupsOf(room, 'A'));
  // B 没提交、C 走人
  SM.leaveRoom(room, 'C');

  ok(room.phase === SM.PHASE.ROUND1_SPLIT, '仍在第一轮分牌（等 B）');
  ok(!room.results.round1, '没有结果（提前结算会让已提交的人白打）');
})();

/* ---------------------------------------------------------------- */
console.log('\n[3] 弃权也算「已就绪」，不能因为弃权者卡住');
(function () {
  const room = startRoom('900003', ['A', 'B', 'C']);
  SM.submitGroups(room, 'A', groupsOf(room, 'A'));
  SM.submitGroups(room, 'B', groupsOf(room, 'B'));
  SM.forfeitRound(room, 'C');

  ok(!!room.results.round1, '丙弃权后自动结算');
  ok(room.phase === SM.PHASE.ROUND2_SPLIT, '推进到第二轮');
})();

/* ---------------------------------------------------------------- */
console.log('\n[4] 2 人局走 1 人 → 走「人数不足结束」，不重复结算');
(function () {
  const room = startRoom('900004', ['A', 'B']);
  SM.submitGroups(room, 'A', groupsOf(room, 'A'));
  SM.leaveRoom(room, 'B');

  ok(room.phase === SM.PHASE.SETTLED, '进入结账（人数不足）');
  ok(room.endReason === 'someoneLeft', '结束原因标记为 someoneLeft');
  ok(!room.results.round1, '没有额外跑一轮结算（否则会出现"结算了又结账"的错乱）');
  ok(SM.findPlayer(room, 'A').score === INITIAL, '甲的分数没被凭空改动');
})();

/* ---------------------------------------------------------------- */
console.log('\n[5] 已经全员提交并结算后，再有人离开 → 结果不被覆盖');
(function () {
  const room = startRoom('900005', ['A', 'B', 'C']);
  SM.submitGroups(room, 'A', groupsOf(room, 'A'));
  SM.submitGroups(room, 'B', groupsOf(room, 'B'));
  SM.submitGroups(room, 'C', groupsOf(room, 'C'));   // 这一个人触发结算
  const firstResult = JSON.stringify(room.results.round1);
  const seqAfterSettle = room.resultSeq;
  ok(!!room.results.round1, '全员提交后已结算');

  SM.leaveRoom(room, 'C');
  ok(JSON.stringify(room.results.round1) === firstResult, '第一轮结果没被第二次结算覆盖');
  ok(room.resultSeq === seqAfterSettle, 'resultSeq 没有多加一次');
})();

/* ---------------------------------------------------------------- */
console.log('\n[6] 第二轮同样成立（不是只在第一轮打补丁）');
(function () {
  const room = startRoom('900006', ['A', 'B', 'C']);
  SM.submitGroups(room, 'A', groupsOf(room, 'A'));
  SM.submitGroups(room, 'B', groupsOf(room, 'B'));
  SM.forfeitRound(room, 'C');
  ok(room.phase === SM.PHASE.ROUND2_SPLIT, '先过了第一轮');

  // 第二轮：C 已经走了？没有 —— 弃权者仍在房间里，可以继续玩
  const me = SM.findPlayer(room, 'C');
  ok(!me.left, '弃权者仍在房间（与「离开」不同）');

  // 第二轮 C 不提交直接离开
  const subA = SM.submitGroups(room, 'A', groupsOfRound2(room, 'A'));
  const subB = SM.submitGroups(room, 'B', groupsOfRound2(room, 'B'));
  ok(subA.ok && subB.ok, '第二轮按 1+5 提交成功');
  SM.leaveRoom(room, 'C');
  ok(!!room.results.round2, '★ 第二轮也立刻结算（同一处修复覆盖两个轮次）');
})();

/* ---------------------------------------------------------------- */
console.log('\n[7] 结算期重新进房：分数不许被重置（全量 review P0-2）');
(function () {
  /* 线上真实路径：一局打到一半有人离开 → 人数不足进结算 → 他又点回来。
   * （2 人局走 1 人就是 SETTLED，见上面 [4]。）
   * joinRoom 旧实现无条件 `p.score = CONFIG.INITIAL_SCORE`，于是：
   *   离开时 7 分 → 结算期重进变回基准分，结算页显示基准分，
   *   而档案里记的是「7 − 基准分」—— 玩家看到的账和排行榜的账对不上。
   *   （基准分 v106 起是 0，症状从「显示 20、档案记 −13」变成「显示 0、档案记 +7」。）
   * 真正的「新一局归零」由 startNextRound 统一负责，joinRoom 不该代劳。 */
  const room = startRoom('900007', ['A', 'B']);
  SM.submitGroups(room, 'A', groupsOf(room, 'A'));   // B 没提交，A 先走
  SM.leaveRoom(room, 'A');
  ok(room.phase === SM.PHASE.SETTLED, '2 人局走 1 人 → 进结算期（[4] 同一个路径）');

  const a = SM.findPlayer(room, 'A');
  ok(a.left === true, 'A 已经离开这一局');

  /* 把分数摆成一个确定的非初始值（真实场景里由这局的输赢算出来），
   * 这样「重进后被重置成 20」会立刻暴露，而不用去猜随机牌局的输赢。 */
  a.score = 7;

  const res = SM.joinRoom(room, { id: 'A', nickname: '玩家A' });
  ok(res.ok === true, '结算期可以重新进来（房间从第一局起一直停在 SETTLED）');
  ok(a.score === 7, '★ 分数保持 7，没有被重置成 20（旧实现这里必然是 20）', 'score=' + a.score);
  ok(a.left === false, '座位恢复为在场');
  ok(a.joinedLate === false, '★ 他打过上一局，不算「结算期才来的新人」（否则看不到上一局结算）');
  ok(a.wantNext === true, '结算期进来的语义是「我要打下一局」');

  /* 新人则是另一套：分数初始化，且标记 joinedLate */
  const resNew = SM.joinRoom(room, { id: 'C', nickname: '玩家C' });
  ok(resNew.ok === true, '新人也能在结算期进来');
  const c = SM.findPlayer(room, 'C');
  ok(c.score === INITIAL, '★ 新人分数从初始分开始');
  ok(c.joinedLate === true, '新人标记 joinedLate（前端不弹上一局结算）');

  /* 收尾：新一局开始时全员归零这条老行为不能被改掉 */
  ['A', 'C'].forEach(function (id) {
    SM.wantNext(room, id);
    SM.setReady(room, id, true);
  });
  const nx = SM.startNextRound(room);
  ok(nx.ok === true, '条件齐了能开下一局', nx.error);
  ok(SM.findPlayer(room, 'A').score === INITIAL, '★ 新一局开始才把分数归零（归零责任已经搬到 startNextRound）');
  ok(SM.findPlayer(room, 'A').joinedLate === false, '新一局清掉 joinedLate');
})();

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
