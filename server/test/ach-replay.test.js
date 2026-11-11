/**
 * 成就重放器（node server/test/ach-replay.test.js）
 *
 * 这是「改口径以后历史能不能翻转」的证据文件。核心断言只有一句：
 *
 *     基线 + fold(事件)  ==  线上当时算出来的结果
 *
 * 对不上就说明重放器抄错了 `profile.record()` 的判定。最容易抄错的四处，
 * 每处都有独立断言：
 *
 *   1. `posCount/negCount` 是**全场**算的，AI 占名额 → 带 bot 的场次里，
 *      负分的人不止一个，那条「只有我一个人负分」就不该亮；
 *   2. `loseBefore` 取的是**这一场之前**的连败数 → 必须在推进 streak 之前判；
 *   3. r12 是**严格大于 100**，100 整不算（用户定的边界）；
 *   4. 结算事件是**桶的边界** → 同一个房间的第二场不能带着第一场的 `_r1`。
 *
 * 期望值全部写死，没有一处拿被测函数算期望。
 */
'use strict';

const path = require('path');
const Replay = require('../achReplay.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) pass += 1;
  else { fail += 1; console.error('✗ ' + name + (extra ? ' — ' + extra : '')); }
}
function eq(a, b, name) {
  ok(a === b, name, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
}

/* 事件构造器：字段名与 eventLog 的紧凑格式一致 */
function gEvt(room, hand, round, groups, t) {
  return { k: 'g', v: 1, r: room, h: hand, rd: round, t: t, g: groups };
}
function sEvt(room, hand, players, t) {
  return { k: 's', v: 1, r: room, h: hand, t: t, p: players };
}
/* 基线表：**每个参与者都要有**。重放只处理「有基线的人」——
 * 没有基线 = 他的 ach 全是历史，拿事件重放等于把历史抹掉（脚本里也是这么守的）。 */
function bases(ids, at, streak) {
  const m = new Map();
  ids.forEach(function (id) {
    m.set(id, { at: at, counts: { since: 1 }, currentStreak: streak || 0 });
  });
  return m;
}
function base(pid, at, patch, streak) {
  const b = {};
  b[pid] = Object.assign({ at: at, counts: Object.assign({ since: 1 }, patch || {}),
    currentStreak: streak || 0 });
  return new Map(Object.entries(b));
}
function countsOf(res, pid) {
  const st = res.byPid.get(pid);
  return st ? st.counts : null;
}
function n(c, key) { return (c && Number(c[key])) || 0; }
function tn(c, key) { return (c && c.t && Number(c.t[key])) || 0; }
function mn(c, key) { return (c && c.n && Number(c.n[key])) || 0; }

console.log('\n[1] 轮级：牌型、分母、组归属（甲拿的不许记到乙头上）');
{
  const events = [
    gEvt('R1', 1, 1, [
      ['tenhalf', 'p1', [['p1', '10.5点'], ['p2', '爆牌']]],
      ['douniu', 'p2', [['p1', '没牛'], ['p2', '牛牛']]]
    ], 1000),
    sEvt('R1', 1, [['p1', 10, 0], ['p2', -10, 0]], 1010)
  ];
  const res = Replay.replay(events, { baseByPid: bases(['p1', 'p2'], 0) });
  const c1 = countsOf(res, 'p1');
  const c2 = countsOf(res, 'p2');
  ok(!!c1 && !!c2, '两个人的桶都建出来了');
  eq(tn(c1, 'th'), 1, 'p1 十点半命中 1');
  eq(tn(c1, 'mn'), 1, 'p1 没牛命中 1');
  eq(tn(c1, 'nn'), 0, '★ p1 没有牛牛 —— 乙拿的牛牛不许记到甲头上');
  eq(tn(c2, 'bz'), 1, 'p2 爆牌命中 1');
  eq(tn(c2, 'nn'), 1, 'p2 牛牛命中 1');
  eq(mn(c1, 'tenhalf'), 1, 'p1 十点半分母 1');
  eq(mn(c1, 'douniu'), 1, 'p1 斗牛分母 1');
  eq(n(c1, 'vsn'), 0, '★ 大牌对撞：本组只有 p1 一个大牌，不算对撞');
  eq(n(c1, 'smn'), 0, '★ 小牌对撞：本组不是「全场都是小牌」，也不算');
  eq(n(c1, 's1'), 0, '三个组赢了一组 → 不是通吃');
}

console.log('\n[2] 对撞：大牌撞大牌 / 一桌全小牌');
{
  const events = [
    gEvt('R2', 1, 1, [
      ['tenhalf', 'p1', [['p1', '10.5点'], ['p2', '10.5点']]],
      ['douniu', 'p3', [['p1', '没牛'], ['p2', '没牛'], ['p3', '没牛']]]
    ], 2000),
    /* 轮级计数要等这一场结算才从房间桶冲进档案（与线上一致），所以必须有结算事件 */
    sEvt('R2', 1, [['p1', -4, 0], ['p2', -4, 0], ['p3', 8, 0]], 2100)
  ];
  const res = Replay.replay(events, { baseByPid: bases(['p1', 'p2', 'p3'], 0) });
  const c1 = countsOf(res, 'p1');
  const c2 = countsOf(res, 'p2');
  const c3 = countsOf(res, 'p3');
  eq(n(c1, 'vsn'), 1, 'p1 对撞分母 1');
  eq(n(c1, 'vs'), 1, 'p1 撞赢');
  eq(n(c2, 'vsn'), 1, 'p2 对撞分母 1');
  eq(n(c2, 'vsl'), 1, 'p2 撞输');
  eq(n(c3, 'vsn'), 0, 'p3 没参与大牌对撞');
  eq(n(c1, 'smn'), 1, 'p1 小牌对撞分母 1');
  eq(n(c1, 'sml'), 1, 'p1 小牌局里输了');
  eq(n(c3, 'smv'), 1, 'p3 小牌局里赢了');
  eq(n(c3, 'sml'), 0, '赢的人不算输');
}

console.log('\n[3] 场级：「只有我一个人正分 / 负分」');
{
  const events = [
    sEvt('R3', 1, [['p1', 12, 0], ['p2', -7, 0], ['p3', -5, 0]], 3000)
  ];
  const res = Replay.replay(events, { baseByPid: bases(['p1', 'p2', 'p3'], 0) });
  eq(n(countsOf(res, 'p1'), 'r9'), 1, '★ 全场只有 p1 正分 → 你咋这幸 +1');
  eq(n(countsOf(res, 'p2'), 'r10'), 0, '★ p2 负分，但不是唯一负分 → 我咋这霉不亮');
  eq(n(countsOf(res, 'p3'), 'r10'), 0, 'p3 同理');
}
{
  const events = [
    sEvt('R4', 1, [['p1', 12, 0], ['p2', -12, 0]], 3100)
  ];
  const res = Replay.replay(events, { baseByPid: bases(['p1', 'p2'], 0) });
  /* v116：两人局不算。零和下赢的那方天然是全场唯一正分 ——
   * 那不是「幸」，那是「赢了一把」。改之前线上 235 场记了 777 次。 */
  eq(n(countsOf(res, 'p1'), 'r9'), 0, '★ 两人局，p1 独赢 → r9 **不亮**（v116 起要求 ≥3 人）');
  eq(n(countsOf(res, 'p2'), 'r10'), 0, '★ 两人局，p2 独负 → r10 也不亮');

  /* 三人局才是名字里说的那件事：一桌人都没赢到，只有我。 */
  const three = [
    sEvt('R4b', 1, [['p1', 12, 0], ['p2', -7, 0], ['p3', -5, 0]], 3150)
  ];
  const res3 = Replay.replay(three, { baseByPid: bases(['p1', 'p2', 'p3'], 0) });
  eq(n(countsOf(res3, 'p1'), 'r9'), 1, '★ 三人局，p1 独正 → r9 亮');
}

console.log('\n[4] 场级：AI 也占正负分的名额');
{
  const events = [
    sEvt('R5', 1, [['p1', 5, 0], ['p2', -5, 0], ['bot_x', -3, 1]], 4000)
  ];
  const res = Replay.replay(events, { baseByPid: bases(['p1', 'p2'], 0) });
  eq(n(countsOf(res, 'p2'), 'r10'), 0,
    '★ 有 AI 也在负分 → 负分不是「只有我一个人」，r10 不亮');
  eq(n(countsOf(res, 'p1'), 'r9'), 1, '正分仍然只有 p1 一个 → r9 亮');
  ok(!res.byPid.has('bot_x'), '★ AI 不进状态表（它不该有自己的成就）');
}

console.log('\n[5] 一夜暴富：严格大于 100');
{
  const events = [
    sEvt('R6', 1, [['p1', 101, 0]], 5000),
    sEvt('R7', 1, [['p9', 100, 0]], 5100)
  ];
  const res = Replay.replay(events, { baseByPid: bases(['p1', 'p9'], 0) });
  eq(n(countsOf(res, 'p1'), 'r12'), 1, '101 → 亮');
  eq(n(countsOf(res, 'p9'), 'r12'), 0, '★ 100 整不算（严格大于，用户定的边界）');
}

console.log('\n[6] 翻身农奴：看的是「这一场之前」的连败数');
{
  const events = [
    sEvt('R8', 1, [['p1', 6, 0], ['p2', 6, 0]], 6000)
  ];
  /* p1 基线里已经连败 5 场，p2 只连败 4 场 —— 同一场、同样赢，结果必须不同 */
  const bp = base('p1', 0, {}, -5);
  bp.set('p2', { at: 0, counts: { since: 1 }, currentStreak: -4 });
  const res = Replay.replay(events, { baseByPid: bp });
  eq(n(countsOf(res, 'p1'), 'r7'), 1, '★ 连败满 5 场之后赢一场 → 翻身农奴 +1');
  eq(n(countsOf(res, 'p2'), 'r7'), 0, '★ 只连败 4 场 → 不亮');
  eq(res.byPid.get('p1').streak, 1, '赢了之后连胜变 +1');
  eq(res.byPid.get('p2').streak, 1, 'p2 同理');
}
{
  /* 在输的那一场上不该记 r7，而且 streak 要往下走 */
  const events = [sEvt('R9', 1, [['p1', -3, 0]], 6100)];
  const res = Replay.replay(events, { baseByPid: base('p1', 0, {}, -5) });
  eq(n(countsOf(res, 'p1'), 'r7'), 0, '输的那一场不记翻身农奴');
  eq(res.byPid.get('p1').streak, -6, '连败从 -5 走到 -6');
}

console.log('\n[7] 基线之前的事件不算（否则会和基线双重计数）');
{
  /* 场级事件是桶的冲点：没有结算，轮级事件就还挂在房间桶上、不会进档案
   * （线上也是这样 —— achRun 在一场结束时才合并）。所以这里必须给一个结算。 */
  const events = [
    gEvt('R10', 1, 1, [['tenhalf', 'p1', [['p1', '10.5点']]]], 1000),
    sEvt('R10', 1, [['p1', 5, 0]], 1100),
    gEvt('R10', 2, 1, [['tenhalf', 'p1', [['p1', '10.5点']]]], 9000),
    sEvt('R10', 2, [['p1', 5, 0]], 9100)
  ];
  const res = Replay.replay(events, { baseByPid: base('p1', 5000) });
  eq(tn(countsOf(res, 'p1'), 'th'), 1, '★ 只有 t=9000 那条被算进来');
  eq(mn(countsOf(res, 'p1'), 'tenhalf'), 1, '分母同理');
}

console.log('\n[8] 结算事件是桶的边界（_r1 不许跨场泄漏）');
{
  /* 场 A：第一轮 3 组全赢 + 第二轮 2 组全赢 → 一把五组全胜（sa=1） */
  const a1 = gEvt('R11', 1, 1, [
    ['tenhalf', 'p1', [['p1', '10.5点']]],
    ['piaosanye', 'p1', [['p1', '豹子']]],
    ['douniu', 'p1', [['p1', '牛牛']]]
  ], 11000);
  const a2 = gEvt('R11', 1, 2, [
    ['tenhalf', 'p1', [['p1', '10.5点']]],
    ['piaosanye', 'p1', [['p1', '豹子']]]
  ], 11100);
  const aS = sEvt('R11', 1, [['p1', 30, 0]], 11200);
  /* 场 B：第一轮只赢 1 组（没全赢），第二轮 2 组全赢。
   * 桶没重置的话，场 A 留下的 `_r1` 会让这里凭空多一个「五子登科」。 */
  const b1 = gEvt('R11', 2, 1, [
    ['tenhalf', 'p2', [['p1', '10.5点'], ['p2', '10.5点']]],
    ['piaosanye', 'p1', [['p1', '豹子']]],
    ['douniu', 'p1', [['p1', '牛牛']]]
  ], 11300);
  const b2 = gEvt('R11', 2, 2, [
    ['tenhalf', 'p1', [['p1', '10.5点']]],
    ['piaosanye', 'p1', [['p1', '豹子']]]
  ], 11400);
  const bS = sEvt('R11', 2, [['p1', 20, 0]], 11500);
  const res = Replay.replay([a1, a2, aS, b1, b2, bS], { baseByPid: bases(['p1', 'p2'], 0) });
  const c1 = countsOf(res, 'p1');
  eq(n(c1, 's1'), 1, '场 A 第一轮通吃 +1');
  eq(n(c1, 's2'), 2, '第二轮通吃两次（场 A、场 B 各一次）');
  eq(n(c1, 'sa'), 1, '★ 五子登科只有 1 次 —— 场 A 的 _r1 没泄漏到场 B');
}

console.log('\n[9] 没有基线的人不参与（避免拿事件抹掉全部历史）');
{
  const events = [gEvt('R12', 1, 1, [['tenhalf', 'p1', [['p1', '10.5点']]]], 12000)];
  const res = Replay.replay(events, { baseByPid: new Map() });
  eq(res.byPid.size, 0, '★ 空基线表 → 一个人都不重放（没有桶可冲）');
  eq(res.rounds, 1, 'rounds 只是「扫过多少条轮级事件」的计数，不代表有人被写');
}

console.log('\n[10] diffCounts：只比计数器，不把 since 当差异');
{
  const a = { since: 111, v: 1, t: { th: 3 }, n: { tenhalf: 10 }, vs: 4, vsn: 10, r9: 2 };
  const b = { since: 222, v: 1, t: { th: 3 }, n: { tenhalf: 10 }, vs: 5, vsn: 10, r9: 2 };
  const d = Replay.diffCounts(a, b);
  eq(d.length, 1, '只有一处差异');
  eq(d[0].key, 'vs', '差异是 vs（since 变了不算）');
  eq(d[0].d, 1, '增量 +1');
  eq(Replay.isEmptyDiff(Replay.diffCounts(a, a)), true, '完全相同 → 空 diff');
  const t = Replay.diffCounts({ t: { th: 1 } }, { t: { th: 2, lp: 1 } });
  eq(t.length, 1, 't 的差异合成一条');
  eq(Object.keys(t[0].types).sort().join(','), 'lp,th', 'th 与 lp 都在里面');
}

console.log('\n[11] decodeGroups：坏数据不炸');
{
  eq(Replay.decodeGroups(null).length, 0, 'null → 空数组');
  eq(Replay.decodeGroups({}).length, 0, '缺 g → 空数组');
  const d = Replay.decodeGroups({ g: [['tenhalf', 'p1', [['p1', '10.5点']]], null] });
  eq(d.length, 1, '★ 中间夹一个 null 会被丢掉，不会让整场崩');
  eq(d[0].entries[0].typeName, '10.5点', 'typeName 原样带过去');
}

console.log('\n----------------------------------------');
if (fail) {
  console.error('失败 ' + fail + ' 项，通过 ' + pass + ' 项');
  process.exit(1);
} else {
  console.log('通过 ' + pass + ' 项，失败 0 项');
}
