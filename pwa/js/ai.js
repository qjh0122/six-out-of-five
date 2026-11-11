/**
 * AI 决策（分牌策略）
 *
 * 思路：不做复杂的启发式猜测，直接**穷举所有合法分法**，用 engine 判定每组强度，
 * 加权求和后取最优。组合数很小：
 *   第一轮 1/2/3：6 × C(5,2) = 60 种
 *   第二轮 1/5  ：6 种
 * 单次决策不到 1ms，完全够用，而且策略天然贴合真实规则（不会出现"AI 不懂规则"的怪决策）。
 *
 * 强度映射到 0~1（负面情况给负分），权重按各组的分值量级设定：
 *   - 斗牛没牛要倒扣 5 分，所以给重罚，绝不会为了保单张而放弃成牛
 *   - 十点半正好 10.5 收双倍，给超过 1 的奖励
 *
 * 双端可用：浏览器挂 AI，Node 走 module.exports（服务端直接用同一份策略）。
 */
(function (global, factory) {
  var Engine = (typeof require === 'function') ? require('./engine.js') : global.Engine;
  var mod = factory(Engine);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  } else {
    global.AI = mod;
  }
})(typeof self !== 'undefined' ? self : this, function (Engine) {
  'use strict';

  var SUIT_BONUS = { spade: 0.03, heart: 0.02, club: 0.01, diamond: 0 };

  /* 单张大小顺序：A 当 1 最小，2..K 递增，大王最大 */
  function singleOrder(card) {
    if (!card) return 0;
    /* 大王 13（最大）、小王 12.5（只输大王、赢 K）。
     * 这里必须给小数：都给 13 的话 AI 会把小王当成和大王等价的好牌，
     * 单张轮次里就会拿小王去和别人硬碰。 */
    if (card.suit === 'joker' || Engine.isJoker(card)) return card.rank >= 15 ? 13 : 12.5;
    var r = Number(card.rank);
    if (r === 14) return 0;   // A
    return r - 1;             // 2 → 1 ... K → 12
  }

  function singleStrength(card) {
    return (singleOrder(card) + (SUIT_BONUS[card.suit] || 0)) / 13;
  }

  /* 十点半：爆点归零；正好 10.5 收双倍，给溢价 */
  function tenHalfStrength(hand) {
    var total;
    try { total = Engine.tenHalfTotal(hand); } catch (e) { return 0; }
    if (total > 105) return 0;
    if (total === 105) return 1.2;
    return (total / 105) * 0.85;
  }

  /* 飘三叶：豹子 > 同花顺 > 同花 > 顺子 > 对子 > 散牌 */
  function piaoSanYeStrength(hand) {
    var t;
    try { t = Engine.piaoSanYeType(hand).type; } catch (e) { return 0; }
    return (Number(t) || 1) / 6;
  }

  /* 斗牛：没牛倒扣 5 分，必须重罚；五花牛 / 牛牛 给高溢价 */
  function douNiuStrength(hand) {
    var t;
    try { t = Engine.douNiuType(hand).type; } catch (e) { return -1; }
    if (t < 0) return -1.2;       // 没牛
    if (t === 10) return 1.35;    // 五花牛
    if (t === 9) return 1.2;      // 牛牛
    return 0.35 + t * 0.06;       // 牛1 ~ 牛9
  }

  /* ==========================================================================
   * 期望收益模型
   *
   * 三组是各自独立结算的（每组单独比、单独收分），所以「总收益 = 各组期望之和」，
   * 不需要人工权重 —— 权重一旦靠拍脑袋定，就容易出现「为了 1 分的同花顺
   * 放弃 2 分的十点半」这种亏本决策。
   *
   * 每组期望 = 赢面估计 × 赢下时的收分：
   *   单张   收 1 分/人
   *   十点半 正好 10.5 收 2 分，否则 1 分
   *   飘三叶 收 1 分，自己是豹子时再 +1（场上豹子越多越多，AI 只保守算自己）
   *   斗牛   五花牛 4 / 牛牛 3 / 牛8-9 2 / 牛1-7 1；没牛倒扣 5
   * ======================================================================== */

  /* 收分口径**从 engine 的运行时配置读**（config.js 通过 Engine.setConfig 注入）。
   * 以前这里把 1 / 2 / 1 / 5 写死，策划一改 config.js，AI 的收益模型就不跟着变——
   * 表现是「配置里五花牛收 6 分，AI 还按 4 分算」，开始出现看不懂的亏本决策。
   * 取不到配置才退回默认值，保证单独 require ai.js 也能跑。 */
  function num(key, fallback) {
    var c = (Engine && Engine.CONFIG) || {};
    var v = Number(c[key]);
    return isFinite(v) && v > 0 ? v : fallback;
  }
  function douNiuPointsFor(t) {
    var c = (Engine && Engine.CONFIG) || {};
    var w = c.DOUNIU_WIN_POINTS || {};
    var pick = t === 10 ? w.WUHUA : (t === 9 ? w.NIUNIU : (t >= 7 ? w.NIU89 : w.NIU17));
    var v = Number(pick);
    return isFinite(v) && v > 0 ? v : (t === 10 ? 4 : (t === 9 ? 3 : (t >= 7 ? 2 : 1)));
  }

  function singleEV(card) {
    return singleStrength(card) * num('SINGLE_WIN', 1);
  }

  function tenHalfEV(hand) {
    var total;
    try { total = Engine.tenHalfTotal(hand); } catch (e) { return 0; }
    if (total > 105) return 0;                     // 爆点，必输
    var winProb = total === 105 ? 0.95 : (total / 105) * 0.6;
    var points = total === 105 ? num('TENHALF_MAX_WIN', 2) : num('TENHALF_WIN', 1);
    return winProb * points;
  }

  function piaoSanYeEV(hand) {
    var t;
    try { t = Engine.piaoSanYeType(hand).type; } catch (e) { return 0; }
    var winProb = (Number(t) || 1) / 6 * 0.95;
    var points = num('PIAOSANYE_WIN', 1)
      + (Number(t) === 6 ? num('PIAOSANYE_LEOPARD_BONUS', 1) : 0);  // 豹子额外收分
    return winProb * points;
  }

  function douNiuEV(hand) {
    var penalty = num('DOUNIU_NONE_PENALTY', 5);
    var t;
    try { t = Engine.douNiuType(hand).type; } catch (e) { return -penalty * 0.8; }
    if (t < 0) return -penalty * 0.8;              // 没牛：大概率被倒扣，按八成估
    var points = douNiuPointsFor(t);
    var winProb = 0.5 + t * 0.045;                 // 牛型越高赢面越大
    return winProb * points;
  }

  function emptyGroups() {
    return { single: [], tenhalf: [], piaosanye: [], douniu: [] };
  }

  /* 第一轮：6 张拆成 1 / 2 / 3
   *
   * ★ 「能不爆就不许爆」这条规则对 AI 同样成立。
   * 人类的十点半排成爆点时会被弹窗硬挡住、不给提交（见 game.js 的 bust-modal），
   * 而 AI 之前只按期望值挑：爆点那组 EV 记 0 分，可它仍然可能总分最高
   * （单张和飘三叶那两组够强）—— 于是 AI 会心安理得地送出一组爆点。
   * 实测 20000 手随机牌里 AI 排出 300 手爆点，其中 202 手（1%）本来完全可以不爆。
   * 结果是规则双标：人被拦、AI 照送，那一组白输给别人。
   *
   * 所以分两轮挑：先只在「十点半不爆」的分法里取最优；
   * 整手怎么配都爆（极端烂牌）才退回全体里挑 —— 和有爆点弹窗时的判断口径一致。
   */
  function decideRound1(hand) {
    var best = null;
    var bestScore = -Infinity;
    var bestSafe = null;
    var bestSafeScore = -Infinity;
    for (var i = 0; i < 6; i++) {
      var rest = [];
      for (var x = 0; x < 6; x++) if (x !== i) rest.push(hand[x]);
      // rest 5 张里挑 2 张给十点半，剩 3 张给飘三叶
      for (var a = 0; a < 4; a++) {
        for (var b = a + 1; b < 5; b++) {
          var tenhalf = [rest[a], rest[b]];
          var psy = [];
          for (var y = 0; y < 5; y++) if (y !== a && y !== b) psy.push(rest[y]);
          var score = singleEV(hand[i]) + tenHalfEV(tenhalf) + piaoSanYeEV(psy);
          var split = { single: [hand[i]], tenhalf: tenhalf, piaosanye: psy, douniu: [] };
          if (score > bestScore) { bestScore = score; best = split; }
          /* 只有「不爆」的分法才进合法候选。tenHalfEV 内部已经判定爆点，
           * 但那只是「给 0 分」，不是「排除」—— 这里才是真的排除。 */
          if (!tenHalfBust(tenhalf) && score > bestSafeScore) {
            bestSafeScore = score;
            bestSafe = split;
          }
        }
      }
    }
    return bestSafe || best || emptyGroups();
  }

  /* 这一手十点半是不是爆点。用 engine 的口径（含大王万能解析），
   * 与结算、与人类的爆点拦截弹窗完全同源，避免两边阈值漂移。 */
  function tenHalfBust(hand) {
    try { return !!Engine.tenHalfBust(hand); } catch (e) { return false; }
  }

  /* 第二轮：6 张拆成 1 / 5 */
  function decideRound2(hand) {
    var best = null;
    var bestScore = -Infinity;
    for (var i = 0; i < 6; i++) {
      var douniu = [];
      for (var x = 0; x < 6; x++) if (x !== i) douniu.push(hand[x]);
      var score = singleEV(hand[i]) + douNiuEV(douniu);
      if (score > bestScore) {
        bestScore = score;
        best = { single: [hand[i]], tenhalf: [], piaosanye: [], douniu: douniu };
      }
    }
    return best || emptyGroups();
  }

  /**
   * 决定本轮的出牌分组。
   * @param {Array} hand  6 张手牌
   * @param {number} round 1 或 2
   * @returns {{single:Array, tenhalf:Array, piaosanye:Array, douniu:Array}}
   */
  function decide(hand, round) {
    if (!Array.isArray(hand) || hand.length !== 6) return emptyGroups();
    return Number(round) === 2 ? decideRound2(hand) : decideRound1(hand);
  }

  return {
    decide: decide,
    decideRound1: decideRound1,
    decideRound2: decideRound2,
    // 暴露强度函数便于单测与调试
    singleStrength: singleStrength,
    tenHalfStrength: tenHalfStrength,
    piaoSanYeStrength: piaoSanYeStrength,
    douNiuStrength: douNiuStrength
  };
});
