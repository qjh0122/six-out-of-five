/**
 * 牌型判定引擎（纯逻辑，无 DOM / 无 wx / 无 IO）
 *
 * 本文件同时被两处使用（**同一份代码，不复制**）：
 *  - 前端 pwa/（浏览器里作为全局 Engine，index.html 直接引这段）
 *  - 服务端 server/hub.js 与 Node 单测（module.exports）
 * 以前还有微信小游戏 src/ 与网页预览版 preview/ 两个使用方，那两个目录已经不在仓库里了。
 *
 * 规则遵循《六选五》策划文档 3.2 / 3.4 节，并按 v0.2 规则变更调整了大王的用法。
 *
 * 牌数据结构约定（与 card.js 一致）：
 *   card = { suit: 'joker', rank: 15 | 14.5 }        ← 大王 / 小王（都是万能牌）
 *   card = { suit: 'spade'|'heart'|'club'|'diamond', rank: 2..14 }
 *   rank: 11=J, 12=Q, 13=K, 14=A, 15=大王, 14.5=小王（suit 都是 'joker'）
 *   花色大小：黑桃(spade) > 红桃(heart) > 梅花(club) > 方片(diamond)；王无花色、最高
 *
 * ★ 大小王的共同点与唯一的区别（2026-11-12 加小王）：
 *   **功能完全一样** —— 四种玩法里都是万能牌，能替代任何真牌，双王也能同时当赖子。
 *   所以「这是不是万能牌」的判断一律只写 `isJoker()`（判 suit），**不要**去区分大小王，
 *   否则每加一个玩法就要记得处理两次。
 *   唯一需要区分的地方只有「王和王直接比大小」：单张（rank 15 > 14.5）、
 *   十点半同点数时比花色（王压真花色，大王压小王）。斗牛和飘三叶里
 *   **王根本不参与比大小**（斗牛比的是除王以外最大的那张；飘三叶比的是王替身后的牌），
 *   所以那两种玩法里「小王打不过大王」不生效 —— 用户 2026-11-12 明确的口径：
 *   「只有需要用王比大小的时候才由王决胜」。
 *
 * 注意（规则要点，v0.2 起）：
 *   - 单张比大小：大王 > 小王 > K > Q > J > 10 > … > 2 > A（A 当 1，最小）
 *   - 十点半：A=1、J/Q/K=0.5；**大王完全万能，可以当 10**；按点数比大小，
 *              同点数比「把点数做大的那张」（10.5 就比那张 10 的花色），
 *              **王比 10 大**：王撑出来的 10 压过任何真 10；
 *              赢家点数正好 10.5 收 2 分/人，否则 1 分/人
 *   - 飘三叶：A 保持最大（AAA 最大、QKA 最大顺子）；**大王仍是万能**；
 *              每个对手付 = 1 + 场上豹子总数（含赢家自己），非豹子赢恒为 1 分/人
 *   - 斗牛：J/Q/K=10、A=1；**大王既能去凑「三张成 10」，也能留在剩下两张里凑牛牛**——
 *              剩下的三张真牌自己就是 10 的倍数时，王补进那两张，必成牛牛；
 *              同牛型比**最大的那张**（王不参与，有大王就取除王以外最大的），
 *              一样再比花色；有大王不算五花牛
 */
