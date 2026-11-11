/**
 * 引擎单元测试：发牌 / 牌型判定 / 计分
 * 跑法：node pwa/test/engine.test.js
 *
 * 这一层是整套规则的地基：engine.js 同时被前端、AI、服务端结算复用，
 * 牌型判错一次，战绩、排行榜、AI 决策会全部跟着错，而且不会报错。
 *
 * 设计原则：
 *   - 能用「独立实现」算期望值的地方，绝不拿引擎自己验自己
 *     （例如十点半总点数用 rank 直接算、斗牛牛几用总点数取模算）
 *   - 能穷举的地方穷举（54 张牌的两两组合全部跑一遍）
 *   - 比较器必须满足反对称与传递，否则 settleGroup 选出的赢家会依赖数组顺序
 */
'use strict';

const Card = require('../js/card.js');
const E = require('../js/engine.js');
const SM = require('../js/stateMachine.js');
const CONFIG = require('../js/config.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function C(suit, rank) { return { suit: suit, rank: rank }; }
const JOKER = C('joker', 15);
const SUITS4 = ['spade', 'heart', 'club', 'diamond'];

function handLabel(h) { return h.map(E.cardLabel).join(' '); }

/* ==========================================================================
 * 一、发牌
 * ======================================================================== */
console.log('[发牌] 牌堆构成');

{
  const deck = Card.createDeck();
  ok(deck.length === 54, '一副牌 54 张（52 + 大王 + 小王）', 'got ' + deck.length);
  ok(deck.filter(Card.isJoker).length === 2, '有且只有 2 张王');
  ok(deck.filter(Card.isBigJoker).length === 1, '大王 1 张');
  ok(deck.filter(Card.isSmallJoker).length === 1, '小王 1 张');

  const normal = deck.filter(function (c) { return !Card.isJoker(c); });
  ok(normal.length === 52, '常规牌 52 张');

  const ids = new Set(deck.map(Card.cardId));
  ok(ids.size === 54, '没有重复的牌');

  let missing = 0;
  for (const s of SUITS4) {
    for (let r = 2; r <= 14; r++) {
      const hit = normal.some(function (c) { return c.suit === s && c.rank === r; });
      if (!hit) missing++;
    }
  }
  ok(missing === 0, '4 花色 × 2~14 一张不缺', missing + ' 张缺失');

  const joker = deck.filter(Card.isJoker)[0];
  ok(joker.rank === 15, '大王 rank = 15');
  ok(E.singleRank(joker) === 15, '单张里大王点数最高');
}

console.log('\n[发牌] 洗牌');

{
  const deck = Card.createDeck();
  const before = deck.map(Card.cardId).sort().join(',');
  Card.shuffle(deck);
  ok(deck.length === 54, '洗牌后仍是 54 张');
  ok(deck.map(Card.cardId).sort().join(',') === before, '洗牌只换顺序，不增不减');

  /* 洗牌有效性：1000 次洗牌里，大王出现在首位的次数应该远大于 0 且远小于全部 */
  let topJoker = 0;
  const positions = new Array(54).fill(0);
  for (let i = 0; i < 1000; i++) {
    Card.shuffle(deck);
    const p = deck.findIndex(Card.isJoker);
    positions[p]++;
    if (p === 0) topJoker++;
  }
  ok(topJoker > 0 && topJoker < 200, '大王不会固定在某一位（1000 次里首位 ' + topJoker + ' 次）');
  ok(positions.filter(function (n) { return n > 0; }).length > 30, '大王能落到大多数位置（覆盖 ' +
    positions.filter(function (n) { return n > 0; }).length + '/54）');
}

console.log('\n[发牌] 房间开局发牌');

{
  function player(id) {
    return {
      id: id, nickname: id, ready: true, left: false, connected: true,
      disconnectedAt: null, score: CONFIG.INITIAL_SCORE, hand: [],
      groups: null, submitted: { round1: false, round2: false }
    };
  }
  const room = SM.newRoom('900001', player('p1'));
  /* 这几条测的是「发牌本身」：每人 6 张、总数对、不重发。
   * 人数上限 v82 收到 5 之后，6/8 人局只存在于「上限还是 8 的时候建的房间」里，
   * 所以这里显式把房间上限设成 8 —— 发牌逻辑必须对老房间继续成立。
   * 新的 5 人上限由 pwa/test/player-cap.test.js 负责。 */
  room.cap = 8;
  for (let i = 2; i <= 6; i++) SM.joinRoom(room, player('p' + i));
  for (let i = 1; i <= 6; i++) SM.setReady(room, 'p' + i, true);
  const r = SM.startGame(room, 'p1');
  ok(r.ok, '6 人局可以开局', r.error);

  const all = [];
  let wrongSize = 0;
  for (const p of r.room.players) {
    if (p.hand.length !== 6) wrongSize++;
    all.push(...p.hand);
  }
  ok(wrongSize === 0, '每人正好 6 张', wrongSize + ' 人不符');
  ok(all.length === 36, '6 人共发出 36 张');
  ok(new Set(all.map(Card.cardId)).size === 36, '36 张互不重复');
  ok(r.room.phase === SM.PHASE.ROUND1_SPLIT, '开局进入第一轮分牌阶段');
}

{
  /* 最多 8 人：8 × 6 = 48 ≤ 53，仍够发 */
  function player(id) {
    return {
      id: id, nickname: id, ready: true, left: false, connected: true,
      disconnectedAt: null, score: CONFIG.INITIAL_SCORE, hand: [],
      groups: null, submitted: { round1: false, round2: false }
    };
  }
  const room = SM.newRoom('900002', player('q1'));
  room.cap = 8;   // 老 8 人房：牌堆要够（8 × 6 = 48 ≤ 53）
  for (let i = 2; i <= 8; i++) SM.joinRoom(room, player('q' + i));
  for (let i = 1; i <= 8; i++) SM.setReady(room, 'q' + i, true);
  const r = SM.startGame(room, 'q1');
  const all = [];
  for (const p of r.room.players) all.push(...p.hand);
  ok(all.length === 48, '8 人局发出 48 张');
  ok(new Set(all.map(Card.cardId)).size === 48, '48 张互不重复（没有越界发重复牌）');
}

/* ==========================================================================
 * 二、单张比大小
 * ======================================================================== */
console.log('\n[牌型] 单张比大小');

{
  /* 顺序：大王 > K > Q > J > 10 > … > 2 > A（A 当 1，最小） */
  const order = [JOKER];
  for (let r = 13; r >= 2; r--) order.push(C('spade', r));
  order.push(C('spade', 14));           // A 最小

  let bad = 0;
  for (let i = 0; i < order.length - 1; i++) {
    if (E.compareSingle(order[i], order[i + 1]) <= 0) bad++;
  }
  ok(bad === 0, '单张顺序正确（王 > K > … > 2 > A）', bad + ' 处倒序');

  ok(E.compareSingle(C('spade', 10), C('heart', 10)) > 0, '同点数黑桃赢红桃');
  ok(E.compareSingle(C('heart', 10), C('club', 10)) > 0, '同点数红桃赢梅花');
  ok(E.compareSingle(C('club', 10), C('diamond', 10)) > 0, '同点数梅花赢方片');
  ok(E.compareSingle(C('spade', 10), C('heart', 10)) === -E.compareSingle(C('heart', 10), C('spade', 10)),
    '同点数比较反对称');

  /* settleGroup 给 single 传的是数组，比较器必须能同时吃对象和数组 */
  ok(E.compareSingle([C('spade', 13)], [C('heart', 12)]) > 0, '传数组也能正确比较（K 赢 Q）');
  ok(E.compareSingle(null, C('spade', 2)) < 0, '空牌按最小处理，不静默判平');
}

/* ==========================================================================
 * 三、十点半
 * ======================================================================== */
console.log('\n[牌型] 十点半：点数计算（对照独立实现）');

{
  /* 独立实现：A=1、J/Q/K=0.5、2~10 面值，王单独处理 */
  function expectTenths(card) {
    if (E.isJoker(card)) return null;
    if (card.rank === 14) return 10;
    if (card.rank >= 11) return 5;
    return card.rank * 10;
  }

  const deck = Card.createDeck();
  const normal = deck.filter(function (c) { return !E.isJoker(c); });
  let bad = 0;
  for (const c of normal) {
    if (E.tenHalfTenths(c) !== expectTenths(c)) bad++;
  }
  ok(bad === 0, '52 张常规牌的点数转换全对', bad + ' 张不符');
}

{
  /* 穷举 54 张牌的所有 2 张组合（C(54,2) = 1431 种），逐条核对 */
  const deck = Card.createDeck();
  let illegalTotal = 0, jokerMax = 0;
  const jokerTops = new Set();

  for (let i = 0; i < deck.length; i++) {
    for (let j = i + 1; j < deck.length; j++) {
      const h = [deck[i], deck[j]];
      const total = E.tenHalfTotal(h);
      if (total % 5 !== 0) illegalTotal++;         // 十分之一单位必然是 5 的倍数
      if (total <= 0 || total > 200) illegalTotal++;
      if (E.hasJoker(h)) {
        if (total === 105) jokerMax++;
        jokerTops.add(total);
      }
    }
  }
  ok(illegalTotal === 0, '1431 种两张组合的点数都是合法的 5 的倍数', illegalTotal + ' 组异常');
  /* 加了小王之后从 16 变 33：大王 + 10/J/Q/K = 16，小王同样 16，再加「大小王」这一组自己就是 10.5。
   * 三个数必须同时成立 —— 少算双王会得到 32，少算小王会退回 16，都是漏了东西的信号。 */
  ok(jokerMax === 33, '含王的组合里有 33 组能凑到 10.5（16 + 16 + 双王）', 'got ' + jokerMax);
  ok(!jokerTops.has(110) && !jokerTops.has(115), '含王的组合永远不会爆出 11 点以上（王会自己退到合适点数）');
}

console.log('\n[牌型] 十点半：大王取值');

{
  ok(E.tenHalfTotal([C('spade', 10), JOKER]) === 105, '10 + 王 = 10.5');
  /* ★ v56：王可以当 10 了（用户 2026-10-29 更正，群里口径「王比 10 大」） */
  ok(E.tenHalfTotal([C('spade', 13), JOKER]) === 105, '★ K + 王 = 10.5（王当 10，以前只能退到 9）');
  ok(E.tenHalfTotal([C('spade', 11), JOKER]) === 105, '★ J + 王 = 10.5');
  ok(E.tenHalfTotal([C('spade', 12), JOKER]) === 105, '★ Q + 王 = 10.5');
  ok(E.tenHalfTotal([C('spade', 14), JOKER]) === 100, 'A + 王 = 10（王当 9）');
  ok(E.tenHalfTotal([C('spade', 2), JOKER]) === 100, '2 + 王 = 10（王当 8）');
  ok(E.tenHalfTotal([C('spade', 9), JOKER]) === 100, '9 + 王 = 10（王当 1）');
  ok(E.tenHalfDisplay([C('spade', 13), JOKER]) === '10.5点', '★ K + 王 显示 10.5点');
  ok(E.tenHalfDisplay([JOKER, JOKER]) === '10.5点', '双王（两张大王，只可能来自构造数据）当作 10.5，不崩');
}

console.log('\n[牌型] 十点半：爆牌与比大小');

{
  ok(E.tenHalfBust([C('spade', 10), C('heart', 14)]), '10 + A = 11 爆牌');
  ok(E.tenHalfBust([C('spade', 10), C('heart', 2)]), '10 + 2 = 12 爆牌');
  ok(!E.tenHalfBust([C('spade', 9), C('heart', 14)]), '9 + A = 10 不爆');
  ok(E.tenHalfDisplay([C('spade', 10), C('heart', 14)]) === '爆牌', '爆牌显示「爆牌」');

  /* 同为 10.5 且那张 10 同花色时，王当半点也压过 K（王的花色算最大）。 */
  ok(E.compareTenHalf([C('spade', 10), C('heart', 13)], [C('spade', 10), JOKER]) < 0,
    '★ 同为 10♠：10+王 赢 10+K（王比 10 大）');
  ok(E.compareTenHalf([C('spade', 9), C('heart', 14)], [C('club', 10), C('diamond', 2)]) > 0,
    '10 点赢爆牌');
  ok(E.compareTenHalf([C('spade', 10), JOKER], [C('heart', 9), C('heart', 14)]) > 0,
    '10.5 赢 10 点');
  ok(E.compareTenHalf([C('spade', 13), JOKER], [C('heart', 14), JOKER]) > 0,
    '★ K+王（10.5）赢 A+王（10）');
}

console.log('\n[牌型] 十点半：比较器代数性质（穷举抽样）');

{
  /* 反对称 + 传递。任何一条不成立，settleGroup 的赢家就会依赖玩家数组顺序。 */
  const deck = Card.createDeck();
  const hands = [];
  for (let i = 0; i < deck.length; i++) {
    for (let j = i + 1; j < deck.length; j++) hands.push([deck[i], deck[j]]);
  }

  let asym = 0;
  for (let k = 0; k < 200000; k++) {
    const a = hands[(Math.random() * hands.length) | 0];
    const b = hands[(Math.random() * hands.length) | 0];
    const ab = E.compareTenHalf(a, b);
    const ba = E.compareTenHalf(b, a);
    if (ab !== -ba) asym++;
  }
  ok(asym === 0, '20 万次随机对抗：比较结果严格反对称', asym + ' 次不对称');

  let trans = 0;
  for (let k = 0; k < 50000; k++) {
    const a = hands[(Math.random() * hands.length) | 0];
    const b = hands[(Math.random() * hands.length) | 0];
    const c = hands[(Math.random() * hands.length) | 0];
    const ab = E.compareTenHalf(a, b), bc = E.compareTenHalf(b, c), ac = E.compareTenHalf(a, c);
    if (ab > 0 && bc > 0 && !(ac > 0)) trans++;
  }
  ok(trans === 0, '5 万次随机三元组：比较结果满足传递性', trans + ' 次违反');
}

/* ==========================================================================
 * 四、飘三叶
 * ======================================================================== */
console.log('\n[牌型] 飘三叶');

{
  const T = E.PSY_TYPE;
  const cases = [
    { name: 'AAA 豹子', h: [C('spade', 14), C('heart', 14), C('club', 14)], type: T.LEOPARD },
    { name: '222 豹子', h: [C('spade', 2), C('heart', 2), C('club', 2)], type: T.LEOPARD },
    { name: '5♠6♠7♠ 同花顺', h: [C('spade', 5), C('spade', 6), C('spade', 7)], type: T.STRAIGHT_FLUSH },
    { name: 'A♠2♠3♠ 同花顺（A23）', h: [C('spade', 14), C('spade', 2), C('spade', 3)], type: T.STRAIGHT_FLUSH },
    { name: 'Q♠K♠A♠ 同花顺（A 最大）', h: [C('spade', 12), C('spade', 13), C('spade', 14)], type: T.STRAIGHT_FLUSH },
    { name: '2♠5♠9♠ 同花', h: [C('spade', 2), C('spade', 5), C('spade', 9)], type: T.FLUSH },
    { name: '5♠6♥7♦ 顺子', h: [C('spade', 5), C('heart', 6), C('diamond', 7)], type: T.STRAIGHT },
    { name: '9♠9♥K♦ 对子', h: [C('spade', 9), C('heart', 9), C('diamond', 13)], type: T.PAIR },
    { name: '2♠5♥9♦ 散牌', h: [C('spade', 2), C('heart', 5), C('diamond', 9)], type: T.HIGH }
  ];
  for (const c of cases) {
    const got = E.piaoSanYeType(c.h).type;
    ok(got === c.type, c.name + ' → ' + E.PSY_NAME[c.type], 'got ' + E.PSY_NAME[got]);
  }

  /* 牌型等级必须严格单调 */
  ok(T.LEOPARD > T.STRAIGHT_FLUSH && T.STRAIGHT_FLUSH > T.FLUSH &&
     T.FLUSH > T.STRAIGHT && T.STRAIGHT > T.PAIR && T.PAIR > T.HIGH,
    '等级序列 豹子 > 同花顺 > 同花 > 顺子 > 对子 > 散牌');

  /* A 的特殊性：A23 是最小顺子，QKA 是最大顺子 */
  ok(E.comparePiaoSanYe([C('spade', 4), C('heart', 5), C('diamond', 6)],
    [C('spade', 14), C('heart', 2), C('diamond', 3)]) > 0, '456 顺子大于 A23 顺子');
  ok(E.comparePiaoSanYe([C('spade', 12), C('heart', 13), C('diamond', 14)],
    [C('spade', 11), C('heart', 12), C('diamond', 13)]) > 0, 'QKA 顺子大于 JQK 顺子');

  /* 对子比大小：先比对子点数，再比单张 */
  ok(E.comparePiaoSanYe([C('spade', 9), C('heart', 9), C('diamond', 2)],
    [C('spade', 8), C('heart', 8), C('diamond', 14)]) > 0, '99 对子大于 88 对子（单张 A 也救不了）');

  /* 豹子比点数 */
  ok(E.comparePiaoSanYe([C('spade', 14), C('heart', 14), C('club', 14)],
    [C('spade', 13), C('heart', 13), C('club', 13)]) > 0, 'AAA 大于 KKK');
}

console.log('\n[牌型] 飘三叶：大王仍万能');

{
  const T = E.PSY_TYPE;
  ok(E.piaoSanYeType([JOKER, C('spade', 11), C('heart', 11)]).type === T.LEOPARD,
    '王 + J,J 凑成豹子');
  ok(E.piaoSanYeType([JOKER, C('spade', 11), C('spade', 12)]).type === T.STRAIGHT_FLUSH,
    '王 + J♠,Q♠ 凑成同花顺');
  ok(E.piaoSanYeType([JOKER, C('spade', 2), C('spade', 9)]).type === T.FLUSH,
    '王 + 2♠,9♠ 凑成同花');
  ok(E.piaoSanYeType([JOKER, C('spade', 5), C('heart', 7)]).type >= T.STRAIGHT,
    '王 + 5,7 至少能凑成顺子');
  ok(E.piaoSanYeTypeName([JOKER, C('spade', 11), C('heart', 11)]) === '豹子',
    '牌型名正确');
}

/* ==========================================================================
 * 五、斗牛
 * ======================================================================== */
console.log('\n[牌型] 斗牛：无王手牌');

{
  const cases = [
    { name: 'K,Q,J,K,Q 五花牛', h: [C('spade', 13), C('heart', 12), C('club', 11), C('diamond', 13), C('spade', 12)], type: 10, niu: null },
    { name: '5,5,5,5,10 牛牛', h: [C('spade', 5), C('heart', 5), C('club', 5), C('diamond', 5), C('spade', 10)], type: 9, niu: 0 },
    { name: '4,5 + K,Q,J 牛9', h: [C('spade', 4), C('heart', 5), C('club', 13), C('diamond', 12), C('spade', 11)], type: 8, niu: 9 },
    { name: '2,6 + K,Q,J 牛8', h: [C('spade', 2), C('heart', 6), C('club', 13), C('diamond', 12), C('spade', 11)], type: 7, niu: 8 },
    { name: '2,3 + K,Q,J 牛5', h: [C('spade', 2), C('heart', 3), C('club', 13), C('diamond', 12), C('spade', 11)], type: 4, niu: 5 },
    { name: '2,9 + K,Q,J 牛1', h: [C('spade', 2), C('heart', 9), C('club', 13), C('diamond', 12), C('spade', 11)], type: 0, niu: 1 },
    { name: '2,3,4,6,7 没牛', h: [C('spade', 2), C('heart', 3), C('club', 4), C('diamond', 6), C('spade', 7)], type: -1, niu: null }
  ];
  for (const c of cases) {
    const info = E.douNiuType(c.h);
    ok(info.type === c.type, c.name + ' → ' + c.name.split(' ')[1], 'got ' + info.name);
    ok(info.niu === c.niu, c.name + ' 的牛数正确', 'got ' + info.niu);
  }
}

console.log('\n[牌型] 斗牛：牛数必须等于总点数取模（独立校验）');

{
  /* 关键不变量：只要存在能凑 10 的三张，剩下两张的和 ≡ 五张总和 (mod 10)，
   * 所以「牛几」应该恒等于「总点数 % 10」，与选出哪三张无关。
   * 引擎只检查第一个合法三张组，这里用总和独立验证它没选错。 */
  const deck = Card.createDeck();
  const normal = deck.filter(function (c) { return !E.isJoker(c); });
  let checked = 0, bad = 0;

  for (let i = 0; i < normal.length; i++) {
    for (let j = i + 1; j < normal.length; j++) {
      for (let k = j + 1; k < normal.length; k++) {
        for (let m = k + 1; m < normal.length; m++) {
          for (let n = m + 1; n < normal.length; n++) {
            if (checked % 997 !== 0) { checked++; continue; }  // 抽样，避免跑太久
            checked++;
            const h = [normal[i], normal[j], normal[k], normal[m], normal[n]];
            const info = E.douNiuType(h);
            if (info.type < 0) continue;          // 没牛没有牛数
            if (info.type === 10) continue;        // 五花牛是特例，牛数记为 null
            const sum = h.reduce(function (s, c) { return s + E.douNiuPoint(c); }, 0);
            const expected = sum % 10;
            if (info.niu !== expected) bad++;
          }
        }
      }
    }
  }
  ok(checked > 2000, '抽到了足够多的样本（' + checked + ' 手）');
  ok(bad === 0, '有牛的手牌，牛数 = 总点数 % 10', bad + ' 手不符');
}

console.log('\n[牌型] 斗牛：五花牛边界');

{
  ok(E.douNiuType([C('spade', 11), C('heart', 12), C('club', 13), C('diamond', 11), C('spade', 12)]).type === 10,
    '五张真花牌是五花牛');
  ok(E.douNiuType([C('spade', 11), C('heart', 12), C('club', 13), C('diamond', 11), C('spade', 14)]).type !== 10,
    '四花 + A 不是五花牛（A 不算花牌）');
  ok(E.douNiuType([JOKER, C('spade', 11), C('heart', 12), C('club', 13), C('diamond', 11)]).type !== 10,
    '王 + 四张花牌不是五花牛');

  /* 五花牛必须是**五张**。
   * 旧实现只判「全花牌」不判张数，三张 JQK 也返回 type 10（收 4 分/人）。
   * 正常流程进不来（submitGroups 卡死 5 张），但这是靠上游保证的隐式契约，
   * 多一个「解析单组做预览」的调用方就会露出来。 */
  ok(E.douNiuType([C('spade', 11), C('heart', 12), C('club', 13)]).type !== 10,
    '★ 三张花牌不是五花牛（张数必须是 5）');
  ok(E.douNiuType([C('spade', 11), C('heart', 12), C('club', 13), C('diamond', 11)]).type !== 10,
    '★ 四张花牌不是五花牛');
  ok(E.douNiuInfo([C('spade', 11), C('heart', 12), C('club', 13)]).name !== '五花牛',
    '★ douNiuInfo 也不再把三张花牌报成「五花牛」');
}

console.log('\n[牌型] 斗牛：大王两处都能补');

{
  /* 用户 2026-10-29 截图：9♠ 9♦ 2♣ + 王 + 3♣
   * 9+9+2 = 20 已成交十 → 王留在剩两张里补 3♣，必成牛牛。
   * 以前一律让王去凑十，剩 9♠9♦ 得牛8。 */
  const h = [C('spade', 9), C('diamond', 9), C('club', 2), JOKER, C('club', 3)];
  ok(E.douNiuType(h).type === 9, '★ 三张真牌自己成十 → 王补剩两张，牛牛（不是牛8）',
    E.douNiuType(h).name);
  const dec = E.douNiuDecider(h);
  ok(dec && dec.rank === 9 && dec.suit === 'spade', '★ 决胜牌取除王最大的 9♠',
    dec ? dec.rank + '/' + dec.suit : 'null');
}

{
  const h = [JOKER, C('spade', 11), C('heart', 12), C('club', 13), C('diamond', 11)];
  const info = E.douNiuInfo(h);
  ok(info.type === 9, '王 + 四张花牌 = 牛牛');
  ok(info.compareCards.length === 4, '比牌材料 = 除王以外的 4 张', 'len=' + info.compareCards.length);
  ok(info.compareCards.every(function (c) { return !E.isJoker(c); }), '比牌材料不含王');

  ok(E.douNiuType([JOKER, C('spade', 2), C('heart', 8), C('club', 5), C('diamond', 6)]).type === 9,
    '王 + 2,8,5,6 能挑出最优三张组 → 牛牛');
  ok(E.douNiuType([JOKER, C('spade', 3), C('heart', 7), C('club', 13), C('diamond', 12)]).type === 9,
    '王 + 3,7 + K,Q → 剩 K,Q 得牛牛');

  /* 王手必然有牛：枚举所有「王 + 4 张非王牌」的组合抽样 */
  const deck = Card.createDeck();
  const normal = deck.filter(function (c) { return !E.isJoker(c); });
  let noCow = 0, tested = 0;
  for (let i = 0; i < normal.length; i++) {
    for (let j = i + 1; j < normal.length; j++) {
      for (let k = j + 1; k < normal.length; k++) {
        for (let m = k + 1; m < normal.length; m++) {
          if (tested % 131 !== 0) { tested++; continue; }
          tested++;
          if (E.douNiuType([JOKER, normal[i], normal[j], normal[k], normal[m]]).type < 0) noCow++;
        }
      }
    }
  }
  ok(noCow === 0, '王手永远不会没牛（抽样 ' + tested + ' 手）', noCow + ' 手没牛');
}

console.log('\n[牌型] 斗牛：同牛型比大小');

{
  /* 王手不能因为「王不算牌面」就被无王手无条件压死：
   * 同牛型比的是五张里最大的那张，王手取「除王以外最大的」。 */
  const jokerHand = [JOKER, C('spade', 11), C('heart', 12), C('club', 13), C('diamond', 11)];
  const lowHand = [C('heart', 5), C('diamond', 5), C('club', 10), C('diamond', 10), C('spade', 10)];
  ok(E.douNiuType(lowHand).type === 9, '构造的低牌手也是牛牛（5,5,10,10,10）');
  ok(E.compareDouNiu(jokerHand, lowHand) > 0, '同为牛牛：王手除王最大是 K♣，赢对手的 10♠');

  /* 反过来应该输，证明不是恒为真 */
  const strongHand = [C('spade', 13), C('heart', 13), C('club', 10), C('diamond', 10), C('spade', 10)];
  ok(E.douNiuType(strongHand).type === 9, '构造的高牌手也是牛牛（K,K,10,10,10）');
  ok(E.compareDouNiu(jokerHand, strongHand) < 0, '同为牛牛：K♣ 输给 K♠（同点比花色）');
}

/* ==========================================================================
 * 六、计分
 * ======================================================================== */
console.log('\n[计分] 每组「每人付几分」');

{
  ok(E.winPointsPerPlayer('tenhalf', [C('spade', 10), JOKER]) === CONFIG.TENHALF_MAX_WIN,
    '十点半正好 10.5 → 每人 ' + CONFIG.TENHALF_MAX_WIN + ' 分');
  ok(E.winPointsPerPlayer('tenhalf', [C('spade', 9), C('heart', 14)]) === CONFIG.TENHALF_WIN,
    '十点半 10 点 → 每人 ' + CONFIG.TENHALF_WIN + ' 分');
  ok(E.winPointsPerPlayer('single', [C('spade', 13)]) === CONFIG.SINGLE_WIN,
    '单张 → 每人 ' + CONFIG.SINGLE_WIN + ' 分');

  /* 飘三叶：豹子按场上豹子总数加成 */
  const leopard = [C('spade', 14), C('heart', 14), C('club', 14)];
  const high = [C('spade', 14), C('heart', 13), C('club', 2)];
  ok(E.winPointsPerPlayer('piaosanye', leopard, [{ id: 'a', hand: leopard }]) === 2,
    '场上 1 个豹子 → 每人 2 分');
  ok(E.winPointsPerPlayer('piaosanye', leopard, [
    { id: 'a', hand: leopard }, { id: 'b', hand: leopard }, { id: 'c', hand: leopard }
  ]) === 4, '场上 3 个豹子 → 每人 4 分');
  ok(E.winPointsPerPlayer('piaosanye', high, [{ id: 'a', hand: high }]) === 1,
    '非豹子赢 → 每人 1 分');

  ok(E.douNiuWinPoints([C('spade', 11), C('heart', 12), C('club', 13), C('diamond', 11), C('spade', 12)]) === 4,
    '五花牛 4 分');
  ok(E.douNiuWinPoints([C('spade', 5), C('heart', 5), C('club', 5), C('diamond', 5), C('spade', 10)]) === 3,
    '牛牛 3 分');
  ok(E.douNiuWinPoints([C('spade', 4), C('heart', 5), C('club', 13), C('diamond', 12), C('spade', 11)]) === 2,
    '牛9 2 分');
  ok(E.douNiuWinPoints([C('spade', 2), C('heart', 3), C('club', 13), C('diamond', 12), C('spade', 11)]) === 1,
    '牛5 1 分');
}

console.log('\n[计分] 结算：分数必须守恒');

{
  /**
   * @param {string} mode
   * @param {Array} entries
   */
  function checkConserve(mode, entries, label) {
    const r = E.settleGroup(mode, entries);
    const sum = Object.keys(r.deltas).reduce(function (s, k) { return s + r.deltas[k]; }, 0);
    ok(sum === 0, label + '：输赢总和为 0', 'sum=' + sum);
    const known = entries.some(function (e) { return e.id === r.winnerId; });
    ok(known, label + '：赢家必须来自参与者', 'winnerId=' + r.winnerId);
    const touched = entries.filter(function (e) { return e.id !== r.winnerId; });
    ok(touched.every(function (e) { return r.deltas[e.id] < 0; }), label + '：所有输家都在扣分');
    ok(r.deltas[r.winnerId] > 0, label + '：赢家在加分');
  }

  checkConserve('single', [
    { id: 'a', hand: [C('spade', 14)] },
    { id: 'b', hand: [C('heart', 2)] }
  ], '单张 2 人');

  checkConserve('single', [
    { id: 'a', hand: [C('spade', 14)] },
    { id: 'b', hand: [C('heart', 2)] },
    { id: 'c', hand: [C('club', 13)] },
    { id: 'd', hand: [C('diamond', 12)] }
  ], '单张 4 人');

  checkConserve('tenhalf', [
    { id: 'a', hand: [C('spade', 10), JOKER] },
    { id: 'b', hand: [C('heart', 9), C('club', 14)] },
    { id: 'c', hand: [C('diamond', 5), C('spade', 5)] }
  ], '十点半 3 人');

  checkConserve('piaosanye', [
    { id: 'a', hand: [C('spade', 14), C('heart', 14), C('club', 14)] },
    { id: 'b', hand: [C('spade', 13), C('heart', 13), C('club', 13)] },
    { id: 'c', hand: [C('spade', 2), C('heart', 5), C('club', 9)] }
  ], '飘三叶 3 人 2 豹');

  checkConserve('douniu', [
    { id: 'a', hand: [C('spade', 5), C('heart', 5), C('club', 5), C('diamond', 5), C('spade', 10)] },
    { id: 'b', hand: [C('spade', 2), C('heart', 3), C('club', 4), C('diamond', 6), C('spade', 7)] },
    { id: 'c', hand: [C('spade', 4), C('heart', 5), C('club', 13), C('diamond', 12), C('spade', 11)] }
  ], '斗牛 3 人（含没牛）');
}

console.log('\n[计分] 结算：具体分值');

{
  const r = E.settleGroup('tenhalf', [
    { id: 'a', hand: [C('spade', 10), JOKER] },
    { id: 'b', hand: [C('heart', 9), C('club', 14)] }
  ]);
  ok(r.winnerId === 'a', '10.5 赢 10 点');
  ok(r.winPoints === 2, '10.5 每人 2 分');
  ok(r.deltas.a === 2 && r.deltas.b === -2, '赢家 +2 / 输家 -2');
}
{
  const r = E.settleGroup('douniu', [
    { id: 'a', hand: [JOKER, C('spade', 11), C('heart', 12), C('club', 13), C('diamond', 11)] },
    { id: 'b', hand: [C('spade', 2), C('heart', 3), C('club', 4), C('diamond', 6), C('spade', 7)] }
  ]);
  ok(r.winnerId === 'a', '牛牛（王手）赢没牛');
  ok(r.winPoints === 3, '牛牛基础 3 分');
  ok(r.deltas.b === -8, '没牛者额外倒扣 5 分 → -8', 'deltas.b=' + r.deltas.b);
}
{
  const r = E.settleGroup('douniu', [
    { id: 'a', hand: [C('spade', 5), C('heart', 5), C('club', 5), C('diamond', 5), C('spade', 10)] },
    { id: 'b', hand: [C('spade', 4), C('heart', 5), C('club', 13), C('diamond', 12), C('spade', 11)] }
  ]);
  ok(r.deltas.b === -3, '两边都有牛时没有额外倒扣（牛牛 3 分）', 'deltas.b=' + r.deltas.b);
}
{
  const r = E.settleGroup('piaosanye', [
    { id: 'a', hand: [C('spade', 14), C('heart', 14), C('club', 14)] },
    { id: 'b', hand: [C('spade', 13), C('heart', 13), C('club', 13)] },
    { id: 'c', hand: [C('spade', 2), C('heart', 5), C('club', 9)] }
  ]);
  ok(r.winnerId === 'a', 'AAA 赢 KKK');
  ok(r.winPoints === 3, '场上 2 个豹子 → 每人 3 分', 'winPoints=' + r.winPoints);
  ok(r.deltas.a === 6 && r.deltas.b === -3 && r.deltas.c === -3, '赢家 +6（两人各付 3）');
}

console.log('\n[计分] 结算：边界与防御');

{
  /* 全部弃权：不结算，不抛错 */
  const r = E.settleGroup('single', [
    { id: 'a', hand: [] },
    { id: 'b', hand: [] }
  ]);
  ok(r.winPoints === 0, '全员弃权不结算（winPoints=0）');
  ok(Object.keys(r.deltas).every(function (k) { return r.deltas[k] === 0; }), '全员弃权不扣分');
}
{
  /* 有人空手牌：空手不能把真正赢家顶掉 */
  const r = E.settleGroup('single', [
    { id: 'a', hand: [] },
    { id: 'b', hand: [C('spade', 2)] }
  ]);
  ok(r.winnerId === 'b', '空手牌不会顶掉有牌的赢家');
}
{
  /* 未知玩法：必须抛错，不能静默返回 */
  let threw = false;
  try { E.settleGroup('unknown-mode', [{ id: 'a', hand: [] }]); } catch (e) { threw = true; }
  ok(threw, '未知玩法直接抛错（不静默返回错误结果）');
}
{
  const r = E.settleGroup('tenhalf', [
    { id: 'a', hand: [C('spade', 10), JOKER] },
    { id: 'b', hand: [C('heart', 9), C('club', 14)] }
  ]);
  ok(r.entries.length === 2, '结果里带每个参与者的牌型名');
  ok(r.winnerTypeName === '10.5点', '赢家牌型名正确', r.winnerTypeName);
}

console.log('\n[计分] 结算：随机对局守恒压力测试');

{
  const MODES = [
    { mode: 'single', size: 1 },
    { mode: 'tenhalf', size: 2 },
    { mode: 'piaosanye', size: 3 },
    { mode: 'douniu', size: 5 }
  ];
  let bad = 0, runs = 0;

  for (let t = 0; t < 600; t++) {
    const deck = Card.createDeck();
    Card.shuffle(deck);
    /* 取够 4 人需要的张数：1+2+3+5 = 11 张/轮，这里直接按人数切 */
    for (const spec of MODES) {
      const n = 2 + (t % 3);                    // 2~4 人
      const need = spec.size * n;
      if (need > deck.length) continue;
      const entries = [];
      for (let i = 0; i < n; i++) {
        entries.push({ id: 'p' + i, hand: deck.slice(i * spec.size, (i + 1) * spec.size) });
      }
      const r = E.settleGroup(spec.mode, entries);
      const sum = Object.keys(r.deltas).reduce(function (s, k) { return s + r.deltas[k]; }, 0);
      runs++;
      if (sum !== 0) bad++;
    }
  }
  ok(runs > 2000, '随机跑了 ' + runs + ' 局结算');
  ok(bad === 0, '所有随机对局分数守恒', bad + ' 局不守恒');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail === 0 ? 0 : 1);
