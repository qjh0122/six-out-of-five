/**
 * 圆桌座位环的几何计算（纯函数，不碰 DOM）
 *
 * 为什么单独成文件：这段算术一旦搬进 game.js 的 IIFE，就只能靠真浏览器探针回归；
 * 而它恰好是「头像一大就糊成一团」的根源 —— 必须被单测钉住（见 pwa/test/seat-ring.test.js）。
 * 写法与 slotLayout.js 一致（UMD，Node require / 浏览器全局两用）。
 *
 * ★ 核心不是「画个椭圆」，而是**弧长均分**。
 *
 * 按角度均分看着天经地义（θᵢ = 270° + (i−(n−1)/2)·span/(n−1)），但椭圆长轴端每度走过
 * 的长度是短轴端的 rx/ry ≈ 1.6 倍：5 人局顶部相邻座位间距 180 设计px，侧面只有 103 ——
 * 而一个带昵称的座位块要 112 宽，侧面必然互相压住。这就是「头像一大就糊成一团」的
 * 数学原因，调 span 治不好。
 *
 * 现在的做法：沿上弧采 512 个点算累积弧长，再按等弧长二分反解角度。
 * 均分后各处间距相等（5 人局 ≈ 216），头像才放得大。
 *
 * ★ 上弧给对手，下弧留给「我」和中央状态牌 —— 这是竖屏唯一的出路：
 *   竖屏 750 宽，一个正圆的座位环会把组槽挤没。
 *
 * ★ 尺寸谁说了算：rx 由**宽度**定（桌子该由宽度决定，不是由剩多少高度决定），
 *   ry 由 rx 乘固定比例定（0.615 ≈ 真实牌桌俯视比例）。高度是算出来的结果，不是输入。
 */
