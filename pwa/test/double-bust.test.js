/**
 * 十点半「双爆」口径回归（P1-9）
 * 跑法：node pwa/test/double-bust.test.js
 *
 * 双爆 = 两边都超 10.5。十点半组正好 2 张牌，任意两张点数之和超 10.5 就爆
 * （9+9=18、10+K=20 都爆），所以这条分支**经常走到**，不是老注释写的「2 张牌下不可达」。
 *
 * 旧实现：双爆时直接比单张大小 → 9+9（18 点）反而赢 8+8（16 点）。
 * 而同一文件 tenHalfResolvedBetter() 的注释写的是「双爆时爆得少者优」——两处口径打架。
 * 现在统一为**爆得少者优**（十点半的通行口径，也是玩家直觉）。
 */
'use strict';

const E = require('../js/engine.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function C(suit, rank) { return { suit: suit, rank: rank }; }
const JOKER = C('joker', 15);
const S = 'spade', H = 'heart', CL = 'club', D = 'diamond';

/* ========================================================================== */
console.log('\n[1] 双爆：爆得少者优（本轮改动的核心）');
/* 9+9 = 18 点；8+8 = 16 点。旧实现判 9+9 赢，新实现必须判 8+8 赢。 */
const a99 = [C(S, 9), C(H, 9)];
const b88 = [C(CL, 8), C(D, 8)];
ok(E.tenHalfBust(a99) && E.tenHalfBust(b88), '两手确实都爆');
ok(E.tenHalfTotal(a99) === 180 && E.tenHalfTotal(b88) === 160, '点数分别是 18 / 16（×10 存）');
ok(E.compareTenHalf(a99, b88) === -1, '★ 9+9（18）输给 8+8（16）—— 爆得少者优');
ok(E.compareTenHalf(b88, a99) === 1, '反向对称：8+8 赢 9+9');

/* 再取一对差距更大的，防止「刚好在边界上凑巧对」 */
const a20 = [C(S, 10), C(H, 13)];   // 10 + K(0.5) = 10.5 → 其实不爆，留作对照
ok(!E.tenHalfBust(a20), '10 + K 其实不爆（正好 10.5）—— 别把「到顶」当「爆」');
const aQQ = [C(S, 12), C(H, 12)];   // 1 点
ok(!E.tenHalfBust(aQQ), 'Q + Q = 1 点，远没爆');

const aSB = [C(S, 10), C(H, 10)];   // 20 点，爆得最多
ok(E.tenHalfBust(aSB), '10+10 爆');
ok(E.compareTenHalf(aSB, a99) === -1, '10+10（20）输给 9+9（18）');
ok(E.compareTenHalf(aSB, b88) === -1, '10+10（20）输给 8+8（16）');

/* ========================================================================== */
console.log('\n[2] 不爆永远赢爆的（这条不能被上面的改动带坏）');
ok(E.compareTenHalf(a20, a99) === 1, '10.5（不爆）赢 18（爆）');
ok(E.compareTenHalf(a99, a20) === -1, '反向：18（爆）输给 10.5');

/* ========================================================================== */
console.log('\n[3] 爆得一样多 → 比非王牌（仍是确定性结果，不能返回 0 摆烂）');
const p1 = [C(S, 9), C(H, 9)];          // 18，最大牌 ♠9
const p2 = [C(H, 9), C(CL, 9)];         // 18，最大牌 ♥9
ok(E.tenHalfTotal(p1) === E.tenHalfTotal(p2), '两手点数相同');
const r1 = E.compareTenHalf(p1, p2);
const r2 = E.compareTenHalf(p2, p1);
ok(r1 === 1 && r2 === -1, '同爆点按花色分出胜负，且正反一致', r1 + '/' + r2);

/* ========================================================================== */
console.log('\n[4] 带王时也遵守同一口径');
/* 王可充当任意点数（v56 起连 10 也能当）。王 + 9 的最优解析是不爆（王当 A/1 → 10 点），
 * 所以它不是双爆用例——这里验的是「解析之后仍然走同一套比较」。 */
const jokerHand = [JOKER, C(S, 9)];
ok(!E.tenHalfBust(jokerHand), '王 + 9 的最优解析不爆');
ok(E.compareTenHalf(jokerHand, a99) === 1, '王+9 赢 9+9（不爆赢爆）');
const jokerBest = E.resolveTenHalf ? E.resolveTenHalf(jokerHand) : null;
ok(jokerBest === null || !E.tenHalfBust(jokerBest), '解析结果同样不爆');

/* ========================================================================== */
console.log('\n[5] 与解析口径一致：tenHalfResolvedBetter 与 compareTenHalf 不能互相打架');
/* 这两处以前是矛盾的（一个说爆得少者优，一个按单张比）。
 * 现在必须对任意「双爆」组合给出同一个答案。 */
const bustHands = [
  [C(S, 9), C(H, 9)],
  [C(CL, 8), C(D, 8)],
  [C(S, 10), C(H, 10)],
  [C(S, 11), C(H, 11)],   // J+J = 1 点，不爆
  [C(S, 7), C(H, 8)]      // 15 点，爆
];
let mismatch = 0;
for (let i = 0; i < bustHands.length; i++) {
  for (let j = 0; j < bustHands.length; j++) {
    if (i === j) continue;
    const x = bustHands[i], y = bustHands[j];
    if (!E.tenHalfBust(x) || !E.tenHalfBust(y)) continue;   // 只看双爆对
    const byCompare = E.compareTenHalf(x, y) > 0;           // compareTenHalf 认为 x 赢
    const byResolved = E.tenHalfResolvedBetter(x, y);       // 解析器认为 x 更优
    if (byCompare !== byResolved) {
      mismatch++;
      console.log('    不一致：' + E.tenHalfDisplay(x) + ' vs ' + E.tenHalfDisplay(y));
    }
  }
}
ok(mismatch === 0, '★ 双爆时两处口径完全一致（不一致数 = ' + mismatch + '）');

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
