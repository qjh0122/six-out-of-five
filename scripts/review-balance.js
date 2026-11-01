/**
 * 数值体系体检（review 用，不是产品代码）
 *
 * 只做一件事：把「一把牌 5 个组各自的权重」量出来，回答三个问题：
 *   Q1 每组实际贡献多少分差？斗牛是不是压倒性？
 *   Q2 玩家「认真分配」比「随便分配」多拿多少分？（= 决策值不值钱）
 *   Q3 一把的波动有多大 → 3 局档够不够分出高下？
 *
 * 口径说明：
 *   · 2 人局（最简、最容易看清权重；多人局是把它放大，不改变结论方向）
 *   · 两轮共用同一批 6 张牌（这是产品规则，必须照抄）
 *   · 全部走真实 Engine.settleGroup，不重写规则 —— 重写就等于在测自己的理解
 */
'use strict';
const E = require('../pwa/js/engine.js');
const Card = require('../pwa/js/card.js');
const C = require('../pwa/js/config.js');

const N = Number(process.env.N || 20000);

/* ---------- 工具 ---------- */
function deal(n) {
  const deck = Card.createDeck();
  Card.shuffle(deck);
  const hands = [];
  for (let i = 0; i < n; i++) hands.push(deck.splice(0, C.CARDS_PER_PLAYER));
  return hands;
}

/* 给定若干张牌，拆成「组大小数组」对应的所有分法。
 * 例：[1,2,3] → 60 种；[1,5] → 6 种。组内顺序不影响结算，所以不去重排列。 */
function partitions(cards, sizes) {
  const out = [];
  function rec(rest, i, acc) {
    if (i === sizes.length) { if (rest.length === 0) out.push(acc.map(a => a.slice())); return; }
    const k = sizes[i];
    const n = rest.length;
    if (k === 0) { acc.push([]); rec(rest, i + 1, acc); acc.pop(); return; }
    // 组合枚举
    const idx = [];
    (function comb(start, left) {
      if (left === 0) {
        const chosen = idx.map(x => rest[x]);
        const remain = rest.filter((_, j) => idx.indexOf(j) < 0);
        acc.push(chosen);
        rec(remain, i + 1, acc);
        acc.pop();
        return;
      }
      for (let j = start; j < n; j++) { idx.push(j); comb(j + 1, left - 1); idx.pop(); }
    })(0, k);
  }
  rec(cards.slice(), 0, []);
  return out;
}

function randPartition(cards, sizes) {
  const pool = cards.slice();
  // 洗一下再切，等价于均匀随机分组
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const out = [];
  let p = 0;
  for (const k of sizes) { out.push(pool.slice(p, p + k)); p += k; }
  return out;
}

/* 结算一组，返回 [Δ甲, Δ乙] */
function settle(mode, handA, handB) {
  const r = E.settleGroup(mode, [{ id: 'A', hand: handA }, { id: 'B', hand: handB }]);
  return [r.deltas.A, r.deltas.B];
}

const ROUNDS = [
  { name: '第一轮', groups: [{ mode: 'single', size: 1 }, { mode: 'tenhalf', size: 2 }, { mode: 'piaosanye', size: 3 }] },
  { name: '第二轮', groups: [{ mode: 'single', size: 1 }, { mode: 'douniu', size: 5 }] }
];

/* ---------- Q1 每组权重（随机分法对随机分法） ---------- */
console.log('='.repeat(66));
console.log('Q1  每组的分差分布（2 人局，双方都随机分牌 = "无脑玩"基线，' + N + ' 手）');
console.log('='.repeat(66));
console.log('组别        平均|Δ|   标准差   最小   最大   ≥5分的比例');

const stats = {};
for (const g of [...ROUNDS[0].groups, ROUNDS[1].groups[1]]) stats[g.mode] = { abs: [], sd: [], vals: [] };

for (let t = 0; t < N; t++) {
  const [hA, hB] = deal(2);
  for (const rd of ROUNDS) {
    const sizes = rd.groups.map(g => g.size);
    const pA = randPartition(hA, sizes);
    const pB = randPartition(hB, sizes);
    rd.groups.forEach((g, i) => {
      const d = settle(g.mode, pA[i], pB[i])[0];
      stats[g.mode].abs.push(Math.abs(d));
      stats[g.mode].vals.push(d);
    });
  }
}

