/**
 * 成就统计（node pwa/test/achievements.test.js）
 *
 * 这个文件锁四件事，任何一条坏了成就页就是错的（而且**不会报错**，只是数字不对）：
 *
 *   1. **大牌型的字符串与 engine 真实输出一致**。
 *      achievements.js 靠 `mode + ':' + typeName` 认牌型，而 typeName 是
 *      engine.js 里拼出来的（'10.5点' / '豹子' / '牛牛' …）。哪天引擎改了措辞，
 *      成就系统不会崩，只会「这个成就永远拿不到」——本文件用真实手牌跑一遍
 *      Engine.typeName 对照，把这种静默失效挡在合入之前。
 *
 *   2. **按玩家分桶**。房间增量是 `{ byPid: { pid: 计数 } }`，不是全场一个桶。
 *      第一版写成一个桶，结果是「甲拿的豹子记到了乙头上」——两人局的端到端
 *      测试量得出来，但纯逻辑测试更该先挡住它。
 *
 *   3. **分母口径**。概率是 `我命中 / 我参与该组的次数`，不是「打了多少把」，
 *      也不是「场上出现过几次」；对撞的分母更是只在「两边都拿大牌」时才 +1。
 *
 *   4. **白名单合并**。房间桶上有 `byPid` / `_r1`（判五子登科用的临时标记），
 *      它们绝不能被 mergeInto 写进档案 —— 写进去就是一条永不消失的脏字段。
 *
 * 判据独立：期望值全部手写，没有一处拿被测函数自己算期望。
 */
'use strict';

var Ach = require('../js/achievements.js');
var Engine = require('../js/engine.js');

