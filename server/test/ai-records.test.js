/**
 * 含 AI 的对局：不计入战绩、不影响积分、不入排行榜
 * 跑法：node server/test/ai-records.test.js
 *
 * 口径（用户原话）：「含 AI 的对局不计入战绩和排行榜，不影响积分和数据等，
 * 但在我的战绩页面上要能表示出含人机对战」。
 *
 * 落到数据结构上是两件事，这里逐条锁死：
 *   1. 人机局**不进 recent**，单独进 aiRecent —— recent 是所有统计口径的唯一输入，
 *      让它掺进不该计的场次，等于每个消费方都要记得过滤一遍，漏一个就漏进排行榜。
 *   2. 人机局**一个统计字段都不碰**：games / wins / losses / draws / totalNet /
 *      连胜 / 最长连胜 / 最长连败 / 单场最高。
 * 另外三条是这个口径的连带影响，一起验：
 *   · 只打过人机的人不进榜（games === 0），但档案不能被 prune 当僵尸删掉；
 *   · 历史修正（markAiGames）能从 recent 退回 aiRecent 并**重算**派生值；
 *   · 备份/恢复（dump → 新实例）不能把人机流水弄丢。
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const { ProfileStore } = require('../profile.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

const TMP = os.tmpdir();
let seq = 0;
function fresh() {
  seq += 1;
  const file = path.join(TMP, 'lxw-ai-prof-' + Date.now() + '-' + seq + '.json');
  const seed = path.join(TMP, 'lxw-ai-seed-' + Date.now() + '-' + seq + '.json');
  return new ProfileStore({ file: file, seedFile: seed });
}
function cleanup() {
  // 临时档案随系统清理，这里只尽力删掉本次生成的
  try {
    fs.readdirSync(TMP)
      .filter((f) => /^lxw-ai-(prof|seed)-/.test(f))
      .forEach((f) => { try { fs.unlinkSync(path.join(TMP, f)); } catch (e) {} });
  } catch (e) {}
}

/* ========================================================================== */
console.log('\n[1] 人机局：不进场次/积分/连胜，只进 aiRecent');
{
  const s = fresh();
  s.record('p1', '甲', 5, 1000, '111111', 1, { playerCount: 2, endReason: 'scoreZero' });
  s.record('p1', '甲', -4, 2000, '111111', 2, { playerCount: 2, endReason: 'scoreZero' });
  const before = s.get('p1');
  eq(before.games, 2, '两场人类局 → games 2');
  eq(before.totalNet, 1, '净胜 5-4 = 1');
  eq(before.currentStreak, -1, '最近一场负 → 当前 -1 连');
  eq(before.bestNet, 5, '单场最高 5');

  const r = s.record('p1', '甲', 12, 3000, '222222', 3, { playerCount: 2, endReason: 'scoreZero', hasBot: true });
  ok(r.recorded && r.ai, '人机局返回 {recorded:true, ai:true}');

  const after = s.get('p1');
  eq(after.games, 2, '★ 人机局不增加场次');
  eq(after.totalNet, 1, '★ 人机局不影响累计净胜（+12 没进来）');
  eq(after.wins, 1, '★ 人机局不记胜场（赢了也不记）');
  eq(after.currentStreak, -1, '★ 人机局不打断/不续连胜');
  eq(after.bestNet, 5, '★ 人机局不进「单场最高」（12 没顶上去）');
  eq(after.aiGames, 1, '★ aiGames 记 1');
  eq(after.recent.length, 2, '★ recent 里没有它');
  /* 对外档案（看别人）默认不带 aiRecent：那是几 KB 的体积，且对看客无意义；
   * 但 aiGames 这个无害的总数一律带上。这条是刻意的设计，别被后手改成「都带」。 */
  eq(after.aiRecent, undefined, '对外档案 get() 不带 aiRecent（省体积）');

  const self = s.getSelf('p1');
  eq(self.aiRecent.length, 1, '★ getSelf 的 aiRecent 里有它');
  eq(self.aiRecent[0].net, 12, '流水里保留净胜（战绩页要显示）');
  eq(self.aiRecent[0].ai, true, '流水带 ai 标记');
  eq(self.aiRecent[0].roomId, '222222', '流水保留房间号（历史修正要靠它做键）');
  eq(self.aiGames, 1, 'getSelf 也带 aiGames');

  /* 幂等：同房间同场次重复广播只记一次 */
  const dup = s.record('p1', '甲', 12, 3000, '222222', 3, { hasBot: true });
  eq(dup.reason, 'duplicate', '同一场重复落库被幂等挡住');
  eq(s.get('p1').aiGames, 1, '重复广播不会把 aiGames 加成 2');
}

