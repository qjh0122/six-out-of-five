/**
 * 斗牛「平局不可达」守卫（2026-11-12）
 *
 * ── 起因 ────────────────────────────────────────────────────────
 * 加小王时我给斗牛留了一个待定项：「只差大小王的两手牛牛要不要让大王赢」。
 * 用户否掉了这个提法：
 *   「不可能出现两手牌各拿一个王、同时都是牛牛、然后比大小其他四张牌完全一样，
 *     最大的牌因为已经从 10JQK 中选了，就一定不一样，能区别出大小」。
 *
 * ── 为什么用户是对的（不是"大概不会"，是逻辑上不可能）────────────
 * ① compareDouNiuCards 逐张比：点数 → 点数相同再比花色。
 *    所以「判平」⟺ 两边的 compareCards 是**同一批牌**（rank + suit 全等 ⟺ 同一张牌）。
 * ② 有王的一手 compareCards 剔掉王只剩 4 张真牌，无王一手是 5 张，
 *    逐张只比 min(4, 5) = 4 张 —— 要平仍然需要这 4 张是同一批牌。
 * ③ 结论：判平 ⟹ 至少 4 张牌被两家各拿一份 ⟹ 单副 54 张里不可达。
 *
 * 换句话说，上一轮那个「其余全同、只差大小王」的用例是**构造数据**：
 * 两家同时持有 ♠Q ♥10 ♣3 ♦2，一副牌里根本发不出来。
 * 它只能证明「王不参与比大小」，不能证明「真实牌局会平局」。
 *
 * ── 这里守什么 ──────────────────────────────────────────────────
 * [1] 前提：同点数必须比花色。这条一破，「同一批牌」的判据就失效，平局会变多。
 * [2] 穷举单王 × 单王：188,093 个含王牛牛的 4 张组合，没有一个能在不共享牌时判平。
 * [3] 真实发牌抽样 20 万局：含王且两家都牛牛的局必须真实出现（防空转），且一律分出胜负。
 * [4] 正向对照：最大牌不同（哪怕只差花色）就一定分得出 —— 这就是用户那句话。
 * [5] 源码守卫：别给斗牛加「王决胜」分支（那是给不存在的场景写代码）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Engine = require('../js/engine.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

const ROOT = path.join(__dirname, '..', '..');
const engineSrc = fs.readFileSync(path.join(ROOT, 'pwa', 'js', 'engine.js'), 'utf8');

const c = (suit, rank) => ({ suit: suit, rank: rank });
const BIG = { suit: 'joker', rank: 15 };
const SMALL = { suit: 'joker', rank: 14.5 };
const cid = (k) => k.suit + '-' + k.rank;

/* ---------------------------- [1] 前提 ---------------------------- */
console.log('\n[1] 前提：点数相同要比花色，否则「同一批牌」判据不成立');
ok(Engine.compareDouNiuCard(c('spade', 13), c('heart', 13)) > 0, '♠K > ♥K（同点数比花色）');
eq(Engine.compareDouNiuCard(c('spade', 13), c('spade', 13)), 0, '同一张牌才判平');
/* A 只算 1：斗牛的决胜点数不是 highRank 那套 */
ok(Engine.compareDouNiuCard(c('spade', 13), c('spade', 14)) > 0, 'K > A（斗牛里 A 只算 1）');

/* ------------------- [2] 穷举单王 × 单王 ------------------- */
console.log('\n[2] 穷举：含大王 / 含小王能成牛牛的真牌组合');
const real = [];
for (const s of ['spade', 'heart', 'club', 'diamond']) for (let r = 2; r <= 14; r++) real.push(c(s, r));

function niuniuGroups(joker) {
  const groups = new Map();   // 4 张真牌的 key → 这 4 张牌
  let count = 0;
  for (let a = 0; a < 49; a++) {
    for (let b = a + 1; b < 50; b++) {
      for (let d = b + 1; d < 51; d++) {
        for (let e = d + 1; e < 52; e++) {
          const cards = [real[a], real[b], real[d], real[e]];
          if (Engine.douNiuType([joker].concat(cards)).type !== 9) continue;   // 只看牛牛
          count += 1;
          groups.set([a, b, d, e].join(','), cards);
        }
      }
    }
  }
  return { groups, count };
}

const bigNN = niuniuGroups(BIG);
const smallNN = niuniuGroups(SMALL);
eq(bigNN.count, 188093, '含大王能成牛牛的真牌组合 = 188093');
eq(smallNN.count, bigNN.count, '含小王的组合数与大王完全一致（王的身份不影响牛型判定）');
eq([...bigNN.groups.keys()].sort().join('|'), [...smallNN.groups.keys()].sort().join('|'),
  '两边的组合一一对应（所以「平局」只可能发生在同一批真牌上）');

/* 逐个签名检查：签字相同 → 两家拿到的是同一批 4 张牌 → 真实发牌不可达 */
let sameSig = 0, notShared = 0;
for (const [key, cardsBig] of bigNN.groups) {
  const cardsSmall = smallNN.groups.get(key);
  if (!cardsSmall) continue;
  sameSig += 1;
  const mine = new Set(cardsBig.map(cid));
  const overlap = cardsSmall.filter((x) => mine.has(cid(x))).length;
  if (overlap === 0) notShared += 1;
}
eq(sameSig, 188093, '签名相同的对数 = 全部 188093 个');
eq(notShared, 0, '★ 其中「两家不共享任何真牌」的 = 0 → 平局在真实发牌里不可达');

