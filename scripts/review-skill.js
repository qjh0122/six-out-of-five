/**
 * 数值体系体检 · 第二步：技能回报（Q2）
 *
 * 核心问题：**认真分牌的人，能不能稳定赢过随便分牌的人？**
 * 这是判断「这游戏是技巧游戏还是运气游戏」的唯一硬指标。
 *
 * 方法：
 *   A（高手）= 枚举自己全部合法分法，选对「对手随机分法样本」期望最高的那一种
 *   B（新手）= 随机分法
 *   双方牌力完全相同（同一手牌），唯一差别是分配策略 → 胜率差就是策略的价值
 *
 * 注意：这是**技能价值的下界**。真实对局里双方都会算，那时差距会缩小，
 *       但「A 明显 > 50%」就足以证明策略不是摆设。
 */
'use strict';
const E = require('../pwa/js/engine.js');
const C = require('../pwa/js/config.js');
const Card = require('../pwa/js/card.js');

const HANDS = Number(process.env.HANDS || 300);   // 手数
const OPP_SAMPLES = Number(process.env.OPP || 40); // 对手分法采样数

function deal(n) {
  const deck = Card.createDeck();
  Card.shuffle(deck);
  const hands = [];
  for (let i = 0; i < n; i++) hands.push(deck.splice(0, C.CARDS_PER_PLAYER));
  return hands;
}