/* ========================================================================== */
console.log('\n[2] 只打过人机的人：不进榜，也不是「僵尸档案」');
{
  const s = fresh();
  s.record('p2', '只练AI', 8, 1000, '333333', 1, { playerCount: 2, endReason: 'scoreZero', hasBot: true });
  const p = s.get('p2');
  eq(p.games, 0, '人类场次 0');
  eq(p.aiGames, 1, '人机场次 1');

  eq(s.top(50).length, 0, '★ 排行榜里没有他（games === 0）');
  eq(s.rankOf('p2'), null, '★ 也拿不到名次');

  const removed = s.prune();
  eq(removed.length, 0, '★ prune 不删「只打过人机」的档案');
  ok(s.get('p2') !== null, '档案还在（否则战绩页那几行会凭空消失）');

  /* 对照：真的什么都没打的档案仍然会被清掉 */
  s.ensure('ghost', '路过的');
  const removed2 = s.prune();
  eq(removed2.length, 1, '对照：零场次零 AI 的僵尸档案照旧被清');
}

/* ========================================================================== */
console.log('\n[3] 历史修正：把混进战绩的人机局退回 aiRecent，并重算派生值');
{
  const s = fresh();
  /* 三场人类局 + 一场人机局（历史原因当时按普通局记了） */
  s.record('p3', '乙', 6, 1000, '444444', 1, { playerCount: 2, endReason: 'scoreZero' });
  s.record('p3', '乙', 4, 2000, '444444', 2, { playerCount: 2, endReason: 'scoreZero' });
  s.record('p3', '乙', 20, 3000, '555555', 3, { playerCount: 3, endReason: 'scoreZero' });   // ← 含 AI
  s.record('p3', '乙', -9, 4000, '444444', 4, { playerCount: 2, endReason: 'scoreZero' });
  const before = s.get('p3');
  eq(before.games, 4, '修正前 4 场');
  eq(before.totalNet, 21, '修正前净胜 6+4+20-9 = 21');
  eq(before.bestNet, 20, '修正前单场最高 20（正是那场人机局）');

  const res = s.markAiGames(['555555#3000']);
  eq(res.moved, 1, '搬走 1 条流水');
  const after = s.get('p3');
  eq(after.games, 3, '★ 场次 4 → 3');
  eq(after.totalNet, 1, '★ 净胜 21 → 1（20 分那场退出了）');
  eq(after.bestNet, 6, '★ 单场最高回到 6（重算，不是沿用旧值）');
  eq(after.aiGames, 1, '★ aiGames 记 1');
  eq(after.longestStreak, 2, '★ 连胜重算：6、4 两连胜');
  eq(after.currentStreak, -1, '★ 当前连负重算：最后一场 -9');

  /* 幂等：再调一次没有可搬的 */
  const res2 = s.markAiGames(['555555#3000']);
  eq(res2.moved, 0, '重复修正不会重复搬（幂等）');
  eq(s.get('p3').aiGames, 1, 'aiGames 没有被加成 2');
}