(function (global, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  } else {
    global.SeatRing = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 每种版式的参数。竖屏这一套是量出来的（2026-10-31，390×844 → 设计空间 670 宽）：
   *   块高 450 = topPad 46 + 2×ry 334 + meGap 6 + me 块 64
   * 组槽因此从 816 掉到 ~550，牌面 139×195 → 117×164（−16%），
   * 与设计稿「3 张组约 120×168」对得上。
   *
   * insetX 50 的道理：座位块半宽 56，环再往外挪头像就出屏。rx 从 656/2=328 收到 271，
   * 环最外侧座位中心 x≈76，块左沿 20 —— 离画布边还有 20 设计px 余量。 */
  var MODES = {
    portrait: {
      edgeX: 14,        // 毡面左右留边（毡比座位环还宽一点，座位才像「坐在桌沿上」）
      insetX: 50,       // rx = (w − 2×edgeX)/2 − insetX
      ratio: 0.615,     // ry = rx × ratio
      /* 顶部座位块要整块落在块内：座位块高 ≈119（头像 68 + 昵称 22 + 分数 25 + 间距），
       * 半高 ≈60。给 46 时 2 人局（对手在正上方 y=46）头像上半圆被裁掉 13 设计px ——
       * 5 人局看不出来（那个座位在 y≈67），只有 2 人局会缺一块，是最容易漏的那档。
       * 探针 scripts/probe-table.js 的「所有座位完整落在桌面块内」守这条。 */
      topPad: 62,
      meH: 64,          // 「我」那一格的块高
      meGap: 6,         // 环下沿到「我」的间距
      feltPadX: 24,     // 毡面比环各方向多出来的边（视觉，不参与定位）
      /* 纵向不外扩：毡面上下沿正好压在座位环上，座位头像**骑在桌沿**上。
       * 早先给了 26，结果环下沿的「我」和毡面底边叠了 20px（截图里那半个头像）。
       * 外扩只在横向有意义 —— 侧边座位要有个「桌沿」托着。 */
      feltPadY: 0,
      avatar: 68,       // 座位头像直径（改前 42 —— 圆桌的主要收益就是把头像放大）
      nmwMax: 120,      // 昵称块最大宽
      nmwMin: 84,
      /* 2 人局对战条（v89）。单挑时桌上只有一个对手坐在正上方，中间一大片空毡面，
       * 而这一局唯一真正重要的信息是「分差」。
       *   duelPlaqueDy 34 —— 中央牌下移，给对战条腾出座位与牌之间的那条缝；
       *   duelMeDy 16    —— 「我」跟着下移，块高同步 +16（不然会被 #game-top 裁掉）；
       *   vsH 56         —— 对战条高度，vsGap 是牌子半高(48) + 间距(14) + 条半高(28)。 */
      duelPlaqueDy: 34,
      duelMeDy: 16,
      vsH: 56,
      vsGap: 90
    },

    /* 横屏（.ls「左桌右盘」）：桌子占左栏 800 设计px，组槽与手牌在右栏。
     *
     * 为什么不沿用 portrait 只换 w：横屏左栏只有 800 宽，而高有 ~700 ——
     * 竖屏那套「rx 由宽定、ry = rx×0.615」算出来 550 高正好能塞进左栏，
     * 所以比例可以照搬，真正要改的只是左右余量（左栏没有屏幕边，只有列间距）：
     * insetX 收到 44，最外侧座位才不至于离列边界太远而显得桌子缩在中间。
     *
     * avatar 保持 68：横屏 scale 与竖屏接近（≈0.52），68 设计px ≈ 35 CSS px，
     * 两边真机看起来一样大。调它会让同一张桌子在两个朝向上头像大小不同。 */
    landscape: {
      edgeX: 16,
      insetX: 44,
      ratio: 0.615,
      topPad: 62,
      meH: 64,
      meGap: 6,
      feltPadX: 24,
      feltPadY: 0,
      avatar: 68,
      nmwMax: 120,
      nmwMin: 84,
      /* 对战条参数与竖屏一致：横屏的对手同样在正上方，同样有那片空毡面。
       * 不同之处只是桌子高度，而这三个数是相对中央牌算的，与桌子高度无关。 */
      duelPlaqueDy: 34,
      duelMeDy: 16,
      vsH: 56,
      vsGap: 90
    },

    /* 桌面 / 平板宽横屏（v91）：1280×800、1024×768、1180×820 这一类。
     *
     * 这一档的舞台设计高不是 750，而是 **1015~1219**（= 视口高 / scale，
     * 而 scale 由宽度定：1280/1624 = 0.788 → 800/0.788 = 1015）。
     * 也就是说左栏比 iPhone 横屏高出 265~470 设计px —— 原来的 `landscape`
     * 一档按 750 的预算算出来 550 高的桌子，摆进 967 高的栏里，上下各空 200，
     * 看着像「大窗口里一张小桌子」（原型给这一档的参数是环 704 / 头像 86）。
     *
     * 但**这里只放大到 620，不是 704**：rx 是宽度算出来的，左栏 800 定死，
     * rx 顶到 358 动了不；能加的只有 ratio。ratio 0.615 → 0.66 让桌子更圆一点
     * （真实牌桌俯视本来就接近正圆，手机上用 0.615 是为了省纵向），
     * ry 从 209 涨到 236，环高 550 → 620。
     *
     * 真正把这 400 多设计px 用掉的是**网格**，不是环：`.rt-desktop` 把组标签条
     * 与操作条挪到左栏桌子下面，右栏只留组槽与手牌 —— 组槽从 497 回到 591，
     * 三张牌从 105×147 回到 127×178（关闭圆桌时是 144×202）。
     *
     * avatar 80（手机上 68）：左栏 800 宽下 5 人局弧长间距 284，80 的头像
     * 加上昵称块还有富余；桌面上 CSS px = 设计px × 0.788，80 → 63 CSS px，
     * 与手机上的 68 × 0.5 = 34 CSS px 相比确实更大，但那是对的：
     * 桌面上这张桌子的对角尺寸是手机的两倍。 */
    desktop: {
      edgeX: 16,
      /* insetX 从 44 收到 36 —— 但不能更小：4 人局的两位外侧座位落在 x = cx − rx，
       * rx 350 时 x = 50，而座位块最小宽 88，块左沿正好压在 x = 6。
       * 收到 26（rx 358）时那块会出界 2 设计px，`[6d]` 的「不出块」断言当场红。 */
      insetX: 36,
      ratio: 0.66,
      topPad: 70,
      meH: 72,
      meGap: 6,
      feltPadX: 26,
      feltPadY: 0,
      avatar: 80,
      nmwMax: 132,
      nmwMin: 88,
      duelPlaqueDy: 34,
      duelMeDy: 16,
      vsH: 56,
      vsGap: 90
    },

    /* 紧凑竖屏（v90）：16:9 手机（375×667 / 360×640 / 320×568）。
     *
     * 这一档的舞台**设计高恒为 ~1332**，与 19.5:9 的 1623 差 291 —— 而这 291
     * 必须从环里出：扣掉屏幕留白 48 与底部（手牌 268 + 操作 88 + 组标签 88 + 间距 24）
     * 之后，「正常环 466 + 间距 8」只剩下 344 给组槽，三组牌被压到 68×95，
     * 比它替换掉的 v86 版式（109×153）还小 —— 上了圆桌反而看不清牌，这不叫升级。
     *
     * 缩法是**按比例一起缩**，不是只砍 ry：
     *   avatar 68→56、topPad 62→58、meH 64→56、meGap 6→4 省下 44；
     *   ratio 0.615→0.52 压扁椭圆，ry 从 167 收到 143，再省 48。
     * 只砍 ry 会让桌子变成一颗压扁的橄榄球、座位在弧上挤成一排；
     * 半径从 271 收到 275（insetX 50→46）反而是**稍微拉宽**的 —— 扁而宽的椭圆
     * 让最外侧座位离画布边更远，中央牌两边也留出更宽的缝。
     *
     * 环高因此 466 → 404，组槽 344 → 406，三张组牌回到 82×115、
     * 斗牛 5 张 90×126（v86 版式是 62×87，涨了 45%）。
     *
     * ★ 中央牌这一档要配合缩：环压扁之后 5 人局的两个内圈座位离牌心只有 ~102，
     *   而 340×110 的牌半高 55 + 座位半高 53 = 108 —— 会压住。
     *   CSS 里 `#game-top.gt-ring.rt-compact .gt-plaque` 把牌缩到 300 宽、字号降一档，
     *   半高降到 ~40，两边都让开。改这里任何一个数都要重跑 probe-table。 */
    portraitCompact: {
      edgeX: 14,
      insetX: 46,
      ratio: 0.52,
      topPad: 58,
      meH: 56,
      meGap: 4,
      feltPadX: 22,
      feltPadY: 0,
      avatar: 56,
      nmwMax: 112,
      nmwMin: 80,
      /* 对战条：中央牌照样下移 30 给条子让位，但 duelMeDy 是 **0**。
       * 正常竖屏那 16 是为了让「我」躲开下移后的中央牌；这一档牌只有 ~80 高
       * （是 110 的 0.73 倍），下移 30 之后牌底离「我」还有 81，不需要再挪。
       * 而 +14 会让环高从 404 涨到 418、组槽少 14 —— 斗牛那 5 张就是从 82 掉到 80，
       * 差 2 px 掉出 82×115 的下限（probe-table BOTS=1 实测）。 */
      duelPlaqueDy: 30,
      duelMeDy: 0,
      vsH: 52,
      vsGap: 84,
      /* 中央牌整体再下移 8：环压扁之后，5 人局的两个内圈座位心到牌心只有 102，
       * 而「牌半高 42 + 座位块半高 53」= 95 —— 只剩 7 设计px 净空（3 CSS px），
       * 真机换个字体就可能压住。+8 把净空抬到 15。牌底离「我」还有 100，不会顶到。 */
      plaqueDy: 8
    }
  };

  /* 上弧张角。1 个对手时 0°（正上方）—— 也就是 2 人局面对面坐，几何上本来就成立。
   * 4 个对手（5 人局）定 214°：早先给 202° 时最外侧座位中心落在 x≈58，
   * 8 字长昵称的块宽 132 会被裁掉 8px。这张表不是纯审美参数，
   * 它决定「最外侧座位离画布边还有多远」。 */
  function spanOf(n) {
    return n === 1 ? 0
      : n === 2 ? 132
      : n === 3 ? 176
      : n === 4 ? 214
      : n === 5 ? 214
      : 224;
  }

  /* 对手在「上弧」上的角度（度），按弧长均分。
   * 返回长度 = n；n = 0 返回空数组（房间里只有我一个人）。 */
  function oppAngles(n, ring) {
    n = Math.max(0, n | 0);
    if (n <= 0) return [];
    if (n === 1) return [270];

    var span = spanOf(n);
    var a0 = 270 - span / 2;
    var a1 = 270 + span / 2;
    var N = 512;
    var i;

    /* 累积弧长。pts 与 cum 同长，cum[0] = 0。 */
    var cum = [0];
    var px = Math.cos(a0 * Math.PI / 180) * ring.rx;
    var py = Math.sin(a0 * Math.PI / 180) * ring.ry;
    for (i = 1; i <= N; i++) {
      var a = (a0 + (a1 - a0) * i / N) * Math.PI / 180;
      var x = ring.rx * Math.cos(a);
      var y = ring.ry * Math.sin(a);
      var dx = x - px;
      var dy = y - py;
      cum.push(cum[i - 1] + Math.sqrt(dx * dx + dy * dy));
      px = x;
      py = y;
    }

    var total = cum[N];
    var out = [];
    for (i = 0; i < n; i++) {
      var target = total * i / (n - 1);
      /* 二分找到 target 落在哪一段，再在该段内线性插值角度 */
      var lo = 0;
      var hi = N;
      while (lo < hi - 1) {
        var mid = (lo + hi) >> 1;
        if (cum[mid] < target) lo = mid; else hi = mid;
      }
      var seg = (cum[hi] - cum[lo]) || 1;
      out.push(a0 + (a1 - a0) * (lo + (target - cum[lo]) / seg) / N);
    }
    return out;
  }

  function pointOnRing(ring, deg) {
    var a = deg * Math.PI / 180;
    return { x: ring.cx + ring.rx * Math.cos(a), y: ring.cy + ring.ry * Math.sin(a) };
  }

  /* 相邻座位的最小弧长间距。测试用它守「座位块不会互相压住」——
   * 这条断言比「角度看起来匀不匀」有用得多：压不压住是可见的，匀不匀是感觉的。 */
  function minArcSpacing(degs, ring) {
    if (!degs || degs.length < 2) return Infinity;
    var min = Infinity;
    for (var i = 1; i < degs.length; i++) {
      var d = Math.abs(degs[i] - degs[i - 1]);
      /* 用平均半径把角度差折成弧长；同一段小弧上足够精确 */
      var arc = d * Math.PI / 180 * Math.sqrt((ring.rx * ring.rx + ring.ry * ring.ry) / 2);
      if (arc < min) min = arc;
    }
    return min;
  }

  function mode(modeName) {
    return MODES[modeName] || MODES.portrait;
  }

  /* 主入口。
   * opts: { w 设计像素宽度, n 对手人数, mode 'portrait'|'landscape', maxH 高度上限 }
   * 返回的一切坐标都是**相对于这个块左上角**的设计像素 —— 调用方只需把块摆好、
   * 把该设的宽高写进 CSS，不用知道舞台上还有什么。 */
  function layout(opts) {
    opts = opts || {};
    var m = mode(opts.mode);
    var w = Math.max(320, Math.round(opts.w || 670));
    var n = Math.max(0, opts.n | 0);

    var feltW = w - m.edgeX * 2;
    var rx = Math.round(feltW / 2 - m.insetX);
    var ry = Math.round(rx * m.ratio);

    /* 高度上限：横屏左栏给 800 宽算出 550 高，正常放得下；但窄横屏（667×375，
     * 左栏 800 被压到 ~660）与平板分屏时左栏会变矮，桌子必须自己缩回来 ——
     * 否则底部「我」那一格会被 grid 裁掉，且裁的位置随设备而变，最难查。
     *
     * 缩的是 rx（ry 跟着 ratio 走），不是只砍 ry —— 只砍 ry 会让桌子变成一个
     * 压扁的椭圆，头像骑在弧上会挤成一排。 */
    if (opts.maxH) {
      var roomY = opts.maxH - m.topPad - m.meGap - m.meH;
      var ryMax = Math.floor(roomY / 2);
      if (ryMax > 0 && ry > ryMax) {
        ry = ryMax;
        rx = Math.round(ry / m.ratio);
      }
    }

    var cx = Math.round(w / 2);
    var cy = m.topPad + ry;
    /* 2 人局：中央牌与「我」都往下让一点，中间那条缝给对战条。
     * 用 n === 1 判（房间一共 2 个人），不是「人数 ≤ 2」—— n = 0（一个人）没有对手，
     * 摆一条「分差」出来只会让人以为漏了什么。 */
    var duel = n === 1;
    /* plaqueDy：紧凑档专用的小下移（见 portraitCompact）。中央牌往下挪一点，
     * 换的是它与内圈座位之间的**纵向**净空 —— 环一压扁，那点净空只剩个位数。 */
    var dy = (duel ? m.duelPlaqueDy : 0) + (m.plaqueDy || 0);
    var h = cy + ry + m.meGap + m.meH + (duel ? m.duelMeDy : 0);

    var ring = { cx: cx, cy: cy, rx: rx, ry: ry };
    var degs = oppAngles(n, ring);

    var seats = degs.map(function (d) {
      var p = pointOnRing(ring, d);
      /* 昵称块宽度：不能越过块左右边界（越界就会被 #game-top 裁掉，
       * 而且裁的是文字的中间部分，看起来像「名字被吃了一半」）。 */
      var room = 2 * (Math.min(p.x, w - p.x) - 6);
      var nmw = Math.min(m.nmwMax, Math.max(m.nmwMin, Math.round(room)));
      return { deg: d, x: Math.round(p.x), y: Math.round(p.y), nmw: nmw };
    });

    return {
      mode: opts.mode || 'portrait',
      w: w,
      n: n,
      h: h,
      avatar: m.avatar,
      ring: ring,
      seats: seats,
      plaque: { x: cx, y: cy - 4 + dy },
      me: { x: cx, y: cy + ry + m.meGap + (duel ? m.duelMeDy : 0) },
      /* 对战条：只在 2 人局给坐标，其余情况是 null（渲染层据此决定要不要画） */
      vs: duel ? { x: cx, y: Math.round(cy - 4 + dy - m.vsGap), h: m.vsH } : null,
      /* 毡面：比座位环外扩一圈，纯视觉 */
      felt: {
        x: cx - (rx + m.feltPadX),
        y: cy - (ry + m.feltPadY),
        w: 2 * (rx + m.feltPadX),
        h: 2 * (ry + m.feltPadY)
      },
      /* 表情入口：桌子右下角。它原来在顶栏右端，删顶栏之后必须有下家；
       * 放桌面右上会被对手座位压住，放右下离拇指最近，也不压毡面。 */
      emoji: { x: w - 52, y: h - 50 },
      arcSpacing: minArcSpacing(degs, ring)
    };
  }

  return {
    MODES: MODES,
    spanOf: spanOf,
    oppAngles: oppAngles,
    pointOnRing: pointOnRing,
    minArcSpacing: minArcSpacing,
    layout: layout
  };
});
