/**
 * 成就 v114 的守卫：去重 + 通赔 + 文案口径
 *
 * 这一版改的三件事，坏起来都不报错：
 *   1. **去重**：同一牌型留「首次」+「N 次」两条，页面上一半卡片永远「未达成」；
 *   2. **通赔**：判定「全输」时如果只看「没赢」，弃权的人后面几组根本没参与，
 *      也会被算成通赔 —— 那不是输，那是没打；
 *   3. **文案**：卡片展示的是累计次数，描述里却写「十次」，玩家会以为停在 10。
 */
'use strict';

const Ach = require('../js/achievements.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

function group(mode, entries, winnerId) {
  return {
    group: mode,
    winnerId: winnerId,
    entries: entries.map(function (e) { return { id: e[0], typeName: e[1] }; })
  };
}

console.log('\n[1] 通赔：一轮每一组都参与、且每一组都没赢');
{
  /* 三人房，第一轮三组全被乙赢走 → 甲、丙都是「一巡散场」 */
  const run = Ach.accumulate(null, 1, [
    group('tenhalf', [['a', '9点'], ['b', '10.5点'], ['c', '8点']], 'b'),
    group('piaosanye', [['a', '散牌'], ['b', '豹子'], ['c', '对子']], 'b'),
    group('douniu', [['a', '没牛'], ['b', '牛牛'], ['c', '没牛']], 'b')
  ]);
  eq(Ach.runOf(run, 'a').l1, 1, '甲：第一轮三组全输 → l1 +1');
  eq(Ach.runOf(run, 'c').l1, 1, '丙：同上');
  eq(Ach.runOf(run, 'a').lw, 1, '通赔总次数 +1');
  eq(Ach.runOf(run, 'b').l1 || 0, 0, '★ 赢家不算通赔（他三组全赢，那是通吃）');
  eq(Ach.runOf(run, 'b').s1, 1, '赢家确实记了通吃');
}
{
  /* 一轮里只要赢过一组，就不是通赔 */
  const run = Ach.accumulate(null, 1, [
    group('tenhalf', [['a', '10.5点'], ['b', '9点']], 'a'),
    group('piaosanye', [['a', '散牌'], ['b', '豹子']], 'b'),
    group('douniu', [['a', '没牛'], ['b', '牛牛']], 'b')
  ]);
  eq(Ach.runOf(run, 'a').l1 || 0, 0, '★ 赢过一组就不算通赔');
}
{
  /* ★ 关键负向：有人弃权（没参与那组）时，哪怕他参与的组全输，也不算通赔 */
  const run = Ach.accumulate(null, 1, [
    group('tenhalf', [['a', '9点'], ['b', '10.5点']], 'b'),
    group('piaosanye', [['a', '弃权'], ['b', '豹子']], 'b'),
    group('douniu', [['a', '弃权'], ['b', '牛牛']], 'b')
  ]);
  eq(Ach.runOf(run, 'a').l1 || 0, 0, '★ 中途弃权不算通赔（他只打了一组）');
  eq(Ach.runOf(run, 'a').lw || 0, 0, '通赔总次数也不动');
}
{
  /* 第二轮两组全输 → 双赔；第一轮也全输 → 叠加成「五子皆输」 */
  const run = Ach.accumulate(null, 1, [
    group('tenhalf', [['a', '9点'], ['b', '10.5点']], 'b'),
    group('piaosanye', [['a', '散牌'], ['b', '豹子']], 'b'),
    group('douniu', [['a', '没牛'], ['b', '牛牛']], 'b')
  ]);
  Ach.accumulate(run, 2, [
    group('tenhalf', [['a', '8点'], ['b', '9点']], 'b'),
    group('douniu', [['a', '没牛'], ['b', '牛牛']], 'b')
  ]);
  eq(Ach.runOf(run, 'a').l2, 1, '第二轮两组全输 → l2 +1');
  eq(Ach.runOf(run, 'a').la, 1, '★ 一把五组全输 → la +1');
  eq(Ach.runOf(run, 'a').lw, 2, '通赔总次数 = 两轮各一次');
}
{
  /* 通吃与通赔互斥：同一个人不可能在同一轮既全赢又全输 */
  const run = Ach.accumulate(null, 1, [
    group('tenhalf', [['a', '10.5点'], ['b', '9点']], 'a'),
    group('piaosanye', [['a', '豹子'], ['b', '散牌']], 'a'),
    group('douniu', [['a', '牛牛'], ['b', '没牛']], 'a')
  ]);
  const a = Ach.runOf(run, 'a');
  ok((a.s1 > 0) !== (a.l1 > 0), '★ 同一轮不会既通吃又通赔');
}

console.log('\n[2] 目录去重：同一牌型只留一条计数成就');
{
  const names = Ach.CATALOG.map(function (x) { return x.name; });
  ['刚好十点半', '豹纹加身', '一气呵成', '牛气冲天', '五朵金花'].forEach(function (n) {
    eq(names.indexOf(n), -1, '「' + n + '」已删除（与「N 次」那条重复）');
  });
  ['十点半成瘾', '豹子头', '同花顺专业户', '牛魔王', '花牛成精'].forEach(function (n) {
    ok(names.indexOf(n) >= 0, '「' + n + '」保留（它记的是次数）');
  });
  const types = Ach.CATALOG.filter(function (x) { return x.series === 'type'; });
  eq(types.length, 8, '牌型系列 8 条（5 大 + 3 小）');
  eq(Ach.CATALOG.length, 39, '总数 39（v116 补熟面孔 / 铁人 / 十五连胜 / 单场之王）');
}

console.log('\n[3] 文案：描述不许写门槛，牌张数要写对');
{
  const byName = {};
  Ach.CATALOG.forEach(function (x) { byName[x.name] = x; });
  ['十点半成瘾', '豹子头', '同花顺专业户', '牛魔王', '花牛成精'].forEach(function (n) {
    ok(!/十次|五次|三十次|三次/.test(byName[n].desc), '★「' + n + '」描述里没有门槛数字', byName[n].desc);
  });
  ok(!/十次以上/.test(byName['遇强则强'].desc), '★「遇强则强」描述不再写「十次以上」', byName['遇强则强'].desc);
  ok(/飘三叶三张/.test(byName['一手散珠'].desc), '★「一手散珠」写的是三张（飘三叶是三张牌）', byName['一手散珠'].desc);
}

console.log('\n[4] 通赔四条与通吃一一对应');
{
  const sweep = Ach.CATALOG.filter(function (x) { return x.series === 'sweep'; });
  eq(sweep.length, 8, '通吃 4 + 通赔 4');
  const names = sweep.map(function (x) { return x.name; });
  eq(names.join(','), '一巡清场,双杀,五子登科,常胜将军,一巡散场,双赔,五子皆输,常败将军', '顺序与命名都钉住');
  const ach = Ach.blank();
  ach.l1 = 2; ach.l2 = 1; ach.la = 1; ach.lw = 3;
  const rows = Ach.evaluate(ach, { games: 5 }).list.filter(function (x) { return x.series === 'sweep'; });
  eq(rows.map(function (x) { return x.raw; }).join(','), '0,0,0,0,2,1,1,3', '四条通赔各自读自己的计数');
}

console.log('\n[5] 对撞八条：对称口径 + 两条胜率互斥（v115）');
{
  /* 八条对称表：大牌 / 小牌 各自的 赢次数 · 输次数 · 胜率≥46% · 胜率<34%。
   * 中间 34%~46% 是真空区（2026-11-11 第 3 批），两条都不亮。
   * 顺序就是目录顺序，钉住它 —— 以后谁插一条、删一条，这里立刻红。 */
  const vs = Ach.CATALOG.filter(function (x) { return x.series === 'vs'; });
  eq(vs.map(function (x) { return x.name; }).join(','),
    '硬茬子,软脚虾,遇强则强,外强中干,宁为鸡头,鸡飞蛋打,矮子里拔将军,矬子里垫底',
    '★ 对撞八条的顺序与命名都钉住（大牌 4 前，小牌 4 后）');

  function evalWith(vs, vsn, smv, smn) {
    const ach = Ach.blank();
    ach.vs = vs; ach.vsn = vsn; ach.vsl = vsn - vs;
    ach.smv = smv; ach.smn = smn; ach.sml = smn - smv;
    const rows = Ach.evaluate(ach, { games: 20 }).list;
    function get(n) { return rows.filter(function (x) { return x.name === n; })[0]; }
    return {
      hard: get('硬茬子'), softy: get('软脚虾'),
      strong: get('遇强则强'), bluff: get('外强中干'),
      head: get('宁为鸡头'), broken: get('鸡飞蛋打'),
      tall: get('矮子里拔将军'), short: get('矬子里垫底')
    };
  }
  {
    const r = evalWith(70, 100, 24, 30);
    ok(r.strong.ok === true && r.bluff.ok === false, '★ 大牌胜率 70% → 遇强则强亮，外强中干不亮');
    ok(r.tall.ok === true && r.short.ok === false, '★ 小牌胜率 80% → 矮子里拔将军亮，矬子里垫底不亮');
    ok(r.hard.ok === true && r.softy.ok === true, '★ 赢次数与输次数同时成立（70% 也是输过 30 次的）');
    eq(r.hard.raw, 70, '硬茬子的次数 = 赢的次数 70');
    eq(r.softy.raw, 30, '软脚虾的次数 = 输的次数 30');
  }
  {
    const r = evalWith(33, 100, 9, 30);
    ok(r.strong.ok === false && r.bluff.ok === true, '★ 大牌胜率 33% < 34% → 外强中干亮，遇强则强不亮');
    ok(r.tall.ok === false && r.short.ok === true, '★ 小牌胜率 30% < 34% → 矬子里垫底亮');
  }
  {
    /* 2026-11-11 第 3 批：34%~46% 是**真空区**，两条都不亮。
     * 上一版是「≥50% / <50% 互补」，五五开必归一边；现在中间留了空档 ——
     * 略高于均值不是本事，略低于均值也不算倒霉。 */
    const r = evalWith(40, 100, 12, 30);
    ok(r.strong.ok === false && r.bluff.ok === false,
      '★ 大牌 40% 落在真空区 → 两条都不亮');
    ok(r.tall.ok === false && r.short.ok === false,
      '★ 小牌 40% 落在真空区 → 两条都不亮');
    ok(Math.abs(r.strong.rate - 0.4) < 1e-9, '真空区里胜率照样算出来（卡片要显示，不是藏起来）');
    ok(Math.abs(r.tall.rate - 0.4) < 1e-9, '小牌真空区同理');
    const none = evalWith(0, 0, 0, 0);
    eq(none.tall.rate, null, '小牌没打过时胜率是 null（显示「—」而不是 0%）');
    eq(none.strong.rate, null, '大牌没打过时胜率同样是 null');
  }
  {
    /* 边界：46% 归正向（≥ 含等号），34% 归真空区（< 34% 才反向） */
    const atFwd = evalWith(46, 100, 0, 0);
    ok(atFwd.strong.ok === true, '★ 边界 46% → 遇强则强亮');
    const atRev = evalWith(34, 100, 0, 0);
    ok(atRev.bluff.ok === false, '★ 边界 34% → 外强中干不亮（要严格小于）');
    const belowRev = evalWith(33, 100, 0, 0);
    ok(belowRev.bluff.ok === true, '★ 33% → 外强中干亮');
  }
  {
    const r = evalWith(99, 99, 0, 0);
    ok(r.strong.ok === false, '★ 只撞 99 次、胜率 100% 也不亮（门槛是 100 次）');
    ok(r.bluff.ok === false, '★ 分母不够时对手那条也不亮');
    eq(r.strong.raw, 99, '卡片上的次数仍然是 99');
  }
  {
    const r = evalWith(70, 100, 0, 0);
    eq(r.strong.rate, 0.7, '硬碰硬卡片的出现率就是胜率');
    ok(!(r.strong.ok && r.bluff.ok), '★ 两条不会同时点亮（46% 与 34% 不重叠）');
    ok(!(r.tall.ok && r.short.ok), '★ 小牌那两条同样不会同时亮');
  }
  {
    /* 描述里不许出现门槛数字（用户裁定：卡片展示次数，写门槛会让人以为停在 10） */
    const bad = vs.filter(function (x) { return /十次|五次|三十次|三张凑十/.test(x.desc); });
    eq(bad.map(function (x) { return x.name; }).join(','), '', '★ 对撞八条描述里都没有门槛数字');
    /* 名字不许重（用户要求「各有特色」） */
    const dup = vs.filter(function (x, i) { return vs.map(function (y) { return y.name; }).indexOf(x.name) !== i; });
    eq(dup.length, 0, '★ 八条名字互不重复');
  }
}

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
