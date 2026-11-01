/**
 * 「中途结束本局」不进战绩 —— 落库层的口径测试
 * 跑法：node server/test/dissolve-archive.test.js
 *
 * 修的是什么（有实证，不是猜的）：
 *   以前只要房间进入 SETTLED，_persistSettlement 就按 `分数 − 20` 落一条。
 *   而结束本局时分数**一分都没动过**（分数只在正常结算里加减），
 *   于是每一把被解散的局都变成档案里的一场「净胜 0」：
 *     · games +1、draws +1   → 场次膨胀、胜率被稀释
 *     · currentStreak = 0    → ★ 正在连胜的人被一次解散直接断掉
 *   连「房间建好、还没开局就结束」都算一场，最荒唐。
 *
 * 现在只在 finishDissolve 里打 voided 标记，_persistSettlement 见到就跳过。
 * 这里把这三种局面钉死：没开局解散、局中解散、作废后开新局正常结算。
 *
 * 为什么单独一个文件：这是「数据对不对」的测试，跟投票流程（dissolve.test.js）
 * 和 UI 文案都没关系，混在一起以后很难看出到底是规则坏了还是口径坏了。
 */
'use strict';

const os = require('os');
const path = require('path');

process.env.PROFILE_FILE = path.join(os.tmpdir(), 'lxw-voided-' + Date.now() + '.json');

