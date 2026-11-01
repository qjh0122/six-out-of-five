/**
 * 规则护栏 · 原型适配层自检
 *
 * 【背景】原型曾经自己实现过一份 154 行的牌型判定（evSingle / evTenHalf / evPiao / evDouniu），
 * 与 pwa/js/engine.js 构成**两份真相**。那份手抄版压掉了两样东西：
 *   · 「大王万能」的全部分支（十点半王能当 10 且比真 10 大、斗牛王能去凑三张、飘三叶王万能）
 *   · compareHighCards 那层「逐张交错比 (点数, 花色)」的兜底
 * 结果：飘三叶 4.4%、十点半 0.8%、含大王时斗牛 25.5% 的组判赢判反。
 *
 * 【现状】原型已改为 <script src="../../pwa/js/engine.js">，规则只有一份。
 * 所以这个脚本的定位也跟着变了：不再对比「两份实现是否分叉」，
 * 而是检查「原型的适配层有没有把引擎用错」——排序、结算包装、特效归属、文案。
 *
 * 检查项（每种玩法 × 随机手牌，含/不含大王各跑一轮）：
 *   ① 赢家一致        ② 每人得分一致      ③ 名次排序严格单调
 *   ④ 每家收分一致    ⑤ 特效只挂赢家      ⑥ 牌型文案非空
 *
 * 用法：node scripts/review-rule-parity.js [每组轮数，默认 800]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'docs', 'prototypes', 'circle-table.html');
const Engine = require(path.join(ROOT, 'pwa', 'js', 'engine.js'));

const ROUNDS = Number(process.argv[2] || 800);

/* ---------------- 1. 从原型里抠出适配层（原样跑，不重写） ---------------- */
const src = fs.readFileSync(HTML, 'utf8');

function cut(from, to, label, inclusive) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error('找不到起点: ' + label);
  const b = src.indexOf(to, a);
  if (b < 0) throw new Error('找不到终点: ' + label);
  return src.slice(a, inclusive ? b + to.length : b);
}

const pieces = [
  cut('var GROUPS = {', '\n};', 'GROUPS', true),
  cut('var SUIT_SYM', '/* =============================== \u53d1\u724c\u811a\u672c', '\u9002\u914d\u5c42', false),
  cut('var DEAL = {', 'var SCORE_A', 'DEAL', false),
  cut('function ensureHands', 'function buildScenes', 'ensureHands/runGroup/specialOf', false)
].join('\n');

const sandbox = { console, Math, Object, Array, String, JSON, Engine };
vm.createContext(sandbox);
vm.runInContext(pieces, sandbox, { filename: 'prototype-adapter.js' });

const P = vm.runInContext(
  '({ GROUPS, DEAL, runGroup, ensureHands, specialOf, evalHand, ecards, CMP })',
  sandbox
);
const DEAL_ORIG = JSON.parse(JSON.stringify(P.DEAL));

/* ---------------- 2. 牌组工具 ---------------- */
const SUITS = ['spade', 'heart', 'club', 'diamond'];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const JOKER = { rank: 15, suit: 'joker' };

function fullDeck(withJoker) {
  const d = [];
  RANKS.forEach((r) => SUITS.forEach((s) => d.push({ rank: r, suit: s })));
  if (withJoker) d.push(JOKER);
  return d;
}
function shuffle(a, rnd) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const toP = (c) => [c.rank, c.suit];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODE_INFO = {
  single: { round: 1, idx: 0, n: 1 },
  tenhalf: { round: 1, idx: 1, n: 2 },
  piaosanye: { round: 1, idx: 2, n: 3 },
  douniu: { round: 2, idx: 1, n: 5 }
};
const KEYS = ['me', 's0', 's1', 's2', 's3'];

/* 入口包装：把这一组手牌塞进 DEAL，让原型自己算，不改原型一行代码 */
function protoRun(mode, hands) {
  const info = MODE_INFO[mode];
  P.DEAL[info.round] = P.DEAL[info.round] || {};
  P.DEAL[info.round][mode] = hands;
  const alive = KEYS.slice(0, Object.keys(hands).length);
  return P.runGroup(info.round, info.idx, alive);
}