/* ========================================================================== */
console.log('\n[4] 历史候选推断：只在「差出来的座位无法解释」时才认');
{
  const s = fresh();
  /* 甲、乙打过两场正常局 */
  s.record('a', '甲', 3, 1000, '600001', 1, { playerCount: 2, endReason: 'scoreZero' });
  s.record('b', '乙', -3, 1000, '600001', 1, { playerCount: 2, endReason: 'scoreZero' });
  s.record('a', '甲', 5, 2000, '600002', 2, { playerCount: 2, endReason: 'scoreZero' });
  s.record('b', '乙', -5, 2000, '600002', 2, { playerCount: 2, endReason: 'scoreZero' });

  /* 一场 playerCount=3 但只有甲落库 → 3 - 1 = 2 个座位没主 */
  s.record('a', '甲', 7, 9000, '600003', 3, { playerCount: 3, endReason: 'scoreZero' });

  let cands = s.suggestAiGames();
  eq(cands.length, 1, '★ 无人可解释的缺口 → 1 个候选');
  eq(cands[0].key, '600003#9000', '候选就是那一场');
  eq(cands[0].humans, 1, '落库的真实玩家 1 个');
  eq(cands[0].gap, 2, '缺口 = 全座 3 − 真人 1');

  /* 现在让丙「被截断」：他打了 22 场，recent 只留 20 条，
   * 于是比最老一条更早的场次，他完全可能在场却查不到 —— 那种缺口不算证据。 */
  const s2 = fresh();
  s2.record('a', '甲', 3, 1000, '700001', 1, { playerCount: 3, endReason: 'scoreZero' });
  for (let i = 0; i < 22; i++) {
    s2.record('c', '丙', 1, 5000 + i * 10, '70000' + (i % 9), i + 1, { playerCount: 2, endReason: 'scoreZero' });
  }
  const cands2 = s2.suggestAiGames();
  ok(cands2.every((c) => c.key !== '700001#1000'),
    '★ 场次早于某人被截断的流水 → 不认定为 AI（可能是他没被记下来）');

  /* 反过来：场次晚于所有人的流水范围 → 仍然算候选 */
  const s3 = fresh();
  for (let i = 0; i < 22; i++) {
    s3.record('c', '丙', 1, 5000 + i * 10, '70000' + (i % 9), i + 1, { playerCount: 2, endReason: 'scoreZero' });
  }
  s3.record('a', '甲', 3, 99000, '700009', 90, { playerCount: 3, endReason: 'scoreZero' });
  const cands3 = s3.suggestAiGames();
  ok(cands3.some((c) => c.key === '700009#99000'),
    '★ 晚于所有人流水范围的缺口 → 认作候选');
}

/* ========================================================================== */
console.log('\n[5] 清空战绩：人机流水一起清（否则「清空」后还留着一行）');
{
  const s = fresh();
  s.record('p5', '丙', 4, 1000, '800001', 1, { playerCount: 2, endReason: 'scoreZero' });
  s.record('p5', '丙', 9, 2000, '800002', 2, { playerCount: 2, endReason: 'scoreZero', hasBot: true });
  eq(s.get('p5').aiGames, 1, '清空前有 1 场人机');
  const r = s.resetStatsOf('p5');
  ok(r.ok, '清空成功');
  const p = s.getSelf('p5');
  eq(p.games, 0, '人类场次归零');
  eq(p.aiGames, 0, '★ 人机场次也归零');
  eq(p.aiRecent.length, 0, '★ 人机流水也清空');
}

/* ========================================================================== */
console.log('\n[6] 备份/恢复：人机流水要跟着档案走');
{
  const s = fresh();
  s.record('p6', '丁', 2, 1000, '900001', 1, { playerCount: 2, endReason: 'scoreZero' });
  s.record('p6', '丁', 6, 2000, '900002', 2, { playerCount: 2, endReason: 'scoreZero', hasBot: true });
  const dump = s.dump();
  const row = dump.find((x) => x.playerId === 'p6');
  ok(row && Array.isArray(row.aiRecent) && row.aiRecent.length === 1, 'dump 里带 aiRecent');
  eq(row.aiGames, 1, 'dump 里带 aiGames');

  /* 落盘 → 新实例读同一个文件（模拟重启 / 容器重建） */
  s.flush();
  const again = new ProfileStore({ file: s.file, seedFile: s.seedFile });
  eq(again.get('p6').games, 1, '恢复后人类场次还是 1');
  eq(again.get('p6').aiGames, 1, '★ 恢复后人机场次还在');
  eq(again.getSelf('p6').aiRecent.length, 1, '★ 恢复后人机流水还在');
}

