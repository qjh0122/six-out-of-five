/**
 * 第一轮「十点半优先」规则测试
 * 跑法：node pwa/test/tenhalf-priority.test.js
 *
 * 规则（用户口径）：
 *   · 第一轮的十点半组必须优先做成**不爆**的组合 —— 「可以不刚刚好十点半，只要不爆点就行」；
 *   · 能凑 10.5 时优先凑 10.5（10.5 是这组的满分）；
 *   · 其余两组（比大小 / 飘三叶）不受约束，随便配；
 *   · 违背时只**提醒**，不拦操作。
 *
 * 这套判定的价值全在「说的是不是真的」：
 * 它算的点数必须和 engine 结算时的口径**一模一样**（都是十分之一整数，
 * 王要按 engine 的解析算），否则会出现「界面说 10.5、结算页说 11」——
 * 那比不提示还糟。所以下面每一条都拿 Engine 的结果做对照。
 */
'use strict';

const SM = require('../js/stateMachine.js');
const Engine = require('../js/engine.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

/* 牌：A=14、J/Q/K=11/12/13，王 rank=15；十点半里 JQK 算半点、A 算 1 点 */
function C(suit, rank) { return { suit: suit, rank: rank }; }
const SPADE_10 = C('spade', 10), HEART_10 = C('heart', 10), CLUB_10 = C('club', 10);
const K = C('club', 13), Q = C('diamond', 12), J = C('heart', 11), ACE = C('spade', 14);
const TWO = C('heart', 2), NINE = C('diamond', 9), JOKER = C('joker', 15);

/* 帮选手：把「已放进十点半组的两张」和「手里剩下的」拼成整手牌传进去 ——
 * 状态机的接口签的是整手牌，它自己会剔掉已放入的牌（见 tenHalfAdvice 注释）。 */
function advice(placed, rest, round) {
  return SM.tenHalfAdvice(round === undefined ? 1 : round,
    { tenhalf: placed.slice() }, placed.concat(rest || []));
}

/* ========================================================================== */
console.log('\n[1] 已经是 10.5：不该有任何提示');
[['10 + K', [SPADE_10, K]], ['王 + 10', [JOKER, SPADE_10]], ['10 + Q', [SPADE_10, Q]]].forEach(function (t) {
  const a = advice(t[1], []);
  eq(a, null, '★ ' + t[0] + ' 是满分，不打扰');
});
/* 顺便确认这套「满分」和 engine 一致 —— 否则提示与结算各说各话 */
eq(Engine.tenHalfTotal([SPADE_10, K]), 105, 'engine 口径：10 + K = 10.5（105 个十分之一）');
eq(Engine.tenHalfTotal([JOKER, SPADE_10]), 105, 'engine 口径：王按最优解析撑出 10.5');

/* ========================================================================== */
/* 没爆 = 合格。哪怕手里有更好的不爆方案，也不许提示。
 *
 * 这一档原来有个 'miss'（「能凑 10.5 却没凑」，弹一句「用 10♠ + K」），现在删了。
 * 理由不是「太吵」，是**它会改掉游戏**：第一轮三组互相抢牌，
 * 把那张 10 让给飘三叶去凑豹子、十点半退到 9 点，完全可能是更赚的下法。
 * 一旦界面替你宣布「这样能到 10.5」，最优解就由程序定了，竞技性没了。 */
console.log('\n[2] 没爆就一律不提示（不替玩家做策略选择）');
eq(advice([NINE, K], [SPADE_10, TWO]), null,
  '★ 9.5 点、手里能凑 10.5 → 不提示（退一步换另外两组更强是正当策略）');

/* 「多个不爆方案」是这一条的核心场景：手里同时有 10+K（10.5）和 8+2（10），
 * 玩家选了 8+2 —— 不许说「其实能到 10.5」。 */
eq(advice([C('spade', 8), C('club', 2)], [SPADE_10, K]), null,
  '★ 手里有不爆的 10.5（10+K），玩家选了 10 点（8+2）→ 不提示');
eq(advice([NINE, ACE], [SPADE_10, K]), null,
  '★ 10 点（9+A）与 10.5（10+K）都在手里，选了 10 → 不提示');

/* 不爆但也不是最大：更不该提 */
eq(advice([C('diamond', 5), C('heart', 4)], [C('spade', 9)]), null,
  '★ 9 点、手里还有 9 → 不提示（「不爆」是底线，不是「必须最大」）');

/* 王在「已放入」的位置也要正确参与判定：王按最优解析取「不爆里最大的那个点数」，
 * 所以 9 + 王 = 10（王当 A），而 9 + 2 = 11 是爆的。 */
eq(advice([C('spade', 9), C('club', 2)], [JOKER]).kind, 'bust',
  '★ 9+2=11 爆，手里有王（9+王=10 不爆）→ bust，不是 null');

/* 不爆且已经是用王能拿到的最好点数 → 不提示 */
eq(advice([C('spade', 9), JOKER], [C('club', 2)]), null,
  '★ 9 + 王 = 10 点，手里剩 2（9+2=11 爆）→ 不提示');

/* ========================================================================== */
console.log('\n[3] 爆了但有救：红色警告（不再点名换哪两张）');
const bust = advice([SPADE_10, HEART_10], [K, TWO]);
ok(!!bust, '10 + 10 手牌有 K → 有提示');
eq(bust.kind, 'bust', '★ kind = bust（爆了，且换一张就能不爆）');
eq(bust.bust, true, '★ bust = true');
eq(bust.points, 200, '当前 20 点（10+10）');
/* best 仍然算出来（内部靠它判断「有没有救」），但界面**不再点名**具体牌：
 * 挑哪组不爆是玩家的策略，详见 game.js 的 warnTenHalf。 */
eq(bust.best.points, 105, '内部：最优解能到 10.5');
ok(bust.best.cards.some(function (c) { return c.rank === 13; }), '内部：最优解含那张 K');
ok(bust.kind === 'bust' && bust.bust === true, '★ 界面只按「会输」处理，不暴露这组牌');

/* 手里没有能救的牌 → 整手必爆：**一个字都不说**。
 * 2026-10-30 与用户确认的口径：只有「存在不爆的打法、玩家却选了爆的」才提示；
 * 必爆局面给不给提示都不影响他做决定（换也换不出更好的），那就闭嘴。 */
console.log('\n[4] 整手怎么配都爆：不提示');
/* 双爆时**爆得少的占优**（engine compareTenHalf），但「20 点修到 19 点」不改变胜负，
 * 提示只会变成噪音。曾经这一档叫 'worse-bust'，已删除。 */
eq(advice([SPADE_10, HEART_10], [NINE]), null,
  '★ 10+10 手里有 9 —— 换谁都是爆（20 → 19）→ 不提示');

/* 换谁都一样爆（三张 10 怎么配都是 20）→ 没什么可建议的，不打扰 */
eq(advice([SPADE_10, HEART_10], [CLUB_10]), null,
  '★ 怎么换都 20 点 → 不提示（没有更好的，说了只是噪音）');
eq(advice([NINE, TWO], []), null, '手里的牌全放完了 → 不提示（无处可换）');

/* ========================================================================== */
console.log('\n[5] 只放了一张：只有「配哪张都爆、但换两张还能不爆」才提醒');
/* 10♠ 配 2 / A / 10♥ 全爆（12 / 11 / 20），但 2+A 本身不爆 → 这张放错组了 */
const mustBust = advice([SPADE_10], [TWO, ACE, HEART_10]);
ok(!!mustBust, '放了 10，手里 2 / A / 10 → 有提示');
eq(mustBust.kind, 'must-bust', '★ kind = must-bust');
eq(mustBust.points, null, '还没满，没有「当前点数」');
eq(mustBust.bust, true, '★ 按「会爆」处理（红色）');

/* 整手都爆（三张 10）→ 说不出「换一张」这种话，因为是骗人的 */
eq(advice([SPADE_10], [HEART_10, CLUB_10]), null,
  '★ 放了 10，手里只剩两张 10 —— 换哪张都爆，整手也没有不爆组合 → 不提示');

/* 注意 2 和 A 都救不了 10：10+2=12、10+A=11 都是爆的。
 * 能救它的是半点牌（J/Q/K）—— 10 + K = 10.5。 */
eq(advice([SPADE_10], [TWO, ACE]).kind, 'must-bust',
  '★ 放了 10，手里只有 2 / A：10 配谁都爆，但 2+A 不爆 → must-bust（提示换一张）');
eq(advice([SPADE_10], [K, TWO]), null, '放了 10，手里有 K → 10+K=10.5 有救，不打扰');
eq(advice([K], [SPADE_10, TWO]), null, '放了 K，手里有 10 → 能到 10.5，不打扰（还没到该说的时候）');

/* ========================================================================== */
console.log('\n[6] 第二轮不受这条规则约束');
eq(advice([SPADE_10, HEART_10], [K], 2), null, '★ round=2 → 永远 null（第二轮没有十点半组）');

/* ========================================================================== */
console.log('\n[7] 边界');
eq(advice([], [SPADE_10, K]), null, '还没放牌 → 不提示');
eq(SM.tenHalfPair([SPADE_10]), null, 'tenHalfPair 少于 2 张 → null');
eq(SM.tenHalfPair([SPADE_10, K]).points, 105, 'tenHalfPair 点数正确');
eq(SM.tenHalfPair([SPADE_10, K]).bust, false, 'tenHalfPair 不爆');
eq(SM.tenHalfPair([SPADE_10, HEART_10]).bust, true, 'tenHalfPair 爆点判断正确');

/* 传整手牌时自动剔掉已放入的那张：否则会「自己和自己配对」，
 * 提示说「换 10♠ 能到 10.5」，而那张 10♠ 就是玩家刚放下的 */
const dedup = advice([SPADE_10], [SPADE_10, K]);
eq(dedup, null, '★ 已放入的牌不会被当成「手里的备选」（否则等于劝玩家换掉同一张）');

/* 王在「已放入」的位置也要正确参与：王 + 10 是 10.5，换成别的只会更差 */
eq(advice([JOKER], [SPADE_10, TWO]), null, '王 + 10 可成 10.5，放王时不打扰');

/* ========================================================================== */
console.log('\n[8] 与 engine 的判定完全一致（抽查）');
[
  [[SPADE_10, K], 105, false],
  [[JOKER, SPADE_10], 105, false],
  [[SPADE_10, HEART_10], 200, true],
  [[NINE, K], 95, false],
  [[K, Q], 10, false],
  [[ACE, K], 15, false]
].forEach(function (t) {
  const p = SM.tenHalfPair(t[0]);
  eq(p.points, t[1], '点数一致：' + Engine.tenHalfDisplay(t[0]));
  eq(p.bust, t[2], '爆点判定一致：' + Engine.tenHalfDisplay(t[0]));
});

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
