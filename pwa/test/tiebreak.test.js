/**
 * 同点数 / 同牛型「再比一次」的规则回归（用户实测报错后的定版）
 * 跑法：node pwa/test/tiebreak.test.js
 *
 * 用户报的三处错，其实是一个根因：**平局时的比牌材料选错了**。
 *
 *   A. 十点半 两手都是 10.5，旧实现拿「那张半点牌」的牌面比（J=11 < Q=12 < K=13），
 *      于是「10♦ + Q♣」压过「10♥ + Q♦」——跟 10 的花色毫无关系。
 *      正确：都是 10.5 时比的是那张 **10** 的花色（♠>♥>♣>♦），J/Q/K 只是半点。
 *   B. 斗牛 定完牛型后比的是**五张里最大的那张**（K > Q > J > 10 > … > 2 > A，A 只算 1），
 *      一样再比花色。有大王的那手，王本身不参与，取「除王以外最大的那张」。
 *      曾经错两版：先是五张全比但用 A=14 的高牌点数；后来改成「只比剩两张」，
 *      于是出现「剩 Q,10 赢剩 10,10」而对方手里明明有 K 的怪结果。
 *
 * 三个用例的手牌直接照抄用户截图，赢家对了才算修好。
 */
'use strict';

const E = require('../js/engine.js');
const Card = require('../js/card.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function C(suit, rank) { return { suit: suit, rank: rank }; }
const JOKER = C('joker', 15);

/* ==========================================================================
 * 一、十点半：都是 10.5 → 比那张 10 的花色
 * ======================================================================== */
console.log('\n[十点半] 同为 10.5：比 10 的花色，J/Q/K 的牌面不参与');

{
  const h10s = [JOKER, C('spade', 10)];               // 10♠ + 王
  const h10h = [C('diamond', 12), C('heart', 10)];    // 10♥ + Q
  const h10c = [C('diamond', 11), C('club', 10)];     // 10♣ + J
  const h10d = [C('diamond', 12), C('diamond', 10)];  // 10♦ + Q

  ok(E.compareTenHalf(h10s, h10h) > 0, '10♠ + 王 赢 10♥ + Q');
  ok(E.compareTenHalf(h10h, h10c) > 0, '10♥ + Q 赢 10♣ + J');
  ok(E.compareTenHalf(h10c, h10d) > 0, '10♣ + J 赢 10♦ + Q（半点牌的牌面不参与）');
  ok(E.compareTenHalf(h10d, h10h) < 0, '反过来看：10♦ + Q 输 10♥ + Q');
  ok(E.compareTenHalf(h10s, h10s) === 0, '同一手牌对自己是平局');
}

{
  // 同点数但都不是 10.5：比「把点数做大的那张」，A 只算 1
  const sevenA = [C('spade', 7), C('heart', 14)];    // 8 点，材料 7 + A
  const fourFour = [C('club', 4), C('diamond', 4)];  // 8 点，材料 4 + 4
  ok(E.compareTenHalf(sevenA, fourFour) > 0, '同为 8 点：7+A 赢 4+4（比的是 7，不是 A=14）');
  ok(E.compareTenHalf(fourFour, sevenA) < 0, '同为 8 点：4+4 输 7+A');
}

console.log('\n[十点半] 决胜牌（结算面板展示用）');

{
  ok(E.deciderLabel('tenhalf', [C('diamond', 12), C('heart', 10)]) === '10♥',
    '10.5 的决胜牌是那张 10（Q♦ + 10♥ → 10♥）',
    E.deciderLabel('tenhalf', [C('diamond', 12), C('heart', 10)]));
  ok(E.deciderLabel('tenhalf', [JOKER, C('spade', 10)]) === '10♠',
    '王 + 10♠ 的决胜牌是 10♠（王不参与）',
    E.deciderLabel('tenhalf', [JOKER, C('spade', 10)]));
  ok(E.deciderLabel('tenhalf', [C('spade', 7), C('heart', 14)]) === '7♠',
    '7+A 的决胜牌是 7♠（贡献 7 点 > A 的 1 点）',
    E.deciderLabel('tenhalf', [C('spade', 7), C('heart', 14)]));
}

/* ==========================================================================
 * 一·补、飘三叶：顺子 / 同花顺 同点数 → 也要比花色
 *
 * 这是 2026-10-30 全量 review 发现的第二个「平局材料选错」：
 *   comparePiaoSanYeResolved 里 STRAIGHT_FLUSH / STRAIGHT 两个分支写的是
 *     return ta.high < tb.high ? -1 : (ta.high > tb.high ? 1 : 0);
 *   high 相同就直接 0 —— 而同花 / 散牌 / 对子都老老实实回落比了牌。
 * 于是「平局」落到 settleGroup：它只按 comp > 0 换赢家，candidates[0] 是**入房顺序**，
 * 结果是谁先进房谁赢：4♦5♦6♦ 能赢 4♠5♠6♠，输的人看着牌面一样大，完全无从理解。
 *
 * 注意花色序是 spade(4) > heart(3) > club(2) > diamond(1)。
 * （这里踩过一次坑：写测例时用 'd'/'s' 当花色名，suitRank 两个都返回 0，
 *   于是「怎么比都是平局」—— 验证结论之前先确认入参是合法花色。）
 * ======================================================================== */
console.log('\n[飘三叶] 同点顺子 / 同花顺：比花色，且赢家与入房顺序无关');

{
  const sfD = [C('diamond', 6), C('diamond', 5), C('diamond', 4)];   // 同花顺，方片
  const sfS = [C('spade', 6), C('spade', 5), C('spade', 4)];         // 同花顺，黑桃
  ok(E.piaoSanYeType(sfD).type === 5 && E.piaoSanYeType(sfS).type === 5, '两手都是同花顺');
  ok(E.comparePiaoSanYe(sfD, sfS) < 0, '★ 同花顺同点：方片输黑桃（旧实现返回 0）',
    'compare=' + E.comparePiaoSanYe(sfD, sfS));
  ok(E.comparePiaoSanYe(sfS, sfD) > 0, '★ 反过来黑桃赢（反对称，不是「两边都是 0」）',
    'compare=' + E.comparePiaoSanYe(sfS, sfD));

  const r1 = E.settleGroup('piaosanye', [{ id: 'A', hand: sfD }, { id: 'B', hand: sfS }]);
  ok(r1.winnerId === 'B', '★ 方片先进房也照样输（赢家 = 黑桃那手）', 'winner=' + r1.winnerId);
  const r2 = E.settleGroup('piaosanye', [{ id: 'A', hand: sfS }, { id: 'B', hand: sfD }]);
  ok(r2.winnerId === 'A', '★ 换个入房顺序，赢家仍是黑桃那手（不再是谁先进谁赢）', 'winner=' + r2.winnerId);
  ok(r1.deltas.B === 1 && r1.deltas.A === -1, '分数跟着赢家走：+1 / -1', JSON.stringify(r1.deltas));
}

{
  const stD = [C('diamond', 6), C('heart', 5), C('club', 4)];   // 混花顺子
  const stS = [C('spade', 6), C('club', 5), C('heart', 4)];
  ok(E.piaoSanYeType(stD).type === 3 && E.piaoSanYeType(stS).type === 3, '两手都是顺子（非同花）');
  ok(E.comparePiaoSanYe(stD, stS) < 0, '★ 顺子同点：比最大的那张 6 的花色，方片输黑桃',
    'compare=' + E.comparePiaoSanYe(stD, stS));
  ok(E.settleGroup('piaosanye', [{ id: 'A', hand: stD }, { id: 'B', hand: stS }]).winnerId === 'B',
    '★ 顺子同点，赢家是黑桃那手');
}

{
  /* A23 是最小顺子（high=3），两手都是 A23 时回落比牌 → 比 A 的花色 */
  const a23d = [C('diamond', 14), C('heart', 3), C('club', 2)];
  const a23s = [C('spade', 14), C('club', 3), C('heart', 2)];
  ok(E.piaoSanYeType(a23d).high === 3 && E.piaoSanYeType(a23s).high === 3, 'A23 的 high 都是 3');
  ok(E.comparePiaoSanYe(a23d, a23s) < 0, '★ A23 对 A23：比 A 的花色，方片输黑桃',
    'compare=' + E.comparePiaoSanYe(a23d, a23s));
}

{
  /* 真·同牌（单副牌里不会出现，但比较器必须自洽）：
   * 返回 0 时才允许出现平局，而且 tieIds 要把两家都带出来 —— 不许默默按数组顺序判。 */
  const h = [C('spade', 6), C('spade', 5), C('spade', 4)];
  ok(E.comparePiaoSanYe(h, h) === 0, '同一手牌对自己是平局');
  const r = E.settleGroup('piaosanye', [{ id: 'A', hand: h }, { id: 'B', hand: h.slice() }]);
  ok(r.tieIds && r.tieIds.length === 2 && r.tieIds.indexOf('A') >= 0 && r.tieIds.indexOf('B') >= 0,
    '★ 牌面完全相同才判平局，且 tieIds 把两家都标出来（不再是一条无人知晓的隐式规则）',
    JSON.stringify(r.tieIds));
}

{
  /* 性质测试：比较器必须反对称。缺一处 tie-break 就会在这里冒出来 ——
   * 旧实现在同点顺子上 a vs b 与 b vs a 都返回 0，所以再加一条：
   * 不同手牌不能算平局。
   *
   * 抽样必须是**两手不重叠**的牌（一手真牌局里不可能两家共用手牌）。
   * 早期版本是从「所有三张组合」里各取一手比，两手会共用 2 张牌 ——
   * 于是「3♠ Q♠ Q♥」对「3♠ Q♥ 大王」这种牌面必然平局（王补成 Q♠），
   * 4 万次里稳定冒出十几次，看着像 bug，其实是抽样方式不合法。 */
  const deck = Card.createDeck();
  let asym = 0, falseTie = 0;
  for (let t = 0; t < 40000; t++) {
    const d = deck.slice();
    Card.shuffle(d);
    const a = d.slice(0, 3);
    const b = d.slice(3, 6);
    const ab = E.comparePiaoSanYe(a, b), ba = E.comparePiaoSanYe(b, a);
    if (ab !== -ba) asym++;
    if (ab === 0) falseTie++;
  }
  ok(asym === 0, '4 万次随机对抗：飘三叶比较器严格反对称', asym + ' 次不对称');
  ok(falseTie === 0, '★ 4 万手互不重叠的真牌局里没有一次平局 ——同点顺子漏比花色就是这种假平局',
    falseTie + ' 次假平局');
}

/* ==========================================================================
 * 二、斗牛：同牛型 → 比五张里最大的那张，K 最大 A=1，一样再比花色
 * ======================================================================== */
console.log('\n[斗牛] 同牛型比「五张里最大的那张」');

{
  const hand = [C('diamond', 12), C('club', 13), C('club', 3), C('heart', 2), C('heart', 5)]; // Q K 3 2 5
  const info = E.douNiuInfo(hand);
  ok(info.type === 9, 'Q,K,3,2,5 = 牛牛（3+2+5=10，剩 Q,K）', info.name);
  ok(info.compareCards.length === 5, '比牌材料是整手五张（不是只剩两张）', 'len=' + info.compareCards.length);
  ok(E.deciderLabel('douniu', hand) === 'K♣', '决胜牌 = 五张里最大的 K♣', E.deciderLabel('douniu', hand));
}

{
  /* 新旧规则的分水岭（从全牌堆里搜出来的真实手牌）：
   *   A = 3♠ 7♥ K♥ 8♣ K♣ —— 牛8，凑十的是 3+7+K♥，剩 K♣ + 8♣
   *   B = Q♠ K♠ A♠ 7♦ Q♦ —— 牛8，凑十的是 Q+Q+K♠，剩 A♠ + 7♦
   *   旧规则只比剩两张 → A 的 K♣,8♣ 压过 B 的 A♠,7♦ → 判 A 赢；
   *   新规则比五张最大 → B 有 K♠，A 只有 K♥ → 同点比花色，B 赢。
   *   这正说明「凑十的那三张里的大牌也得算」——用户就是拿这种牌报的错。 */
  const a = [C('spade', 3), C('heart', 7), C('heart', 13), C('club', 8), C('club', 13)];
  const b = [C('spade', 12), C('spade', 13), C('spade', 14), C('diamond', 7), C('diamond', 12)];
  ok(E.douNiuType(a).name === '牛8' && E.douNiuType(b).name === '牛8', '两手都是牛8',
    E.douNiuType(a).name + ' / ' + E.douNiuType(b).name);
  ok(E.deciderLabel('douniu', a) === 'K♥' && E.deciderLabel('douniu', b) === 'K♠',
    '两手决胜牌分别是 K♥ / K♠（各自五张里最大的牌）',
    E.deciderLabel('douniu', a) + ' / ' + E.deciderLabel('douniu', b));
  ok(E.compareDouNiu(b, a) > 0, '牛8 比五张最大：K♠ 赢 K♥（只看剩两张会误判 A 赢）');
  ok(E.compareDouNiu(a, b) < 0, '反过来 A 输给 B');
}

{
  /* 五花牛之间同样比五张里最大的牌 */
  const f1 = [C('spade', 13), C('heart', 12), C('club', 11), C('diamond', 13), C('heart', 11)];
  const f2 = [C('heart', 13), C('club', 12), C('diamond', 11), C('spade', 12), C('spade', 11)];
  ok(E.douNiuType(f1).type === 10 && E.douNiuType(f2).type === 10, '两手都是五花牛');
  ok(E.compareDouNiu(f1, f2) > 0, '五花牛比最大：K♠ 赢 K♥');
}

console.log('\n[斗牛] 有大王的手：王不参与比大小，取除王以外最大的那张');

{
  /* 王手 = 王 + Q♥10♣3♦2♠（牛牛，剩 Q♥10♣），除王最大 Q♥；
   * 对手 = Q♠10♦7♣2♦A♠（牛牛，7+2+A=10，剩 Q♠10♦），最大 Q♠。
   * 若让王按 rank 15 参与，王手会无条件最大 —— 那不是规则。 */
  const jokerHand = [JOKER, C('heart', 12), C('club', 10), C('diamond', 3), C('spade', 2)];
  const other = [C('spade', 12), C('diamond', 10), C('club', 7), C('diamond', 2), C('spade', 14)];
  ok(E.douNiuType(jokerHand).type === 9 && E.douNiuType(other).type === 9, '两手都是牛牛');
  ok(E.deciderLabel('douniu', jokerHand) === 'Q♥',
    '王手的决胜牌是除王以外最大的 Q♥（王不参与）', E.deciderLabel('douniu', jokerHand));
  ok(E.compareDouNiu(other, jokerHand) > 0, '同为 Q：Q♠ 赢 Q♥（王不参与，否则王恒最大）');
  ok(E.compareDouNiu(jokerHand, other) < 0, '反过来王手输');

  /* 王手也不能靠「牌面少一张」被白吃：K 还是要压过 Q */
  const jokerK = [JOKER, C('club', 13), C('heart', 10), C('diamond', 3), C('spade', 2)];
  ok(E.compareDouNiu(jokerK, other) > 0, '王手除王最大是 K♣ → 赢 Q♠');
}

console.log('\n[斗牛] A 只算 1：A 不能压过 K');

{
  const kq = [C('diamond', 12), C('club', 13), C('club', 3), C('heart', 2), C('heart', 5)];   // 牛牛 → K♣
  const aa = [C('spade', 14), C('club', 8), C('heart', 6), C('diamond', 4), C('heart', 14)];  // 牛牛 → 8♣
  ok(E.douNiuType(kq).type === 9 && E.douNiuType(aa).type === 9, '两手都是牛牛');
  ok(E.compareDouNiu(kq, aa) > 0, '牛牛比最大：K♣ 赢 8♣（A 只算 1，比不过 K）');
  ok(E.compareDouNiu(aa, kq) < 0, '牛牛比最大：8♣ 输 K♣');
}

{
  // 没牛：同样比五张里最大的那张，A 仍然只算 1
  const noCowK = [C('club', 13), C('heart', 14), C('club', 2), C('diamond', 3), C('spade', 4)];  // K,A,2,3,4
  const noCowA = [C('spade', 14), C('heart', 14), C('club', 2), C('diamond', 3), C('spade', 4)];  // A,A,2,3,4
  ok(E.douNiuType(noCowK).type === -1, 'K,A,2,3,4 没牛（没有任何三张能凑十）', E.douNiuType(noCowK).name);
  ok(E.douNiuType(noCowA).type === -1, 'A,A,2,3,4 也没牛', E.douNiuType(noCowA).name);
  ok(E.compareDouNiu(noCowK, noCowA) > 0, '没牛比最大单张：K 赢 A（A 只算 1）');
}

console.log('\n[斗牛] 最大的牌点数一样再比花色');

{
  const base = [C('club', 10), C('diamond', 2), C('heart', 3), C('spade', 5)];  // 2+3+5=10 → 剩 K + 10
  const kS = [C('spade', 13)].concat(base);
  const kH = [C('heart', 13)].concat(base);
  ok(E.douNiuType(kS).type === 9 && E.douNiuType(kH).type === 9, '两手都是牛牛（剩 K 和 10）');
  ok(E.deciderLabel('douniu', kS) === 'K♠' && E.deciderLabel('douniu', kH) === 'K♥',
    '两手决胜牌分别是 K♠ / K♥',
    E.deciderLabel('douniu', kS) + ' / ' + E.deciderLabel('douniu', kH));
  ok(E.compareDouNiu(kS, kH) > 0, '同为 K：黑桃赢红桃');
}

/* ==========================================================================
 * 三、用户截图原样复现（端到端：settleGroup 选出来的赢家）
 * ======================================================================== */
console.log('\n[截图回归-1] 十点半：10♣ / 10♦ / 10♠ 三个 10.5 并列');

{
  const r = E.settleGroup('tenhalf', [
    { id: 'b1', hand: [C('diamond', 11), C('club', 10)] },     // J♦ 10♣
    { id: 'b2', hand: [C('diamond', 6), C('diamond', 2)] },    // 8 点
    { id: 'b3', hand: [C('diamond', 12), C('diamond', 10)] },  // Q♦ 10♦
    { id: 'b4', hand: [JOKER, C('spade', 10)] }                // 王 10♠
  ]);
  ok(r.winnerId === 'b4', '赢家是 10♠ 那家（♠ > ♦ > ♣）', 'winner=' + r.winnerId);
  ok(r.winPoints === 2, '10.5 收每人 2 分', 'winPoints=' + r.winPoints);
  ok(r.deltas.b4 === 6 && r.deltas.b1 === -2, '分数守恒：+6 / -2', JSON.stringify(r.deltas));
}

console.log('\n[截图回归-2] 十点半：10♥ + Q vs 10♦ + Q（旧版判 10♦ 赢）');

{
  const r = E.settleGroup('tenhalf', [
    { id: 'b4', hand: [C('diamond', 12), C('heart', 10)] },  // Q♦ 10♥
    { id: 'b5', hand: [C('diamond', 10), C('club', 12)] }    // 10♦ Q♣
  ]);
  ok(r.winnerId === 'b4', '赢家是 10♥ 那家（♥ > ♦）', 'winner=' + r.winnerId);
  ok(r.deltas.b4 === 2 && r.deltas.b5 === -2, '分数 +2 / -2', JSON.stringify(r.deltas));
}

console.log('\n[截图回归-3] 斗牛：四家牛牛，比五张里最大的牌 → K♣ > Q♣ > J♥ > 8♣');

{
  const r = E.settleGroup('douniu', [
    { id: 'b2', hand: [C('diamond', 12), C('club', 13), C('club', 3), C('heart', 2), C('heart', 5)] },  // Q K 3 2 5 → 最大 K♣
    { id: 'b3', hand: [C('club', 7), C('diamond', 14), JOKER, C('heart', 11), C('club', 10)] },         // 王手 → 除王最大 J♥
    { id: 'b6', hand: [C('club', 5), C('diamond', 11), C('heart', 3), C('club', 12), C('spade', 2)] },  // 5 J 3 Q 2 → 最大 Q♣
    { id: 'me', hand: [C('spade', 14), C('club', 8), C('heart', 6), C('diamond', 4), C('heart', 14)] }  // A 8 6 4 A → 最大 8♣
  ]);
  ok(r.winnerId === 'b2', '赢家是最大牌 K♣ 的那家', 'winner=' + r.winnerId);
  ok(r.entries.filter(function (e) { return e.typeName === '牛牛'; }).length === 4, '四家都是牛牛');
  const dec = {};
  r.entries.forEach(function (e) { dec[e.id] = e.decider; });
  ok(dec.b2 === 'K♣' && dec.b6 === 'Q♣' && dec.b3 === 'J♥' && dec.me === '8♣',
    '各家决胜牌是 K♣ / Q♣ / J♥ / 8♣（王手取除王以外最大的那张）', JSON.stringify(dec));
  ok(r.winPoints === 3, '牛牛收每人 3 分', 'winPoints=' + r.winPoints);
}

/* ==========================================================================
 * 四、比较器代数性质：赢家不能依赖玩家数组顺序
 * ======================================================================== */
console.log('\n[性质] 斗牛比较器：反对称 + 传递（随机抽样）');

{
  const deck = Card.createDeck();
  const hands = [];
  let visited = 0;
  outer:
  for (let i = 0; i < deck.length; i++) {
    for (let j = i + 1; j < deck.length; j++) {
      for (let k = j + 1; k < deck.length; k++) {
        for (let m = k + 1; m < deck.length; m++) {
          for (let n = m + 1; n < deck.length; n++) {
            if (visited++ % 97 !== 0) continue;
            hands.push([deck[i], deck[j], deck[k], deck[m], deck[n]]);
            if (hands.length >= 4000) break outer;
          }
        }
      }
    }
  }
  ok(hands.length >= 4000, '抽到足够样本（' + hands.length + ' 手）');

  let asym = 0, trans = 0;
  for (let t = 0; t < 40000; t++) {
    const a = hands[(Math.random() * hands.length) | 0];
    const b = hands[(Math.random() * hands.length) | 0];
    if (E.compareDouNiu(a, b) !== -E.compareDouNiu(b, a)) asym++;
  }
  for (let t = 0; t < 20000; t++) {
    const a = hands[(Math.random() * hands.length) | 0];
    const b = hands[(Math.random() * hands.length) | 0];
    const c = hands[(Math.random() * hands.length) | 0];
    const ab = E.compareDouNiu(a, b), bc = E.compareDouNiu(b, c), ac = E.compareDouNiu(a, c);
    if (ab > 0 && bc > 0 && !(ac > 0)) trans++;
  }
  ok(asym === 0, '4 万次随机对抗：结果严格反对称', asym + ' 次不对称');
  ok(trans === 0, '2 万次随机三元组：满足传递性', trans + ' 次违反');
}

console.log('\n========================================');
console.log(fail === 0 ? '全部通过' : '有失败');
console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
