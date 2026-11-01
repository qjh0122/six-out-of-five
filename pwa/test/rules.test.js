/**
 * 规则变更回归测试（v0.2）
 * 跑法：node pwa/test/rules.test.js
 *
 * 覆盖两条新规则：
 *   1. 十点半：大王完全万能（能当 10，且王比真 10 大）；按点数比大小，
 *             同点数比「把点数做大的那张」，王在比牌时算最大花色
 *   2. 斗牛：大王**两处都能补**——既能去凑「三张成 10」，也能留在剩下两张里
 *            （三张真牌自己成十时，王补进去必成牛牛）；
 *            同牛型比最大那张，王不参与（取除王以外最大的）；有大王不算五花牛
 * 同时确认飘三叶的大王万能没被误伤。
 */
'use strict';

const E = require('../js/engine.js');
const SM = require('../js/stateMachine.js');
const Card = require('../js/card.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function C(suit, rank) { return { suit: suit, rank: rank }; }
const JOKER = C('joker', 15);

console.log('[十点半] 大王完全万能，能当 10');

ok(E.tenHalfTotal([C('spade', 10), JOKER]) === 105, '10 + 王 = 10.5 点（王当半点）');
ok(E.tenHalfTotal([JOKER, C('heart', 10)]) === 105, '王 + 10 = 10.5 点');
/* ★ v56 规则更正：王可以当 10。以前这里断言的是 95（王退到 9），
 * 用户 2026-10-29 明确「王比 10 大」，所以 J/Q/K/王 配王都能到十点半。 */
ok(E.tenHalfTotal([C('spade', 13), JOKER]) === 105, '★ K + 王 = 10.5（王当 10，以前是 9.5）');
ok(E.tenHalfTotal([C('spade', 11), JOKER]) === 105, '★ J + 王 = 10.5');
ok(E.tenHalfTotal([C('spade', 12), JOKER]) === 105, '★ Q + 王 = 10.5');
ok(E.tenHalfTotal([C('spade', 14), JOKER]) === 100, 'A + 王 = 10 点（王当 9，因为 10+1=11 会爆）');
ok(E.tenHalfTotal([C('spade', 2), JOKER]) === 100, '2 + 王 = 10 点（王当 8）');
ok(E.tenHalfTotal([C('spade', 5), JOKER]) === 100, '5 + 王 = 10 点（王当 5）');
ok(E.tenHalfTotal([C('spade', 8), JOKER]) === 100, '8 + 王 = 10 点（王当 2）');
ok(E.tenHalfTotal([C('spade', 9), JOKER]) === 100, '9 + 王 = 10 点（王当 1）');
ok(E.tenHalfBust([C('spade', 10), C('heart', 14)]), '10 + A = 11 点，爆牌');
ok(!E.tenHalfBust([C('spade', 10), JOKER]), '10 + 王 不爆');
ok(E.tenHalfDisplay([C('spade', 13), JOKER]) === '10.5点', 'K + 王 显示 10.5点');

/* 王配任何牌都不能爆 —— 万能牌的本职。随手挑几张验证解析没跑偏。 */
{
  let bust = 0;
  for (let r = 2; r <= 14; r++) {
    if (E.tenHalfBust([C('spade', r), JOKER])) bust++;
  }
  ok(bust === 0, '王配任何牌都不爆（0.5 / A / 2~10 全可当，取最优解析）', 'bust=' + bust);
}
/* 能到 10.5 的不止「真 10 + 王」了：王 + J/Q/K 也算 */
{
  const reach = [];
  for (let r = 2; r <= 14; r++) {
    if (E.tenHalfTotal([C('spade', r), JOKER]) === 105) reach.push(r);
  }
  ok(reach.length === 4 && reach.indexOf(10) >= 0 && reach.indexOf(11) >= 0 &&
     reach.indexOf(12) >= 0 && reach.indexOf(13) >= 0,
    '★ 10 / J / Q / K 配王都能凑出十点半（以前只有真 10 可以）', JSON.stringify(reach));
}

console.log('\n[十点半] 同点数比「把点数做大的那张」，王比 10 大');

/* 下面这组全部把「那张 10」配成同花色：要验的是「王 vs K/J 谁大」，
 * 花色一致才能把变量隔离出来（踩过一次：给两边配了不同花色的 10，结果红的不是引擎）。 */
ok(E.compareTenHalf([C('spade', 10), C('heart', 13)], [C('spade', 10), JOKER]) === -1,
  '★ 10♠+K 输给 10♠+王（王的花色算最大，以前是反的）');
ok(E.compareTenHalf([C('spade', 10), JOKER], [C('spade', 10), C('heart', 13)]) === 1,
  '★ 10♠+王 赢 10♠+K');
ok(E.compareTenHalf([C('spade', 10), JOKER], [C('spade', 10), C('heart', 11)]) === 1,
  '★ 10♠+王 赢 10♠+J');
/* 反向守一条：王不救一张更小的 10。
 * 10♣+王 仍然输给 10♠+J —— 因为第一步就是比那张 10 的花色，王只作用在第二步。
 * 不写这条的话，很容易被理解成「带王就无敌」。 */
ok(E.compareTenHalf([C('club', 10), JOKER], [C('spade', 10), C('heart', 11)]) === -1,
  '★ 王不救更小的 10：10♣+王 仍输 10♠+J（先比 10 的花色）');
ok(E.compareTenHalf([C('club', 13), JOKER], [C('spade', 10), C('spade', 11)]) === 1,
  '★ 王+K 赢 10♠+J♠（王的 10 压过黑桃 10）');
ok(E.compareTenHalf([C('club', 13), JOKER], [C('spade', 10), C('spade', 13)]) === 1,
  '★ 王+K 赢 10♠+K♠（同样是黑桃 10，王仍然更大）');
ok(E.compareTenHalf([C('club', 10), JOKER], [C('spade', 9), C('heart', 14)]) === 1,
  '10.5 赢 10 点');
ok(E.compareTenHalf([C('spade', 10), C('heart', 13)], [C('spade', 9), C('heart', 14)]) === 1,
  '10.5 赢 10 点（无王侧同样成立）');
ok(E.compareTenHalf([C('spade', 9), C('heart', 14)], [C('club', 8), C('diamond', 2)]) === 1,
  '同为 10 点（9+A vs 8+2）时比把点数做大的那张，9 压过 8');
ok(E.compareTenHalf([C('spade', 13), JOKER], [C('heart', 14), JOKER]) === 1,
  '★ K+王（10.5）赢 A+王（10）—— 以前是 K+王 输');

console.log('\n[十点半] 结算口径');

{
  const r = E.settleGroup('tenhalf', [
    { id: 'a', hand: [C('club', 10), JOKER] },
    { id: 'b', hand: [C('spade', 9), C('heart', 14)] }
  ]);
  ok(r.winnerId === 'a', '10+王 赢 9+A');
  ok(r.winPoints === 2, '10.5 收每人 2 分', 'winPoints=' + r.winPoints);
  ok(r.deltas.a === 2 && r.deltas.b === -2, '收分 2 / -2');
}
{
  const r = E.settleGroup('tenhalf', [
    { id: 'a', hand: [C('spade', 10), JOKER] },
    { id: 'b', hand: [C('spade', 10), C('heart', 13)] }
  ]);
  ok(r.winnerId === 'a', '★ 同为 10.5、同为 10♠ 时，带王一方的 10+王 赢 10+K（王比 10 大）');
}
/* 用户截图那一局的复现：王+K 原来算 9.5 输给两门十点半，现在也是十点半且最硬。 */
{
  const r = E.settleGroup('tenhalf', [
    { id: 'a', hand: [C('spade', 13), JOKER] },          // 王 + K♣ → 10.5
    { id: 'b', hand: [C('spade', 10), C('spade', 11)] }, // 10♠ + J♠ → 10.5
    { id: 'c', hand: [C('diamond', 10), C('diamond', 13)] } // 10♦ + K♦ → 10.5
  ]);
  ok(r.winnerId === 'a', '★ 截图复现：王+K 赢过两门真 10 的十点半');
  ok(r.winPoints === 2, '★ 王撑出来的 10.5 同样收每人 2 分', 'winPoints=' + r.winPoints);
  ok(r.deltas.a === 4 && r.deltas.b === -2 && r.deltas.c === -2,
    '★ 收分 4 / -2 / -2（和截图里的数字同构）', JSON.stringify(r.deltas));
}
{
  const r = E.settleGroup('tenhalf', [
    { id: 'a', hand: [C('club', 13), JOKER] },   // 现在 10.5
    { id: 'b', hand: [C('spade', 9), C('heart', 14)] }  // 10 点
  ]);
  ok(r.winnerId === 'a', '★ K+王（10.5 点）赢 10 点（以前是输）');
}

console.log('\n[斗牛] 大王两处都能补：三张成十 → 王去凑牛牛，否则王去凑那三张');

{
  /* ★ v57 规则更正（用户 2026-10-29 截图）：
   *   9♠ 9♦ 2♣ + 王 + 3♣ —— 9+9+2 = 20 本身就是 10 的倍数，
   *   所以王**不必**去凑那三张，留在剩两张里跟 3♣ 凑成 10 → 牛牛。
   *   以前一律让王去凑十，剩 9♠9♦ 得牛8，把玩家的牛牛算没了。 */
  const hand = [C('spade', 9), C('diamond', 9), C('club', 2), JOKER, C('club', 3)];
  const info = E.douNiuInfo(hand);
  ok(info.type === 9, '★ 9♠9♦2♣ + 王 + 3♣ = 牛牛（以前算成牛8）', info.name);
  ok(info.name === '牛牛', '★ 牌型名是牛牛', info.name);
  ok(info.compareCards.length === 4, '★ 牛牛时比牌材料仍是除王以外的 4 张', 'len=' + info.compareCards.length);
  const dec = E.douNiuDecider(hand);
  ok(dec && dec.rank === 9 && dec.suit === 'spade', '★ 决胜牌是 9♠（不是王）',
    dec ? dec.rank + '/' + dec.suit : 'null');
}
{
  /* 反向：三张真牌凑不出十时，王必须去凑那三张，不会无条件变牛牛。
   * 2,5,7,9 任意三张和 = 14/16/18/21，都不是 10 的倍数；任意两张和也不是 → 最高牛9。 */
  const hand = [C('spade', 2), C('heart', 5), C('club', 7), C('diamond', 9), JOKER];
  ok(E.douNiuType(hand).type === 8, '★ 三张凑不出十时仍是牛9（不会无条件变牛牛）',
    E.douNiuType(hand).name);
}
{
  /* 王不参与比大小：如果王被当成牌面，rank 15 会压过一切，这条就会翻成 > 0。 */
  const withJoker = [C('spade', 9), C('diamond', 9), C('club', 2), JOKER, C('club', 3)];
  const noJoker = [C('spade', 4), C('heart', 6), C('spade', 10), C('heart', 10), C('diamond', 10)];
  ok(E.douNiuType(noJoker).type === 9, '对照手牌也是牛牛（4,6,10,10,10）');
  ok(E.compareDouNiu(withJoker, noJoker) < 0,
    '★ 同为牛牛：王手拿 9♠ 比，输给 10♦（王不参与，否则必胜）');
}

{
  const hand = [JOKER, C('spade', 11), C('heart', 12), C('club', 13), C('diamond', 11)];
  const info = E.douNiuInfo(hand);
  ok(info.type === 9, '王 + 四张花牌 = 牛牛（不是五花牛）', 'type=' + info.type + ' name=' + info.name);
  ok(info.name === '牛牛', '牌型名是牛牛');
  ok(info.compareCards.length === 4, '比牌材料 = 除王以外的 4 张', 'len=' + info.compareCards.length);
  ok(info.compareCards.every(function (c) { return !E.isJoker(c); }), '比牌材料不含王');
}
{
  const hand = [JOKER, C('spade', 2), C('heart', 8), C('club', 5), C('diamond', 6)];
  const info = E.douNiuInfo(hand);
  // 2+8+5+6 里任意三张都不成十（① 不成立），走 ②：王配 5+6 凑十，剩 2+8=10 → 牛牛
  ok(info.type === 9, '王 + 2,8,5,6 能选出最优三张组 → 牛牛', 'type=' + info.type);
}
{
  const hand = [JOKER, C('spade', 3), C('heart', 7), C('club', 13), C('diamond', 12)];
  const info = E.douNiuInfo(hand);
  // 3+7+K(10) = 20 成十（① 成立）→ 王补 12，牛牛
  ok(info.type === 9, '王 + 3,7 + K,Q → 牛牛', 'type=' + info.type);
}
{
  // 王手不可能没牛：随机 500 组验证
  let noCow = 0;
  const deck = Card.createDeck();
  for (let i = 0; i < 500; i++) {
    Card.shuffle(deck);
    const others = deck.filter(function (c) { return !Card.isJoker(c); }).slice(0, 4);
    if (E.douNiuType([JOKER].concat(others)).type < 0) noCow++;
  }
  ok(noCow === 0, '有大王的手牌必然有牛（保底）', noCow + '/500 次没牛');
}

console.log('\n[斗牛] 无王规则不变');

{
  const hand = [C('spade', 11), C('heart', 12), C('club', 13), C('diamond', 11), C('spade', 12)];
  ok(E.douNiuType(hand).type === 10, '五张真花牌仍是五花牛');
}
{
  const hand = [C('spade', 2), C('heart', 3), C('club', 4), C('diamond', 6), C('spade', 7)];
  const t = E.douNiuType(hand).type;
  ok(t === -1, '2,3,4,6,7 没牛', 'type=' + t);
}

console.log('\n[斗牛] 同牛型比大小');

{
  const jokerHand = [JOKER, C('spade', 11), C('heart', 12), C('club', 13), C('diamond', 11)];
  // 同牛型比五张里最大的牌；王手先剔除王，材料是剩下 4 张真实牌
  const info = E.douNiuInfo(jokerHand);
  ok(info.compareCards.length === 4 && E.deciderLabel('douniu', jokerHand) === 'K♣',
    '王手的比牌材料是除王以外的牌，决胜牌 = K♣', E.deciderLabel('douniu', jokerHand));
}
{
  // 王手不能因为「牌少」而无条件输给同为牛牛的无王手
  const jokerHand = [JOKER, C('spade', 11), C('heart', 12), C('club', 13), C('diamond', 11)];
  const normalHand = [C('spade', 5), C('heart', 5), C('club', 10), C('diamond', 10), C('spade', 3)];
  const cn = E.douNiuType(normalHand);
  if (cn.type === 9) {
    const c = E.compareDouNiu(jokerHand, normalHand);
    ok(c !== 0, '同为牛牛时能分出胜负（不是张数少就输）', 'compare=' + c);
  } else {
    ok(true, '构造的无王手不是牛牛，跳过（type=' + cn.type + '）');
  }
}

console.log('\n[斗牛] 结算口径');

{
  const r = E.settleGroup('douniu', [
    { id: 'a', hand: [JOKER, C('spade', 11), C('heart', 12), C('club', 13), C('diamond', 11)] }, // 牛牛
    { id: 'b', hand: [C('spade', 2), C('heart', 3), C('club', 4), C('diamond', 6), C('spade', 7)] } // 没牛
  ]);
  ok(r.winnerId === 'a', '牛牛赢没牛');
  ok(r.winPoints === 3, '牛牛收每人 3 分基础分', 'winPoints=' + r.winPoints);
  ok(r.deltas.b === -8, '没牛者额外倒扣 5 分：-(3+5)=-8', 'deltas.b=' + r.deltas.b);
}

console.log('\n[飘三叶] 大王万能未被误伤');

{
  const hand = [JOKER, C('spade', 11), C('heart', 11)];
  ok(E.piaoSanYeType(hand).type === E.PSY_TYPE.LEOPARD, '王 + J,J 仍能凑豹子');
}
{
  const hand = [JOKER, C('spade', 11), C('spade', 12)];
  ok(E.piaoSanYeType(hand).type === E.PSY_TYPE.STRAIGHT_FLUSH, '王 + J♠,Q♠ 仍能凑同花顺');
}

console.log('\n[整体] AI 两轮分组仍然合法');

{
  const AI = require('../js/ai.js');
  let bad = 0;
  for (let i = 0; i < 300; i++) {
    const deck = Card.createDeck();
    Card.shuffle(deck);
    const hand = deck.slice(0, 6);
    for (const round of [1, 2]) {
      const g = AI.decide(hand, round);
      const used = [];
      for (const k of SM.ROUND_GROUPS[round]) {
        if ((g[k] || []).length !== SM.GROUP_COUNT[k]) { bad++; break; }
        used.push(...g[k]);
      }
      if (used.length !== 6) bad++;
    }
  }
  ok(bad === 0, 'AI 分组张数全部正确', bad + ' 次异常');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail === 0 ? 0 : 1);
