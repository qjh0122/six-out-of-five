/**
 * 数值体系体检 · 第三步：门槛（Q4）
 *
 * 问题：普通玩家靠直觉能想到的几种打法，离「枚举最优」差多少？
 *   · 差得少 → 门槛低，新手也能玩明白
 *   · 差得多 → 这是数学题，不是游戏
 *
 * 只看第二轮（单张 + 斗牛），因为它是权重最大、决策最深的一组，
 * 且只有 6 种分法（选哪张给单张），可以把所有自然策略都穷举出来对比。
 */
'use strict';
const E = require('../pwa/js/engine.js');
const C = require('../pwa/js/config.js');
const Card = require('../pwa/js/card.js');

const N = Number(process.env.N || 30000);

function deal() {
  const deck = Card.createDeck();
  Card.shuffle(deck);
  return [deck.splice(0, C.CARDS_PER_PLAYER), deck.splice(0, C.CARDS_PER_PLAYER)];
}
function randSplit(h) {
  const pool = h.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return { single: [pool[0]], douniu: pool.slice(1) };
}
function score(me, opp) {
  const a = E.settleGroup('single', [{ id: 'A', hand: me.single }, { id: 'B', hand: opp.single }]).deltas.A;
  const b = E.settleGroup('douniu', [{ id: 'A', hand: me.douniu }, { id: 'B', hand: opp.douniu }]).deltas.A;
  return a + b;
}

/* 把 6 张牌按「选第 i 张给单张」全部拆出来 */
function allSplits(h) {
  return h.map((c, i) => ({ single: [c], douniu: h.filter((_, j) => j !== i), idx: i }));
}

/* 用于挑选策略：对手随机采样一批，算每个分法的期望 */
function bestBy(evFn, h, oppPool) {
  const cands = allSplits(h);
  let best = null, bestV = -Infinity;
  for (const c of cands) {
    const v = evFn(c);
    if (v > bestV) { bestV = v; best = c; }
  }
  return best;
}

const STRATEGIES = {
  '随机选一张': (h, pool) => allSplits(h)[Math.floor(Math.random() * 6)],
  '最大牌给单张': (h, pool) => {
    let bi = 0;
    for (let i = 1; i < 6; i++) if (E.compareSingle(h[i], h[bi]) > 0) bi = i;
    return allSplits(h)[bi];
  },
  '最小牌给单张': (h, pool) => {
    let bi = 0;
    for (let i = 1; i < 6; i++) if (E.compareSingle(h[i], h[bi]) < 0) bi = i;
    return allSplits(h)[bi];
  },
  /* 「先保牛，再比单张」：在能凑出牛的方案里挑单张最大的；都没牛则挑单张最大的 */
  '保牛优先': (h, pool) => {
    const cands = allSplits(h);
    const withCow = cands.filter(c => E.douNiuHasCow(c.douniu));
    const use = withCow.length ? withCow : cands;
    let best = use[0];
    for (const c of use) if (E.compareSingle(c.single[0], best.single[0]) > 0) best = c;
    return best;
  },
  '枚举最优（对照）': (h, pool) => bestBy(c => {
    let v = 0;
    for (const o of pool) v += score(c, o);
    return v / pool.length;
  }, h, pool)
};

const OPP = 30;
const res = {};
for (const k of Object.keys(STRATEGIES)) res[k] = { sum: 0, n: 0, wins: 0 };

for (let t = 0; t < N; t++) {
  const [hA, hB] = deal();
  const pool = []; for (let s = 0; s < OPP; s++) pool.push(randSplit(hB));
  const fresh = randSplit(hB);   // 评分用新鲜对手，避免对采样过拟合

  for (const [name, fn] of Object.entries(STRATEGIES)) {
    let tot = 0;
    // 每种策略跑 3 次取平均，压掉随机策略的抖动（「随机选一张」本身就是随机源）
    for (let rep = 0; rep < 3; rep++) tot += score(fn(hA, pool), fresh);
    const v = tot / 3;
    res[name].sum += v; res[name].n++; if (v > 0) res[name].wins++;
  }
}

const base = res['枚举最优（对照）'];
const baseMean = base.sum / base.n;

console.log('='.repeat(70));
console.log('Q4  门槛：直觉打法的收益，离最优差多少（' + N + ' 手，2 人局，只看第二轮）');
console.log('='.repeat(70));
console.log('打法              平均得分   对最优差距   得分率   单轮胜率');
for (const [name, r] of Object.entries(res)) {
  const m = r.sum / r.n;
  const gap = m - baseMean;
  const rate = baseMean !== 0 ? (m / baseMean * 100) : 0;
  console.log(
    (name + '                    ').slice(0, 18) +
    m.toFixed(3).padStart(8) +
    gap.toFixed(3).padStart(11) +
    rate.toFixed(1).padStart(8) + '%' +
    (r.wins / r.n * 100).toFixed(1).padStart(9) + '%'
  );
}

/* ---------- 单张出去的那张牌，最优到底是什么特征 ---------- */
console.log('');
console.log('='.repeat(70));
console.log('Q5  「最优」把哪张牌放去单张？（按最优解统计，10000 手）');
console.log('='.repeat(70));
let cnt = { '最大那张': 0, '最小那张': 0, '中间四张': 0 }, cowHand = 0, total = 0, noCowKeep = 0;
for (let t = 0; t < 10000; t++) {
  const [hA, hB] = deal();
  const pool = []; for (let s = 0; s < 20; s++) pool.push(randSplit(hB));
  const best = bestBy(c => { let v = 0; for (const o of pool) v += score(c, o); return v / pool.length; }, hA, pool);
  const singles = allSplits(hA).map(x => x.single[0]);
  let hi = 0, lo = 0;
  for (let i = 1; i < 6; i++) {
    if (E.compareSingle(singles[i], singles[hi]) > 0) hi = i;
    if (E.compareSingle(singles[i], singles[lo]) < 0) lo = i;
  }
  if (best.idx === hi) cnt['最大那张']++;
  else if (best.idx === lo) cnt['最小那张']++;
  else cnt['中间四张']++;
  if (E.douNiuHasCow(best.douniu)) cowHand++;
  total++;
}
for (const [k, v] of Object.entries(cnt)) console.log('  ' + (k + '        ').slice(0, 12) + (v / total * 100).toFixed(1) + '%');
console.log('  最优解里「斗牛有牛」的比例 ' + (cowHand / total * 100).toFixed(1) + '%');

/* ---------- 斗牛「没牛额外赔 5」的实际触发率 ---------- */
console.log('');
console.log('='.repeat(70));
console.log('Q6  斗牛「没牛额外赔 5 分」到底多常见？（双方随机分，10000 手）');
console.log('='.repeat(70));
let trig = 0, cowWin = 0, noneCount = 0;
for (let t = 0; t < 10000; t++) {
  const [hA, hB] = deal();
  const sA = randSplit(hA), sB = randSplit(hB);
  const hasA = E.douNiuHasCow(sA.douniu), hasB = E.douNiuHasCow(sB.douniu);
  if (!hasA) noneCount++;
  const r = E.settleGroup('douniu', [{ id: 'A', hand: sA.douniu }, { id: 'B', hand: sB.douniu }]);
  if (Math.abs(r.deltas.A) >= 5) trig++;
  if (r.winnerId === 'A' && hasA) cowWin++;
}
console.log('  随机分法下「自己没牛」的概率 ' + (noneCount / 10000 * 100).toFixed(1) + '%');
console.log('  一次斗牛结算分差 ≥5 分的比例 ' + (trig / 10000 * 100).toFixed(1) + '%');