const LABEL = { single: '单张比大小', tenhalf: '十点半', piaosanye: '飘三叶', douniu: '斗牛' };
for (const mode of ['single', 'tenhalf', 'piaosanye', 'douniu']) {
  const s = stats[mode];
  const mean = s.abs.reduce((a, b) => a + b, 0) / s.abs.length;
  const meanRaw = s.vals.reduce((a, b) => a + b, 0) / s.vals.length;
  const sd = Math.sqrt(s.vals.reduce((a, b) => a + (b - meanRaw) ** 2, 0) / s.vals.length);
  const big = s.abs.filter(x => x >= 5).length / s.abs.length;
  console.log(
    (LABEL[mode] + '    ').slice(0, 12) +
    mean.toFixed(2).padStart(6) + '  ' +
    sd.toFixed(2).padStart(6) + '  ' +
    Math.min(...s.abs).toString().padStart(4) + '  ' +
    Math.max(...s.abs).toString().padStart(4) + '  ' +
    (big * 100).toFixed(2).padStart(6) + '%'
  );
}

/* ---------- 一把的合计波动 ---------- */
console.log('');
console.log('='.repeat(66));
console.log('Q3  一把（两轮 5 组）的合计分差分布');
console.log('='.repeat(66));
const totals = [];
for (let t = 0; t < N; t++) {
  const [hA, hB] = deal(2);
  let sum = 0;
  for (const rd of ROUNDS) {
    const sizes = rd.groups.map(g => g.size);
    const pA = randPartition(hA, sizes);
    const pB = randPartition(hB, sizes);
    rd.groups.forEach((g, i) => { sum += settle(g.mode, pA[i], pB[i])[0]; });
  }
  totals.push(sum);
}
function pct(arr, p) { const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(s.length * p)]; }
const tMean = totals.reduce((a, b) => a + b, 0) / totals.length;
const tSd = Math.sqrt(totals.reduce((a, b) => a + (b - tMean) ** 2, 0) / totals.length);
console.log('平均 ' + tMean.toFixed(2) + '  标准差 ' + tSd.toFixed(2) +
  '  一把极值 [' + Math.min(...totals) + ', ' + Math.max(...totals) + ']');
console.log('分位  5%=' + pct(totals, .05) + '  25%=' + pct(totals, .25) + '  中位=' + pct(totals, .5) +
  '  75%=' + pct(totals, .75) + '  95%=' + pct(totals, .95));

/* ---------- 局数档位对「谁赢」的影响 ---------- */
console.log('');
console.log('='.repeat(66));
console.log('Q3b 打满 N 把后，胜者是否真是更强的那个？（模拟：实力差 0 = 纯运气决定）');
console.log('='.repeat(66));
console.log('说明：这里双方用同一策略（随机分牌），所以「真强」不存在，胜率必然≈50%。');
console.log('      本节真正要看的是「总分的标准差随局数怎么收敛」—— 收敛慢 = 前几把定输赢。');
for (const limit of C.HAND_LIMITS) {
  const sums = [];
  for (let t = 0; t < 2000; t++) {
    let s = 0;
    for (let h = 0; h < limit; h++) {
      const [hA, hB] = deal(2);
      for (const rd of ROUNDS) {
        const sizes = rd.groups.map(g => g.size);
        const pA = randPartition(hA, sizes);
        const pB = randPartition(hB, sizes);
        rd.groups.forEach((g, i) => { s += settle(g.mode, pA[i], pB[i])[0]; });
      }
    }
    sums.push(s);
  }
  const m = sums.reduce((a, b) => a + b, 0) / sums.length;
  const sd = Math.sqrt(sums.reduce((a, b) => a + (b - m) ** 2, 0) / sums.length);
  const lead = sums.filter(x => x > 0).length / sums.length;
  console.log(String(limit).padStart(3) + ' 把  → 总分标准差 ' + sd.toFixed(1).padStart(6) +
    '   领先方占比 ' + (lead * 100).toFixed(1) + '%   （纯运气，理论应 ≈50%）');
}
