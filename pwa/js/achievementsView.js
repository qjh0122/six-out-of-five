/**
 * 成就页（纯渲染，无网络、无状态）
 *
 *   global.LXW.achievementsView
 *
 * 输入是一份**服务端档案**（getProfile 的响应，里面带 ach 桶），
 * 输出是整页 HTML 字符串。它不自己拉数据、不自己切屏 ——
 * 谁来拉、拉到之后放哪儿，由 game.js 决定。
 *
 * 为什么渲染单独一层：成就页要在两个地方出现（首页入口、点头像后信息档），
 * 两处的容器与高度都不一样，把 HTML 拼接写死在 game.js 里就会变成两份。
 *
 * 判定全部交给 achievements.js（双端同源），这里只负责「好不好看」。
 */
(function (global, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  } else {
    (global.LXW = global.LXW || {}).achievementsView = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 概率：分母为 0 时显示「—」而不是 0%。
   * 「还没打过」和「打过但一次没拿到」是两件事，用 0% 会把它们混成一件。
   *
   * 一律保留 1 位小数（100% 除外）：12.5% 显示成「13%」会让人以为自己被四舍五入了，
   * 而这种数字是拿来跟牌友对账的，差 0.5 个点就够吵起来。 */
  function rateText(rate) {
    if (rate == null || !isFinite(rate)) return '—';
    var p = rate * 100;
    if (p > 0 && p < 0.1) return '<0.1%';
    if (p >= 100) return '100%';
    return p.toFixed(1) + '%';
  }

  /* 系列顺序：牌型 → 对撞 → 通吃 → 战绩。
   * 和 achievements.js 的 CATALOG 顺序一致，但这里显式写死 ——
   * 依赖 CATALOG 的书写顺序等于让「排序」变成一个隐形约定，改目录顺序就会改页面顺序。 */
  var SERIES_ORDER = ['type', 'vs', 'sweep', 'record'];

  function seriesTitle(key) {
    return { type: '牌型', vs: '对撞', sweep: '通吃', record: '战绩' }[key] || key;
  }
  function seriesHint(key) {
    return {
      type: '拿到某种大牌型的次数。概率的分母是「参与该组的次数」，不是打了多少把',
      vs: '你也拿着大牌、对手也拿着大牌，才叫对撞。吃掉一手普通牌不算',
      sweep: '一轮里所有组都赢下来。第二轮只有两组，所以「双杀」比「一巡清场」容易',
      record: '场次、连胜、单场最高——这些从有战绩那天就在算了'
    }[key] || '';
  }

  function cardHtml(it) {
    /* 未解锁的卡片**照样显示名字与描述**（用户裁定）：
     * 熟人不玩猜谜，让他知道有这回事才会去够。用 ??? 只会让人觉得系统在藏东西。 */
    var pct = it.need > 1 ? Math.min(100, Math.round(it.cur / it.need * 100)) : (it.ok ? 100 : 0);
    return '<li class="ach-card' + (it.ok ? ' is-ok' : '') + '" data-rarity="' + esc(it.rarity) + '">'
      + '<div class="ach-card-top">'
      + '<span class="ach-badge" aria-hidden="true">' + (it.ok ? '★' : '☆') + '</span>'
      + '<span class="ach-rarity">' + esc(it.rarityLabel) + '</span>'
      + '</div>'
      + '<b class="ach-name">' + esc(it.name) + '</b>'
      + '<p class="ach-desc">' + esc(it.desc) + '</p>'
      + (it.need > 1
        ? '<div class="ach-bar"><i style="width:' + pct + '%"></i></div>'
          + '<span class="ach-progress">' + it.cur + ' / ' + it.need + '</span>'
        : (it.ok ? '' : '<span class="ach-progress">未达成</span>'))
      + '</li>';
  }

  /**
   * 整页 HTML。
   *
   * @param {object} profile 服务端档案（需要 games / totalNet / ach）
   * @param {object} Ach     achievements.js 模块（含 ach 与判定）
   * @param {object} opts    { isMe:boolean }
   */
  function pageHtml(profile, Ach, opts) {
    opts = opts || {};
    if (!profile) {
      return '<div class="ach-empty"><p>还没有数据</p></div>';
    }
    /* 老档案（这个功能上线前就注册的人）没有 ach 桶 ——
     * 传 null 让 evaluate 自己兜底成空桶，页面显示「0 / N」而不是报错。 */
    var res = Ach.evaluate(profile.ach || null, profile);
    var st = Ach.typeStats(profile.ach || null);
    var since = Ach.sinceText(st.since);

    var html = '';

    /* ---- 顶部：总数 ---- */
    html += '<div class="ach-head">'
      + '<div class="ach-count"><b>' + res.unlocked + '</b><span>/ ' + res.total + '</span></div>'
      + '<div class="ach-head-side">'
      + '<p class="ach-head-label">' + (opts.isMe ? '你已解锁' : esc(profile.nickname || '对方') + ' 已解锁') + '</p>'
      + (since ? '<p class="ach-since">从 ' + since + ' 起记录</p>' : '')
      + '</div></div>';

    /* ---- 牌型统计平铺：这是用户要的「次数与概率」 ---- */
    var have = st.types.filter(function (t) { return t.hit > 0; }).length;
    if (!st.types.length || (st.types.every(function (t) { return t.seen === 0; }))) {
      html += '<section class="ach-types">'
        + '<h2>牌型</h2>'
        + '<p class="ach-note">还没打过带牌型的局。成就<b>从本功能上线那天开始记</b>，'
        + '以前的战绩没有存牌型，回不去。</p>'
        + '</section>';
    } else {
      html += '<section class="ach-types">'
        + '<h2>牌型 <em>' + have + ' / ' + st.types.length + ' 种拿到过</em></h2>'
        + '<ul class="ach-type-list">';
      st.types.forEach(function (t) {
        html += '<li data-rarity="' + esc(t.rarity) + '"' + (t.hit ? '' : ' class="is-zero"') + '>'
          + '<span class="ach-type-name">' + esc(t.label) + '</span>'
          + '<span class="ach-type-num"><b>' + t.hit + '</b> 次</span>'
          + '<span class="ach-type-rate">' + rateText(t.rate) + '</span>'
          + '</li>';
      });
      html += '</ul>'
        + '<p class="ach-vs">'
        + '大牌对撞 <b>' + st.vs.total + '</b> 次'
        + (st.vs.total
          ? ' · 赢 <b class="up">' + st.vs.win + '</b> · 输 <b class="down">' + st.vs.lose + '</b>'
            + ' · 胜率 <b>' + rateText(st.vs.rate) + '</b>'
          : '')
        + '</p>'
        + '</section>';
    }

    /* ---- 四个系列 ---- */
    SERIES_ORDER.forEach(function (key) {
      var items = res.list.filter(function (i) { return i.series === key; });
      if (!items.length) return;
      var s = res.bySeries[key] || { unlocked: 0, total: items.length };
      html += '<section class="ach-series" data-series="' + key + '">'
        + '<h2>' + seriesTitle(key) + ' <em>' + s.unlocked + ' / ' + s.total + '</em></h2>'
        + '<p class="ach-hint">' + seriesHint(key) + '</p>'
        + '<ul class="ach-grid">';
      items.forEach(function (it) { html += cardHtml(it); });
      html += '</ul></section>';
    });

    return html;
  }

  /** 信息档底部那一行（点头像后的玩家面板里用）。
   * 只靠 playerId 就能点，不需要先把对方成就拉下来 —— 点进去才拉。 */
  function entryRowHtml(profile) {
    if (!profile || !profile.playerId) return '';
    var n = Number(profile.achCount) || 0;
    var total = Number(profile.achTotal) || 0;
    return '<button class="pf-ach" type="button" data-ach-open="' + esc(profile.playerId) + '">'
      + '<span class="pf-ach-star" aria-hidden="true">★</span>'
      + '<span class="pf-ach-label">成就</span>'
      + '<b class="pf-ach-num">' + n + ' / ' + total + '</b>'
      + '<span class="pf-ach-go" aria-hidden="true">›</span>'
      + '</button>';
  }

  return {
    pageHtml: pageHtml,
    entryRowHtml: entryRowHtml,
    rateText: rateText,
    esc: esc
  };
});