/* ========================================================================== */
console.log('\n[7] 窗口外残值：改一场不能顺手抹掉 recent 装不下的历史');
{
  /* 这是上线当天真实踩到的坑：玩家A 24 场，recent 只留 20 条。
   * 第一版 _recompute 纯按 recent 重算，于是「修正 2 场人机局」把另外 4 场
   * 真战绩也一并算没了（24 → 18）。断言就锁这一条：场次只能 -1。 */
  const s = fresh();
  let sum = 0;
  for (let i = 1; i <= 24; i++) {
    const net = (i % 3 === 0) ? -5 : 4;          // 混合正负，别让断言只在单一符号下成立
    sum += net;
    s.record('p7', '戊', net, i * 1000, '710000', i, { playerCount: 2, endReason: 'scoreZero' });
  }
  const before = s.getSelf('p7');
  eq(before.games, 24, '24 场全记在 games 上');
  eq(before.recent.length, 20, '★ 流水只剩 20 条（窗口上限）');
  eq(before.totalNet, sum, '累计净胜 = 24 场之和');

  /* 搬走 recent 里最新那条 */
  const target = before.recent[0];
  const key = target.roomId + '#' + target.endedAt;
  const movedNet = Math.round(Number(target.net) || 0);
  const res = s.markAiGames([key]);
  eq(res.moved, 1, '搬走 1 条');

  const after = s.get('p7');
  eq(after.games, 23, '★ 场次 24 → 23（只少搬走的那一场，不是 19）');
  eq(after.totalNet, sum - movedNet, '★ 净胜只减掉那一场');
  eq(after.aiGames, 1, 'aiGames 记 1');
}

/* ========================================================================== */
console.log('\n[8] 撤销：判错了要能原样退回去');
{
  const s = fresh();
  s.record('p8', '己', 6, 1000, '810001', 1, { playerCount: 2, endReason: 'scoreZero' });
  s.record('p8', '己', -3, 2000, '810002', 2, { playerCount: 2, endReason: 'scoreZero' });
  s.record('p8', '己', 9, 3000, '810003', 3, { playerCount: 4, endReason: 'scoreZero' });  // ← 误判的一场
  const before = s.getSelf('p8');
  const snapshot = { games: before.games, totalNet: before.totalNet, wins: before.wins,
    losses: before.losses, draws: before.draws, bestNet: before.bestNet,
    currentStreak: before.currentStreak, longestStreak: before.longestStreak,
    longestLoseStreak: before.longestLoseStreak };

  s.markAiGames(['810003#3000']);
  eq(s.get('p8').games, 2, '先搬走：2 场');
  eq(s.get('p8').totalNet, 3, '净胜 6-3 = 3');

  const undo = s.unmarkAiGames(['810003#3000']);
  eq(undo.moved, 1, '撤销搬回 1 条');
  const back = s.getSelf('p8');
  eq(back.aiGames, 0, '★ aiGames 归零');
  eq(back.aiRecent.length, 0, '★ 人机流水清空');
  Object.keys(snapshot).forEach((k) => {
    eq(back[k], snapshot[k], '★ 撤销后 ' + k + ' 与修正前一致');
  });

  /* 撤销不认识那条 key 时什么都不做（重复撤销是安全的） */
  const undo2 = s.unmarkAiGames(['810003#3000']);
  eq(undo2.moved, 0, '重复撤销移动 0 条');
}

/* ========================================================================== */
console.log('\n[9] 快照恢复：整体覆盖 + 保留幂等键');
{
  const s = fresh();
  s.record('p9', '庚', 5, 1000, '910001', 1, { playerCount: 2, endReason: 'scoreZero' });
  s.record('p9', '庚', 7, 2000, '910002', 2, { playerCount: 2, endReason: 'scoreZero' });
  const good = s.dump();

  /* 误操作：把两场都当人机搬走 */
  s.markAiGames(['910001#1000', '910002#2000']);
  eq(s.get('p9').games, 0, '误操作之后 0 场');

  const rr = s.restoreFrom(good);
  ok(rr.ok, '恢复成功');
  eq(rr.count, 1, '恢复 1 份档案');
  const p = s.getSelf('p9');
  eq(p.games, 2, '★ 场次回到 2');
  eq(p.totalNet, 12, '★ 净胜回到 12');
  eq(p.aiGames, 0, '★ aiGames 归零');
  eq(p.recent.length, 2, '★ 流水也回来了');

  /* 幂等键要保留：恢复之后，同一场再广播一次不该被重新写进来 */
  const again = s.record('p9', '庚', 5, 1000, '910001', 1, { playerCount: 2, endReason: 'scoreZero' });
  eq(again.reason, 'duplicate', '★ 恢复后 _seen 仍生效（重复广播被挡）');
  eq(s.get('p9').games, 2, '场次没有被写回 3');

  const bad = s.restoreFrom([]);
  eq(bad.ok, false, '空快照被拒');
  const bad2 = s.restoreFrom([{ nickname: '没有 id' }]);
  eq(bad2.ok, false, '没有 playerId 的快照被拒');
}

cleanup();

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail === 0 ? 0 : 1);