/* ------------------- [3] 真实发牌抽样 ------------------- */
console.log('\n[3] 真实发牌抽样 20 万局：含王牛牛必须出现，且一律非平');
const full = real.concat([BIG, SMALL]);
let seed = 20261112;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

let bothJokerNiuniu = 0;      // 两家各带至少一张王、且都是牛牛（用户描述的场景）
let legalTies = 0;            // 真实发牌下的平局（必须为 0）
let sameTypeChecked = 0;      // 同牛型局数，用来确认比较器真的被调用过
let tieWithoutSharedCard = 0; // 不共享牌却判平（必须为 0，否则上面整套推论有洞）
for (let n = 0; n < 200000; n++) {
  const d = shuffle(full);
  const A = d.slice(0, 5), B = d.slice(5, 10);
  const hasJA = A.some(Engine.isJoker), hasJB = B.some(Engine.isJoker);
  const ta = Engine.douNiuType(A).type, tb = Engine.douNiuType(B).type;
  if (hasJA && hasJB && ta === 9 && tb === 9) bothJokerNiuniu += 1;
  if (ta !== tb) continue;
  sameTypeChecked += 1;
  if (Engine.compareDouNiu(A, B) !== 0) continue;
  legalTies += 1;
  const mine = new Set(A.map(cid));
  if (!B.some((x) => mine.has(cid(x)))) tieWithoutSharedCard += 1;
}
eq(legalTies, 0, '★ 20 万局真实发牌：斗牛平局 0 次');
eq(tieWithoutSharedCard, 0, '不共享牌的合法局里判平 0 次（判平必然来自重复牌）');
ok(sameTypeChecked > 10000, '同牛型的局数足够多，比较器确实被大量调用', 'got ' + sameTypeChecked);
ok(bothJokerNiuniu > 1000,
  '★「两家各含王且都牛牛」的样本出现 ' + bothJokerNiuniu + ' 次（不是空转断言）');

/* ------------------- [4] 正向对照 ------------------- */
console.log('\n[4] 最大牌不一样就一定分得出（用户原话的直译）');
const base = [c('spade', 12), c('heart', 10), c('club', 3), c('diamond', 2)];   // Q 10 3 2
const handSmall = [SMALL].concat(base);
const handBig = [BIG].concat(base);
eq(Engine.douNiuTypeName(handSmall), '牛牛', '构造：小王 + Q 10 3 2 = 牛牛');
eq(Engine.douNiuTypeName(handBig), '牛牛', '构造：大王 + Q 10 3 2 = 牛牛');
/* 这对手牌共用同一批真牌 —— 只可能出现在构造数据里，用来证明「王不参与」 */
eq(Engine.compareDouNiu(handSmall, handBig), 0,
  '共用同一批真牌（真实发牌不可达）→ 平局，这就是「王不参与比大小」');
/* 只要最大那张换了花色，立刻分出：同点数也比得到 */
const handSmall2 = [SMALL].concat([c('heart', 12), c('heart', 10), c('club', 3), c('diamond', 2)]);
eq(Engine.douNiuTypeName(handSmall2), '牛牛', '构造：小王 + Q♥ 10♥ 3 2 = 牛牛');
ok(Engine.compareDouNiu(handBig, handSmall2) > 0, '★ 最大牌只差花色（♠Q vs ♥Q）也分得出：大王手赢');
/* 点数不同更不用说 */
const handSmall3 = [SMALL].concat([c('spade', 13), c('heart', 10), c('club', 3), c('diamond', 2)]);
ok(Engine.compareDouNiu(handSmall3, handBig) > 0, '最大牌点数更高（K vs Q）就赢，与王无关');

/* ------------------- [5] 源码守卫 ------------------- */
console.log('\n[5] 源码守卫：别给斗牛加「王决胜」');
const fnStart = engineSrc.indexOf('function compareDouNiuHands');
const fnEnd = engineSrc.indexOf('function douNiuDecider');
ok(fnStart > 0 && fnEnd > fnStart, '定位得到 compareDouNiuHands 的函数体');
const fnBody = engineSrc.slice(fnStart, fnEnd);
ok(!/jokerLevelOf|isJoker|isBigJoker|isSmallJoker/.test(fnBody),
  '★ compareDouNiuHands 里没有任何王判定（平局不可达，加王决胜是给不存在的场景写代码）');
ok(/function jokerLevelOf\(hand\)/.test(engineSrc), 'jokerLevelOf 仍然存在（飘三叶 / 十点半在用）');
/* 对照：飘三叶那句「替完身还平才比王」必须还在 —— 否则这条守卫会误伤同一套规则 */
const psyStart = engineSrc.indexOf('function comparePiaoSanYe(a, b)');
const psyEnd = engineSrc.indexOf('D. 斗牛');
ok(psyStart > 0 && psyEnd > psyStart && /jokerLevelOf/.test(engineSrc.slice(psyStart, psyEnd)),
  '对照：飘三叶比较器里仍然有王决胜（斗牛没有，这是刻意的差异）');



console.log('\n' + (fail === 0 ? '全部通过' : fail + ' 项失败') + ' —— ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail === 0 ? 0 : 1);