var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) pass += 1;
  else { fail += 1; console.error('✗ ' + name + (extra ? ' — ' + extra : '')); }
}
function eq(a, b, name) {
  ok(a === b, name, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
}

/* 造一组结算结果。entries 是 [[id, typeName], …]，直接写死牌型 ——
 * 这一层测的是「统计口径」，不是「牌型判定」（后者由 engine 的测试负责）。 */
function group(mode, pairs, winnerId) {
  return {
    group: mode,
    winnerId: winnerId,
    entries: pairs.map(function (p) { return { id: p[0], typeName: p[1] }; })
  };
}
function bucket(run, pid) {
  return (run && run.byPid && run.byPid[pid]) || {};
}
function tv(b, k) { return (b.t && b.t[k]) || 0; }
function nv(b, k) { return (b.n && b.n[k]) || 0; }

/* ================================================================
 * 一、牌型字符串与 engine 的输出逐字对齐
 * ================================================================ */
var C = function (suit, rank) { return { suit: suit, rank: rank }; };

eq(Engine.typeName('tenhalf', [C('spade', 11), C('heart', 10)]), '10.5点',
  '★ engine 的十点半输出就是「10.5点」，BIG_TYPES 必须照着它写');
eq(Engine.typeName('piaosanye', [C('spade', 9), C('heart', 9), C('club', 9)]), '豹子',
  '★ engine 的豹子输出就是「豹子」');
eq(Engine.typeName('piaosanye', [C('spade', 5), C('spade', 4), C('spade', 3)]), '同花顺',
  '★ engine 的同花顺输出就是「同花顺」');
eq(Engine.typeName('douniu', [C('spade', 10), C('heart', 10), C('club', 10), C('diamond', 5), C('spade', 5)]), '牛牛',
  '★ engine 的牛牛输出就是「牛牛」');
eq(Engine.typeName('douniu', [C('spade', 11), C('heart', 12), C('club', 13), C('diamond', 11), C('spade', 12)]), '五花牛',
  '★ engine 的五花牛输出就是「五花牛」');
eq(Engine.typeName('douniu', [C('spade', 10), C('heart', 10), C('club', 10), C('diamond', 5), C('spade', 4)]), '牛9',
  '牛9 不是大牌型（名字对不上，不该被统计）');

/* ================================================================
 * 二、累加：按人分桶 + 分母按人计
 * ================================================================ */
var run = Ach.accumulate(null, 1, [
  group('single', [['p1', 'K♠'], ['p2', '3♦']], 'p1'),
  group('tenhalf', [['p1', '10.5点'], ['p2', '9点']], 'p1'),
  group('piaosanye', [['p1', '豹子'], ['p2', '散牌']], 'p1')
]);

eq(tv(bucket(run, 'p1'), 'th'), 1, 'p1 拿到一次十点半');
eq(tv(bucket(run, 'p1'), 'lp'), 1, 'p1 拿到一次豹子');
eq(tv(bucket(run, 'p2'), 'th'), 0, '★★ p2 一次十点半都没拿到（分桶生效——不分桶的话这里会是 1）');
eq(tv(bucket(run, 'p2'), 'lp'), 0, '★★ p2 也没有豹子');

/* 分母按人计：两个人都参与了十点半组，所以**各自**是 1 */
eq(nv(bucket(run, 'p1'), 'tenhalf'), 1, '★ 分母是「我自己参与了几次」，不是场上出现几次');
eq(nv(bucket(run, 'p2'), 'tenhalf'), 1, 'p2 的分母也是 1');
eq(nv(bucket(run, 'p1'), 'single'), 0, '单张组不进分母（它没有大牌型）');

eq(bucket(run, 'p1').vsn, 0, '★ 只有一个人拿大牌型 → 不算对撞，分母是 0');
eq(bucket(run, 'p2').vsn, 0, 'p2 也不是对撞');
eq(bucket(run, 'p1').s1, 1, 'p1 第一轮三组全赢 → 一巡清场 +1');
eq(bucket(run, 'p1').sw, 1, '通吃总数 +1');
eq(bucket(run, 'p1').sa, 0, '单看第一轮不能判五子登科');
eq(bucket(run, 'p2').s1, 0, 'p2 没通吃');

/* ================================================================
 * 三、对撞：两边都拿大牌才算，而且各记各的
 * ================================================================ */
var vs = Ach.accumulate(null, 2, [
  group('douniu', [['p1', '牛牛'], ['p2', '牛牛'], ['p3', '没牛']], 'p1')
]);
eq(bucket(vs, 'p1').vsn, 1, 'p1 的对撞分母 +1（他自己撞了一次）');
eq(bucket(vs, 'p1').vs, 1, 'p1 记一次「吃」');
eq(bucket(vs, 'p1').vsl, 0, 'p1 没被吃');
eq(bucket(vs, 'p2').vsn, 1, 'p2 的分母也 +1');
eq(bucket(vs, 'p2').vs, 0, 'p2 没吃到别人');
eq(bucket(vs, 'p2').vsl, 1, 'p2 记一次「被吃」');
eq(bucket(vs, 'p3').vsn, 0, '★ 没牛的人不进对撞分母（他本来就不是大牌型）');
eq(bucket(vs, 'p3').t.nn || 0, 0, 'p3 也没有牛牛计数');
eq(tv(bucket(vs, 'p1'), 'nn'), 1, 'p1 牛牛 +1');
eq(tv(bucket(vs, 'p2'), 'nn'), 1, 'p2 牛牛 +1');

/* 吃掉普通牌不算对撞 —— 这组成就最容易做错的地方 */
var vsNormal = Ach.accumulate(null, 2, [
  group('douniu', [['p1', '牛牛'], ['p2', '没牛']], 'p1')
]);
eq(bucket(vsNormal, 'p1').vsn, 0, '★ 对手是没牛 → 不算对撞（分母 0，胜率无意义）');
eq(bucket(vsNormal, 'p1').vs, 0, '也不记「吃」');

/* 三个人都拿大牌：赢家 1 次吃、另外两人各 1 次被吃 */
var vsThree = Ach.accumulate(null, 2, [
  group('douniu', [['p1', '五花牛'], ['p2', '牛牛'], ['p3', '牛牛']], 'p1')
]);
eq(bucket(vsThree, 'p1').vs, 1, '赢家记吃');
eq(bucket(vsThree, 'p2').vsl, 1, 'p2 被吃');
eq(bucket(vsThree, 'p3').vsl, 1, 'p3 被吃');
eq(bucket(vsThree, 'p1').vsn, 1, '每个人的分母都是 1（他参与了这一次对撞）');

/* ================================================================
 * 四、通吃与五子登科（跨两轮的组合判定）
 * ================================================================ */
/* ★ 注意：accumulate 是**就地修改**并返回同一个对象（房间里就一个 run）。
 * 所以判「只赢第一轮」时必须重新造一份，不能复用已经被第二轮改过的对象。 */
function mkFirstRound() {
  return Ach.accumulate(null, 1, [
    group('single', [['p1', 'A♠'], ['p2', '3♦']], 'p1'),
    group('tenhalf', [['p1', '9点'], ['p2', '8点']], 'p1'),
    group('piaosanye', [['p1', '对子'], ['p2', '散牌']], 'p1')
  ]);
}
var r1 = mkFirstRound();
eq(bucket(r1, 'p1').s1, 1, '第一轮三组全赢');
var r2 = Ach.accumulate(r1, 2, [
  group('single', [['p1', 'A♠'], ['p2', '3♦']], 'p1'),
  group('douniu', [['p1', '牛9'], ['p2', '没牛']], 'p1')
]);
eq(bucket(r2, 'p1').s2, 1, '第二轮两组全赢');
eq(bucket(r2, 'p1').sa, 1, '★ 两轮都全赢 → 五子登科 +1');
eq(bucket(r2, 'p1').sw, 2, '通吃总数 = 第一轮 1 + 第二轮 1');
eq(bucket(r2, 'p2').sa, 0, 'p2 一次都没通吃');

/* 只赢第一轮、第二轮没全赢 → 没有五子登科 */
var halfBase = mkFirstRound();
eq(bucket(halfBase, 'p1').s2, 0, '新建的第一轮结果里没有第二轮的痕迹');
var half = Ach.accumulate(halfBase, 2, [
  group('single', [['p1', 'A♠'], ['p2', '3♦']], 'p1'),
  group('douniu', [['p1', '没牛'], ['p2', '牛9']], 'p2')
]);
eq(bucket(half, 'p1').s2, 0, '第二轮只赢一组，不算通吃');
eq(bucket(half, 'p1').sa, 0, '也不该判五子登科');

/* ================================================================
 * 五、弃权不参与分母
 * ================================================================ */
var withFold = Ach.accumulate(null, 1, [
  group('tenhalf', [['p1', '10.5点'], ['p2', '弃权'], ['p3', '9点']], 'p1')
]);
eq(nv(bucket(withFold, 'p1'), 'tenhalf'), 1, 'p1 的分母是 1');
eq(nv(bucket(withFold, 'p3'), 'tenhalf'), 1, 'p3 的分母也是 1');
eq(nv(bucket(withFold, 'p2'), 'tenhalf'), 0, '★ 弃权的人分母是 0（他没出牌，不该被算参与）');
eq(tv(bucket(withFold, 'p1'), 'th'), 1, '赢家的十点半照常记');

/* ================================================================
 * 六、mergeInto：白名单，且不把房间临时字段带进档案
 * ================================================================ */
var store = Ach.blank();
Ach.mergeInto(store, bucket(r2, 'p1'));
eq(store.s1, 1, '合并后 s1 = 1');
eq(store.s2, 1, '合并后 s2 = 1');
eq(store.sa, 1, '合并后 sa = 1');
eq(store.byPid, undefined, '★ byPid 是房间结构，绝不能进档案');
eq(store._r1, undefined, '★ _r1 是房间临时字段，绝不能进档案');
eq(typeof store.since, 'number', '首次合并会写入 since');
ok(store.since > 0, 'since 是有效时间戳');

/* 再来一次：计数是累加，不是覆盖 */
Ach.mergeInto(store, bucket(r2, 'p1'));
eq(store.s1, 2, '第二次合并后 s1 = 2（累加，不覆盖）');

/* 野字段被拒绝：模拟以后改了 typeKey，老档案里的残键不该跟着走 */
var dirty = Ach.blank();
Ach.mergeInto(dirty, { t: { zz: 5, th: 2 }, n: { unknownmode: 3, tenhalf: 4 } });
eq(dirty.t.zz, undefined, '★ 目录里没有的 typeKey 不写入');
eq(dirty.t.th, 2, '认识的 typeKey 照常写入');
eq(dirty.n.unknownmode, undefined, '不认识的模式不写入分母');
eq(dirty.n.tenhalf, 4, '认识的模式照常写入');

/* runOf：落库时取自己那一桶 */
eq(Ach.runOf(r2, 'p1') && Ach.runOf(r2, 'p1').s1, 1, 'runOf 取到 p1 的桶');
eq(Ach.runOf(r2, 'nobody'), null, '★ runOf 对没参与的人返回 null（不是空对象）');
eq(Ach.runOf(null, 'p1'), null, '没有房间桶时也返回 null');

/* ================================================================
 * 七、统计表：分母为 0 时概率是 null 而不是 0
 * ================================================================ */
var st = Ach.typeStats(Ach.blank());
eq(st.types.length, 8, '八种牌型都要出现（5 种大牌 + 3 种小牌）');
eq(st.types[0].label, '五花牛', '排序：最稀有的排最前');
eq(st.types[0].rate, null, '★ 没参与过 → 概率是 null（不等于 0%）');
eq(st.vs.total, 0, '对撞分母 0');
eq(st.vs.rate, null, '对撞胜率 null');

var st2 = Ach.typeStats(bucket(run, 'p1'));
eq(st2.types.filter(function (t) { return t.label === '十点半'; })[0].hit, 1, '十点半 1 次');
/* p1 参与了 1 次十点半组、拿到 1 次 → 1/1 = 1。
 * 手写 1 而不是 `1/1`，是为了让「分母到底取什么」这件事在期望值里可见。 */
eq(st2.types.filter(function (t) { return t.label === '十点半'; })[0].rate, 1, '★★ 概率分母是「我参与该组的次数」');

/* ================================================================
 * 八、目录与判定
 * ================================================================ */
/* v114：去掉 5 条「首次拿到」的重复成就（与「N 次」那条重复）+ 补 4 条通赔
 * v115：对撞从 7 条重排成对称的 8 条（大牌 4 + 小牌 4） */
eq(Ach.TOTAL, 39, '成就总数 39（牌型 8 + 对撞 8 + 通吃通赔 8 + 战绩 15）');

var emptyEval = Ach.evaluate(Ach.blank(), { games: 0, longestStreak: 0, bestNet: 0 });
eq(emptyEval.total, 39, 'evaluate 返回全部条目（未解锁也要返回，页面要显示名字）');
eq(emptyEval.unlocked, 0, '空档案一个都没解锁');
ok(emptyEval.list.every(function (i) { return typeof i.name === 'string' && i.name.length > 0; }),
  '未解锁条目也带名字（用户裁定：不做 ??? 猜谜）');

var byS = emptyEval.bySeries;
eq(byS.type.total, 8, '牌型系列 8 条（5 种大牌各一条「N 次」+ 3 种小牌）');
eq(byS.vs.total, 8, '对撞系列 8 条（大牌 4 + 小牌 4，一一对称）');
eq(byS.sweep.total, 8, '通吃 / 通赔各 4 条');
eq(byS.record.total, 15, '战绩系列 15 条（v116 补熟面孔 / 铁人 / 十五连胜 / 单场之王；人间清醒已删）');

/* 单条判定：拿到 1 次十点半 → h2 还没解锁（门槛 10 次），但**次数已经记上** */
var oneTh = Ach.evaluate({ t: { th: 1 } }, { games: 1, longestStreak: 0, bestNet: 0 });
function findEval(e, id) {
  return e.list.filter(function (i) { return i.id === id; })[0];
}
eq(findEval(oneTh, 'h2').raw, 1, '拿到 1 次，raw 就是 1（卡片展示的是次数）');
eq(findEval(oneTh, 'h2').ok, false, '十点半成瘾：需要 10 次');
eq(findEval(oneTh, 'h2').cur, 1, '进度条显示 1 / 10');

/* ---- 对撞八条胜率 / 次数（2026-11-11 第 3 批：比率口径） ----
 *
 * 大牌：c4 硬茬子(赢次数) c8 软脚虾(输次数) c3 遇强则强(胜率≥46%) c7 外强中干(胜率<34%)
 * 小牌：c5 宁为鸡头(赢次数) c6 鸡飞蛋打(输次数) c9 矮子里拔将军(≥46%) c10 矬子里垫底(<34%)
 *
 * 为什么不是 50%：对撞是 N 人对赌，必然 1 赢 N−1 输，个人胜率上限 = 1/N。
 * 线上实测平均 2.38 人 → 上限 42.1%，全局胜率 42.06%。50% 是数学不可达。
 *
 * 34%~46% 是**真空区**：两条都不亮。略高于均值不是本事，略低于均值也不算倒霉，
 * 给徽章就等于又发了一枚「参与即得」。这是第 3 批的故意设计，不是漏判。
 *
 * 门槛也变了（大牌 100 / 小牌 30）：没有样本量，比率只是运气的一次快照。 */
var vsWin = Ach.evaluate({ vsn: 100, vs: 60, vsl: 40 }, {});
eq(findEval(vsWin, 'c4').ok, true, '硬茬子：撞 100 次赢 60 次 → 赢的次数够 1 就亮');
eq(findEval(vsWin, 'c8').ok, true, '软脚虾：输 40 次 → 也亮（一输一赢互不排斥）');
eq(findEval(vsWin, 'c3').ok, true, '★ 遇强则强：60% ≥ 46% → 亮');
eq(findEval(vsWin, 'c7').ok, false, '外强中干：60% → 不亮');

var vsEdge = Ach.evaluate({ vsn: 100, vs: 46, vsl: 54 }, {});
eq(findEval(vsEdge, 'c3').ok, true, '★ 边界 46% → 遇强则强亮（≥ 含等号）');
eq(findEval(vsEdge, 'c7').ok, false, '★ 边界 46% → 外强中干不亮');

var vsDead = Ach.evaluate({ vsn: 100, vs: 40, vsl: 60 }, {});
eq(findEval(vsDead, 'c3').ok, false, '★ 40% 在真空区 → 遇强则强不亮');
eq(findEval(vsDead, 'c7').ok, false, '★ 40% 在真空区 → 外强中干也不亮（略输不算「干」）');

var vsLose = Ach.evaluate({ vsn: 100, vs: 33, vsl: 67 }, {});
eq(findEval(vsLose, 'c3').ok, false, '33% → 遇强则强不亮');
eq(findEval(vsLose, 'c7').ok, true, '★ 33% < 34% → 外强中干亮');

/* 样本门槛：胜率再高，分母不够也不给。
 * 不设门槛的话「撞一次赢一次」就是 100%，一局点亮 —— 那不叫运强，叫运气好一次。 */
var vsFew = Ach.evaluate({ vsn: 99, vs: 99 }, {});
eq(findEval(vsFew, 'c3').ok, false, '★ 胜率 100% 但只撞了 99 次 → 不解锁（门槛 100）');
eq(findEval(vsFew, 'c7').ok, false, '★ 分母不够时 c7 也不亮（门槛是两边共同的前提）');

/* 小牌同构：门槛 30 次（可遇性低，见 achievements.js 的 SM_MIN） */
var smWin = Ach.evaluate({ smn: 30, smv: 15, sml: 15 }, {});
eq(findEval(smWin, 'c5').ok, true, '宁为鸡头：小牌局赢 15 次 → 亮');
eq(findEval(smWin, 'c6').ok, true, '鸡飞蛋打：小牌局输 15 次 → 亮');
eq(findEval(smWin, 'c9').ok, true, '★ 矮子里拔将军：50% ≥ 46% → 亮');
eq(findEval(smWin, 'c10').ok, false, '矬子里垫底：50% → 不亮');

var smDead = Ach.evaluate({ smn: 30, smv: 12, sml: 18 }, {});
eq(findEval(smDead, 'c9').ok, false, '★ 小牌 40% 在真空区 → 矮子里拔将军不亮');
eq(findEval(smDead, 'c10').ok, false, '★ 小牌 40% 在真空区 → 矬子里垫底也不亮');

var smLose = Ach.evaluate({ smn: 30, smv: 9, sml: 21 }, {});
eq(findEval(smLose, 'c9').ok, false, '★ 小牌 30% → 矮子里拔将军不亮');
eq(findEval(smLose, 'c10').ok, true, '★ 小牌 30% < 34% → 矬子里垫底亮');

var smFew = Ach.evaluate({ smn: 29, smv: 29 }, {});
eq(findEval(smFew, 'c9').ok, false, '★ 小牌 100% 但只 29 次 → 不解锁（门槛 30）');
eq(findEval(smFew, 'c10').ok, false, '★ 小牌分母不够时 c10 也不亮');

/* 空窗地毯检查：任意一组计数值，两条胜率成就都不能同时亮（46% 与 34% 不重叠） */
var badPairs = [];
[[0, 0], [30, 0], [30, 14], [30, 15], [100, 33], [100, 34], [100, 46], [100, 60], [370, 180]]
  .forEach(function (p) {
    var e = Ach.evaluate({ vsn: p[0], vs: p[1], vsl: p[0] - p[1] }, {});
    if (findEval(e, 'c3').ok && findEval(e, 'c7').ok) badPairs.push('vs ' + p.join('/'));
  });
eq(badPairs.length, 0, '★ 大牌胜率两条永远不会同时亮：' + (badPairs.join(', ') || '无冲突'));

var badSm = [];
[[0, 0], [30, 0], [30, 10], [30, 14], [29, 29], [30, 30]].forEach(function (p) {
  var e = Ach.evaluate({ smn: p[0], smv: p[1] }, {});
  if (findEval(e, 'c9').ok && findEval(e, 'c10').ok) badSm.push('sm ' + p.join('/'));
});
eq(badSm.length, 0, '★ 小牌胜率两条永远不会同时亮：' + (badSm.join(', ') || '无冲突'));

/* 八条的名字都要有，且不能重名（用户裁定：名字要各有特色） */
var vsNames = emptyEval.list.filter(function (i) { return i.series === 'vs'; })
  .map(function (i) { return i.name; });
eq(vsNames.length, 8, '对撞系列对外暴露 8 条');
eq(vsNames.filter(function (n, i) { return vsNames.indexOf(n) !== i; }).length, 0,
  '★ 对撞 8 条名字互不重复：' + vsNames.join(' / '));

/* 战绩系列靠档案里已有的字段，不需要新采集 */
var vet = Ach.evaluate({}, { games: 100, longestStreak: 10, bestNet: 15 });
eq(findEval(vet, 'first').ok, true, '第一次：games ≥ 1');
eq(findEval(vet, 'veteran').ok, true, '老油条：games ≥ 100');
eq(findEval(vet, 'streak10').ok, true, '十连胜：longestStreak ≥ 10');
/* v112 改口径：一夜暴富不再看「单把 15 分」这个绝对阈值，
 * 而是「我的净胜 ≥ 在场所有输家负分总和的一半」（由 accumulateHand 计数 r12）。 */
eq(findEval(vet, 'windfall').ok, false, '只靠 bestNet 拿不到一夜暴富（它看的是 r12 计数）');

/* 边界：差一点点就不解锁 */
var justUnder = Ach.evaluate({}, { games: 99, longestStreak: 9, bestNet: 14 });
eq(findEval(justUnder, 'veteran').ok, false, '99 场拿不到老油条');
eq(findEval(justUnder, 'streak10').ok, false, '9 连胜拿不到十连胜');
eq(findEval(justUnder, 'windfall').ok, false, '没有 r12 计数就拿不到一夜暴富');

/* 传 null / 缺字段不能抛 */
var nullEval = Ach.evaluate(null, null);
eq(nullEval.total, 39, 'ACH 为 null 时按空桶处理，不抛');
eq(nullEval.unlocked, 0, '仍然是 0 解锁');

/* sinceText */
eq(Ach.sinceText(0), '', 'since=0 返回空串（页面据此不显示「从 X 起记录」）');
ok(/^\d{4}-\d{2}-\d{2}$/.test(Ach.sinceText(Date.now())), 'sinceText 输出 YYYY-MM-DD');

/* blank / blankCounts 的区别 */
var b1 = Ach.blank();
var b2 = Ach.blankCounts();
eq(b1.v, 1, 'blank 带结构版本号');
eq(b2.v, undefined, 'blankCounts 不带版本号（它是房间增量，不是档案）');
eq(b2.since, undefined, 'blankCounts 也不带 since（时间在落库时写）');
ok(!!b1.t && !!b2.t, '两者都有 t / n');

/* ================================================================
 * 汇总
 * ================================================================ */
/* 汇总格式必须能被 scripts/run-tests.js 的 `通过 N 项，失败 M 项` 正则取到。
 * 写成「N 项通过」的话，这个文件的几十条断言在总账里一直是 0 —— 数字小看不出来，
 * 但「131 文件 / N 断言」这句话会悄悄少算一整个文件。 */
console.log('\n' + (fail === 0 ? '全部通过' : '有失败'));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
