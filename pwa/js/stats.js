/**
 * 战绩统计口径（纯函数，双端同源）
 *
 * ── 为什么要单独一份 ────────────────────────────────────────────────
 * 同一件事原来写了两遍：
 *   · 服务端 `server/profile.js` 的 `record()`：每打完一把，把 games / wins /
 *     losses / draws / totalNet / bestNet / 两个连胜**增量**更新一次，落进档案；
 *   · 前端 `pwa/js/records.js` 的 `stats()`：把本机记录列表**整表重算**一遍。
 *
 * 两边现在口径一致（有一条对拍测试盯着），但改规则必须记得改两处 ——
 * 而这类「两处都跑得过、只是数不一样」的偏差不会报错，玩家看到的是
 * 「战绩页说 12 胜，排行榜说 11 胜」，然后开始怀疑哪边坏了。
 *
 * 把口径收成一份纯函数之后，服务端是「逐把 apply」，前端是「整表 fold」，
 * **同一段代码**跑出来的数不可能分岔。
 *
 * ── 口径（改之前先读这四条）──────────────────────────────────────────
 *
 * 1. **只看净胜的正负。** 正 = 胜，负 = 负，0 = 平。没有「小胜」「大胜」之分。
 * 2. **平局把连胜和连败都打断。** 平局既不是赢也不是输，不能算进任何一边。
 * 3. **AI 局不计入任何统计。** 过滤由调用方做（两边都在入口处过滤），
 *    这里只管算 —— 因为「哪些记录算」是业务判断，不是口径。
 * 4. **单场最高分在第一场直接取那一场的值**，不是从 0 起算。
 *    一个全负的人，-18 就是他真实的最好成绩；写 0 会被读成「有一局打平了」。
 *
 * 浏览器全局：`window.LXW.Stats`；服务端 `require('../pwa/js/stats.js')`
 */
(function (global, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  } else {
    global.LXW = global.LXW || {};
    global.LXW.Stats = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function blank() {
    return {
      games: 0,
      wins: 0,
      losses: 0,
      flats: 0,
      totalNet: 0,
      bestNet: 0,
      currentStreak: 0,      // 正 = 连胜，负 = 连败，0 = 刚平或还没打
      longestStreak: 0,
      longestLoseStreak: 0
    };
  }

  function copy(s) {
    var o = blank();
    if (!s) return o;
    for (var k in o) {
      if (Object.prototype.hasOwnProperty.call(s, k)) {
        var v = Number(s[k]);
        o[k] = isFinite(v) ? v : 0;
      }
    }
    return o;
  }

  /** 一场之后的新统计。**不改入参**（服务端会把它写回档案，前端会拿它填列表）。 */
  function apply(prev, net) {
    var s = copy(prev);
    var n = Number(net);
    if (!isFinite(n)) n = 0;   // 脏数据当平局，不要让它把整份统计算成 NaN

    s.games += 1;
    s.totalNet += n;
    if (n > 0) {
      s.wins += 1;
      s.currentStreak = s.currentStreak >= 0 ? s.currentStreak + 1 : 1;
    } else if (n < 0) {
      s.losses += 1;
      s.currentStreak = s.currentStreak <= 0 ? s.currentStreak - 1 : -1;
    } else {
      s.flats += 1;
      s.currentStreak = 0;
    }
    var abs = Math.abs(s.currentStreak);
    if (s.currentStreak > 0 && abs > s.longestStreak) s.longestStreak = abs;
    if (s.currentStreak < 0 && abs > s.longestLoseStreak) s.longestLoseStreak = abs;
    if (s.games === 1) s.bestNet = n;
    else if (n > s.bestNet) s.bestNet = n;
    return s;
  }

  /** 整表重算。`nets` 必须是**从旧到新**的顺序（跟前端列表的展示顺序相反）。 */
  function fromNets(nets) {
    var s = blank();
    var list = Array.isArray(nets) ? nets : [];
    for (var i = 0; i < list.length; i++) s = apply(s, list[i]);
    return s;
  }

  /** 胜率：四舍五入到整数百分点。0 场返回 0（调用方负责显示成「—」）。 */
  function rate(s) {
    if (!s || !s.games) return 0;
    return Math.round(s.wins / s.games * 100);
  }

  return {
    blank: blank,
    apply: apply,
    fromNets: fromNets,
    rate: rate
  };
});