const SM = require('../../pwa/js/stateMachine.js');
const { Hub } = require('../hub.js');
const { ProfileStore } = require('../profile.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

const profiles = new ProfileStore({ file: process.env.PROFILE_FILE, log: function () {} });
const hub = new Hub({ profiles: profiles, log: function () {} });

/* 在 hub 里造一个房间并广播一次（广播链路里才会调 _persistSettlement，
 * 这也是线上唯一的落库入口 —— 直接调私有方法测不到「忘记调用」这类错）。 */
function room(roomId, players) {
  const list = players.map(function (p) { return { id: p.playerId, nickname: p.nickname }; });
  const r = SM.newRoom(roomId, list[0]);
  list.slice(1).forEach(function (p) { SM.joinRoom(r, p); });
  hub.rooms.set(roomId, r);
  return r;
}

function games(p) {
  const rec = profiles.data.get(p.playerId);
  return rec ? rec.games : 0;
}
function streak(p) {
  const rec = profiles.data.get(p.playerId);
  return rec ? rec.currentStreak : 0;
}

(async function main() {
  const A = await profiles.createAccount('va1', 'pw123456', '甲');
  const B = await profiles.createAccount('va2', 'pw123456', '乙');
  ok(A.ok && B.ok, '两个账号建好了');
  const a = { playerId: A.playerId, nickname: '甲' };
  const b = { playerId: B.playerId, nickname: '乙' };

  /* ---------- 1. 还没开局就结束本局 ---------- */
  console.log('\n[1] 房间建好、还没开局 → 结束本局');
  /* 这一条最荒唐：一局都没打过，却能在每个人档案里记一场。
   * 建房 → 拉人 → 谈崩了不想玩了，是最常见的路径之一。 */
  const r1 = room('R-A1', [a, b]);
  SM.proposeDissolve(r1, a.playerId);
  SM.voteDissolve(r1, b.playerId, true);
  eq(r1.phase, SM.PHASE.SETTLED, '投票成立 → 结算');
  hub._broadcast('R-A1');
  eq(games(a), 0, '★ 甲的场次还是 0');
  eq(games(b), 0, '★ 乙的场次还是 0');
  streak(a);
  eq(streak(a), 0, '连胜没被写坏');

  /* ---------- 2. 局中结束本局 ---------- */
  console.log('\n[2] 开局后分牌中 → 结束本局');
  /* 先给甲刷一段连胜，再让他被解散一次：
   * 以前这一步会把 currentStreak 打成 0，是玩家最难接受的一种「无妄之灾」。 */
  const r2 = room('R-A2', [a, b]);
  SM.startGame(r2, a.playerId);
  /* 直接给甲记两场胜，模拟他正连着赢 */
  profiles.record(a.playerId, '甲', 6, Date.now(), 'R-WIN1', 1, { playerCount: 2, endReason: 'scoreZero' });
  profiles.record(a.playerId, '甲', 6, Date.now(), 'R-WIN2', 1, { playerCount: 2, endReason: 'scoreZero' });
  eq(games(a), 2, '前置：甲已有 2 场');
  eq(streak(a), 2, '前置：甲正在连胜 2');

  SM.proposeDissolve(r2, a.playerId);
  SM.voteDissolve(r2, b.playerId, true);
  hub._broadcast('R-A2');
  eq(games(a), 2, '★ 解散后场次仍是 2（没多记一场 0 分平局）');
  eq(streak(a), 2, '★ 连胜没被打断（这是最要紧的一条）');

  /* ---------- 3. 作废之后开新局，正常结算照常记 ---------- */
  console.log('\n[3] 作废 → 开新局 → 正常结账，照样记一场');
  /* 防的是「修过头」：voided 一旦漏清，从此这个房间的每一局都不记，
   * 那比原来更糟 —— 玩家打完一整晚，档案里一场都没有。 */
  SM.wantNext(r2, a.playerId); SM.wantNext(r2, b.playerId);
  SM.setReady(r2, a.playerId, true); SM.setReady(r2, b.playerId, true);
  ok(!!SM.autoStartIfReady(r2), '两人报名 + 准备 → 开了新一局');
  eq(r2.voided, false, '新一局不再带着「作废」标记');

  SM.findPlayer(r2, a.playerId).score = 26;   // 甲这把赢 6
  SM.findPlayer(r2, b.playerId).score = 14;
  r2.phase = SM.PHASE.SETTLED;                 // 模拟正常结账（markSettled 未导出）
  r2.settledAt = Date.now();
  r2.handSeq = (r2.handSeq || 0) + 1;
  hub._broadcast('R-A2');
  eq(games(a), 3, '★ 正常结账照常记一场（作废标记没有漏清）');
  eq(streak(a), 3, '连胜接着往上走');

  /* ---------- 4. 幂等：同一次结算反复广播只记一次 ---------- */
  console.log('\n[4] 同一次结算重复广播 → 不重复记账');
  hub._broadcast('R-A2');
  hub._broadcast('R-A2');
  eq(games(a), 3, '反复广播仍是 3 场');

  /* ---------- 5. 打过几把之后才结束 → 真实的输赢要照记 ---------- */
  console.log('\n[5] 已经打过分再结束 → 不作废，照记一场');
  /* 这是最容易修过头的一条。分数每一轮就在加减，一局常常打了四五把才被结束；
   * 如果按「只要是被解散的一律作废」处理，玩家真赢来的分会被整局抹掉。 */
  const r5 = room('R-A3', [a, b]);
  SM.startGame(r5, a.playerId);
  SM.findPlayer(r5, a.playerId).score = 26;    // 甲已经赢着 6 分
  SM.proposeDissolve(r5, a.playerId);
  SM.voteDissolve(r5, b.playerId, true);
  eq(r5.voided, false, '★ 分数动过 → 不作废');
  hub._broadcast('R-A3');
  eq(games(a), 4, '★ 照常记一场（真赢的分没被抹掉）');
  eq(streak(a), 4, '连胜继续');

  /* ---------- 6. 有人离开也能作废（不止「结束本局」这一条路） ---------- */
  console.log('\n[6] 一分没打、对手掉线判弃 → 同样不进档案');
  /* 这是同一个坑的另一半：voided 以前只有 finishDissolve 会写，
   * 于是「20/20 点结束本局」不记，「20/20 对手掉线」照记一场 0 分平局。
   * 对玩家的观感是：连胜 5 场，进一局、对手手机没电、一分没打，
   * 回战绩页连胜变 0，还多一条「有人离开结束 · 0」。 */
  const before6 = games(a);
  const streak6 = streak(a);
  const r6 = room('R-A6', [a, b]);
  SM.setReady(r6, a.playerId, true); SM.setReady(r6, b.playerId, true);
  SM.startGame(r6, a.playerId);
  eq(r6.phase, SM.PHASE.ROUND1_SPLIT, '真的开局了（否则下面测的是等待期掉人）');
  SM.markDisconnected(r6, b.playerId);
  SM.finalizeLeave(r6, b.playerId);      // 宽限到期 → 判弃 → 人数不足结束
  eq(r6.endReason, 'someoneLeft', '结束原因是 someoneLeft');
  eq(r6.voided, true, '★ 一分没动 → 作废');
  hub._broadcast('R-A6');
  eq(games(a), before6, '★ 甲没多出场次（实际 ' + games(a) + '）');
  eq(streak(a), streak6, '★ 甲的连胜没被打断');

  /* ---------- 7. 反向：同一路径，打过一轮就必须照记 ---------- */
  console.log('\n[7] 走过这条路、但分数动过 → 必须照记（别修过头）');
  const before7 = games(a);
  const r7 = room('R-A7', [a, b]);
  SM.setReady(r7, a.playerId, true); SM.setReady(r7, b.playerId, true);
  SM.startGame(r7, a.playerId);
  eq(r7.phase, SM.PHASE.ROUND1_SPLIT, '真的开局了');
  /* 直接给分数，再声明「这一局动过分」—— 等价于真的打过一轮，
   * 但不用凑 6 张分组。标记本身由 settleRound 写，这里验的是下游落库口径。 */
  SM.findPlayer(r7, a.playerId).score = 26;
  SM.findPlayer(r7, b.playerId).score = 14;
  r7.anyScoreChange = true;
  SM.leaveRoom(r7, b.playerId);
  eq(r7.endReason, 'someoneLeft', '结束原因仍是 someoneLeft');
  eq(r7.voided, false, '★ 分数动过 → 不作废');
  hub._broadcast('R-A7');
  eq(games(a), before7 + 1, '★ 照常记一场（实际 ' + games(a) + '）');

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  if (fail > 0) process.exitCode = 1;
})();