(function (global, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  } else {
    global.Engine = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------- 花色与点数常量 ---------------------------- */
  var SUIT_ORDER = { spade: 4, heart: 3, club: 2, diamond: 1 };
  var SUIT_SYMBOL = { spade: '\u2660', heart: '\u2665', club: '\u2663', diamond: '\u2666' };
  var SUIT_CN = { spade: '黑桃', heart: '红桃', club: '梅花', diamond: '方片' };
  var RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  /* 两张王共用 suit='joker'，只靠 rank 分先后：15 = 大王、14.5 = 小王。
   * 14.5 必须严格夹在 A(14) 和 大王(15) 之间 —— 用 14 会和 A 撞点数，
   * 而 joker 不在 SUIT_ORDER 里（花色算 0），撞上之后小王反而比任何真牌都小。 */
  var JOKER = { suit: 'joker', rank: 15 };
  var SMALL_JOKER = { suit: 'joker', rank: 14.5 };

  /* 飘三叶大王万能枚举用：52 张具体牌（点数 2~14 × 4 花色） */
  var SUITS_ALL = ['spade', 'heart', 'club', 'diamond'];
  var ALL_CARDS = (function () {
    var list = [];
    for (var s = 0; s < SUITS_ALL.length; s++) {
      for (var r = 2; r <= 14; r++) list.push({ suit: SUITS_ALL[s], rank: r });
    }
    return list;
  })();

  /* ---------------------------- 可调数值（策划可改） ---------------------------- */
  var CONFIG = {
    INITIAL_SCORE: 0,             // 每人初始分数（基准 0，理由见 config.js 同名字段）
    SINGLE_WIN: 1,                // 单张比大小：赢家收每人分
    TENHALF_WIN: 1,               // 十点半：普通赢家收每人分
    TENHALF_MAX_WIN: 2,           // 十点半：赢家总点数正好 10.5（含王撑出来的）→ 收每人分
    PIAOSANYE_WIN: 1,             // 飘三叶：基础分（每个对手必付）
    PIAOSANYE_LEOPARD_BONUS: 1,   // 飘三叶：场上每有一个豹子（含赢家自己），每个对手额外多付的分
                                  // 每人付 = PIAOSANYE_WIN + PIAOSANYE_LEOPARD_BONUS × 场上豹子总数
                                  // 例：4 人局 3 个豹子 → 1 + 1×3 = 4 分/人，赢家总收 12
    DOUNIU_WIN_POINTS: {          // 斗牛：赢家牌型 -> 收每人分
      WUHUA: 4,                   // 五花牛
      NIUNIU: 3,                  // 牛牛（牛0）
      NIU89: 2,                   // 牛8 / 牛9
      NIU17: 1,                   // 牛1 ~ 牛7
      NONE: 1                     // 没牛（全没牛时赢家保底 1 分，见交付说明）
    },
    DOUNIU_NONE_PENALTY: 5        // 没牛者额外输给斗牛赢家的分数
  };

  function setConfig(cfg) {
    for (var k in cfg) {
      if (Object.prototype.hasOwnProperty.call(cfg, k)) {
        if (typeof cfg[k] === 'object' && cfg[k] !== null && typeof CONFIG[k] === 'object') {
          for (var k2 in cfg[k]) CONFIG[k][k2] = cfg[k][k2];
        } else {
          CONFIG[k] = cfg[k];
        }
      }
    }
  }

  /* ---------------------------- 基础工具 ---------------------------- */
  function isJoker(card) { return !!card && card.suit === 'joker'; }
  /* 大小王只在**两者互相比较**时才需要区分（单张比大小、十点半比花色）。
   * 判断「是不是万能牌 / 要不要解析成替身」一律用 isJoker —— 两条路走错一边，
   * 就会变成「小王能凑牌型但不算王」这种半残状态，而那种 bug 只在拿到小王时才出现。 */
  function isBigJoker(card) { return isJoker(card) && card.rank >= JOKER.rank; }
  function isSmallJoker(card) { return isJoker(card) && card.rank < JOKER.rank; }
  function hasJoker(hand) {
    for (var i = 0; i < hand.length; i++) if (isJoker(hand[i])) return true;
    return false;
  }
  /* 手上有几张王（0~2）。只有斗牛需要问「是不是双王」——
   * 两张王同时在手时那边恒为牛牛，不必逐张试。 */
  function jokerCount(hand) {
    var n = 0;
    for (var i = 0; i < hand.length; i++) if (isJoker(hand[i])) n++;
    return n;
  }
  function containsJoker(hand) { return hasJoker(hand); }
  function replaceJoker(hand, card) {
    return hand.map(function (x) { return isJoker(x) ? card : x; });
  }

  function rankLabel(rank) { return RANK_LABEL[rank] || String(rank); }
  function suitSymbol(suit) { return SUIT_SYMBOL[suit] || '?'; }
  function cardLabel(card) {
    if (!card) return '—';
    if (isJoker(card)) return card.rank >= JOKER.rank ? '大王' : '小王';
    return rankLabel(card.rank) + suitSymbol(card.suit);
  }
  function suitRank(suit) { return SUIT_ORDER[suit] || 0; }

  /* 单张比大小点数：大王(15) > 小王(14.5) > K > Q > J > 10 > … > 2 > A(1 最小)
   *
   * 王直接返回自己的 rank（15 / 14.5）—— 「小王打不过大王」在这一行就成立了，
   * 不需要额外分支，也不会因为「只加了一种王」而在某处漏判。 */
  function singleRank(card) {
    if (!card) return -1;          // 空/异常入参：按“最小”处理，避免 undefined 静默比平
    if (isJoker(card)) return card.rank;
    if (card.rank === 14) return 1; // A 当 1
    return card.rank;
  }

  /* 高牌点数（用于同点/同型 tie-break 的“最大单张”）：大王 > 小王 > A(14) */
  function highRank(card) {
    if (isJoker(card)) return card.rank;
    return card.rank; // 2..14
  }

  /* 取单张：兼容「牌对象」与「手牌数组」两种入参 */
  function firstCard(x) {
    if (Array.isArray(x)) return x[0] || null;
    return x || null;
  }

  /* 单张比大小比较器：返回 -1/0/1
   * 统一入参契约：既可传单张牌对象，也可传手牌数组（settleGroup 传的是数组）。
   * 这样 COMPARATOR 里 4 个比较器的签名一致，不会再出现“数组被当成牌对象”的静默平局。 */
  function compareSingle(a, b) {
    var ca = firstCard(a), cb = firstCard(b);
    if (!ca && !cb) return 0;
    if (!ca) return -1;
    if (!cb) return 1;
    var ra = singleRank(ca), rb = singleRank(cb);
    if (ra !== rb) return ra < rb ? -1 : 1;
    var sa = suitRank(ca.suit), sb = suitRank(cb.suit);
    if (sa === sb) return 0;
    return sa < sb ? -1 : 1;
  }

  /* 高牌比较器（tie-break 用）：大王最高，A 最大 14 */
  function compareHighCard(a, b) {
    var ra = highRank(a), rb = highRank(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    var sa = suitRank(a.suit), sb = suitRank(b.suit);
    if (sa === sb) return 0;
    return sa < sb ? -1 : 1;
  }

  function sortDesc(hand) {
    return hand.slice().sort(function (a, b) { return compareHighCard(b, a); });
  }

  /* 逐张按“最大单张点数 → 花色”比较（用于同点/同型 tie-break） */
  function compareHighCards(a, b) {
    var sa = sortDesc(a), sb = sortDesc(b);
    var n = Math.max(sa.length, sb.length);
    for (var i = 0; i < n; i++) {
      if (i >= sa.length) return -1;
      if (i >= sb.length) return 1;
      var c = compareHighCard(sa[i], sb[i]);
      if (c !== 0) return c;
    }
    return 0;
  }

  /* 注：原来还有一个 compareHighCardsPrefix（A=14 版本的「比少的张数」），
   * 已随斗牛同型比大小改成 compareDouNiuCards 一起删除 —— 那里必须 A=1 才是对的。 */

  /* ---------------------------- B. 十点半（2 张） ---------------------------- */
  /* 用“十分之一”整数避免浮点误差：10.5 点 = 105 十分之一 */
  /* 单张点数（十分之一）：A=1、J/Q/K=0.5、2~10 按面值。
   * 王不在这张表里算 —— 它充当哪张牌由 resolveTenHalf() 决定，见 tenHalfTenths。 */
  function tenthsOfRank(rank) {
    if (rank === 14) return 10;      // A = 1 点
    if (rank >= 11) return 5;        // J/Q/K = 0.5 点
    return rank * 10;                // 2~10 按面值
  }

  /* 单张点数：真牌走 tenthsOfRank；未解析的王兜底按半点计。 */
  function tenHalfTenths(card) {
    if (isJoker(card)) return 5;     // 兜底：真实取值见 resolveTenHalf
    return tenthsOfRank(card.rank);
  }

  /* 手牌总点（十分之一）：大王已按固定 0.5 计入，无需再解析 */
  function tenHalfTotalResolved(hand) {
    var s = 0;
    for (var i = 0; i < hand.length; i++) s += tenHalfTenths(hand[i]);
    return s;
  }
  function tenHalfBustResolved(hand) { return tenHalfTotalResolved(hand) > 105; }

  /* 王牌在比牌里的花色：**比任何真花色都大**。
   *
   * 规则来源（用户 2026-10-29 确认，群里「十点半 是最大的 10 / 十点半不比半点，比 10 / 王比 10 大」）：
   *   十点半之间不比那张半点牌，比的是**把点数做到 10 的那张 10**；而王比 10 大。
   * 所以王不论撑的是 10 还是半点，比花色时都算最大。
   * 单独用常量而不是塞进 SUIT_ORDER —— 那个表被单张/飘三叶/斗牛共用，
   * 把王塞进去会连带改掉那三种玩法。
   *
   * ★ 两张王分两档（2026-11-12）：真花色最大是黑桃 4，所以小王 5、大王 6。
   *   这是「小王打不过大王」在十点半里**唯一**的落点 —— 两家都是 10.5、
   *   都是王撑出来的那张 10 时，谁的王大谁赢。十点半的王要参与比花色，
   *   所以这里必须分；而斗牛/飘三叶的王不参与比大小，那边就不该分（见 compareDouNiu / resolvePiaoSanYe）。 */
  var JOKER_SUIT_RANK = 5;          // 小王（也压任何真花色）
  var BIG_JOKER_SUIT_RANK = 6;      // 大王
  function tenHalfSuitRank(card) {
    if (!card) return 0;
    if (isJoker(card)) {
      /* 入参常常是**替身**（suit='joker'、rank 已换成 10 之类），
       * 所以大小王要靠替身带过来的 jk 字段认，看 rank 会把大王认成小王。 */
      return card.jk >= JOKER.rank ? BIG_JOKER_SUIT_RANK : JOKER_SUIT_RANK;
    }
    return suitRank(card.suit);
  }

  /* 同点数时的比牌材料：**保留王**，但把王换成「它解析后充当的那张牌」。
   *
   * 旧实现是把王整张摘掉，注释理由是「王只当半点，不该凭身份占便宜」。
   * 那条在旧规则下自洽，但新规则要求「王比 10 大」，于是会出反效果：
   *   「10♠ + 王」摘掉王只剩 1 张，牌少判负 → 输给「10♠ + K♣」，
   *   跟「王比 10 大」正好相反（实测过）。
   * 现在改成：点数按解析结果算（王当 10 就按 10 点），花色按最大算。
   * jk 留着原始 rank（15 / 14.5），花色档位靠它分大小王。 */
  function tenHalfSideCards(hand, resolved) {
    var r = resolved || resolveTenHalf(hand);
    var out = [];
    for (var i = 0; i < hand.length; i++) {
      out.push(isJoker(hand[i]) ? { suit: 'joker', rank: r[i].rank, jk: hand[i].rank } : hand[i]);
    }
    return out;
  }
  /* 同点数时单张之间怎么比：**先比它对点数的贡献，再比花色**。
   *
   * 这里踩过一次真实的坑：旧实现排序用的是牌面点数（highRank），于是 J/Q/K 按 11/12/13 排，
   * 比的是「那张半点牌」而不是「那张 10」。用户截图里的两手 10.5：
   *   机4 = Q♦ + 10♥     机5 = 10♦ + Q♣
   * 旧规则拿 Q♦(12) 和 Q♣(12) 比 → 梅花赢 → 判机5 赢，跟「比那张 10」完全无关。
   * 正确规则（用户确认）：都是 10.5 时，比的是那张 **10** 的花色；
   * 推广到其它同点数（如 8 点：7+A vs 4+4），比的是把点数做大的那张（7 > 4），
   * 而不是 A 最高——十点半是点数玩法，A 就是 1 点。
   *
   * 留意：入参可能是「王的替身」（suit='joker'，rank 是解析后的点数），
   * 所以点数一律走 tenthsOfRank(rank)，不能走 tenHalfTenths（那会把王拍成 0.5）。 */
  function compareTenHalfCard(a, b) {
    var ta = tenthsOfRank(a.rank), tb = tenthsOfRank(b.rank);
    if (ta !== tb) return ta < tb ? -1 : 1;
    var sa = tenHalfSuitRank(a), sb = tenHalfSuitRank(b);
    if (sa === sb) return 0;
    return sa < sb ? -1 : 1;
  }
  /* resolvedA / resolvedB 由调用方传进来：compareTenHalf 已经解析过一次，
   * 这里再解析一遍纯属浪费（每次解析要枚举 48 张候选牌）。 */
  function compareTenHalfSide(a, b, resolvedA, resolvedB) {
    var sa = tenHalfSideCards(a, resolvedA).sort(function (x, y) { return compareTenHalfCard(y, x); });
    var sb = tenHalfSideCards(b, resolvedB).sort(function (x, y) { return compareTenHalfCard(y, x); });
    var n = Math.min(sa.length, sb.length);
    for (var i = 0; i < n; i++) {
      var c = compareTenHalfCard(sa[i], sb[i]);
      if (c !== 0) return c;
    }
    if (sa.length !== sb.length) return sa.length < sb.length ? -1 : 1;
    return 0;
  }

  /* 同点数时的「决胜牌」：贡献点数最大的那张（10.5 就是那张 10），同贡献取花色大的。
   * 只用于结算面板上告诉玩家「你输在哪张牌上」。 */
  function tenHalfDecider(hand) {
    if (!hand || !hand.length) return null;
    var resolved = resolveTenHalf(hand);
    var side = tenHalfSideCards(hand, resolved);
    if (!side.length) return null;
    var best = side[0];
    for (var i = 1; i < side.length; i++) {
      if (compareTenHalfCard(side[i], best) > 0) best = side[i];
    }
    return best;
  }

  /* 大王在十点半里完全万能：0.5（J/Q/K）、1（A）、2~10 全部可当，自动取最优。
   * **曾经把 10 排除在外**（「唯一不能当的是 10」，于是「王 + K」最高只到 9.5），
   * 用户 2026-10-29 更正规则后放开：「王比 10 大」，王 + K 就是十点半。
   * 保留这个枚举（而不是直接用 ALL_CARDS）是为了让「王能当什么」在这里一眼可查。 */
  var JOKER_TENHALF_CARDS = (function () {
    var list = [];
    for (var s = 0; s < SUITS_ALL.length; s++) {
      for (var r = 2; r <= 14; r++) {
        list.push({ suit: SUITS_ALL[s], rank: r });
      }
    }
    return list;
  })();

  /* 解析选择器：不爆优先，其次点数大者优；双爆时爆得少者优 */
  function tenHalfResolvedBetter(a, b) {
    var ta = tenHalfTotalResolved(a), tb = tenHalfTotalResolved(b);
    var ba = ta > 105, bb = tb > 105;
    if (ba !== bb) return !ba;
    if (ba) return ta < tb;
    return ta > tb;
  }

  /* 王万能（含 10，见上面 JOKER_TENHALF_CARDS 的口径变迁）：枚举王可充当的点数，取最优解析。
   *
   * ★ 大小王同时在一个人手里时，**两张必须分别替换**（2026-11-12）。
   *   `replaceJoker()` 会把所有王换成同一张牌 —— 只适合「一张王」和飘三叶
   *   （那边凑豹子要的正是三张同点，统一替换恰好是正解）。但十点半是**点数相加**：
   *   「9 + 大王 + 小王」统一替换成 A 得 9+1+1 = 11 爆，正确解是一张当 A(1)、
   *   一张当 K(0.5) = 10.5。所以这里退化成两两组合的枚举。
   *
   *   枚举空间用「按点数去重后的候选」（13 种而非 52 张）：双王只看总点数，
   *   王的花色档位由 jk 决定、与替成哪张牌无关，所以同一 rank 的四个花色等价。
   *   169 次替代 + 每次 6 张求和，比 2704 次省一个数量级，结果完全一致。
   *   每人最多 6 张牌、全副牌也只有两张王，所以分支最多到两张。 */
  var JOKER_TENHALF_POINTS = (function () {
    var seen = {}, out = [];
    for (var i = 0; i < JOKER_TENHALF_CARDS.length; i++) {
      var r = JOKER_TENHALF_CARDS[i].rank;
      if (seen[r]) continue;
      seen[r] = 1;
      out.push(JOKER_TENHALF_CARDS[i]);
    }
    return out;
  })();

  function resolveTenHalf(hand) {
    if (!hasJoker(hand)) return hand;
    var idx = [];
    for (var i = 0; i < hand.length; i++) if (isJoker(hand[i])) idx.push(i);

    if (idx.length === 1) {
      var best = null;
      for (var j = 0; j < JOKER_TENHALF_CARDS.length; j++) {
        var h = replaceJoker(hand, JOKER_TENHALF_CARDS[j]);
        if (best === null || tenHalfResolvedBetter(h, best)) best = h;
      }
      return best;
    }

    /* 双王（大小王各一张）：两张各自选点数，取总点数最优的组合 */
    var best2 = null;
    for (var a = 0; a < JOKER_TENHALF_POINTS.length; a++) {
      for (var b = 0; b < JOKER_TENHALF_POINTS.length; b++) {
        var h2 = hand.slice();
        h2[idx[0]] = JOKER_TENHALF_POINTS[a];
        h2[idx[1]] = JOKER_TENHALF_POINTS[b];
        if (best2 === null || tenHalfResolvedBetter(h2, best2)) best2 = h2;
      }
    }
    return best2;
  }

  /* 手牌比较：未爆 > 爆；都不爆比点数（10.5 最大）；同点数比「把点数做大的那些牌」。
   * 注意：同点数这一步必须拿**原始手牌**比（保留王的身份），
   * 否则王已经被替换成具体花色，"王算最大花色"就失效了。 */
  function compareTenHalf(a, b) {
    var ra = resolveTenHalf(a), rb = resolveTenHalf(b);
    var ba = tenHalfBustResolved(ra), bb = tenHalfBustResolved(rb);
    if (ba && !bb) return -1;
    if (!ba && bb) return 1;
    if (ba && bb) {
      /* 双爆：**爆得少者优**——这是十点半的通行口径，也和上面
       * tenHalfResolvedBetter() 的注释一致。以前这里直接比单张大小，
       * 于是 9+9（18 点）反而赢 8+8（16 点），和同文件的解析口径打架。
       * 十点半组正好 2 张牌，任意两张点数和超 10.5 就爆，所以这条分支
       * 是**经常走到**的，不是「2 张牌下不可达」。 */
      var ta = tenHalfTotalResolved(ra), tb = tenHalfTotalResolved(rb);
      if (ta !== tb) return ta < tb ? 1 : -1;
      return compareTenHalfSide(a, b, ra, rb);   // 爆得一样多：比谁的点数来源更硬
    }
    var t1 = tenHalfTotalResolved(ra), t2 = tenHalfTotalResolved(rb);
    if (t1 !== t2) return t1 < t2 ? -1 : 1;
    return compareTenHalfSide(a, b, ra, rb);     // 同点数：比那张把点数做大的牌
  }

  function tenHalfTotal(hand) { return tenHalfTotalResolved(resolveTenHalf(hand)); }
  function tenHalfBust(hand) { return tenHalfBustResolved(resolveTenHalf(hand)); }
  function tenHalfDisplay(hand) {
    var r = resolveTenHalf(hand);
    if (tenHalfBustResolved(r)) return '爆牌';
    return (tenHalfTotalResolved(r) / 10).toFixed(1).replace(/\.0$/, '') + '点';
  }

  /* ---------------------------- C. 飘三叶 / 炸金花（3 张，大王万能） ---------------------------- */
  /* 牌型：豹子(6) > 同花顺(5) > 同花(4) > 顺子(3) > 对子(2) > 散牌(1) */
  var PSY_TYPE = { LEOPARD: 6, STRAIGHT_FLUSH: 5, FLUSH: 4, STRAIGHT: 3, PAIR: 2, HIGH: 1 };
  var PSY_NAME = { 6: '豹子', 5: '同花顺', 4: '同花', 3: '顺子', 2: '对子', 1: '散牌' };

  function straightInfo(ranks) {
    if (ranks[0] === 14 && ranks[1] === 3 && ranks[2] === 2) return { high: 3 }; // A23
    if (ranks[0] === ranks[1] + 1 && ranks[1] === ranks[2] + 1) return { high: ranks[0] };
    return null;
  }

  /* 不含大王的飘三叶牌型判定 */
  function piaoSanYeTypeResolved(hand) {
    var ranks = hand.map(function (c) { return c.rank; }).sort(function (a, b) { return b - a; });
    var s0 = hand[0].suit, s1 = hand[1].suit, s2 = hand[2].suit;
    var isFlush = (s0 === s1 && s1 === s2);
    var isTrips = (ranks[0] === ranks[1] && ranks[1] === ranks[2]);
    var straight = straightInfo(ranks);

    if (isTrips) return { type: PSY_TYPE.LEOPARD, trips: ranks[0] };
    if (isFlush && straight) return { type: PSY_TYPE.STRAIGHT_FLUSH, high: straight.high };
    if (isFlush) return { type: PSY_TYPE.FLUSH };
    if (straight) return { type: PSY_TYPE.STRAIGHT, high: straight.high };
    if (ranks[0] === ranks[1]) return { type: PSY_TYPE.PAIR, pair: ranks[0], kicker: ranks[2] };
    if (ranks[1] === ranks[2]) return { type: PSY_TYPE.PAIR, pair: ranks[1], kicker: ranks[0] };
    return { type: PSY_TYPE.HIGH };
  }

  function comparePiaoSanYeResolved(a, b) {
    var ta = piaoSanYeTypeResolved(a), tb = piaoSanYeTypeResolved(b);
    if (ta.type !== tb.type) return ta.type < tb.type ? -1 : 1;
    switch (ta.type) {
      case PSY_TYPE.LEOPARD:
        if (ta.trips !== tb.trips) return ta.trips < tb.trips ? -1 : 1;
        /* 同一副牌里不可能出现两手同点豹子（要 6 张同点数），
         * 但比较器必须自成全序 —— 落到下面的兜底，别留下一个 return 0。 */
        return compareHighCards(a, b);
      case PSY_TYPE.STRAIGHT_FLUSH:
      case PSY_TYPE.STRAIGHT:
        if (ta.high !== tb.high) return ta.high < tb.high ? -1 : 1;
        /* 同 high 必须回落比牌，不能 return 0。
         * 旧实现直接 return 0，而 settleGroup 只按 `> 0` 换赢家、candidates[0] 是入房顺序
         * → 「平局」等于「先进房的人赢」：4♦5♦6♦ 会赢 4♠5♠6♠（牌面看着一样大，输家无从理解）。
         * 同花 / 散牌 / 对子都做了完整比较，这里漏了一处。口径统一走 compareHighCards（逐张比花色）。 */
        return compareHighCards(a, b);
      case PSY_TYPE.PAIR:
        if (ta.pair !== tb.pair) return ta.pair < tb.pair ? -1 : 1;
        if (ta.kicker !== tb.kicker) return ta.kicker < tb.kicker ? -1 : 1;
        /* 对子点数与踢脚都一样（如 3♥3♦7♣ vs 3♠3♣7♥）同样要比花色。
         * 这是同一个 bug 的另一处：漏了它，「平局」又变回「谁先进房谁赢」，
         * 而随机抽样 4 万对里能撞出十几次 —— 真实牌局里一点都不罕见。 */
        return compareHighCards(a, b);
      case PSY_TYPE.FLUSH:
      case PSY_TYPE.HIGH:
      default:
        return compareHighCards(a, b);
    }
  }

  /* 大王万能：枚举替代为 52 张具体牌，取最大牌型 */
  function resolvePiaoSanYe(hand) {
    if (!hasJoker(hand)) return hand;
    var best = null;
    for (var i = 0; i < ALL_CARDS.length; i++) {
      var h = replaceJoker(hand, ALL_CARDS[i]);
      if (best === null || comparePiaoSanYeResolved(h, best) > 0) best = h;
    }
    return best;
  }

  /* 一手牌里最大的王等级：0 = 没有王，1 = 有小王，2 = 有大王。
   * 只在「牌型与牌力完全相同时」用来决胜（见 comparePiaoSanYe）。 */
  function jokerLevelOf(hand) {
    var lv = 0;
    if (!hand) return lv;
    for (var i = 0; i < hand.length; i++) {
      if (!isJoker(hand[i])) continue;
      var l = isBigJoker(hand[i]) ? 2 : 1;
      if (l > lv) lv = l;
    }
    return lv;
  }

  function piaoSanYeType(hand) { return piaoSanYeTypeResolved(resolvePiaoSanYe(hand)); }
  function piaoSanYeTypeName(hand) { return PSY_NAME[piaoSanYeType(hand).type]; }
  function comparePiaoSanYe(a, b) {
    var c = comparePiaoSanYeResolved(resolvePiaoSanYe(a), resolvePiaoSanYe(b));
    if (c !== 0) return c;
    /* ★ 牌型 + 点数 + 花色全平之后，才轮到王（用户 2026-11-12 明确要求：
     *   「飘三叶也需要看王大小，比如大王加俩7的豹子比小王加俩7的豹子大」）。
     *
     *   为什么必须放在最后而不是跟牌型一起比：飘三叶的王是**替身**，
     *   一旦参与前面的比较，「王 + 7♠7♦」就不再是「7 的豹子」而是「王压一切」，
     *   连豹子比豹子的点数规则都会被架空。放在最后，只有「替完身还完全一样」才由王说话 ——
     *   而那种情形本来只能在两家都有王、或王的替身恰好补成对方那张牌时出现。
     *
     *   大小：大王 > 小王 > 无王。王比任何真牌大，所以「小王 + 7♠7♦」的豹子
     *   压过「真 7♠7♦7♣」的豹子 —— 这与十点半「王比 10 大」是同一个口径，
     *   而不是「只有两家都有王时才比」。
     *
   *   斗牛不套用这条：那边的王不参与比大小（用户同一天强调「都是牛牛就用 10JQK 比」），
   *   而且那边**平局在单副牌里不可达**（同型比到花色就已分胜负），见 compareDouNiuHands 的注释。 */
    var la = jokerLevelOf(a), lb = jokerLevelOf(b);
    return la === lb ? 0 : (la < lb ? -1 : 1);
  }

  /* ---------------------------- D. 斗牛（5 张） ---------------------------- */
  /* 牌型等级：五花牛(10) > 牛牛(9) > 牛9(8) > 牛8(7) > … > 牛1(0) > 没牛(-1) */
  function douNiuPoint(card) {
    if (card.rank >= 11 && card.rank <= 13) return 10; // J/Q/K
    if (card.rank === 14) return 1;                    // A
    return card.rank;                                   // 2~10
  }

  function douNiuNiuOf(sum) {
    var niu = sum % 10;
    return { niu: niu, type: niu === 0 ? 9 : niu - 1, name: niu === 0 ? '牛牛' : '牛' + niu };
  }

  /* 斗牛的单张比牌点数：**K 最大、A = 1 最小**（「从 K 到 1」）。
   * 不能复用 highRank（那里 A=14 最大）——斗牛里 A 就是 1 点，
   * 否则「A + 8 + 6 + 4 + A」这种只剩 8 的牛牛会凭空靠 A 压过 K，
   * 正是用户截图里「KQ 的牛牛输给 A86 4A 的牛牛」的直接原因。 */
  function douNiuCompareRank(card) {
    if (!card) return -1;
    if (card.rank === 14) return 1;
    return card.rank;            // 2..13：K 最大
  }
  function compareDouNiuCard(a, b) {
    var ra = douNiuCompareRank(a), rb = douNiuCompareRank(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    var sa = suitRank(a.suit), sb = suitRank(b.suit);
    if (sa === sb) return 0;
    return sa < sb ? -1 : 1;
  }
  /* 按「最大牌 → 次大牌 → … → 花色」逐张比；两侧张数不同时按少的比（比完即平） */
  function compareDouNiuCards(a, b) {
    var sa = a.slice().sort(function (x, y) { return compareDouNiuCard(y, x); });
    var sb = b.slice().sort(function (x, y) { return compareDouNiuCard(y, x); });
    var n = Math.min(sa.length, sb.length);
    for (var i = 0; i < n; i++) {
      var c = compareDouNiuCard(sa[i], sb[i]);
      if (c !== 0) return c;
    }
    return 0;
  }

  /* 同牛型比大小的**比牌材料**：除大王以外的全部手牌。
   *
   * 用户 2026-10 澄清（上一版按「只比剩两张」做，是错的）：
   *   牛型相同时比的是**五张里最大的那张**，点数一样再比花色（K > … > 2 > A，A 只算 1）。
   *   有大王的牌，王本身不参与比大小，取「除王以外最大的那张」——
   *   否则「王 + Q 10 3 2」会靠王的 rank 15 白压过别人的 K，跟「王只当凑十工具」矛盾。
   * 所以这里返回「去掉王的手牌」，排序与逐张比较交给 compareDouNiuCards。 */
  function douNiuSideCards(hand) {
    var out = [];
    for (var i = 0; i < hand.length; i++) if (!isJoker(hand[i])) out.push(hand[i]);
    return out;
  }

  /* 「这堆牌里能不能挑出 3 张，点数和是 10 的倍数」。
   * 抽成公共函数是因为两处都要用：
   *   ① 无王手牌 → 判「有没有牛」；
   *   ② 含王手牌 → 判「三张真牌能不能自己成十」，也就是王能不能不去凑那三张。 */
  function douNiuHasThreeTens(cards) {
    if (!cards || cards.length < 3) return false;
    var pts = [];
    for (var i = 0; i < cards.length; i++) pts.push(douNiuPoint(cards[i]));
    for (var a = 0; a < pts.length - 2; a++) {
      for (var b = a + 1; b < pts.length - 1; b++) {
        for (var c = b + 1; c < pts.length; c++) {
          if ((pts[a] + pts[b] + pts[c]) % 10 === 0) return true;
        }
      }
    }
    return false;
  }

  /* 不含大王：三张凑 10 的倍数，剩两张定牛型；五张全花牌 = 五花牛 */
  function douNiuInfoResolved(hand) {
    /* 「五花牛」= **五张**全是 J/Q/K。
     * 以前只判了「全花牌」、没判张数，于是三张 JQK 传进来也算五花牛（type 10，收 4 分/人）。
     * 正常流程进不来（submitGroups 卡死 5 张），但这是一条纯靠上游保证的隐式契约 ——
     * 一旦哪天多出一个「解析单组用于预览」的调用方，就会拿三张牌判出个五花牛来。
     * 一行代价，把契约变成本函数的自证。 */
    var allCourt = hand.length === 5;
    for (var i = 0; i < hand.length; i++) {
      if (!(hand[i].rank >= 11 && hand[i].rank <= 13)) { allCourt = false; break; }
    }
    if (allCourt) return { type: 10, niu: null, name: '五花牛', compareCards: hand };

    var total = 0;
    for (var p = 0; p < hand.length; p++) total += douNiuPoint(hand[p]);

    /* 「有没有牛」= 能不能挑出三张凑成 10 的倍数。
     * 只要存在这样一组，剩下两张的和 ≡ 总和 (mod 10)，所以**牛几由总点数决定**，
     * 与选哪三张无关 —— 于是这里只判断「存在」，不必枚举分组挑「剩两张最强」的那组
     * （同型比大小已经改成看五张里最大的牌，分组结果不影响胜负）。 */
    var hasCow = douNiuHasThreeTens(hand);

    var info = hasCow ? douNiuNiuOf(total % 10)
      : { type: -1, niu: null, name: '没牛' };
    info.compareCards = hand;      // 同型比大小：五张里最大的那张（无王，无需剔除）
    return info;
  }

  /* 含大王：
   *
   * 用户 2026-10-29 更正（原实现只做了第 ② 条，把第 ① 条漏了）：
   *   ① 王**可以不**去凑那三张 —— 剩下的 3 张真牌自己就是 10 的倍数时，
   *      王留在另外两张里，可以补成任意点数，于是那两张必然凑成 10 的倍数 = **牛牛**。
   *      截图里的 9♠ 9♦ 2♣ + 王 + 3♣：9+9+2 = 20 已经成十，王当 7 配 3♣ → 牛牛。
   *      以前一律让王去凑十，于是剩 9♠9♦ 得牛8，把玩家的牛牛算没了。
   *   ② 否则王必须去凑「三张成 10」那一组，剩下两张不含王的牌定牛型。
   *
   * 王可充当任意 1~10 点，所以这两条路都走得通，取对玩家最有利的（① 恒为牛牛，
   * 因此只要 ① 成立就直接返回，不必再算 ②）。
   * 有大王的手牌**不算五花牛**（五花牛要求五张都是真花牌，王 + 四张花牌判成牛牛）。
   * 但**同型比大小时王不参与**：比牌材料是除王以外的牌，取其中最大的那张
   * （用户明确要求「不能拿王比大小」）。 */
  function douNiuInfoJoker(hand) {
    var others = douNiuSideCards(hand);
    if (others.length < 3) return { type: -1, niu: null, name: '没牛', compareCards: others };

    /* ★ 大小王同时在手：**恒为牛牛**（2026-11-12）。
     *
     * 为什么不用枚举验证：5 张里 2 王 + 3 张真牌。取「2 王 + 1 张真牌 p」这组去凑十 ——
     * 两张王各能当 0.5 / 1 / 2~10，其和可覆盖 1~20 之间的任意 0.5 倍数，
     * 所以总能取到 x+y 使 (x + y + p) 是 10 的倍数。剩下两张是「1 张真牌 + 1 张王」，
     * 王补成任意点数即可让这两张也成 10 的倍数 —— 那就是牛牛。
     * 也就是说双王下**真牌是什么都不影响结果**，写死在 9 档不是偷懒，是结论本身。
     *
     * 比牌材料仍然剔除王（王不参与比大小，与单王口径一致）：
     * 双王手只剩 3 张真牌，逐张比时按少的张数比。 */
    if (jokerCount(hand) >= 2) {
      var nn = douNiuNiuOf(0);          // { niu: 0, type: 9, name: '牛牛' }
      nn.compareCards = others;
      return nn;
    }

    /* ① 三张真牌自己成十 → 王去补剩下的那张，牛牛。 */
    if (douNiuHasThreeTens(others)) {
      var niuniu = douNiuNiuOf(0);          // { niu: 0, type: 9, name: '牛牛' }
      niuniu.compareCards = others;
      return niuniu;
    }

    /* ② 王去凑三张成十，剩下两张真牌定牛型；挑对玩家最有利的那组。 */
    var best = null;
    for (var a = 0; a < others.length - 1; a++) {
      for (var b = a + 1; b < others.length; b++) {
        var pair = [];
        for (var k = 0; k < others.length; k++) if (k !== a && k !== b) pair.push(others[k]);
        if (pair.length !== 2) continue;             // 只剩两张才符合「剩下两张」的定义
        var info = douNiuNiuOf(douNiuPoint(pair[0]) + douNiuPoint(pair[1]));
        if (best === null || info.type > best.type) best = info;
      }
    }
    if (best === null) return { type: -1, niu: null, name: '没牛', compareCards: others };
    best.compareCards = others;    // 有王的手牌：比牌材料 = 除王以外的牌
    return best;
  }

  function douNiuInfo(hand) {
    if (!hand || hand.length === 0) return { type: -1, niu: null, name: '没牛', compareCards: [] };
    if (hasJoker(hand)) return douNiuInfoJoker(hand);
    return douNiuInfoResolved(hand);
  }

  /* 比大小：先比牛型；同型比 compareCards——
   *   一律是「五张里最大的那张」，点数一样再比花色（K 最大、A 只算 1）。
   *   有大王的手牌 compareCards 已剔除王，所以取的是「除王以外最大的那张」。
   *   两侧张数不同（王手 4 张 vs 无王 5 张）时按少的逐张比，逐张只在最大牌完全相同时才用到。
   *
   * ★ 这里**没有**王决胜分支，也**不需要**加（2026-11-12 复核，用户指出）。
   *   逐张比到「点数 + 花色」全等，等价于「两边拿到同一张牌」；判平至少需要 4 张牌
   *   被两家各拿一份 —— 单副 54 张里发不出来。所以「其余四张完全一样、只差大小王」
   *   这个场景本身不存在：两手含王牛牛的最大牌必然不同，一定分得出胜负。
   *   实测：单副牌里含王能成牛牛的 4 张真牌组合共 188,093 个，签名相同的对 100% 共用真牌；
   *   20 万局真实发牌里斗牛平局 0 次（见 pwa/test/douniu-tie-unreachable.test.js）。
   *   别为了「万一平局」在这里加 jokerLevelOf —— 那会给飘三叶 / 十点半的口径
   *   制造第二套解释，而它保护的是一条走不到的路。 */
  function compareDouNiuHands(a, b) {
    var ia = douNiuInfo(a), ib = douNiuInfo(b);
    if (ia.type !== ib.type) return ia.type < ib.type ? -1 : 1;
    return compareDouNiuCards(ia.compareCards, ib.compareCards);
  }

  /* 同型比大小时的「决胜牌」：比牌材料里最大的那张（王手已剔除王），只用于结算面板展示 */
  function douNiuDecider(hand) {
    var cards = douNiuInfo(hand).compareCards;
    if (!cards || !cards.length) return null;
    var best = cards[0];
    for (var i = 1; i < cards.length; i++) {
      if (compareDouNiuCard(cards[i], best) > 0) best = cards[i];
    }
    return best;
  }

  function douNiuType(hand) {
    var i = douNiuInfo(hand);
    return { type: i.type, niu: i.niu, name: i.name };
  }
  function douNiuTypeName(hand) { return douNiuInfo(hand).name; }
  function douNiuHasCow(hand) { return douNiuInfo(hand).type >= 0; }

  function compareDouNiu(a, b) { return compareDouNiuHands(a, b); }

  /* 斗牛赢家收每人分数 */
  function douNiuWinPoints(hand) {
    var t = douNiuType(hand).type;
    if (t === 10) return CONFIG.DOUNIU_WIN_POINTS.WUHUA;
    if (t === 9) return CONFIG.DOUNIU_WIN_POINTS.NIUNIU;
    if (t === 8 || t === 7) return CONFIG.DOUNIU_WIN_POINTS.NIU89;
    if (t >= 0) return CONFIG.DOUNIU_WIN_POINTS.NIU17;
    return CONFIG.DOUNIU_WIN_POINTS.NONE;
  }

  /* ---------------------------- 统一牌型名 ---------------------------- */
  function typeName(mode, hand) {
    if (!hand || hand.length === 0) return '弃权';
    switch (mode) {
      case 'single': return cardLabel(hand[0]);
      case 'tenhalf': return tenHalfDisplay(hand);
      case 'piaosanye': return piaoSanYeTypeName(hand);
      case 'douniu': return douNiuTypeName(hand);
      default: return '';
    }
  }

  var COMPARATOR = {
    single: compareSingle,
    tenhalf: compareTenHalf,
    piaosanye: comparePiaoSanYe,
    douniu: compareDouNiu
  };

  /* ---------------------------- 结算 ---------------------------- */
  /* 飘三叶「场上豹子总数」：该组所有参与者里牌型为豹子的人数（含赢家自己）。
   * 手牌非 3 张（弃权 / 异常）的条目不计入，避免对空手牌做牌型判定。 */
  function piaoSanYeLeopardCount(entries) {
    var n = 0;
    if (!entries) return n;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || !e.hand || e.hand.length !== 3) continue;
      if (piaoSanYeType(e.hand).type === PSY_TYPE.LEOPARD) n++;
    }
    return n;
  }

  /* 非斗牛玩法「每个对手付几分」（计分档）：
   *   single    → CONFIG.SINGLE_WIN（固定 1）
   *   tenhalf   → 赢家该组解析后总点数正好 10.5（含大王万能解析）→ TENHALF_MAX_WIN(2)，
   *               否则（10 点等未爆非满点、或极端情况下的爆牌赢家）→ TENHALF_WIN(1)
   *   piaosanye → PIAOSANYE_WIN + PIAOSANYE_LEOPARD_BONUS × 场上豹子总数（含赢家自己）
   *               非豹子赢时场上无豹子（豹子必胜），故恒为基础 1 分/人。
   *               例：4 人局 3 豹（最大豹子赢）→ 1 + 1×3 = 4 分/人，总收 3×4 = 12。
   * 注意：十点半只看「解析后的实际点数」，不再看是否含大王（旧「含大王翻倍」已删除）。 */
  var TENHALF_MAX_TENTHS = 105;   // 105 个十分之一 = 10.5 点
  function winPointsPerPlayer(mode, winnerHand, entries) {
    if (mode === 'tenhalf') {
      return tenHalfTotal(winnerHand) === TENHALF_MAX_TENTHS
        ? CONFIG.TENHALF_MAX_WIN : CONFIG.TENHALF_WIN;
    }
    if (mode === 'piaosanye') {
      // entries 缺省（单测/调试直接问赢家手牌）时按「赢家自己是不是豹子」兜底
      var leopards = entries
        ? piaoSanYeLeopardCount(entries)
        : (piaoSanYeType(winnerHand).type === PSY_TYPE.LEOPARD ? 1 : 0);
      return CONFIG.PIAOSANYE_WIN + CONFIG.PIAOSANYE_LEOPARD_BONUS * leopards;
    }
    return CONFIG.SINGLE_WIN;
  }

  /* 同型/同点数时的决胜牌（结算面板上告诉玩家「输在哪张」）。
   * 十点半 = 贡献点数最大的那张（10.5 就是那张 10）；斗牛 = 五张里最大的那张（王不算）。 */
  function deciderLabel(mode, hand) {
    if (!hand || !hand.length) return '';
    var c = null;
    if (mode === 'tenhalf') c = tenHalfDecider(hand);
    else if (mode === 'douniu') c = douNiuDecider(hand);
    return c ? cardLabel(c) : '';
  }

  function settleGroup(mode, entries) {
    var comp = COMPARATOR[mode];
    if (!comp) throw new Error('unknown mode: ' + mode);

    var deltas = {};
    entries.forEach(function (e) { deltas[e.id] = 0; });

    function buildResult(winner, winPoints, tieIds) {
      return {
        winnerId: winner.id,
        winnerHand: winner.hand,
        winnerTypeName: typeName(mode, winner.hand),
        winPoints: winPoints || 0,   // 赢家向每个对手收几分（前端据此显示「豹子 ×N」等标记）
        tieIds: tieIds || [winner.id],
        deltas: deltas,
        entries: entries.map(function (e) {
          return {
            id: e.id, hand: e.hand, typeName: typeName(mode, e.hand),
            decider: deciderLabel(mode, e.hand)
          };
        })
      };
    }

    // 防线：手牌为空的条目视为弃权/最小，不进入“选赢家”的候选集。
    // 否则空 hand 与任何人比都是 0（平局），可能把真正赢家顶掉。
    var candidates = entries.filter(function (e) {
      return !!(e && e.hand && e.hand.length > 0);
    });

    // 全部弃权（正常流程不会发生，所有人都必须提交）：不结算，winner 取 entries[0]
    if (candidates.length === 0) return buildResult(entries[0], 0);

    /* 选赢家：按比较器取最大。
     * 比较器现在保证「牌型 → 点数 → 花色」全序，所以 0 只可能出现在**牌面完全相同**的两手
     * （单副牌里实际不可能发生）。真出现时按入房顺序取第一个，并把 tieIds 带出去，
     * 让前端/测试能看到这是平局，而不是让「数组顺序」当一条无人知晓的隐式规则。 */
    var winner = candidates[0];
    var tieIds = [winner.id];
    for (var i = 1; i < candidates.length; i++) {
      var c = comp(candidates[i].hand, winner.hand);
      if (c > 0) { winner = candidates[i]; tieIds = [winner.id]; }
      else if (c === 0 && candidates[i].id !== winner.id) tieIds.push(candidates[i].id);
    }

    var winPoints;
    if (mode === 'douniu') {
      var base = douNiuWinPoints(winner.hand);
      winPoints = base;
      var winnerHasCow = douNiuHasCow(winner.hand);
      entries.forEach(function (e) {
        if (e.id === winner.id) return;
        // 弃权者按“没牛”计，正常情况不会走到
        var eHasCow = (e.hand && e.hand.length > 0) ? douNiuHasCow(e.hand) : false;
        var pay = base + ((winnerHasCow && !eHasCow) ? CONFIG.DOUNIU_NONE_PENALTY : 0);
        deltas[e.id] -= pay;
        deltas[winner.id] += pay;
      });
    } else {
      // 十点半 / 飘三叶：按计分档取「每个对手付几分」（见 winPointsPerPlayer；飘三叶需传入整组 entries）
      var win = winPointsPerPlayer(mode, winner.hand, entries);
      winPoints = win;
      entries.forEach(function (e) {
        if (e.id === winner.id) return;
        deltas[e.id] -= win;
        deltas[winner.id] += win;
      });
    }

    return buildResult(winner, winPoints, tieIds);
  }

  /* ---------------------------- 导出 ---------------------------- */
  return {
    SUIT_ORDER: SUIT_ORDER,
    SUIT_SYMBOL: SUIT_SYMBOL,
    SUIT_CN: SUIT_CN,
    RANK_LABEL: RANK_LABEL,
    JOKER: JOKER,
    CONFIG: CONFIG,
    setConfig: setConfig,

    isJoker: isJoker,
    hasJoker: hasJoker,
    containsJoker: containsJoker,
    isBigJoker: isBigJoker,
    isSmallJoker: isSmallJoker,
    jokerCount: jokerCount,
    jokerLevelOf: jokerLevelOf,
    SMALL_JOKER: SMALL_JOKER,
    rankLabel: rankLabel,
    suitSymbol: suitSymbol,
    cardLabel: cardLabel,
    suitRank: suitRank,
    singleRank: singleRank,      // 单张点数（A 当 1）
    highRank: highRank,          // 高牌点数（A 保持 14）

    compareSingle: compareSingle,
    compareHighCard: compareHighCard,
    compareTenHalf: compareTenHalf,
    compareTenHalfCard: compareTenHalfCard,   // 十点半同点数比牌：先比点数贡献，再比花色
    comparePiaoSanYe: comparePiaoSanYe,
    compareDouNiu: compareDouNiu,
    compareDouNiuCard: compareDouNiuCard,     // 斗牛比牌：K 最大、A = 1 最小，再比花色
    compareDouNiuCards: compareDouNiuCards,

    tenHalfDecider: tenHalfDecider,
    douNiuDecider: douNiuDecider,
    deciderLabel: deciderLabel,

    tenHalfTenths: tenHalfTenths,
    tenHalfTotal: tenHalfTotal,
    tenHalfBust: tenHalfBust,
    tenHalfDisplay: tenHalfDisplay,
    resolveTenHalf: resolveTenHalf,
    /* 解析择优的判据。导出是为了让测试能直接验证「解析口径」与
     * compareTenHalf 的双爆分支**说的是同一件事**——这两处曾经互相打架。 */
    tenHalfResolvedBetter: tenHalfResolvedBetter,

    piaoSanYeType: piaoSanYeType,
    piaoSanYeTypeName: piaoSanYeTypeName,
    piaoSanYeLeopardCount: piaoSanYeLeopardCount,
    PSY_TYPE: PSY_TYPE,
    PSY_NAME: PSY_NAME,

    douNiuPoint: douNiuPoint,
    douNiuType: douNiuType,
    douNiuTypeName: douNiuTypeName,
    douNiuHasCow: douNiuHasCow,
    douNiuWinPoints: douNiuWinPoints,
    douNiuInfo: douNiuInfo,          // 暴露给单测：含 compareCards（同型比大小的材料 = 除王外的牌）
    douNiuSideCards: douNiuSideCards, // 同上：取「除王以外的牌」

    typeName: typeName,
    winPointsPerPlayer: winPointsPerPlayer,
    settleGroup: settleGroup
  };
});