/* ---------------- 3. 对撞 ---------------- */
function trial(players, withJoker, rnd) {
  const out = {};
  const deck = fullDeck(withJoker);

  Object.keys(MODE_INFO).forEach((mode) => {
    const need = MODE_INFO[mode].n;
    const pool = shuffle(deck.slice(), rnd);
    if (pool.length < need * players) return;

    const hands = {};
    const entries = [];
    for (let i = 0; i < players; i++) {
      const cards = pool.slice(i * need, i * need + need);
      hands[KEYS[i]] = cards.map(toP);
      entries.push({ id: KEYS[i], hand: cards });
    }

    const pr = protoRun(mode, JSON.parse(JSON.stringify(hands)));
    const eng = Engine.settleGroup(mode, entries);
    const live = KEYS.slice(0, players);

    const winOk = pr.winner === eng.winnerId;

    const scoreDiff = [];
    live.forEach((k) => {
      const a = pr.delta[k] || 0, b = eng.deltas[k] || 0;
      if (a !== b) scoreDiff.push({ k, proto: a, engine: b });
    });

    const perOk = (pr.per || 0) === (eng.winPoints || 0);

    /* 名次排序必须严格单调：用引擎的比较器复核原型排出来的顺序 */
    let mono = true;
    for (let i = 1; i < pr.entries.length; i++) {
      if (Engine[P.CMP[mode]](pr.entries[i - 1].eh, pr.entries[i].eh) < 0) { mono = false; break; }
    }

    /* 特效只挂赢家；且赢家手上真有那个牌型（由引擎的牌型编码判定） */
    const fxEntry = pr.entries.filter((e) => e.k === pr.winner)[0];
    const fxOk = !pr.fx || !!fxEntry;
    let fxFalse = 0;
    if (pr.fx && fxEntry) {
      const eh = fxEntry.eh;
      if (pr.fx.kind === 'bz' && Engine.piaoSanYeType(eh).type !== Engine.PSY_TYPE.LEOPARD) fxFalse++;
      if (pr.fx.kind === 'nn' && Engine.douNiuType(eh).type !== 9) fxFalse++;
      if (pr.fx.kind === 'wh' && Engine.douNiuType(eh).type !== 10) fxFalse++;
      if (pr.fx.kind === 'jh' && !(Engine.tenHalfTotal(eh) === 105)) fxFalse++;
    }

    /* 牌型文案不能为空（文案是设计稿的一部分） */
    const labelBad = pr.entries.filter((e) => !e.r || !e.r.label).length;

    out[mode] = out[mode] || {
      n: 0, winBad: 0, scoreBad: 0, perBad: 0, monoBad: 0, fxBad: 0, fxFalse: 0, labelBad: 0, samples: []
    };
    const rec = out[mode];
    rec.n++;
    if (!winOk) {
      rec.winBad++;
      if (rec.samples.length < 3) rec.samples.push({ kind: 'win', hands, protoWinner: pr.winner, engWinner: eng.winnerId });
    }
    if (scoreDiff.length) {
      rec.scoreBad++;
      if (rec.samples.length < 3) rec.samples.push({ kind: 'score', hands, diff: scoreDiff, winner: pr.winner, winPoints: eng.winPoints });
    }
    if (!perOk) rec.perBad++;
    if (!mono) rec.monoBad++;
    if (!fxOk) rec.fxBad++;
    rec.fxFalse += fxFalse;
    rec.labelBad += labelBad;
  });
  return out;
}

const FIELDS = ['winBad', 'scoreBad', 'perBad', 'monoBad', 'fxBad', 'fxFalse', 'labelBad'];

