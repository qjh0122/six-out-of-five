/**
 * 牌桌组槽的几何计算（纯函数，不碰 DOM）
 *
 * 为什么单独成文件：
 *   第一轮三组是刚性尺寸 —— 牌高 202、组信息 55、上下内边距 14，单组 271，
 *   三组加两道间距合计 840。而组槽可用高 = 舞台高 − 777，390×844 时正好 846：
 *   全站只剩 6 设计px 余量。于是任何更矮的屏幕必然溢出 —— 375×667 的组槽只有 557，
 *   第三组「飘三叶」被整块挤出容器（真机实测 clippedPx 136、visibleRatio 0），
 *   而 .slots 的滚动条在这套皮肤里根本看不见，玩家会以为这组不存在。
 *
 *   布局不能建立在「刚好放得下」上。现在改成先量可用高度、再反推牌尺寸
 *   （上限仍是 144×202，所以 390×844 这些大屏一个像素都不变），矮屏额外进 dense
 *   模式：组信息从「牌下方」搬到「牌右侧」，纵向不再为文字留 55px。
 *
 * 为什么要能 require：这段算术必须被单测钉住（见 pwa/test/table-layout.test.js），
 * 而 game.js 是个 IIFE，塞在里面就只能靠真浏览器探针，回归成本太高。
 *
 * 与 style.css 的耦合（测试会读 CSS 反查这几个数，防止 CSS 改了 JS 没跟上）：
 *   .slots gap                    普通 12 / dense 10
 *   .slot 上下内边距合计           普通 8+6=14 / dense 6+6=12
 *   .slot-meta 高 + .slot 行间距   普通 49+6=55 / dense 0（组信息在右侧，不占纵向）
 */