function partitions(cards, sizes) {
  const out = [];
  function rec(rest, i, acc) {
    if (i === sizes.length) { if (rest.length === 0) out.push(acc.map(a => a.slice())); return; }
    const k = sizes[i], n = rest.length;
    if (k === 0) { acc.push([]); rec(rest, i + 1, acc); acc.pop(); return; }
    const idx = [];
    (function comb(start, left) {
      if (left === 0) {
        const chosen = idx.map(x => rest[x]);
        const remain = rest.filter((_, j) => idx.indexOf(j) < 0);
        acc.push(chosen); rec(remain, i + 1, acc); acc.pop();
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
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const out = []; let p = 0;
  for (const k of sizes) { out.push(pool.slice(p, p + k)); p += k; }
  return out;
}

function settleA(mode, handA, handB) {
  return E.settleGroup(mode, [{ id: 'A', hand: handA }, { id: 'B', hand: handB }]).deltas.A;
}

const ROUNDS = [
  { groups: [{ mode: 'single', size: 1 }, { mode: 'tenhalf', size: 2 }, { mode: 'piaosanye', size: 3 }] },
  { groups: [{ mode: 'single', size: 1 }, { mode: 'douniu', size: 5 }] }
];

/* 给定自己的牌与一组对手分法样本，返回最优自己分法（枚举）与它的期望分 */
function bestSplit(myCards, rd, oppSplits) {
  const sizes = rd.groups.map(g => g.size);
  const mine = partitions(myCards, sizes);
  let best = null, bestVal = -Infinity;
  for (const sp of mine) {
    let v = 0;
    for (const op of oppSplits) {
      rd.groups.forEach((g, i) => { v += settleA(g.mode, sp[i], op[i]); });
    }
    v /= oppSplits.length;
    if (v > bestVal) { bestVal = v; best = sp; }
  }
  return { split: best, ev: bestVal, count: mine.length };
}

/* ---------------- 主循环 ---------------- */
let winA = 0, winB = 0, tie = 0;
let sumA = 0, sumB = 0;
const perHand = [];      // 每把 A 的净胜
let totalSplits = 0, improvedOverRandom = 0;

for (let t = 0; t < HANDS; t++) {
  const [hA, hB] = deal(2);
  let aScore = 0, bScore = 0;

  for (const rd of ROUNDS) {
    const sizes = rd.groups.map(g => g.size);
    // 对手（新手）随机分法采样 OPP_SAMPLES 次
    const oppSplits = [];
    for (let s = 0; s < OPP_SAMPLES; s++) oppSplits.push(randPartition(hB, sizes));

    // A（高手）枚举并取最优
    const r = bestSplit(hA, rd, oppSplits);
    totalSplits += r.count;

    // 用「对手随机分法的实际期望」来打分（不是用回放同一批样本，避免同批偏差）
    const fresh = randPartition(hB, sizes);
    rd.groups.forEach((g, i) => {
      const d = settleA(g.mode, r.split[i], fresh[i]);
      aScore += d; bScore -= d;
    });
  }

  sumA += aScore; sumB += bScore;
  perHand.push(aScore);
  if (aScore > bScore) winA++; else if (aScore < bScore) winB++; else tie++;
}

const n = HANDS;
const meanA = sumA / n;
const sd = Math.sqrt(perHand.reduce((a, b) => a + (b - meanA) ** 2, 0) / n);

console.log('='.repeat(66));
console.log('Q2  技能回报：认真分牌 vs 随便分牌（同一手牌，' + n + ' 手，2 人局）');
console.log('='.repeat(66));
console.log('高手胜 ' + (winA / n * 100).toFixed(1) + '%   平 ' + (tie / n * 100).toFixed(1) +
  '%   负 ' + (winB / n * 100).toFixed(1) + '%');
console.log('高手每把平均净胜 ' + meanA.toFixed(2) + ' 分（标准差 ' + sd.toFixed(2) + '）');
console.log('每轮枚举的分法数：第一轮 ' + partitions(deal(1)[0], [1, 2, 3]).length +
  ' 种，第二轮 ' + partitions(deal(1)[0], [1, 5]).length + ' 种');

/* 同分布下的胜率标准误，用来判断「58% 是真的还是噪声」 */
const se = Math.sqrt(0.25 / n) * 100;
console.log('50% 情形下的标准误 ≈ ' + se.toFixed(1) + ' 个百分点 → ' +
  '高于 ' + (50 + 2 * se).toFixed(1) + '% 才算技能真的有效');

/* ---------- 一把之内，5 组各自贡献了多少「技能收益」 ---------- */
console.log('');
console.log('='.repeat(66));
console.log('Q2b  技能收益按组拆开：哪一组才是「认真分配」真正赚钱的地方');
console.log('='.repeat(66));
const gainByMode = {};
for (const rd of ROUNDS) rd.groups.forEach(g => { gainByMode[g.mode] = { gain: 0, cnt: 0 }; });

for (let t = 0; t < Math.floor(HANDS / 2); t++) {
  const [hA, hB] = deal(2);
  for (const rd of ROUNDS) {
    const sizes = rd.groups.map(g => g.size);
    const oppSplits = [];
    for (let s = 0; s < OPP_SAMPLES; s++) oppSplits.push(randPartition(hB, sizes));
    const r = bestSplit(hA, rd, oppSplits);
    // 随机分法作为对照
    const rnd = randPartition(hA, sizes);
    rd.groups.forEach((g, i) => {
      const opp = randPartition(hB, sizes);
      const gi = settleA(g.mode, r.split[i], opp[i]);
      const gr = settleA(g.mode, rnd[i], opp[i]);
      gainByMode[g.mode].gain += (gi - gr);
      gainByMode[g.mode].cnt++;
    });
  }
}
const LB = { single: '单张比大小', tenhalf: '十点半', piaosanye: '飘三叶', douniu: '斗牛' };
const entries = Object.entries(gainByMode).map(([m, v]) => [m, v.gain / v.cnt]);
const totalGain = entries.reduce((a, b) => a + b[1], 0);
for (const [m, g] of entries) {
  const share = totalGain !== 0 ? (g / totalGain * 100) : 0;
  console.log((LB[m] + '    ').slice(0, 12) + ' 每组技能收益 ' + g.toFixed(3).padStart(7) +
    ' 分   占技能总收益 ' + share.toFixed(1).padStart(5) + '%');
}