function run(label, players, withJoker, rounds) {
  const rnd = mulberry32(20261030 + players * 7 + (withJoker ? 1 : 0));
  const total = {};
  for (let i = 0; i < rounds; i++) {
    const one = trial(players, withJoker, rnd);
    Object.keys(one).forEach((m) => {
      total[m] = total[m] || { n: 0, samples: [] };
      const t = total[m], o = one[m];
      t.n += o.n;
      FIELDS.forEach((f) => { t[f] = (t[f] || 0) + (o[f] || 0); });
      o.samples.forEach((s) => { if (t.samples.length < 2) t.samples.push(s); });
    });
  }
  console.log('\n=== ' + label + ' ===');
  Object.keys(total).forEach((m) => {
    const t = total[m];
    const pct = (x) => ((x / t.n) * 100).toFixed(1) + '%';
    const bad = FIELDS.reduce((s, f) => s + (t[f] || 0), 0);
    console.log(
      '  ' + m.padEnd(10) + ' 组数 ' + String(t.n).padStart(5) +
      '  胜负 ' + String(t.winBad || 0).padStart(4) +
      '  分数 ' + String(t.scoreBad || 0).padStart(4) +
      '  收分 ' + String(t.perBad || 0).padStart(4) +
      '  排序 ' + String(t.monoBad || 0).padStart(4) +
      '  特效 ' + String((t.fxBad || 0) + (t.fxFalse || 0)).padStart(3) +
      '  文案 ' + String(t.labelBad || 0).padStart(3) +
      (bad ? '  ✗' : '  ✓ (吻合率 100%)')
    );
    t.samples.slice(0, 2).forEach((s) => console.log('      样例 ' + JSON.stringify(s)));
  });
  return total;
}

console.log('规则护栏：原型适配层  vs  pwa/js/engine.js（原型现在直接引用引擎）');
console.log('抠出的适配层 ' + pieces.split('\n').length + ' 行；每组 ' + ROUNDS + ' 次随机手牌');

const withJ = run('5 人局 · 含大王（线上真实牌堆 53 张）', 5, true, ROUNDS);
const noJ = run('5 人局 · 不含大王', 5, false, ROUNDS);
const duo = run('2 人局 · 不含大王', 2, false, ROUNDS);

/* ---------------- 5. 演示用的固定牌组：逐组核对 ---------------- */
function dealParity() {
  const plan = [
    { round: 1, mode: 'single' },
    { round: 1, mode: 'tenhalf' },
    { round: 1, mode: 'piaosanye' },
    { round: 2, mode: 'single' },
    { round: 2, mode: 'douniu' }
  ];
  const keys = KEYS.slice(0, 5);
  console.log('\n=== 原型演示的 5 组固定牌（DEAL） ===');
  let bad = 0;
  plan.forEach(({ round, mode }) => {
    const handsP = JSON.parse(JSON.stringify(DEAL_ORIG[round][mode] || {}));
    const entries = keys.filter((k) => handsP[k]).map((k) => ({
      id: k, hand: handsP[k].map((c) => ({ rank: c[0], suit: c[1] }))
    }));
    const pr = protoRun(mode, JSON.parse(JSON.stringify(handsP)));
    const eng = Engine.settleGroup(mode, entries);
    const winOk = pr.winner === eng.winnerId;
    const diff = keys.filter((k) => (pr.delta[k] || 0) !== (eng.deltas[k] || 0));
    if (!winOk || diff.length) bad++;
    const fmt = (o) => keys.map((k) => k + ':' + ((o[k] > 0 ? '+' : '') + o[k])).join(' ');
    console.log(
      '  R' + round + ' ' + mode.padEnd(10) +
      ' 原型赢家 ' + pr.winner + ' / 引擎 ' + eng.winnerId + (winOk ? '' : '  ← 赢家不一致') +
      '\n      原型 ' + fmt(pr.delta) +
      '\n      引擎 ' + fmt(eng.deltas) + (diff.length ? '  ← 分差: ' + diff.join(',') : '')
    );
  });
  return bad;
}
const dealBad = dealParity();