(function (global, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  } else {
    global.SlotLayout = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var METRICS = {
    normal: { gap: 12, padV: 14, metaV: 55, widthRatio: 1 },
    dense:  { gap: 10, padV: 12, metaV: 0,  widthRatio: 0.55 }
  };

  /* 圆桌版 dense 的牌宽比例：**按组内张数给，不能是一个常量**（v89 修 N8）。
   *
   * n ≤ 3 时牌先被高度卡住，0.6 已经够宽；比例再大只是白占组信息的横向空间。
   * n ≥ 4 时宽度是**唯一**约束：(629 × 0.6 − 8×4) / 5 = 69 宽 → 97 高，
   * 低于文档 §11 自定的 82×115。0.78 让 5 张拿到 91×127，
   * 同时给「斗牛 · 5张 0/5」留 142 设计 px（dense 下组信息在牌右侧）。
   *
   * 为什么不在 cardSize 里自动算：这个比例是**排版意图**，不是推导结果 ——
   * 组信息占多宽取决于文案（「十点半 · 2张 3/2」比「斗牛 · 5张 0/5」长得多），
   * 自动反算会在换一行文案时悄悄改牌尺寸。 */
  var RING_RATIO = { 1: 0.6, 2: 0.6, 3: 0.6, 4: 0.78, 5: 0.78 };
  function ringWidthRatio(n) { return RING_RATIO[n] || 0.6; }

  /* 文档 §11 的牌面下限，作为「不许再往下缩」的硬线传进 cardSize。
   * 3 张及以下 ≥110×154；5 张组（斗牛）≥82×115。 */
  var RING_MIN_CARD_W = { 1: 110, 2: 110, 3: 110, 4: 82, 5: 82 };
  function ringMinCardW(n) { return RING_MIN_CARD_W[n] || 82; }

  var CARD_ASPECT = 1.4;   // 扑克牌 2.5:3.5
  var MIN_CARD_W = 56;     // 再挤也要认得出牌面的下限（正常机型不会碰到）
  var MIN_CARD_H = 84;
  var GROUPS = 3;          // 按第一轮的三组算 —— 最多的那一轮不溢出，第二轮的 2 组更没问题

  /* 组槽以外、牌桌纵向固定开销（设计像素）：安全区 + 顶栏 + 手牌 + 按钮 + 标签条。
   * 实测两档一致（390×844：舞台 1623、组槽 846；375×667：舞台 1334、组槽 557 → 都是 777），
   * 说明它与视口宽高比无关，只跟牌桌自身结构有关。
   * 运行时并不依赖这个常量 —— 牌桌可见时直接读 #slots.clientHeight；
   * 它只作为「牌桌还没显示」时的预估，以及测试里的复算口径。 */
  var CHROME_H = 777;

  /* 舞台高（设计像素）→ 组槽可用高度 */
  function slotsHeight(stageH) {
    var h = stageH - CHROME_H;
    return h > 0 ? h : 0;
  }

  /* 矮屏判定：16:9 手机 1331~1334、横屏 1440 命中；19.5:9 手机 1623 不命中 */
  var DENSE_BELOW = 1500;
  function isDense(stageH) { return stageH < DENSE_BELOW; }

  /* 普通排法三组的刚性需求：3 × (padV 14 + 牌高 202 + meta 55) + 2 × gap 12 = 837。
   * 这是「不需要 dense」的**充分条件**：只要组槽有 837，普通排法的牌就是满尺寸（144×202），
   * 进 dense 只会把牌弄小、一点也不省。 */
  var NORMAL_NEED = 837;

  /* v87 新增：按**可用高度**判 dense，而不是按舞台高。
   * 圆桌座位环吃掉 264 设计px（顶栏 194 → 环 458），stageH 还是 1624，
   * 但组槽只剩 552 —— 拿 stageH 判会得出「不用 dense」，然后三组放不下。
   * 所以座位环开着的时候走这条，关掉时两条等价（见 table-layout.test.js 的对照断言）。 */
  function isDenseAt(availH) { return availH < NORMAL_NEED; }

  /* 坐上圆桌之后，顶栏块比原来多吃的设计 px（实测：旧顶栏 182+12，环 466+8）。
   * 这个数字只用于「要不要切 dense」的判断（运行时另有实测的 clientHeight），
   * 但改环高必须同步改它，否则某档屏幕会被判成放得下。
   * 改它之前先跑 scripts/probe-table.js。 */
  var RING_EXTRA_H = 280;

  /* 紧凑竖屏（16:9，v90）：环 404 + 间距 8 vs 旧顶栏 182 + 12 → 多 218。
   * 与 seatRing.MODES.portraitCompact 一起改；同样只服务「要不要 dense」这一个判断，
   * 真正的牌尺寸来自运行时实测的 #slots.clientHeight。 */
  var RING_EXTRA_H_COMPACT = 218;

  function metrics(dense) { return dense ? METRICS.dense : METRICS.normal; }

  /* 单组牌面允许的最大高度：把可用高度按组数均分，扣掉内边距与组信息。
   * rows 默认按第一轮的三组（GROUPS）算；v89 的窄横屏「两列两行」传 2 ——
   * 那不是「三组挤三行」，是两组并排、两行放完，纵向预算从 3 份变 2 份。 */
  function maxCardHeight(availH, dense, rows) {
    var m = metrics(dense);
    var r = rows > 0 ? rows : GROUPS;
    var perSlot = (availH - m.gap * (r - 1)) / r;
    var h = Math.floor(perSlot - m.padV - m.metaV);
    return h < MIN_CARD_H ? MIN_CARD_H : h;
  }

  /* 一组里摆 n 张牌时每张的尺寸。
   * 三个约束取最小：桌带横向能均分多宽、纵向预算是多高、dense 下要给组信息留多宽。 */
  function cardSize(n, opts) {
    opts = opts || {};
    var dense = !!opts.dense;
    var bandInnerW = opts.bandInnerW || 629;
    var capW = opts.capW || 144;
    var maxH = opts.maxCardH;
    if (maxH == null && opts.availH != null) maxH = maxCardHeight(opts.availH, dense);

    var byWidth = Math.floor((bandInnerW - 8 * (n - 1)) / n);
    var w = Math.min(capW, byWidth);
    if (maxH != null) w = Math.min(w, Math.floor(maxH / CARD_ASPECT));
    /* dense 下组信息在右侧，牌这一排最多占 widthRatio 的桌带宽度。
     * 注意要先把牌间距扣掉再均分 —— 直接拿 桌带宽×比例 ÷ n 会多算 8×(n−1)。
     * v87：圆桌把组槽压矮之后，牌通常**先被高度卡住**，0.55 的比例在矮屏上
     * 会多此一举地再卡一次。圆桌版按张数取比例（见 RING_RATIO）。 */
    if (dense) {
      var ratio = opts.widthRatio != null ? opts.widthRatio : metrics(true).widthRatio;
      w = Math.min(w, Math.floor((bandInnerW * ratio - 8 * (n - 1)) / n));
      /* v89（N8 兜底）：比例是手段不是目的。若比例算出来的牌低于下限、
       * 而桌带 + 高度本身还放得下更大的牌，就抬到下限 —— 组信息挤一点可以忍，
       * 牌认不出来不行（dense 下组信息会换行，不会溢出）。 */
      var minW = opts.minW || 0;
      if (minW && w < minW) {
        var roomForMin = Math.floor((bandInnerW - 8 * (n - 1)) / n);
        var capByHeight = maxH != null ? Math.floor(maxH / CARD_ASPECT) : Infinity;
        var canDo = Math.min(capW, roomForMin, capByHeight);
        if (canDo >= minW) w = minW;
        else if (canDo > w) w = canDo;
      }
    }
    if (w < MIN_CARD_W) w = MIN_CARD_W;
    return { w: w, h: Math.round(w * CARD_ASPECT) };
  }

  /* 单组实际占的纵向总高（含内边距与组信息） */
  function groupHeight(cardH, dense) {
    var m = metrics(dense);
    return m.padV + cardH + m.metaV;
  }

  /* 整块组槽需要的总高 —— 测试用它断言「三组一定放得下」 */
  function totalHeight(cardH, dense) {
    var m = metrics(dense);
    return groupHeight(cardH, dense) * GROUPS + m.gap * (GROUPS - 1);
  }

  return {
    METRICS: METRICS,
    CARD_ASPECT: CARD_ASPECT,
    GROUPS: GROUPS,
    CHROME_H: CHROME_H,
    DENSE_BELOW: DENSE_BELOW,
    NORMAL_NEED: NORMAL_NEED,
    RING_EXTRA_H: RING_EXTRA_H,
    RING_EXTRA_H_COMPACT: RING_EXTRA_H_COMPACT,
    MIN_CARD_W: MIN_CARD_W,
    RING_RATIO: RING_RATIO,
    RING_MIN_CARD_W: RING_MIN_CARD_W,
    ringWidthRatio: ringWidthRatio,
    ringMinCardW: ringMinCardW,
    slotsHeight: slotsHeight,
    isDense: isDense,
    isDenseAt: isDenseAt,
    metrics: metrics,
    maxCardHeight: maxCardHeight,
    cardSize: cardSize,
    groupHeight: groupHeight,
    totalHeight: totalHeight
  };
});
