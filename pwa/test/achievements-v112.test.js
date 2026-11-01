/**
 * 成就系统 v112 改版的守卫（node pwa/test/achievements-v112.test.js）
 *
 * 这一版改的全是**口径**，而口径错起来一律不报错：
 *   · 小牌型记到了大牌对撞的分母里 → 「强者运强」的胜率被一群爆点稀释；
 *   · 整把三条算在「一轮」上 → 一局里被计两次，或者第一轮就把结果定了；
 *   · 展示模式没标 → 玩家看到「停在 20/20」的进度条，以为系统不记了。
 *
 * 所以这里按「输入 → 期望值」写死，期望值全部手算，不从实现里取。
 */
'use strict';

const Ach = require('../js/achievements.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

/* 造一轮结算结果：groups 里每组的 entries 只有 id 与 typeName，
 * 和 Engine.settleGroup 的真实输出形状一致（其余字段这里用不到）。 */
function group(mode, entries, winnerId) {
  return {
    group: mode,
    winnerId: winnerId,
    entries: entries.map(function (e) { return { id: e[0], typeName: e[1] }; })
  };
}

console.log('\n[1] 小牌型：爆点 / 散牌 / 没牛 进的是「牌型」计数，不进对撞');
{
  const run = Ach.accumulate(null, 1, [
    group('tenhalf', [['a', '爆牌'], ['b', '爆牌']], 'a'),
    group('piaosanye', [['a', '散牌'], ['b', '豹子']], 'b'),
    group('douniu', [['a', '没牛'], ['b', '没牛']], 'b')
  ]);
  const a = Ach.runOf(run, 'a');
  const b = Ach.runOf(run, 'b');
  eq(a.t.bz, 1, '甲：爆点 1 次');
  eq(a.t.sp, 1, '甲：散牌 1 次');
  eq(a.t.mn, 1, '甲：没牛 1 次');
  eq(b.t.lp, 1, '乙：豹子仍然记在大牌型上');
  eq(a.n.tenhalf, 1, '分母：参与十点半 1 次');
  /* ★ 关键负向断言：小牌型不能被当成「大牌对撞」 */
  eq(a.vsn || 0, 0, '★ 甲没有大牌对撞（爆点/散牌/没牛都不算大牌）');
  eq(b.vsn || 0, 0, '★ 乙也没有（豹子 vs 散牌 不是硬碰硬）');
}

console.log('\n[2] 小牌对撞：全场都是小牌才算');
{
  /* 三人全爆 → 三个人各 +1 分母，赢家 +1 赢，另两人各 +1 输 */
  const run = Ach.accumulate(null, 1, [
    group('tenhalf', [['a', '爆牌'], ['b', '爆牌'], ['c', '爆牌']], 'c')
  ]);
  eq(Ach.runOf(run, 'a').smn, 1, '甲：小牌对撞分母 +1');
  eq(Ach.runOf(run, 'b').smn, 1, '乙：同上');
  eq(Ach.runOf(run, 'c').smn, 1, '丙：同上');
  eq(Ach.runOf(run, 'c').smv, 1, '丙赢：smv +1');
  eq(Ach.runOf(run, 'a').sml, 1, '甲输：sml +1');
  eq(Ach.runOf(run, 'a').smv || 0, 0, '甲没有小牌对撞胜场');
}
{
  /* 只要有一个人不是小牌，就不算「全场都是小牌」 */
  const run = Ach.accumulate(null, 1, [
    group('douniu', [['a', '没牛'], ['b', '牛牛'], ['c', '没牛']], 'b')
  ]);
  eq(Ach.runOf(run, 'a').smn || 0, 0, '★ 混了大牌就不算小牌对撞（分母不动）');
  eq(Ach.runOf(run, 'a').vsn || 0, 0, '也不算大牌对撞（只有乙一个人有大牌）');
}
{
  /* 两个人：一个人自己爆点不算对撞（entries 只有 1 人时） */
  const run = Ach.accumulate(null, 1, [
    group('tenhalf', [['a', '爆牌']], 'a')
  ]);
  eq(Ach.runOf(run, 'a').smn || 0, 0, '只有一个人时不叫对撞');
}
{
  /* 弃权（手牌为空）不算参与：全场只剩一个人出牌 → 不是对撞 */
  const wide = Ach.accumulate(null, 1, [
    group('tenhalf', [['a', '爆牌'], ['b', '弃权']], 'a')
  ]);
  eq(Ach.runOf(wide, 'a').smn || 0, 0, '有人弃权时不算「全场都是小牌」');
  eq(Ach.runOf(wide, 'a').n.tenhalf, 1, '弃权的人不进分母，我也不多算');
}

console.log('\n[3] 整把三条：你咋这幸 / 我咋这霉 / 一夜暴富');
{
  /* 甲 +10，乙 -5，丙 -5：只有甲正分；sumNeg = 10，10*2 >= 10 → 暴富 */
  const run = Ach.accumulateHand(null, [
    { id: 'a', score: 10 }, { id: 'b', score: -5 }, { id: 'c', score: -5 }
  ]);
  eq(Ach.runOf(run, 'a').r9, 1, '★ 全场只有甲正分 → 你咋这幸 +1');
  eq(Ach.runOf(run, 'a').r12, 1, '★ 甲 10 分 ≥ 输家负分总和 10 的一半 → 一夜暴富 +1');
  eq(Ach.runOf(run, 'a').r10 || 0, 0, '甲不是唯一负分的人（他是正分）');
  eq(Ach.runOf(run, 'b').r9 || 0, 0, '乙没赢，拿不到你咋这幸');
  eq(Ach.runOf(run, 'b').r10 || 0, 0, '负分的有两个人 → 谁都不是「唯一负分」');
}
{
  /* 甲 -4，乙 +2，丙 +2：只有甲负分；两个赢家 → 谁都不是「唯一赢家」 */
  const run = Ach.accumulateHand(null, [
    { id: 'a', score: -4 }, { id: 'b', score: 2 }, { id: 'c', score: 2 }
  ]);
  eq(Ach.runOf(run, 'a').r10, 1, '★ 全场只有甲负分 → 我咋这霉 +1');
  eq(Ach.runOf(run, 'b').r9 || 0, 0, '两个赢家时没有「唯一赢家」');
  eq(Ach.runOf(run, 'a').r12 || 0, 0, '负分的人拿不到暴富');
}
{
  /* 暴富的边界：净胜 4、输家合计 10 → 4*2=8 < 10，不算 */
  const no = Ach.accumulateHand(null, [
    { id: 'a', score: 4 }, { id: 'b', score: -5 }, { id: 'c', score: -5 }
  ]);
  eq(Ach.runOf(no, 'a').r12 || 0, 0, '★ 净胜不到输家合计一半 → 不算暴富（4 < 10/2）');
  const yes = Ach.accumulateHand(null, [
    { id: 'a', score: 5 }, { id: 'b', score: -5 }, { id: 'c', score: -5 }
  ]);
  eq(Ach.runOf(yes, 'a').r12, 1, '正好一半也算（5 ≥ 10/2）');
}
{
  /* 没人输（全平）时不算暴富；只有一个人时不算 */
  const flat = Ach.accumulateHand(null, [{ id: 'a', score: 0 }, { id: 'b', score: 0 }]);
  eq(Ach.runOf(flat, 'a').r12 || 0, 0, '全平不算暴富（分母 0）');
  const solo = Ach.accumulateHand(null, [{ id: 'a', score: 9 }]);
  eq(Ach.runOf(solo, 'a') === null || Ach.runOf(solo, 'a').r9 === undefined, true, '一个人的房间不算（没有「全场」可言）');
}
{
  /* 退房的人不参与：他的分数是冻结的，不能拿来做「唯一负分」的判断 */
  const left = Ach.accumulateHand(null, [
    { id: 'a', score: -3 }, { id: 'b', score: 0, left: true }, { id: 'c', score: 0, left: true }
  ]);
  eq(Ach.runOf(left, 'a'), null, '★ 只剩我一个人在场 → 不算任何整把成就');
}

console.log('\n[4] 展示口径：只有六条画进度条');
{
  const res = Ach.evaluate(null, { games: 40, longestStreak: 6, longestLoseStreak: 3, bestNet: 12 });
  const prog = res.list.filter(function (x) { return x.mode === 'progress'; }).map(function (x) { return x.name; });
  eq(prog.join(','), '常客,老油条,势不可挡,十连胜,背到极点,衰神附体', '进度条成就正好这六条（顺序也钉住）');
  const counts = res.list.filter(function (x) { return x.mode === 'count'; });
  eq(counts.length, 33 - 6, '其余 27 条都是次数口径（v114 去重 5 条 + 补 4 条通赔）');
  ok(counts.every(function (x) { return x.need >= 1; }), '次数口径的成就都有解锁门槛');
  /* 用户点名的例子：牌桌屠夫阈值 20，但**展示**的是累计次数，不是 0/20。
   * 门槛和展示是两件事 —— 门槛决定星亮不亮，展示决定玩家看到什么数字。 */
  var butcher = res.list.filter(function (x) { return x.name === '牌桌屠夫'; })[0];
  ok(butcher && butcher.mode === 'count' && butcher.need === 20,
    '★ 牌桌屠夫：门槛 20 但按次数展示（不是 0 / 20 的进度）');
}
{
  /* 牌型卡带出现率：十点半 3 次 / 20 次参与 = 15% */
  const ach = Ach.blank();
  ach.t = { th: 3 };
  ach.n = { tenhalf: 20 };
  const res = Ach.evaluate(ach, { games: 5 });
  const h2 = res.list.filter(function (x) { return x.id === 'h2'; })[0];
  ok(Math.abs(h2.rate - 0.15) < 1e-9, '★ 牌型出现率 = 命中 / 参与该组次数（3/20 = 15%）', h2.rate);
  ok(h2.raw === 3 && h2.mode === 'count', '牌型卡计数是 3，展示口径是次数');
  const never = Ach.evaluate(null, { games: 0 }).list.filter(function (x) { return x.id === 'h2'; })[0];
  eq(never.rate, null, '没打过该牌组时出现率是 null（页面显示「—」而不是 0%）');
}
{
  /* 连败成就读的是档案里的 longestLoseStreak（和连胜同一条来源） */
  const res = Ach.evaluate(null, { games: 10, longestStreak: 1, longestLoseStreak: 6 });
  const lo = res.list.filter(function (x) { return x.name === '背到极点'; })[0];
  const lo10 = res.list.filter(function (x) { return x.name === '衰神附体'; })[0];
  ok(lo.ok === true && lo.cur === 5, '6 连败 → 背到极点达成（进度按 5 封顶）', lo.cur);
  ok(lo10.ok === false && lo10.cur === 6, '6 连败还不够衰神附体（要 10）', lo10.cur);
}

console.log('\n[5] 结构性不变量');
{
  const ids = Ach.CATALOG.map(function (x) { return x.id; });
  eq(new Set(ids).size, ids.length, '★ 成就 id 不重复');
  ok(Ach.CATALOG.every(function (x) { return x.name && x.desc && x.desc.length > 8; }),
    '★ 每条都有名字与一句像样的说明（不许留空壳）');
  const names = Ach.CATALOG.map(function (x) { return x.name; });
  eq(names.indexOf('人间清醒'), -1, '★ 人间清醒已删除');
  ok(names.indexOf('你咋这幸') >= 0 && names.indexOf('我咋这霉') >= 0, '两条新整把成就都在');
  ok(names.indexOf('背到极点') >= 0 && names.indexOf('衰神附体') >= 0, '两条连败成就都在');

  /* 新计数字段必须同时进 blankCounts 与 COUNT_KEYS —— 这就是那个「加上却永远不动」的坑 */
  const b = Ach.blankCounts();
  ['smv', 'sml', 'smn', 'r7', 'r9', 'r10', 'r12'].forEach(function (k) {
    ok(k in b, 'blankCounts 里有 ' + k);
  });
  const merged = Ach.mergeInto(Ach.blank(), {
    smv: 1, sml: 2, smn: 3, r7: 4, r9: 5, r10: 6, r12: 7
  });
  eq([merged.smv, merged.sml, merged.smn, merged.r7, merged.r9, merged.r10, merged.r12].join(','),
    '1,2,3,4,5,6,7', '★ mergeInto 认这七个新字段（漏一个就永久停在 0）');
}

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