/* ---------------- 6. 两条历史回归（防止旧缺陷复活） ---------------- */
function cases() {
  const c = (a) => a.map((x) => ({ rank: x[0], suit: x[1] }));
  const p = (a) => a.map((x) => [x[0], x[1]]);
  let bad = 0;

  console.log('\n=== 历史回归用例 ===');

  /* ① 牛9 不能放「牛牛」特写。旧原型把牛牛和牛9 都编码成 t=9，18.5% 的组误播。 */
  const niu9 = [[14, 'spade'], [5, 'club'], [13, 'spade'], [4, 'club'], [9, 'diamond']];
  const eNiu9 = Engine.douNiuType(c(niu9));
  const fxNiu9 = P.specialOf('douniu', { cards: p(niu9), r: P.evalHand('douniu', p(niu9), c(niu9)) });
  const ok1 = eNiu9.type === 8 && !fxNiu9;
  if (!ok1) bad++;
  console.log('  ① 牛9 手牌 → 引擎 type=' + eNiu9.type + '（牛9）、原型特效 ' +
    (fxNiu9 ? fxNiu9.kind : 'null') + (ok1 ? '  ✓' : '  ✗ 牛9 又放了牛牛特写'));

  /* ② 全桌没牛时，输家不该被多扣 5 分（旧原型 31% 的组命中）。 */
  const winNoNiu = [[2, 'heart'], [3, 'club'], [4, 'club'], [6, 'diamond'], [7, 'spade']];
  const loseNoNiu = [[2, 'club'], [3, 'diamond'], [4, 'spade'], [6, 'heart'], [7, 'club']];
  const pr2 = protoRun('douniu', { me: p(loseNoNiu), s0: p(winNoNiu) });
  const eng2 = Engine.settleGroup('douniu', [
    { id: 'me', hand: c(loseNoNiu) }, { id: 's0', hand: c(winNoNiu) }
  ]);
  const ok2 = pr2.delta.me === eng2.deltas.me && pr2.delta.s0 === eng2.deltas.s0;
  if (!ok2) bad++;
  console.log('  ② 两人都没牛 → 原型 ' + JSON.stringify(pr2.delta) +
    '、引擎 ' + JSON.stringify(eng2.deltas) + (ok2 ? '  ✓' : '  ✗ 没牛罚分又无条件加了'));

  /* ③ 含大王的斗牛：旧原型完全没写王的分支，25.5% 的组判错。 */
  const jokerHand = [[15, 'joker'], [10, 'spade'], [10, 'heart'], [3, 'club'], [7, 'diamond']];
  const pr3 = protoRun('douniu', { me: p(jokerHand), s0: p(loseNoNiu) });
  const eng3 = Engine.settleGroup('douniu', [
    { id: 'me', hand: c(jokerHand) }, { id: 's0', hand: c(loseNoNiu) }
  ]);
  const ok3 = pr3.delta.me === eng3.deltas.me;
  if (!ok3) bad++;
  console.log('  ③ 含王的斗牛 → 原型 ' + JSON.stringify(pr3.delta) +
    '、引擎 ' + JSON.stringify(eng3.deltas) + '（赢家 ' + eng3.winnerId + '）' + (ok3 ? '  ✓' : '  ✗ 王的分支又丢了'));

  return bad;
}
const caseBad = cases();

/* ---------------- 7. 通过判定 ---------------- */
let bad = 0;
[withJ, noJ, duo].forEach((set) => Object.keys(set).forEach((m) => {
  FIELDS.forEach((f) => { bad += set[m][f] || 0; });
}));
console.log('\n随机对撞不一致：' + bad + ' 组；固定牌组：' + dealBad + ' 组；历史回归：' + caseBad + ' 项');
if (bad || dealBad || caseBad) {
  console.log('结论：原型与线上引擎仍有分叉，不能交付。');
} else {
  console.log('结论：原型展示的每一个赢家和分数，都是线上引擎算出来的同一份结果。');
}
process.exitCode = (bad || dealBad || caseBad) ? 1 : 0;
